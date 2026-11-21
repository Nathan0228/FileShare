package store

import (
	"context"
	"database/sql"
	"errors"

	"sft/internal/wire"
)

type FileSummary struct {
	FileID string `json:"fileId"`
	Name   string `json:"name"`
	Size   uint64 `json:"size"`
	Owner  string `json:"owner"`
}

type FilePage = Page[FileSummary]

func (s *Store) List(ctx context.Context, actor wire.ID, scope string, cursor *string) (FilePage, error) {
	var query string
	switch scope {
	case "owned":
		query = `SELECT f.id, f.name, f.size, owner.username
			FROM files f JOIN users owner ON owner.id=f.owner_id
			WHERE owner.id=? AND owner.enabled=TRUE
			AND f.deleted_at IS NULL AND f.id>?
			ORDER BY f.id LIMIT 21`
	case "shared":
		query = `SELECT f.id, f.name, f.size, owner.username
			FROM file_acl acl JOIN files f ON f.id=acl.file_id
			JOIN users owner ON owner.id=f.owner_id
			JOIN users grantee ON grantee.id=acl.grantee_id
			WHERE grantee.id=? AND grantee.enabled=TRUE AND (grantee.permissions & 2)<>0
			AND f.deleted_at IS NULL AND f.id>?
			ORDER BY f.id LIMIT 21`
	default:
		return FilePage{}, wire.E("BAD_REQUEST", false)
	}
	key := "files/" + scope
	boundary, err := s.readCursor(actor, key, cursor, 16, 16)
	if err != nil {
		return FilePage{}, err
	}
	return readPage(ctx, s, actor, key, query, func(rows *sql.Rows) (FileSummary, []byte, error) {
		var file FileSummary
		var id []byte
		err := rows.Scan(&id, &file.Name, &file.Size, &file.Owner)
		if err == nil {
			file.FileID = wire.ID(id).String()
		}
		return file, id, err
	}, actor[:], boundary)
}

func (s *Store) ShareSet(ctx context.Context, actor, file wire.ID, grantee string, allow bool) error {
	if !ValidUsername(grantee) {
		return wire.E("BAD_REQUEST", false)
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	member, err := lockAccount(ctx, tx, actor)
	if err != nil {
		return err
	}
	if !member.enabled || member.permissions&SharePermission == 0 {
		return wire.E("DENIED", false)
	}
	var size uint64
	err = tx.QueryRowContext(ctx, `SELECT size FROM files
		WHERE id=? AND owner_id=? AND deleted_at IS NULL FOR UPDATE`, file[:], actor[:]).Scan(&size)
	if err != nil {
		return denyMissing(err)
	}
	var target []byte
	err = tx.QueryRowContext(ctx, `SELECT id FROM users
		WHERE username=? AND id<>? AND (?=FALSE OR enabled=TRUE)`, grantee, actor[:], allow).Scan(&target)
	if err != nil {
		return denyMissing(err)
	}
	action := "share.revoke"
	if allow {
		action = "share.grant"
		_, err = tx.ExecContext(ctx, `INSERT INTO file_acl (file_id, grantee_id) VALUES (?, ?)
			ON DUPLICATE KEY UPDATE granted_at=granted_at`, file[:], target)
	} else {
		_, err = tx.ExecContext(ctx, "DELETE FROM file_acl WHERE file_id=? AND grantee_id=?", file[:], target)
	}
	if err != nil {
		return err
	}
	if err := recordAudit(ctx, tx, actor[:], action, file[:], map[string]string{"grantee": grantee}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) FileDelete(ctx context.Context, actor, file wire.ID) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	member, err := lockAccount(ctx, tx, actor)
	if err != nil {
		return err
	}
	if !member.enabled {
		return wire.E("DENIED", false)
	}
	var size uint64
	var deletedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT size, deleted_at FROM files
		WHERE id=? AND owner_id=? FOR UPDATE`, file[:], actor[:]).Scan(&size, &deletedAt)
	if err != nil {
		return denyMissing(err)
	}
	if deletedAt.Valid {
		return tx.Commit()
	}
	if member.used < size {
		return errors.New("file quota counter inconsistent")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE files SET deleted_at=UTC_TIMESTAMP(6) WHERE id=?", file[:]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM file_acl WHERE file_id=?", file[:]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE users SET used_bytes=used_bytes-? WHERE id=?", size, actor[:]); err != nil {
		return err
	}
	if err := recordAudit(ctx, tx, actor[:], "file.delete", file[:], nil); err != nil {
		return err
	}
	return tx.Commit()
}
