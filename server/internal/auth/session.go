package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"time"

	"sft/internal/wire"
)

func (s *Service) Attach(ctx context.Context, state *State, token string) (Identity, error) {
	hash, err := parseSecret(token)
	if err != nil {
		return Identity{}, err
	}
	identity, err := s.checkSession(ctx, hash, true)
	if err != nil {
		return Identity{}, err
	}
	if err := state.bind(identity.UserID, hash); err != nil {
		return Identity{}, err
	}
	identity.Token = token
	return identity, nil
}

// Check reads the authorization state of the currently bound session. Only
// authenticated user activity should pass touch=true.
func (s *Service) Check(ctx context.Context, state *State, touch bool) (Identity, error) {
	hash, active := state.tokenHash()
	if !active {
		return Identity{}, wire.E("UNAUTH", false)
	}
	return s.checkSession(ctx, hash, touch)
}

// CheckToken validates a captured session for a queued outgoing message.
// The current connection state and the idle deadline are left alone.
func (s *Service) CheckToken(ctx context.Context, token string) (Identity, error) {
	hash, err := parseSecret(token)
	if err != nil {
		return Identity{}, err
	}
	return s.checkSession(ctx, hash, false)
}

func (s *Service) Logout(ctx context.Context, state *State) error {
	hash, active := state.tokenHash()
	if active {
		if _, err := s.db.ExecContext(ctx, `
			UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
			time.Now().UTC(), hash[:]); err != nil {
			return err
		}
	}
	state.clear(hash)
	return nil
}

// Prune removes expired bearer and invitation records in bounded batches.
// Security events have independent retention in the audit table.
func (s *Service) Prune(ctx context.Context) error {
	cutoff := time.Now().UTC().Add(-24 * time.Hour)
	_, sessionsErr := s.db.ExecContext(ctx,
		`DELETE FROM sessions WHERE expires_at < ? ORDER BY expires_at LIMIT 1000`, cutoff)
	_, invitesErr := s.db.ExecContext(ctx,
		`DELETE FROM invites WHERE expires_at < ? ORDER BY expires_at LIMIT 1000`, cutoff)
	return errors.Join(sessionsErr, invitesErr)
}

func (s *Service) checkSession(ctx context.Context, hash [sha256.Size]byte, touch bool) (Identity, error) {
	now := time.Now().UTC()
	var id []byte
	var identity Identity
	var expires time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT u.id, u.role, u.permissions, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		JOIN credentials c ON c.credential_id = s.credential_id AND c.user_id = s.user_id
		WHERE s.token_hash = ? AND u.enabled = 1 AND c.revoked_at IS NULL
		AND s.revoked_at IS NULL AND s.idle_until > ? AND s.expires_at > ?`,
		hash[:], now, now).Scan(&id, &identity.Role, &identity.Permissions, &expires)
	if err != nil {
		return Identity{}, denyMissing(err)
	}
	if len(id) != len(identity.UserID) {
		return Identity{}, errors.New("invalid session account ID in database")
	}
	identity.UserID = wire.ID(id)
	if touch {
		idleUntil := now.Add(idleTTL)
		if expires.Before(idleUntil) {
			idleUntil = expires
		}
		_, err = s.db.ExecContext(ctx, `
			UPDATE sessions SET idle_until = GREATEST(idle_until, ?)
			WHERE token_hash = ? AND revoked_at IS NULL AND idle_until > ? AND expires_at > ?`,
			idleUntil, hash[:], now, now)
		if err != nil {
			return Identity{}, err
		}
	}
	return identity, nil
}

func saveSession(ctx context.Context, tx *sql.Tx, hash [sha256.Size]byte, userID wire.ID, credentialID []byte, now time.Time) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, credential_id, created_at, idle_until, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)`, hash[:], userID[:], credentialID, now, now.Add(idleTTL), now.Add(sessionTTL))
	return err
}

func (s *State) bind(id wire.ID, hash [sha256.Size]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.account != (wire.ID{}) && s.account != id {
		return wire.E("UNAUTH", false)
	}
	s.account = id
	s.session = hash
	s.active = true
	s.pending = nil
	return nil
}

func (s *State) tokenHash() ([sha256.Size]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.session, s.active
}

func (s *State) clear(hash [sha256.Size]byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == hash {
		s.session = [sha256.Size]byte{}
		s.active = false
		s.pending = nil
	}
}
