package transfer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"sft/internal/wire"
)

const maintenanceBatch = 32

// Recover is called at startup, before connections can create new scratch files.
func (s *Service) Recover(ctx context.Context) error {
	var recoveryErrors []error
	for _, dir := range []string{s.objects, s.staging} {
		err := filepath.WalkDir(dir, func(path string, item fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if item.IsDir() || !strings.HasPrefix(item.Name(), ".chunk-") && !strings.HasPrefix(item.Name(), ".assemble-") {
				return nil
			}
			return removeSync(path)
		})
		if err != nil {
			recoveryErrors = append(recoveryErrors, err)
		}
	}
	return errors.Join(append(recoveryErrors, s.Cleanup(ctx))...)
}

// Cleanup expires reservations, removes unneeded bytes, and resumes incomplete publication.
func (s *Service) Cleanup(ctx context.Context) error {
	return errors.Join(s.expireJobs(ctx), s.cleanJobs(ctx), s.purgeFiles(ctx), s.resumeJobs(ctx))
}

func (s *Service) expireJobs(ctx context.Context) error {
	return s.eachID(ctx, &s.jobs, `SELECT id FROM upload_jobs WHERE state IN ('OPEN','VERIFYING') AND expires_at <= UTC_TIMESTAMP(6)
		ORDER BY expires_at LIMIT ?`, func(id wire.ID) error {
		job, err := loadJob(ctx, s.db, `id = ?`, id[:])
		if err != nil {
			return err
		}
		if (job.State != "OPEN" && job.State != "VERIFYING") || !job.Expired {
			return nil
		}
		if err := s.markTerminal(ctx, job, "EXPIRED"); err != nil {
			return err
		}
		s.releaseUpload(id)
		return nil
	})
}

func (s *Service) resumeJobs(ctx context.Context) error {
	return s.eachID(ctx, &s.jobs, `SELECT id FROM upload_jobs WHERE state = 'VERIFYING' ORDER BY expires_at LIMIT ?`, func(id wire.ID) error {
		job, err := loadJob(ctx, s.db, `id = ?`, id[:])
		if err != nil || job.State != "VERIFYING" {
			return err
		}
		_, err = s.finishJob(ctx, job)
		var stateErr *wire.ProtocolError
		if errors.As(err, &stateErr) && (stateErr.Code == "HASH_MISMATCH" || stateErr.Code == "DENIED") {
			return nil
		}
		return err
	})
}

func (s *Service) cleanJobs(ctx context.Context) error {
	return s.eachID(ctx, &s.jobs, `SELECT id FROM upload_jobs WHERE cleaned_at IS NULL
		AND state IN ('READY','CANCELLED','EXPIRED','FAILED') ORDER BY expires_at LIMIT ?`, func(id wire.ID) error {
		job, err := loadJob(ctx, s.db, `id = ?`, id[:])
		if err != nil {
			return err
		}
		dir := filepath.Join(s.staging, id.String())
		if filepath.Dir(dir) != s.staging || id == (wire.ID{}) {
			return errors.New("refusing to remove an invalid upload directory")
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
		if err := syncDir(s.staging); err != nil {
			return err
		}
		if job.State != "READY" {
			if err := removeSync(filepath.Join(s.objects, id.String())); err != nil {
				return err
			}
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, `DELETE FROM upload_chunks WHERE upload_id = ?`, id[:]); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE upload_jobs SET cleaned_at = UTC_TIMESTAMP(6) WHERE id = ?`, id[:]); err != nil {
			return err
		}
		return tx.Commit()
	})
}

func (s *Service) purgeFiles(ctx context.Context) error {
	return s.eachID(ctx, &s.files, `SELECT id FROM files WHERE purged_at IS NULL AND deleted_at IS NOT NULL
		ORDER BY deleted_at LIMIT ?`, func(id wire.ID) error {
		var key []byte
		err := s.db.QueryRowContext(ctx, `SELECT object_key FROM files WHERE id = ? AND deleted_at IS NOT NULL`, id[:]).Scan(&key)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		var objectID wire.ID
		if len(key) != len(objectID) {
			return errors.New("invalid deleted file's storage key")
		}
		copy(objectID[:], key)
		if err := removeSync(filepath.Join(s.objects, objectID.String())); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, `UPDATE files SET purged_at = UTC_TIMESTAMP(6) WHERE id = ?`, id[:])
		return err
	})
}

func (s *Service) eachID(ctx context.Context, locks *keyedLocks, query string, process func(wire.ID) error) error {
	rows, err := s.db.QueryContext(ctx, query, maintenanceBatch)
	if err != nil {
		return err
	}
	var targets []wire.ID
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		if len(raw) != 16 {
			rows.Close()
			return errors.New("invalid stored maintenance target")
		}
		targets = append(targets, wire.ID(raw))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var failures []error
	for _, id := range targets {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		unlock, available := locks.tryLock(id)
		if !available {
			continue
		}
		err := process(id)
		unlock()
		if err != nil {
			failures = append(failures, fmt.Errorf("maintenance for %s: %w", id, err))
		}
	}
	return errors.Join(failures...)
}

func removeSync(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Dir(path))
}
