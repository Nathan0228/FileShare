package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"

	"sft/internal/wire"
)

const pageItemLimit = 20
const pageByteLimit = 16 * 1024

type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

func (s *Store) cursorMAC(actor wire.ID, scope string, boundary []byte) []byte {
	mac := hmac.New(sha256.New, s.cursorKey[:])
	mac.Write(actor[:])
	mac.Write([]byte(scope))
	mac.Write([]byte{0})
	mac.Write(boundary)
	return mac.Sum(nil)
}

func (s *Store) makeCursor(actor wire.ID, scope string, boundary []byte) string {
	token := make([]byte, 0, len(boundary)+sha256.Size)
	token = append(token, boundary...)
	token = append(token, s.cursorMAC(actor, scope, boundary)...)
	return base64.RawURLEncoding.EncodeToString(token)
}

func (s *Store) readCursor(actor wire.ID, scope string, cursor *string, minSize, maxSize int) ([]byte, error) {
	if cursor == nil {
		return []byte{}, nil
	}
	if len(*cursor) > base64.RawURLEncoding.EncodedLen(maxSize+sha256.Size) {
		return nil, wire.E("BAD_REQUEST", false)
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(*cursor)
	if err != nil || len(raw) < minSize+sha256.Size || len(raw) > maxSize+sha256.Size {
		return nil, wire.E("BAD_REQUEST", false)
	}
	end := len(raw) - sha256.Size
	boundary := raw[:end]
	if !hmac.Equal(raw[end:], s.cursorMAC(actor, scope, boundary)) {
		return nil, wire.E("BAD_REQUEST", false)
	}
	return boundary, nil
}

func readPage[T any](
	ctx context.Context, s *Store, actor wire.ID, scope, query string,
	scan func(*sql.Rows) (T, []byte, error), args ...any,
) (Page[T], error) {
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return Page[T]{}, err
	}
	defer rows.Close()

	page := Page[T]{Items: make([]T, 0, pageItemLimit)}
	var last []byte
	for rows.Next() {
		if len(page.Items) == pageItemLimit {
			cursor := s.makeCursor(actor, scope, last)
			page.NextCursor = &cursor
			break
		}
		item, boundary, err := scan(rows)
		if err != nil {
			return Page[T]{}, err
		}
		page.Items = append(page.Items, item)
		cursor := s.makeCursor(actor, scope, boundary)
		page.NextCursor = &cursor
		encoded, err := json.Marshal(page)
		if err != nil {
			return Page[T]{}, err
		}
		if len(encoded) > pageByteLimit {
			page.Items = page.Items[:len(page.Items)-1]
			if len(page.Items) == 0 {
				return Page[T]{}, wire.E("STORAGE_UNAVAILABLE", true)
			}
			cursor := s.makeCursor(actor, scope, last)
			page.NextCursor = &cursor
			break
		}
		page.NextCursor = nil
		last = boundary
	}
	return page, rows.Err()
}
