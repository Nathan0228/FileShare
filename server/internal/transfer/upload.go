package transfer

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"sft/internal/wire"
)

type UploadRequest struct {
	OpID   wire.ID
	Name   string
	Size   uint64
	SHA256 [32]byte
}

type UploadReady struct {
	ID         wire.ID
	Name       string
	Size       uint64
	SHA256     [32]byte
	ChunkBytes uint64
	State      string
}

type UploadState struct {
	State  string
	Bitmap string
	FileID *wire.ID
}

type uploadJob struct {
	TransferID wire.ID
	Owner      wire.ID
	Name       string
	Size       uint64
	SHA256     [32]byte
	State      string
	Expired    bool
	FileID     *wire.ID
}

const jobColumns = `id, owner_id, name, size, sha256, state, expires_at <= UTC_TIMESTAMP(6), file_id`

func loadJob(ctx context.Context, q rowQuerier, filter string, args ...any) (uploadJob, error) {
	var job uploadJob
	var id, owner, digest, fileID []byte
	err := q.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM upload_jobs WHERE `+filter, args...).
		Scan(&id, &owner, &job.Name, &job.Size, &digest, &job.State, &job.Expired, &fileID)
	if err != nil {
		return job, err
	}
	if len(id) != 16 || len(owner) != 16 || len(digest) != sha256.Size || job.Size > MaxFileBytes || len(fileID) != 0 && len(fileID) != 16 {
		return job, errors.New("invalid stored upload metadata")
	}
	copy(job.TransferID[:], id)
	copy(job.Owner[:], owner)
	copy(job.SHA256[:], digest)
	if len(fileID) != 0 {
		var value wire.ID
		copy(value[:], fileID)
		job.FileID = &value
	}
	return job, nil
}

func (s *Service) actorJob(ctx context.Context, actor, id wire.ID, capability uint8) (uploadJob, error) {
	if _, _, _, err := checkAccount(ctx, s.db, actor, capability, false); err != nil {
		return uploadJob{}, err
	}
	job, err := loadJob(ctx, s.db, `id = ? AND owner_id = ?`, id[:], actor[:])
	if errors.Is(err, sql.ErrNoRows) {
		return uploadJob{}, wire.E("DENIED", false)
	}
	return job, err
}

func (c *Conn) UploadBegin(ctx context.Context, actor wire.ID, request UploadRequest) (UploadReady, error) {
	if request.OpID == (wire.ID{}) || request.Size > MaxFileBytes || !validName(request.Name) {
		return UploadReady{}, wire.E("BAD_REQUEST", false)
	}
	job, err := c.beginJob(ctx, actor, request)
	if err != nil {
		return UploadReady{}, err
	}
	if job.State == "OPEN" {
		defer c.service.jobs.lock(job.TransferID)()
		job, err = c.service.actorJob(ctx, actor, job.TransferID, canUpload)
		if err != nil {
			return UploadReady{}, err
		}
		if job.State == "OPEN" && job.Expired {
			return UploadReady{}, wire.E("EXPIRED", false)
		}
		if job.State == "OPEN" {
			if err := c.bind(actor, task{upload: true, id: job.TransferID}); err != nil {
				return UploadReady{}, err
			}
		}
	}
	return UploadReady{ID: job.TransferID, Name: job.Name, Size: job.Size, SHA256: job.SHA256, ChunkBytes: ChunkBytes, State: job.State}, nil
}

func (c *Conn) beginJob(ctx context.Context, actor wire.ID, request UploadRequest) (uploadJob, error) {
	s := c.service
	s.newJobs.Lock()
	defer s.newJobs.Unlock()
	if err := ctx.Err(); err != nil {
		return uploadJob{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return uploadJob{}, err
	}
	defer tx.Rollback()
	quota, used, reserved, err := checkAccount(ctx, tx, actor, canUpload, true)
	if err != nil {
		return uploadJob{}, err
	}
	job, err := loadJob(ctx, tx, `owner_id = ? AND op_id = ? FOR UPDATE`, actor[:], request.OpID[:])
	if err == nil {
		if job.Name != request.Name || job.Size != request.Size || job.SHA256 != request.SHA256 {
			return uploadJob{}, wire.E("CONFLICT", false)
		}
		return job, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return uploadJob{}, err
	}
	if used > quota || reserved > quota-used || request.Size > quota-used-reserved {
		return uploadJob{}, wire.E("QUOTA", false)
	}
	var unfinished int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM upload_jobs WHERE owner_id = ? AND state IN ('OPEN','VERIFYING')`, actor[:]).Scan(&unfinished); err != nil {
		return uploadJob{}, err
	}
	if unfinished >= maxUnfinishedJobs {
		return uploadJob{}, wire.E("BUSY", true)
	}
	var pending uint64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM upload_jobs WHERE state IN ('OPEN','VERIFYING')`).Scan(&pending); err != nil {
		return uploadJob{}, err
	}
	free, err := freeDiskBytes(s.staging)
	if err != nil || free < diskHeadroom || pending > (free-diskHeadroom)/2 || request.Size > (free-diskHeadroom)/2-pending {
		return uploadJob{}, wire.E("STORAGE_UNAVAILABLE", true)
	}
	id, err := wire.NewID()
	if err != nil {
		return uploadJob{}, err
	}
	t := task{upload: true, id: id}
	if err := c.bind(actor, t); err != nil {
		return uploadJob{}, err
	}
	committed := false
	defer func() {
		if !committed {
			c.release(actor, t)
		}
	}()
	_, err = tx.ExecContext(ctx, `INSERT INTO upload_jobs (id, owner_id, op_id, name, size, sha256, state, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP(6) + INTERVAL 24 HOUR)`, id[:], actor[:], request.OpID[:], request.Name, request.Size, request.SHA256[:])
	if err != nil {
		return uploadJob{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET reserved_bytes = reserved_bytes + ? WHERE id = ?`, request.Size, actor[:]); err != nil {
		return uploadJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return uploadJob{}, err
	}
	committed = true
	job = uploadJob{TransferID: id, Owner: actor, Name: request.Name, Size: request.Size, SHA256: request.SHA256, State: "OPEN"}
	return job, nil
}

func (c *Conn) UploadStatus(ctx context.Context, actor, id wire.ID) (UploadState, error) {
	s := c.service
	defer s.jobs.lock(id)()
	job, err := s.actorJob(ctx, actor, id, canUpload)
	if err != nil {
		return UploadState{}, err
	}
	if job.State == "OPEN" && job.Expired {
		job.State = "EXPIRED"
	}
	bitmap := make([]byte, (chunkCount(job.Size)+7)/8)
	switch job.State {
	case "READY":
		for index := uint32(0); index < chunkCount(job.Size); index++ {
			bitmap[index/8] |= 1 << (index % 8)
		}
	case "OPEN", "VERIFYING":
		if err := s.fillBitmap(ctx, job, bitmap); err != nil {
			return UploadState{}, err
		}
		if job.State == "OPEN" {
			if _, err := s.db.ExecContext(ctx, `UPDATE upload_jobs SET expires_at = UTC_TIMESTAMP(6) + INTERVAL 24 HOUR WHERE id = ?`, id[:]); err != nil {
				return UploadState{}, err
			}
			if err := c.bind(actor, task{upload: true, id: id}); err != nil {
				return UploadState{}, err
			}
		}
	}
	return UploadState{State: job.State, Bitmap: base64.RawURLEncoding.EncodeToString(bitmap), FileID: job.FileID}, nil
}

func (s *Service) fillBitmap(ctx context.Context, job uploadJob, bitmap []byte) error {
	rows, err := s.db.QueryContext(ctx, `SELECT idx FROM upload_chunks WHERE upload_id = ?`, job.TransferID[:])
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var idx uint32
		if err := rows.Scan(&idx); err != nil {
			return err
		}
		if idx >= chunkCount(job.Size) {
			return errors.New("stored chunk index outside upload")
		}
		bitmap[idx/8] |= 1 << (idx % 8)
	}
	return rows.Err()
}

func (c *Conn) UploadChunk(ctx context.Context, actor, id wire.ID, index uint32, digest [32]byte, data []byte) error {
	s := c.service
	defer s.jobs.lock(id)()
	if !c.bound(actor, task{upload: true, id: id}) {
		return wire.E("DENIED", false)
	}
	job, err := s.actorJob(ctx, actor, id, canUpload)
	if err != nil {
		return err
	}
	if job.State == "EXPIRED" || job.State == "OPEN" && job.Expired {
		return wire.E("EXPIRED", false)
	}
	if job.State != "OPEN" {
		return wire.E("CONFLICT", false)
	}
	length, valid := chunkSize(job.Size, index)
	if !valid || length != uint64(len(data)) {
		return wire.E("BAD_REQUEST", false)
	}
	if digest != sha256.Sum256(data) {
		return wire.E("HASH_MISMATCH", false)
	}
	var storedLength uint64
	var storedDigest []byte
	err = s.db.QueryRowContext(ctx, `SELECT chunk_bytes, sha256 FROM upload_chunks WHERE upload_id = ? AND idx = ?`, id[:], index).Scan(&storedLength, &storedDigest)
	if err == nil && (storedLength != length || len(storedDigest) != sha256.Size || [32]byte(storedDigest) != digest) {
		return wire.E("CONFLICT", false)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	duplicate := err == nil
	chunk := s.chunkPath(id, index)
	if duplicate {
		ok, err := matchesDigest(ctx, chunk, length, digest)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return wire.E("STORAGE_UNAVAILABLE", true)
		}
		if !ok {
			if err := s.writeChunk(id, index, data); err != nil {
				return wire.E("STORAGE_UNAVAILABLE", true)
			}
		}
	} else if err := s.writeChunk(id, index, data); err != nil {
		return wire.E("STORAGE_UNAVAILABLE", true)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, _, _, err := checkAccount(ctx, tx, actor, canUpload, true); err != nil {
		return err
	}
	if !duplicate {
		if _, err := tx.ExecContext(ctx, `INSERT INTO upload_chunks (upload_id, idx, chunk_bytes, sha256) VALUES (?, ?, ?, ?)`, id[:], index, length, digest[:]); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE upload_jobs SET expires_at = UTC_TIMESTAMP(6) + INTERVAL 24 HOUR WHERE id = ?`, id[:]); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Service) chunkPath(id wire.ID, index uint32) string {
	return filepath.Join(s.staging, id.String(), strconv.FormatUint(uint64(index), 10)+".part")
}

func (s *Service) writeChunk(id wire.ID, index uint32, data []byte) error {
	target := s.chunkPath(id, index)
	dir := filepath.Dir(target)
	if err := ensurePrivateDir(dir); err != nil {
		return err
	}
	if err := syncDir(s.staging); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".chunk-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	return publishFile(file, target)
}

func (c *Conn) UploadCommit(ctx context.Context, actor, id wire.ID) (wire.ID, error) {
	s := c.service
	defer s.jobs.lock(id)()
	job, err := s.actorJob(ctx, actor, id, canUpload)
	if err != nil {
		return wire.ID{}, err
	}
	if job.State == "READY" && job.FileID != nil {
		return *job.FileID, nil
	}
	switch {
	case job.State == "VERIFYING":
	case job.State == "EXPIRED" || job.State == "OPEN" && job.Expired:
		return wire.ID{}, wire.E("EXPIRED", false)
	case job.State != "OPEN":
		return wire.ID{}, wire.E("CONFLICT", false)
	case !c.bound(actor, task{upload: true, id: id}):
		return wire.ID{}, wire.E("DENIED", false)
	default:
		bitmap := make([]byte, (chunkCount(job.Size)+7)/8)
		if err := s.fillBitmap(ctx, job, bitmap); err != nil {
			return wire.ID{}, err
		}
		for idx := uint32(0); idx < chunkCount(job.Size); idx++ {
			if bitmap[idx/8]&(1<<(idx%8)) == 0 {
				return wire.ID{}, wire.E("INCOMPLETE", true)
			}
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE upload_jobs SET state = 'VERIFYING',
			expires_at = UTC_TIMESTAMP(6) + INTERVAL 24 HOUR WHERE id = ?`, id[:]); err != nil {
			return wire.ID{}, err
		}
	}
	return s.finishJob(ctx, job)
}

func (s *Service) finishJob(ctx context.Context, job uploadJob) (wire.ID, error) {
	id := job.TransferID
	target := filepath.Join(s.objects, id.String())
	match, err := matchesDigest(ctx, target, job.Size, job.SHA256)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return wire.ID{}, wire.E("STORAGE_UNAVAILABLE", true)
	}
	if !match {
		if err := s.assemble(ctx, job, target); err != nil {
			if !errors.Is(err, errInvalidFile) && !errors.Is(err, os.ErrNotExist) {
				return wire.ID{}, wire.E("STORAGE_UNAVAILABLE", true)
			}
			if markErr := s.markTerminal(ctx, job, "FAILED"); markErr != nil {
				return wire.ID{}, markErr
			}
			s.releaseUpload(id)
			return wire.ID{}, wire.E("HASH_MISMATCH", false)
		}
	}
	// A previous rename may have succeeded while syncing the directory failed.
	if err := syncDir(s.objects); err != nil {
		return wire.ID{}, wire.E("STORAGE_UNAVAILABLE", true)
	}
	fileID, err := s.commitFile(ctx, job)
	if err == nil {
		s.releaseUpload(id)
	}
	return fileID, err
}

func (s *Service) commitFile(ctx context.Context, job uploadJob) (wire.ID, error) {
	id, actor := job.TransferID, job.Owner
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return wire.ID{}, err
	}
	defer tx.Rollback()
	var enabled bool
	var perms uint8
	var reserved uint64
	if err := tx.QueryRowContext(ctx, `SELECT enabled, permissions, reserved_bytes FROM users WHERE id = ? FOR UPDATE`, actor[:]).Scan(&enabled, &perms, &reserved); err != nil {
		return wire.ID{}, err
	}
	if reserved < job.Size {
		return wire.ID{}, errors.New("invalid upload reservation")
	}
	if !enabled || perms&canUpload == 0 {
		if err := transitionTerminal(ctx, tx, job, "FAILED"); err != nil {
			return wire.ID{}, err
		}
		if err := tx.Commit(); err != nil {
			return wire.ID{}, err
		}
		s.releaseUpload(id)
		return wire.ID{}, wire.E("DENIED", false)
	}
	fileID, err := wire.NewID()
	if err != nil {
		return wire.ID{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO files (id, owner_id, object_key, name, size, sha256) VALUES (?, ?, ?, ?, ?, ?)`, fileID[:], actor[:], id[:], job.Name, job.Size, job.SHA256[:]); err != nil {
		return wire.ID{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE upload_jobs SET state = 'READY', file_id = ? WHERE id = ?`, fileID[:], id[:]); err != nil {
		return wire.ID{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET used_bytes = used_bytes + ?, reserved_bytes = reserved_bytes - ? WHERE id = ?`, job.Size, job.Size, actor[:]); err != nil {
		return wire.ID{}, err
	}
	return fileID, tx.Commit()
}

var errInvalidFile = errors.New("file does not match its declared length or digest")

func (s *Service) assemble(ctx context.Context, job uploadJob, target string) error {
	file, err := os.CreateTemp(s.objects, ".assemble-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	digest := sha256.New()
	writer := io.MultiWriter(file, digest)
	data := make([]byte, ChunkBytes)
	for index := uint32(0); index < chunkCount(job.Size); index++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		length, _ := chunkSize(job.Size, index)
		chunk, err := os.Open(s.chunkPath(job.TransferID, index))
		if err != nil {
			return err
		}
		info, err := chunk.Stat()
		if err == nil && (!info.Mode().IsRegular() || uint64(info.Size()) != length) {
			err = errInvalidFile
		}
		if err == nil {
			_, err = io.ReadFull(chunk, data[:length])
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				err = errInvalidFile
			}
		}
		chunk.Close()
		if err != nil {
			return err
		}
		if _, err := writer.Write(data[:length]); err != nil {
			return err
		}
	}
	if [32]byte(digest.Sum(nil)) != job.SHA256 {
		return errInvalidFile
	}
	return publishFile(file, target)
}

func matchesDigest(ctx context.Context, path string, size uint64, expected [32]byte) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || uint64(info.Size()) != size {
		return false, err
	}
	hash := sha256.New()
	buf := make([]byte, 128*1024)
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		n, err := file.Read(buf)
		hash.Write(buf[:n])
		if err == io.EOF {
			return [32]byte(hash.Sum(nil)) == expected, nil
		}
		if err != nil {
			return false, err
		}
	}
}

func (c *Conn) UploadPause(ctx context.Context, actor, id wire.ID) error {
	s := c.service
	defer s.jobs.lock(id)()
	job, err := s.actorJob(ctx, actor, id, 0)
	if err != nil {
		return err
	}
	if job.State != "OPEN" {
		return wire.E("CONFLICT", false)
	}
	c.release(actor, task{upload: true, id: id})
	return nil
}

func (c *Conn) UploadCancel(ctx context.Context, actor, id wire.ID) error {
	s := c.service
	defer s.jobs.lock(id)()
	job, err := s.actorJob(ctx, actor, id, 0)
	if err != nil {
		return err
	}
	switch job.State {
	case "CANCELLED":
		return nil
	case "OPEN", "VERIFYING":
		if err := s.markTerminal(ctx, job, "CANCELLED"); err != nil {
			return err
		}
		s.releaseUpload(id)
		return nil
	case "EXPIRED":
		return wire.E("EXPIRED", false)
	default:
		return wire.E("CONFLICT", false)
	}
}

func (s *Service) markTerminal(ctx context.Context, job uploadJob, target string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := transitionTerminal(ctx, tx, job, target); err != nil {
		return err
	}
	return tx.Commit()
}

func transitionTerminal(ctx context.Context, tx *sql.Tx, job uploadJob, target string) error {
	id, actor := job.TransferID, job.Owner
	var reserved uint64
	if err := tx.QueryRowContext(ctx, `SELECT reserved_bytes FROM users WHERE id = ? FOR UPDATE`, actor[:]).Scan(&reserved); err != nil {
		return err
	}
	if reserved < job.Size {
		return fmt.Errorf("upload %s has an invalid reservation", id.String())
	}
	result, err := tx.ExecContext(ctx, `UPDATE upload_jobs SET state = ? WHERE id = ? AND state IN ('OPEN','VERIFYING')`, target, id[:])
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil || changed == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE users SET reserved_bytes = reserved_bytes - ? WHERE id = ?`, job.Size, actor[:])
	return err
}
