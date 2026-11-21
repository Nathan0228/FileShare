package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"sft/internal/wire"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

func ValidUsername(value string) bool { return usernamePattern.MatchString(value) }

type account struct {
	id          wire.ID
	role        string
	enabled     bool
	permissions uint8
	quota       uint64
	used        uint64
	reserved    uint64
}

type UserProfile struct {
	UserID      string   `json:"userId"`
	Username    string   `json:"username"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	Quota       uint64   `json:"quotaBytes"`
	Used        uint64   `json:"usedBytes"`
	Reserved    uint64   `json:"reservedBytes"`
}

// Profile returns current account details for the authenticated user ID.
func (s *Store) Profile(ctx context.Context, actor wire.ID) (UserProfile, error) {
	profile := UserProfile{UserID: actor.String()}
	var permissions uint8
	err := s.DB.QueryRowContext(ctx, `SELECT username, role, permissions,
		quota_bytes, used_bytes, reserved_bytes FROM users WHERE id=? AND enabled=TRUE`, actor[:]).
		Scan(&profile.Username, &profile.Role, &permissions, &profile.Quota, &profile.Used, &profile.Reserved)
	if errors.Is(err, sql.ErrNoRows) {
		return UserProfile{}, wire.E("UNAUTH", false)
	}
	if err != nil {
		return UserProfile{}, err
	}
	profile.Permissions = permissionNames(permissions)
	return profile, nil
}

func lockAccount(ctx context.Context, tx *sql.Tx, id wire.ID) (account, error) {
	return scanAccount(tx.QueryRowContext(ctx, `SELECT id, role, enabled, permissions,
		quota_bytes, used_bytes, reserved_bytes FROM users WHERE id=? FOR UPDATE`, id[:]))
}

func lockUsername(ctx context.Context, tx *sql.Tx, username string) (account, error) {
	return scanAccount(tx.QueryRowContext(ctx, `SELECT id, role, enabled, permissions,
		quota_bytes, used_bytes, reserved_bytes FROM users WHERE username=? FOR UPDATE`, username))
}

func scanAccount(row *sql.Row) (account, error) {
	var member account
	var id []byte
	err := row.Scan(&id, &member.role, &member.enabled, &member.permissions, &member.quota, &member.used, &member.reserved)
	if err != nil {
		return account{}, denyMissing(err)
	}
	member.id = wire.ID(id)
	return member, nil
}

func denyMissing(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return wire.E("DENIED", false)
	}
	return err
}

func permissionMask(permissions []string) (uint8, error) {
	var mask uint8
	for _, permission := range permissions {
		var bit uint8
		switch permission {
		case "UPLOAD":
			bit = UploadPermission
		case "DOWNLOAD":
			bit = DownloadPermission
		case "SHARE":
			bit = SharePermission
		default:
			return 0, wire.E("BAD_REQUEST", false)
		}
		if mask&bit != 0 {
			return 0, wire.E("BAD_REQUEST", false)
		}
		mask |= bit
	}
	return mask, nil
}

func permissionNames(mask uint8) []string {
	names := make([]string, 0, 3)
	if mask&UploadPermission != 0 {
		names = append(names, "UPLOAD")
	}
	if mask&DownloadPermission != 0 {
		names = append(names, "DOWNLOAD")
	}
	if mask&SharePermission != 0 {
		names = append(names, "SHARE")
	}
	return names
}

func recordAudit(ctx context.Context, tx *sql.Tx, actor []byte, action string, target []byte, meta map[string]string) error {
	var details any
	if meta != nil {
		encoded, err := json.Marshal(meta)
		if err != nil {
			return err
		}
		details = encoded
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_events (actor_id, action, target_id, result, request_meta)
		VALUES (?, ?, ?, 'OK', ?)`, actor, action, target, details)
	return err
}

func issueInvite(ctx context.Context, tx *sql.Tx, id wire.ID) (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at=?
		WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL`, now, id[:]); err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw[:])
	_, err := tx.ExecContext(ctx, `INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		digest[:], id[:], now.Add(15*time.Minute))
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// Bootstrap issues a first-use invitation for the initial administrator. A
// replacement is allowed for the same username only before first enrollment.
func (s *Store) Bootstrap(ctx context.Context, username string) (string, error) {
	if !ValidUsername(username) {
		return "", wire.E("BAD_REQUEST", false)
	}
	var token string
	err := s.withLock(ctx, "sft:v1:bootstrap", func(conn *sql.Conn) error {
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()

		var existingID []byte
		var existingName string
		err = tx.QueryRowContext(ctx, `SELECT id, username FROM users
			WHERE role='admin' LIMIT 1 FOR UPDATE`).Scan(&existingID, &existingName)
		var id wire.ID
		switch {
		case errors.Is(err, sql.ErrNoRows):
			id, err = wire.NewID()
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO users (id, username, role, permissions, quota_bytes)
				VALUES (?, ?, 'admin', ?, ?)`, id[:], username, uint8(7), uint64(adminQuotaBytes))
			if duplicate(err) {
				return wire.E("CONFLICT", false)
			}
			if err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			if existingName != username {
				return errors.New("the initial administrator has already been created")
			}
			id = wire.ID(existingID)
			var enrolled bool
			err = tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM credentials WHERE user_id=?)", id[:]).Scan(&enrolled)
			if err != nil {
				return err
			}
			if enrolled {
				return errors.New("the initial administrator has already enrolled a credential")
			}
		}
		token, err = issueInvite(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := recordAudit(ctx, tx, nil, "admin.bootstrap", id[:], nil); err != nil {
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		return "", err
	}
	return token, nil
}
