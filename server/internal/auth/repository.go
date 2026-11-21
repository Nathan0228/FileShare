package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"sft/internal/wire"
)

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readAccountByName(ctx context.Context, db *sql.DB, username string) (account, error) {
	return scanAccount(db.QueryRowContext(ctx, `
		SELECT id, username, role, permissions
		FROM users WHERE username = ? AND enabled = 1`, username))
}

func readAccountByID(ctx context.Context, db queryer, userID wire.ID, lock bool) (account, error) {
	query := `SELECT id, username, role, permissions FROM users WHERE id = ? AND enabled = 1`
	if lock {
		query += ` FOR UPDATE`
	}
	return scanAccount(db.QueryRowContext(ctx, query, userID[:]))
}

func scanAccount(row *sql.Row) (account, error) {
	var a account
	var id []byte
	if err := row.Scan(&id, &a.Username, &a.Role, &a.Permissions); err != nil {
		return account{}, denyMissing(err)
	}
	if len(id) != len(a.ID) {
		return account{}, errors.New("invalid account ID in database")
	}
	a.ID = wire.ID(id)
	return a, nil
}

func loadCredentials(ctx context.Context, db queryer, a *account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT credential_id, public_key_cose, sign_count, credential_json
		FROM credentials WHERE user_id = ? AND revoked_at IS NULL
		ORDER BY created_at, credential_id LIMIT ?`, a.ID[:], maxCredentials)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, publicKey, data []byte
		var count uint32
		if err := rows.Scan(&id, &publicKey, &count, &data); err != nil {
			return err
		}
		var credential webauthn.Credential
		if err := json.Unmarshal(data, &credential); err != nil {
			return err
		}
		if !bytes.Equal(id, credential.ID) || !bytes.Equal(publicKey, credential.PublicKey) || count != credential.Authenticator.SignCount {
			return errors.New("inconsistent credential record")
		}
		a.Credentials = append(a.Credentials, credential)
	}
	return rows.Err()
}

func saveCredential(ctx context.Context, tx *sql.Tx, userID wire.ID, credential *webauthn.Credential) error {
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO credentials (credential_id, user_id, public_key_cose, sign_count, credential_json)
		VALUES (?, ?, ?, ?, ?)`, credential.ID, userID[:], credential.PublicKey, credential.Authenticator.SignCount, string(data))
	return err
}

func updateCredential(ctx context.Context, tx *sql.Tx, userID wire.ID, credential *webauthn.Credential) error {
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE credentials SET sign_count = ?, credential_json = ?
		WHERE user_id = ? AND credential_id = ? AND revoked_at IS NULL`,
		credential.Authenticator.SignCount, string(data), userID[:], credential.ID)
	return err
}

func readInvite(ctx context.Context, db *sql.DB, hash [sha256.Size]byte, now time.Time) (wire.ID, error) {
	var id []byte
	if err := db.QueryRowContext(ctx, `
		SELECT user_id FROM invites
		WHERE token_hash = ? AND expires_at > ? AND consumed_at IS NULL AND revoked_at IS NULL`,
		hash[:], now).Scan(&id); err != nil {
		return wire.ID{}, denyMissing(err)
	}
	if len(id) != len(wire.ID{}) {
		return wire.ID{}, errors.New("invalid invitation account ID in database")
	}
	return wire.ID(id), nil
}

func consumeInvite(ctx context.Context, tx *sql.Tx, hash [sha256.Size]byte, userID wire.ID, now time.Time) error {
	result, err := tx.ExecContext(ctx, `
		UPDATE invites SET consumed_at = ? WHERE token_hash = ? AND user_id = ?
		AND expires_at > ? AND consumed_at IS NULL AND revoked_at IS NULL`,
		now, hash[:], userID[:], now)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return wire.E("UNAUTH", false)
	}
	return nil
}

func denyMissing(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return wire.E("UNAUTH", false)
	}
	return err
}

func auditSuccess(ctx context.Context, tx *sql.Tx, userID wire.ID, action, result string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO audit_events (actor_id, action, target_id, result)
		VALUES (?, ?, ?, ?)`, userID[:], action, userID[:], result)
	return err
}
