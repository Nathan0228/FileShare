package transfer

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"

	"sft/internal/wire"
)

type DownloadReady struct {
	Name       string
	Size       uint64
	SHA256     [32]byte
	ChunkBytes uint64
}

type downloadFile struct {
	DownloadReady
	key wire.ID
}

func findDownload(ctx context.Context, q rowQuerier, actor, id wire.ID) (downloadFile, error) {
	var file downloadFile
	var key, digest []byte
	err := q.QueryRowContext(ctx, `SELECT f.object_key, f.name, f.size, f.sha256
		FROM files AS f INNER JOIN users AS u ON u.id = ?
		WHERE f.id = ? AND f.deleted_at IS NULL AND u.enabled = 1 AND (u.permissions & ?) <> 0
		AND (f.owner_id = u.id OR EXISTS (SELECT 1 FROM file_acl AS a WHERE a.file_id = f.id AND a.grantee_id = u.id))`,
		actor[:], id[:], canDownload).Scan(&key, &file.Name, &file.Size, &digest)
	if errors.Is(err, sql.ErrNoRows) {
		return file, wire.E("DENIED", false)
	}
	if err != nil {
		return file, err
	}
	if len(key) != len(file.key) || len(digest) != sha256.Size || file.Size > MaxFileBytes {
		return file, errors.New("invalid stored file metadata")
	}
	copy(file.key[:], key)
	copy(file.SHA256[:], digest)
	file.ChunkBytes = ChunkBytes
	return file, nil
}

func (c *Conn) DownloadBegin(ctx context.Context, actor, id wire.ID) (DownloadReady, error) {
	s := c.service
	defer s.files.lock(id)()
	file, err := findDownload(ctx, s.db, actor, id)
	if err != nil {
		return DownloadReady{}, err
	}
	info, err := os.Lstat(filepath.Join(s.objects, file.key.String()))
	if err != nil || !info.Mode().IsRegular() || uint64(info.Size()) != file.Size {
		return DownloadReady{}, wire.E("STORAGE_UNAVAILABLE", true)
	}
	if err := c.bind(actor, task{id: id}); err != nil {
		return DownloadReady{}, err
	}
	return file.DownloadReady, nil
}

// CheckDownload rechecks the ACL immediately before a queued data frame is sent.
func (c *Conn) CheckDownload(ctx context.Context, actor, id wire.ID) error {
	t := task{id: id}
	if !c.bound(actor, t) {
		return wire.E("DENIED", false)
	}
	_, err := findDownload(ctx, c.service.db, actor, id)
	var protocolErr *wire.ProtocolError
	if errors.As(err, &protocolErr) && protocolErr.Code == "DENIED" {
		c.release(actor, t)
	}
	return err
}

func (c *Conn) DownloadChunk(ctx context.Context, actor, id wire.ID, index uint32) ([32]byte, []byte, error) {
	s := c.service
	defer s.files.lock(id)()
	t := task{id: id}
	if !c.bound(actor, t) {
		return [32]byte{}, nil, wire.E("DENIED", false)
	}
	file, err := findDownload(ctx, s.db, actor, id)
	if err != nil {
		var protocolErr *wire.ProtocolError
		if errors.As(err, &protocolErr) && protocolErr.Code == "DENIED" {
			c.release(actor, t)
		}
		return [32]byte{}, nil, err
	}
	length, valid := chunkSize(file.Size, index)
	if !valid {
		return [32]byte{}, nil, wire.E("BAD_REQUEST", false)
	}
	object, err := os.Open(filepath.Join(s.objects, file.key.String()))
	if err != nil {
		return [32]byte{}, nil, wire.E("STORAGE_UNAVAILABLE", true)
	}
	defer object.Close()
	data := make([]byte, length)
	if _, err := object.ReadAt(data, int64(index)*ChunkBytes); err != nil {
		return [32]byte{}, nil, wire.E("STORAGE_UNAVAILABLE", true)
	}
	if err := c.CheckDownload(ctx, actor, id); err != nil {
		return [32]byte{}, nil, err
	}
	return sha256.Sum256(data), data, nil
}

func (c *Conn) DownloadDone(ctx context.Context, actor, id wire.ID, digest [32]byte) error {
	s := c.service
	defer s.files.lock(id)()
	if !c.bound(actor, task{id: id}) {
		return wire.E("DENIED", false)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, _, _, err := checkAccount(ctx, tx, actor, canDownload, true); err != nil {
		return err
	}
	file, err := findDownload(ctx, tx, actor, id)
	if err != nil {
		return err
	}
	if digest != file.SHA256 {
		return wire.E("HASH_MISMATCH", false)
	}
	var exists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM download_receipts WHERE user_id = ? AND file_id = ?`, actor[:], id[:]).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `INSERT INTO download_receipts (user_id, file_id) VALUES (?, ?)`, actor[:], id[:]); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO audit_events (actor_id, target_id, action, result) VALUES (?, ?, 'download.complete', 'OK')`, actor[:], id[:]); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	c.release(actor, task{id: id})
	return nil
}

func (c *Conn) DownloadClose(_ context.Context, actor, id wire.ID) error {
	c.release(actor, task{id: id})
	return nil
}
