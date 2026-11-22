package store

import (
	"context"
	"database/sql"
	"strings"
	"unicode"
	"unicode/utf8"

	"sft/internal/wire"
)

type Friend struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Note     string `json:"note"`
	Enabled  bool   `json:"enabled"`
}

func (s *Store) Friends(ctx context.Context, actor wire.ID, cursor *string) (Page[Friend], error) {
	const scope = "friends"
	boundary, err := s.readCursor(actor, scope, cursor, 1, 64)
	if err != nil {
		return Page[Friend]{}, err
	}
	const query = `SELECT friend.id, friend.username, COALESCE(note.note, ''), friend.enabled
		FROM share_contacts sent
		JOIN share_contacts received ON received.sender_id=sent.recipient_id AND received.recipient_id=sent.sender_id
		JOIN users friend ON friend.id=sent.recipient_id
		JOIN users actor ON actor.id=sent.sender_id AND actor.enabled=TRUE
		LEFT JOIN friend_notes note ON note.user_id=sent.sender_id AND note.friend_id=friend.id
		WHERE sent.sender_id=? AND friend.username>?
		ORDER BY friend.username LIMIT 21`
	return readPage(ctx, s, actor, scope, query, func(rows *sql.Rows) (Friend, []byte, error) {
		var friend Friend
		var id []byte
		if err := rows.Scan(&id, &friend.Username, &friend.Note, &friend.Enabled); err != nil {
			return Friend{}, nil, err
		}
		friend.UserID = wire.ID(id).String()
		return friend, []byte(friend.Username), nil
	}, actor[:], string(boundary))
}

func (s *Store) SetFriendNote(ctx context.Context, actor, friend wire.ID, note string) error {
	note = strings.TrimSpace(note)
	if actor == friend || utf8.RuneCountInString(note) > 80 || strings.ContainsFunc(note, unicode.IsControl) {
		return wire.E("BAD_REQUEST", false)
	}
	var mutual bool
	if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM share_contacts sent
		JOIN share_contacts received ON received.sender_id=sent.recipient_id AND received.recipient_id=sent.sender_id
		WHERE sent.sender_id=? AND sent.recipient_id=?)`, actor[:], friend[:]).Scan(&mutual); err != nil {
		return err
	}
	if !mutual {
		return wire.E("DENIED", false)
	}
	if note == "" {
		_, err := s.DB.ExecContext(ctx, "DELETE FROM friend_notes WHERE user_id=? AND friend_id=?", actor[:], friend[:])
		return err
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO friend_notes (user_id, friend_id, note)
		VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE note=?`, actor[:], friend[:], note, note)
	return err
}
