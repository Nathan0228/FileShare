package store

import (
	"context"
	"database/sql"
	"encoding/binary"
	"time"

	"sft/internal/wire"
)

type OutgoingShare struct {
	FileID    string    `json:"fileId"`
	Name      string    `json:"name"`
	Grantee   string    `json:"grantee"`
	Action    string    `json:"action"`
	CreatedAt time.Time `json:"createdAt"`
	Deleted   bool      `json:"deleted"`
}

// OutgoingShares lists either current grants on the actor's files or their own share history.
func (s *Store) OutgoingShares(ctx context.Context, actor wire.ID, view string, cursor *string) (Page[OutgoingShare], error) {
	switch view {
	case "active":
		return s.activeShares(ctx, actor, cursor)
	case "history":
		return s.shareHistory(ctx, actor, cursor)
	default:
		return Page[OutgoingShare]{}, wire.E("BAD_REQUEST", false)
	}
}

func (s *Store) activeShares(ctx context.Context, actor wire.ID, cursor *string) (Page[OutgoingShare], error) {
	const scope = "outgoing-shares/active"
	const keySize = 2 * len(wire.ID{})
	boundary, err := s.readCursor(actor, scope, cursor, keySize, keySize)
	if err != nil {
		return Page[OutgoingShare]{}, err
	}
	var lastFile, lastGrantee wire.ID
	if len(boundary) > 0 {
		lastFile = wire.ID(boundary[:len(lastFile)])
		lastGrantee = wire.ID(boundary[len(lastFile):])
	}
	const query = `SELECT f.id, f.name, grantee.id, grantee.username, acl.granted_at
		FROM files f
		JOIN file_acl acl ON acl.file_id=f.id
		JOIN users owner ON owner.id=f.owner_id
		JOIN users grantee ON grantee.id=acl.grantee_id
		WHERE f.owner_id=? AND owner.enabled=TRUE AND f.deleted_at IS NULL
		  AND (f.id>? OR (f.id=? AND acl.grantee_id>?))
		ORDER BY f.id, acl.grantee_id LIMIT 21`
	return readPage(ctx, s, actor, scope, query, func(rows *sql.Rows) (OutgoingShare, []byte, error) {
		item := OutgoingShare{Action: "grant"}
		var fileID, granteeID []byte
		if err := rows.Scan(&fileID, &item.Name, &granteeID, &item.Grantee, &item.CreatedAt); err != nil {
			return OutgoingShare{}, nil, err
		}
		item.FileID = wire.ID(fileID).String()
		key := append(make([]byte, 0, keySize), fileID...)
		key = append(key, granteeID...)
		return item, key, nil
	}, actor[:], lastFile[:], lastFile[:], lastGrantee[:])
}

func (s *Store) shareHistory(ctx context.Context, actor wire.ID, cursor *string) (Page[OutgoingShare], error) {
	const scope = "outgoing-shares/history"
	boundary, err := s.readCursor(actor, scope, cursor, 8, 8)
	if err != nil {
		return Page[OutgoingShare]{}, err
	}
	var last uint64
	if len(boundary) > 0 {
		last = binary.BigEndian.Uint64(boundary)
	}
	const query = `SELECT a.id, a.target_id, COALESCE(f.name, ''),
			COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.request_meta, '$.grantee')), ''),
			CASE a.action WHEN 'share.grant' THEN 'grant' ELSE 'revoke' END,
			a.created_at, (f.id IS NULL OR f.deleted_at IS NOT NULL)
		FROM audit_events a
		JOIN users owner ON owner.id=a.actor_id
		LEFT JOIN files f ON f.id=a.target_id AND f.owner_id=a.actor_id
		WHERE a.actor_id=? AND owner.enabled=TRUE
		  AND a.action IN ('share.grant', 'share.revoke') AND a.result='OK'
		  AND a.target_id IS NOT NULL AND a.created_at>=UTC_TIMESTAMP(6) - INTERVAL 30 DAY
		  AND (?=0 OR a.id<?)
		ORDER BY a.id DESC LIMIT 21`
	return readPage(ctx, s, actor, scope, query, func(rows *sql.Rows) (OutgoingShare, []byte, error) {
		var item OutgoingShare
		var id uint64
		var fileID []byte
		err := rows.Scan(&id, &fileID, &item.Name, &item.Grantee, &item.Action, &item.CreatedAt, &item.Deleted)
		if err != nil {
			return OutgoingShare{}, nil, err
		}
		item.FileID = wire.ID(fileID).String()
		return item, binary.BigEndian.AppendUint64(nil, id), nil
	}, actor[:], last, last)
}
