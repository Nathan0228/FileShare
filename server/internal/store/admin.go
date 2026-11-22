package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"sft/internal/wire"
)

type usernameRequest struct {
	Action   string `json:"action"`
	Username string `json:"username"`
}

type accessRequest struct {
	usernameRequest
	Enabled     *bool     `json:"enabled"`
	Permissions *[]string `json:"permissions"`
	Quota       *uint64   `json:"quotaBytes"`
}

type revokeRequest struct {
	usernameRequest
	CredentialID string `json:"credentialId"`
}

type pageRequest struct {
	Action string  `json:"action"`
	Cursor *string `json:"cursor"`
}

type usersPageRequest struct {
	pageRequest
	Role   string `json:"role"`
	Search string `json:"search"`
}

var usernameSearchPattern = regexp.MustCompile(`^[a-z0-9._-]{0,64}$`)

type credentialPageRequest struct {
	pageRequest
	Username string `json:"username"`
}

type userSummary struct {
	UserProfile
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
}

type credentialSummary struct {
	ID        string     `json:"credentialId"`
	CreatedAt time.Time  `json:"createdAt"`
	RevokedAt *time.Time `json:"revokedAt"`
}

type auditSummary struct {
	ID          string          `json:"id"`
	ActorID     *string         `json:"actorId"`
	Action      string          `json:"action"`
	TargetID    *string         `json:"targetId"`
	Result      string          `json:"result"`
	CreatedAt   time.Time       `json:"createdAt"`
	RequestMeta json.RawMessage `json:"requestMeta"`
}

func (s *Store) Admin(ctx context.Context, actor wire.ID, payload []byte) (any, error) {
	var envelope struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, wire.E("BAD_REQUEST", false)
	}
	switch envelope.Action {
	case "create", "invite":
		var request usernameRequest
		if err := wire.JSON(payload, &request); err != nil {
			return nil, err
		}
		if !ValidUsername(request.Username) {
			return nil, wire.E("BAD_REQUEST", false)
		}
		return s.accountAction(ctx, actor, request)
	case "setAccess":
		var request accessRequest
		if err := wire.JSON(payload, &request); err != nil {
			return nil, err
		}
		if !ValidUsername(request.Username) || request.Enabled == nil || request.Permissions == nil ||
			request.Quota == nil || *request.Quota > 1<<50 {
			return nil, wire.E("BAD_REQUEST", false)
		}
		return nil, s.setAccess(ctx, actor, request)
	case "revokeCredential":
		var request revokeRequest
		if err := wire.JSON(payload, &request); err != nil {
			return nil, err
		}
		if !ValidUsername(request.Username) {
			return nil, wire.E("BAD_REQUEST", false)
		}
		return nil, s.revokeCredential(ctx, actor, request)
	case "users":
		var request usersPageRequest
		if err := wire.JSON(payload, &request); err != nil {
			return nil, err
		}
		if err := s.requireAdmin(ctx, actor); err != nil {
			return nil, err
		}
		return s.usersPage(ctx, actor, request)
	case "audit":
		var request pageRequest
		if err := wire.JSON(payload, &request); err != nil {
			return nil, err
		}
		if err := s.requireAdmin(ctx, actor); err != nil {
			return nil, err
		}
		return s.auditPage(ctx, actor, request.Cursor)
	case "credentials":
		var request credentialPageRequest
		if err := wire.JSON(payload, &request); err != nil {
			return nil, err
		}
		if !ValidUsername(request.Username) {
			return nil, wire.E("BAD_REQUEST", false)
		}
		if err := s.requireAdmin(ctx, actor); err != nil {
			return nil, err
		}
		return s.credentialsPage(ctx, actor, request.Username, request.Cursor)
	default:
		return nil, wire.E("BAD_REQUEST", false)
	}
}

func (s *Store) requireAdmin(ctx context.Context, actor wire.ID) error {
	var role string
	var enabled bool
	err := s.DB.QueryRowContext(ctx, "SELECT role, enabled FROM users WHERE id=?", actor[:]).Scan(&role, &enabled)
	if err != nil {
		return denyMissing(err)
	}
	if role != "admin" || !enabled {
		return wire.E("DENIED", false)
	}
	return nil
}

func beginAdmin(ctx context.Context, db *sql.DB, actor wire.ID) (*sql.Tx, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	admin, err := lockAccount(ctx, tx, actor)
	if err == nil && (admin.role != "admin" || !admin.enabled) {
		err = wire.E("DENIED", false)
	}
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (s *Store) accountAction(ctx context.Context, actor wire.ID, request usernameRequest) (any, error) {
	tx, err := beginAdmin(ctx, s.DB, actor)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if request.Action == "create" {
		id, err := wire.NewID()
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO users (id, username, role) VALUES (?, ?, 'user')", id[:], request.Username)
		if duplicate(err) {
			return nil, wire.E("CONFLICT", false)
		}
		if err != nil {
			return nil, err
		}
		if err := recordAudit(ctx, tx, actor[:], "account.create", id[:], nil); err != nil {
			return nil, err
		}
		return nil, tx.Commit()
	}
	target, err := lockUsername(ctx, tx, request.Username)
	if err != nil {
		return nil, err
	}
	if target.role != "user" || !target.enabled {
		return nil, wire.E("DENIED", false)
	}
	token, err := issueInvite(ctx, tx, target.id)
	if err != nil {
		return nil, err
	}
	if err := recordAudit(ctx, tx, actor[:], "invite.issue", target.id[:], nil); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return struct {
		Token string `json:"inviteToken"`
	}{token}, nil
}

func (s *Store) setAccess(ctx context.Context, actor wire.ID, request accessRequest) error {
	permissions, err := permissionMask(*request.Permissions)
	if err != nil {
		return err
	}
	tx, err := beginAdmin(ctx, s.DB, actor)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	target, err := lockUsername(ctx, tx, request.Username)
	if err != nil {
		return err
	}
	if target.role != "user" {
		return wire.E("DENIED", false)
	}
	if target.used > *request.Quota || target.reserved > *request.Quota-target.used {
		return wire.E("QUOTA", false)
	}
	_, err = tx.ExecContext(ctx, "UPDATE users SET enabled=?, permissions=?, quota_bytes=? WHERE id=?",
		*request.Enabled, permissions, *request.Quota, target.id[:])
	if err != nil {
		return err
	}
	if !*request.Enabled {
		if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at=UTC_TIMESTAMP(6)
			WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL`, target.id[:]); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=UTC_TIMESTAMP(6)
			WHERE user_id=? AND revoked_at IS NULL`, target.id[:]); err != nil {
			return err
		}
	}
	if err := recordAudit(ctx, tx, actor[:], "account.set_access", target.id[:], nil); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) revokeCredential(ctx context.Context, actor wire.ID, request revokeRequest) error {
	if len(request.CredentialID) > base64.RawURLEncoding.EncodedLen(1023) {
		return wire.E("BAD_REQUEST", false)
	}
	credentialID, err := base64.RawURLEncoding.Strict().DecodeString(request.CredentialID)
	if err != nil || len(credentialID) == 0 || len(credentialID) > 1023 ||
		base64.RawURLEncoding.EncodeToString(credentialID) != request.CredentialID {
		return wire.E("BAD_REQUEST", false)
	}
	tx, err := beginAdmin(ctx, s.DB, actor)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	target, err := lockUsername(ctx, tx, request.Username)
	if err != nil {
		return err
	}
	if target.role != "user" {
		return wire.E("DENIED", false)
	}
	var revoked sql.NullTime
	err = tx.QueryRowContext(ctx, "SELECT revoked_at FROM credentials WHERE credential_id=? AND user_id=? FOR UPDATE",
		credentialID, target.id[:]).Scan(&revoked)
	if err != nil {
		return denyMissing(err)
	}
	if revoked.Valid {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, "UPDATE credentials SET revoked_at=UTC_TIMESTAMP(6) WHERE credential_id=?", credentialID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=UTC_TIMESTAMP(6)
		WHERE credential_id=? AND revoked_at IS NULL`, credentialID); err != nil {
		return err
	}
	if err := recordAudit(ctx, tx, actor[:], "credential.revoke", target.id[:], nil); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) usersPage(ctx context.Context, actor wire.ID, request usersPageRequest) (Page[userSummary], error) {
	search := strings.ToLower(strings.TrimSpace(request.Search))
	if request.Role != "" && request.Role != "admin" && request.Role != "user" {
		return Page[userSummary]{}, wire.E("BAD_REQUEST", false)
	}
	if search != "" && (request.Role != "user" || !usernameSearchPattern.MatchString(search)) {
		return Page[userSummary]{}, wire.E("BAD_REQUEST", false)
	}

	scope := "admin/users"
	if request.Role != "" {
		scope += "/" + request.Role + "/" + search
	}
	boundary, err := s.readCursor(actor, scope, request.Cursor, 16, 16)
	if err != nil {
		return Page[userSummary]{}, err
	}
	const query = `SELECT id, username, role, enabled, permissions, quota_bytes, used_bytes, reserved_bytes, created_at
		FROM users WHERE id>? AND (?='' OR role=?) AND (?='' OR LOCATE(?, username)>0)
		ORDER BY id LIMIT 21`
	return readPage(ctx, s, actor, scope, query, func(rows *sql.Rows) (userSummary, []byte, error) {
		var user userSummary
		var id []byte
		var permissions uint8
		err := rows.Scan(&id, &user.Username, &user.Role, &user.Enabled, &permissions, &user.Quota, &user.Used, &user.Reserved, &user.CreatedAt)
		if err == nil {
			user.UserID = wire.ID(id).String()
			user.Permissions = permissionNames(permissions)
		}
		return user, id, err
	}, boundary, request.Role, request.Role, search, search)
}

func (s *Store) credentialsPage(ctx context.Context, actor wire.ID, username string, cursor *string) (Page[credentialSummary], error) {
	scope := "admin/credentials/" + username
	boundary, err := s.readCursor(actor, scope, cursor, 1, 1023)
	if err != nil {
		return Page[credentialSummary]{}, err
	}
	const query = `SELECT c.credential_id, c.created_at, c.revoked_at FROM credentials c
		JOIN users u ON u.id=c.user_id WHERE u.username=? AND c.credential_id>?
		ORDER BY c.credential_id LIMIT 21`
	return readPage(ctx, s, actor, scope, query, func(rows *sql.Rows) (credentialSummary, []byte, error) {
		var credential credentialSummary
		var id []byte
		var revoked sql.NullTime
		err := rows.Scan(&id, &credential.CreatedAt, &revoked)
		if err == nil {
			credential.ID = base64.RawURLEncoding.EncodeToString(id)
			if revoked.Valid {
				credential.RevokedAt = &revoked.Time
			}
		}
		return credential, id, err
	}, username, boundary)
}

func stringID(value []byte) *string {
	if value == nil {
		return nil
	}
	id := wire.ID(value).String()
	return &id
}

func (s *Store) auditPage(ctx context.Context, actor wire.ID, cursor *string) (Page[auditSummary], error) {
	const scope = "admin/audit"
	boundary, err := s.readCursor(actor, scope, cursor, 8, 8)
	if err != nil {
		return Page[auditSummary]{}, err
	}
	var maxID uint64
	if len(boundary) > 0 {
		maxID = binary.BigEndian.Uint64(boundary)
	}
	const query = `SELECT id, actor_id, action, target_id, result, created_at, request_meta
		FROM audit_events WHERE (?=0 OR id<?) ORDER BY id DESC LIMIT 21`
	return readPage(ctx, s, actor, scope, query, func(rows *sql.Rows) (auditSummary, []byte, error) {
		var entry auditSummary
		var id uint64
		var actorID, targetID, meta []byte
		err := rows.Scan(&id, &actorID, &entry.Action, &targetID, &entry.Result, &entry.CreatedAt, &meta)
		if err == nil {
			entry.ID = strconv.FormatUint(id, 10)
			entry.ActorID = stringID(actorID)
			entry.TargetID = stringID(targetID)
			entry.RequestMeta = meta
		}
		return entry, binary.BigEndian.AppendUint64(nil, id), err
	}, maxID, maxID)
}
