package transfer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"unicode"
	"unicode/utf8"

	"sft/internal/wire"
)

const (
	ChunkBytes        = wire.ChunkBytes
	MaxFileBytes      = 512 * 1024 * 1024
	MaxActive         = 4
	maxUnfinishedJobs = 8
	diskHeadroom      = 64 * 1024 * 1024
	canUpload         = uint8(1)
	canDownload       = uint8(2)
)

// Service owns active bindings and durable filesystem state for a single Go instance.
type Service struct {
	db      *sql.DB
	staging string
	objects string

	mu      sync.Mutex
	active  map[wire.ID]int
	uploads map[wire.ID]*Conn
	newJobs sync.Mutex
	jobs    keyedLocks
	files   keyedLocks
}

// Conn scopes active transfers to a WebSocket connection.
type Conn struct {
	service *Service
	closed  bool
	tasks   map[task]wire.ID
}

type task struct {
	upload bool
	id     wire.ID
}

type keyedLocks struct {
	mu    sync.Mutex
	locks map[wire.ID]*lockEntry
}

type lockEntry struct {
	mu    sync.Mutex
	users int
}

func (k *keyedLocks) lock(key wire.ID) func() {
	entry := k.ref(key)
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		k.unref(key, entry)
	}
}

func (k *keyedLocks) tryLock(key wire.ID) (func(), bool) {
	entry := k.ref(key)
	if !entry.mu.TryLock() {
		k.unref(key, entry)
		return nil, false
	}
	return func() {
		entry.mu.Unlock()
		k.unref(key, entry)
	}, true
}

func (k *keyedLocks) ref(key wire.ID) *lockEntry {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.locks == nil {
		k.locks = make(map[wire.ID]*lockEntry)
	}
	entry := k.locks[key]
	if entry == nil {
		entry = &lockEntry{}
		k.locks[key] = entry
	}
	entry.users++
	return entry
}

func (k *keyedLocks) unref(key wire.ID, entry *lockEntry) {
	k.mu.Lock()
	defer k.mu.Unlock()
	entry.users--
	if entry.users == 0 {
		delete(k.locks, key)
	}
}

func New(db *sql.DB, storageRoot string) (*Service, error) {
	if db == nil || storageRoot == "" {
		return nil, errors.New("transfer database and storage directory are required")
	}
	root, err := filepath.Abs(storageRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve transfer storage: %w", err)
	}
	s := &Service{
		db: db, staging: filepath.Join(root, "staging"), objects: filepath.Join(root, "objects"),
		active: make(map[wire.ID]int), uploads: make(map[wire.ID]*Conn),
	}
	for _, dir := range []string{root, s.staging, s.objects} {
		if err := ensurePrivateDir(dir); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create transfer directory %s: %w", dir, err)
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("transfer path is not a real directory: %s", dir)
	}
	if runtime.GOOS == "linux" && info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("transfer directory must restrict access to its owner: %s", dir)
	}
	return nil
}

func (s *Service) Conn(_ string) *Conn {
	return &Conn{service: s, tasks: make(map[task]wire.ID)}
}

func (c *Conn) Close() {
	s := c.service
	s.mu.Lock()
	defer s.mu.Unlock()
	c.closed = true
	for t := range c.tasks {
		c.releaseLocked(t)
	}
}

func (c *Conn) bind(actor wire.ID, t task) error {
	s := c.service
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.closed {
		return wire.E("BUSY", true)
	}
	if owner, ok := c.tasks[t]; ok {
		if owner == actor {
			return nil
		}
		return wire.E("DENIED", false)
	}
	if s.active[actor] >= MaxActive || t.upload && s.uploads[t.id] != nil {
		return wire.E("BUSY", true)
	}
	if t.upload {
		s.uploads[t.id] = c
	}
	c.tasks[t] = actor
	s.active[actor]++
	return nil
}

func (c *Conn) bound(actor wire.ID, t task) bool {
	c.service.mu.Lock()
	defer c.service.mu.Unlock()
	owner, ok := c.tasks[t]
	return ok && owner == actor && !c.closed
}

func (c *Conn) release(actor wire.ID, t task) {
	c.service.mu.Lock()
	defer c.service.mu.Unlock()
	if owner, ok := c.tasks[t]; ok && owner == actor {
		c.releaseLocked(t)
	}
}

func (c *Conn) releaseLocked(t task) {
	s := c.service
	actor := c.tasks[t]
	delete(c.tasks, t)
	if t.upload {
		delete(s.uploads, t.id)
	}
	if s.active[actor] <= 1 {
		delete(s.active, actor)
	} else {
		s.active[actor]--
	}
}

func (s *Service) releaseUpload(id wire.ID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if conn := s.uploads[id]; conn != nil {
		conn.releaseLocked(task{upload: true, id: id})
	}
}

func validName(name string) bool {
	if len(name) == 0 || len(name) > 120 || name == "." || name == ".." || !utf8.ValidString(name) {
		return false
	}
	for _, r := range name {
		if r == '/' || r == '\\' || unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return false
		}
	}
	return true
}

func chunkCount(size uint64) uint32 {
	return uint32((size + ChunkBytes - 1) / ChunkBytes)
}

func chunkSize(size uint64, index uint32) (uint64, bool) {
	if index >= chunkCount(size) {
		return 0, false
	}
	offset := uint64(index) * ChunkBytes
	return min(ChunkBytes, size-offset), true
}

func checkAccount(ctx context.Context, db rowQuerier, actor wire.ID, capability uint8, forUpdate bool) (quota, used, reserved uint64, err error) {
	var enabled bool
	var permissions uint8
	query := `SELECT enabled, permissions, quota_bytes, used_bytes, reserved_bytes FROM users WHERE id = ?`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	err = db.QueryRowContext(ctx, query, actor[:]).Scan(&enabled, &permissions, &quota, &used, &reserved)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (!enabled || permissions&capability != capability) {
		return 0, 0, 0, wire.E("DENIED", false)
	}
	return quota, used, reserved, err
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}
