package wire

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

const (
	Subprotocol = "sft.v1"
	HeaderSize  = 32
	MaxControl  = 16 * 1024
	ChunkBytes  = 256 * 1024
	DigestSize  = 32
	MaxMessage  = HeaderSize + DigestSize + ChunkBytes
	NoChunk     = ^uint32(0)
)

type Kind byte

const (
	EnrollBegin   Kind = 0x01
	Challenge     Kind = 0x02
	EnrollFinish  Kind = 0x03
	AuthBegin     Kind = 0x04
	AuthFinish    Kind = 0x05
	AuthOK        Kind = 0x06
	SessionAttach Kind = 0x07
	Logout        Kind = 0x08
	List          Kind = 0x10
	ListOK        Kind = 0x11
	ShareSet      Kind = 0x12
	Admin         Kind = 0x13
	FileDelete    Kind = 0x14
	PutBegin      Kind = 0x20
	PutReady      Kind = 0x21
	PutData       Kind = 0x22
	PutStatus     Kind = 0x23
	PutState      Kind = 0x24
	PutCommit     Kind = 0x25
	PutDone       Kind = 0x26
	PutCancel     Kind = 0x27
	PutPause      Kind = 0x28
	GetBegin      Kind = 0x30
	GetReady      Kind = 0x31
	GetChunk      Kind = 0x32
	GetData       Kind = 0x33
	GetDone       Kind = 0x34
	GetClose      Kind = 0x35
	OK            Kind = 0x7d
	Err           Kind = 0x7e
)

type ID [16]byte

func NewID() (ID, error) {
	var id ID
	if _, err := rand.Read(id[:]); err != nil {
		return ID{}, err
	}
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return id, nil
}

func ParseID(text string) (ID, error) {
	var id ID
	if len(text) != 36 || text[8] != '-' || text[13] != '-' || text[18] != '-' || text[23] != '-' {
		return id, E("BAD_REQUEST", false)
	}
	flat := text[:8] + text[9:13] + text[14:18] + text[19:23] + text[24:]
	if _, err := hex.Decode(id[:], []byte(flat)); err != nil || id == (ID{}) || id.String() != text {
		return ID{}, E("BAD_REQUEST", false)
	}
	return id, nil
}

func (id ID) String() string {
	text := hex.EncodeToString(id[:])
	return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

func (id ID) MarshalText() ([]byte, error) { return []byte(id.String()), nil }

func (id *ID) UnmarshalText(data []byte) error {
	parsed, err := ParseID(string(data))
	if err == nil {
		*id = parsed
	}
	return err
}

type ProtocolError struct {
	Code      string `json:"code"`
	Retryable bool   `json:"retryable"`
}

func E(code string, retryable bool) error { return &ProtocolError{code, retryable} }

func (e *ProtocolError) Error() string { return e.Code }

type Message struct {
	Kind       Kind
	RequestID  uint32
	TransferID ID
	ChunkIndex uint32
	Body       []byte
}

func Decode(raw []byte) (Message, error) {
	if len(raw) < HeaderSize || len(raw) > MaxMessage || raw[0] != 'S' || raw[1] != 'F' || raw[2] != 1 ||
		binary.BigEndian.Uint32(raw[4:8]) != uint32(len(raw)-HeaderSize) {
		return Message{}, errors.New("invalid SFT header")
	}
	m := Message{
		Kind: Kind(raw[3]), RequestID: binary.BigEndian.Uint32(raw[8:12]),
		ChunkIndex: binary.BigEndian.Uint32(raw[28:32]), Body: raw[HeaderSize:],
	}
	copy(m.TransferID[:], raw[12:28])
	return m, nil
}

func (m Message) Encode() []byte {
	// A separate buffer leaves the request payload immutable for asynchronous workers.
	buf := make([]byte, HeaderSize+len(m.Body))
	buf[0], buf[1], buf[2], buf[3] = 'S', 'F', 1, byte(m.Kind)
	binary.BigEndian.PutUint32(buf[4:8], uint32(len(m.Body)))
	binary.BigEndian.PutUint32(buf[8:12], m.RequestID)
	copy(buf[12:28], m.TransferID[:])
	binary.BigEndian.PutUint32(buf[28:32], m.ChunkIndex)
	copy(buf[HeaderSize:], m.Body)
	return buf
}

func (m Message) ValidateRequest() error {
	var hasID, hasChunk, data, empty bool
	switch m.Kind {
	case EnrollBegin, EnrollFinish, AuthBegin, AuthFinish, SessionAttach, List, ShareSet, Admin, FileDelete, PutBegin, GetBegin:
	case Logout:
		empty = true
	case PutData:
		hasID, hasChunk, data = true, true, true
	case PutStatus, PutCommit, PutCancel, PutPause, GetClose:
		hasID, empty = true, true
	case GetChunk:
		hasID, hasChunk, empty = true, true, true
	case GetDone:
		hasID = true
	default:
		return E("BAD_REQUEST", false)
	}
	if hasID != (m.TransferID != (ID{})) || hasChunk != (m.ChunkIndex != NoChunk) {
		return E("BAD_REQUEST", false)
	}
	size := len(m.Body)
	if (empty && size != 0) || (data && (size <= DigestSize || size > DigestSize+ChunkBytes)) ||
		(!empty && !data && (size == 0 || size > MaxControl)) {
		return E("BAD_REQUEST", false)
	}
	return nil
}

func (m Message) Reply(kind Kind, body []byte) Message {
	return Message{Kind: kind, RequestID: m.RequestID, TransferID: m.TransferID, ChunkIndex: m.ChunkIndex, Body: body}
}

func JSON(data []byte, dst any) error {
	if !utf8.Valid(data) || len(data) > MaxControl {
		return E("BAD_REQUEST", false)
	}
	scan := json.NewDecoder(bytes.NewReader(data))
	scan.UseNumber()
	root, err := scan.Token()
	if err != nil || root != json.Delim('{') || scanValue(scan, root, 0) != nil {
		return E("BAD_REQUEST", false)
	}
	if _, err := scan.Token(); err != io.EOF {
		return E("BAD_REQUEST", false)
	}
	if !exactFields(data, dst) {
		return E("BAD_REQUEST", false)
	}
	decode := json.NewDecoder(bytes.NewReader(data))
	decode.DisallowUnknownFields()
	if err := decode.Decode(dst); err != nil {
		return E("BAD_REQUEST", false)
	}
	return nil
}

// encoding/json accepts case-insensitive aliases for struct fields by default.
// Require the documented spelling for the top-level protocol object.
func exactFields(data []byte, dst any) bool {
	if dst == nil {
		return false
	}
	typ := reflect.TypeOf(dst)
	if typ.Kind() != reflect.Pointer || typ.Elem().Kind() != reflect.Struct {
		return true
	}
	var provided map[string]json.RawMessage
	if err := json.Unmarshal(data, &provided); err != nil {
		return false
	}
	for _, field := range reflect.VisibleFields(typ.Elem()) {
		if !field.IsExported() || field.Anonymous {
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" {
			name = field.Name
		}
		if name != "-" {
			delete(provided, name)
		}
	}
	return len(provided) == 0
}

// scanValue validates nested duplicate keys before decoding into Go structs.
func scanValue(dec *json.Decoder, token json.Token, depth int) error {
	if depth > 24 {
		return errors.New("JSON nesting too deep")
	}
	switch token {
	case json.Delim('{'):
		keys := make(map[string]struct{})
		for dec.More() {
			k, err := dec.Token()
			key, ok := k.(string)
			if err != nil || !ok {
				return errors.New("invalid JSON object key")
			}
			if _, exists := keys[key]; exists {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			keys[key] = struct{}{}
			if err := scanNext(dec, depth+1); err != nil {
				return err
			}
		}
		_, err := dec.Token()
		return err
	case json.Delim('['):
		for dec.More() {
			if err := scanNext(dec, depth+1); err != nil {
				return err
			}
		}
		_, err := dec.Token()
		return err
	}
	return nil
}

func scanNext(dec *json.Decoder, depth int) error {
	token, err := dec.Token()
	if err != nil {
		return err
	}
	return scanValue(dec, token, depth)
}

func ParseSHA256(text string) ([DigestSize]byte, error) {
	var digest [DigestSize]byte
	if len(text) != 2*DigestSize {
		return digest, E("BAD_REQUEST", false)
	}
	if _, err := hex.Decode(digest[:], []byte(text)); err != nil || hex.EncodeToString(digest[:]) != text {
		return [DigestSize]byte{}, E("BAD_REQUEST", false)
	}
	return digest, nil
}
