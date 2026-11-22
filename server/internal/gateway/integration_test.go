package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"sft/internal/auth"
	"sft/internal/store"
	"sft/internal/transfer"
	"sft/internal/wire"

	"github.com/gorilla/websocket"
)

func TestWebSocketResumeAndRevocation(t *testing.T) {
	dsn := os.Getenv("SFT_GATEWAY_TEST_DSN")
	if dsn == "" {
		t.Skip("set SFT_GATEWAY_TEST_DSN to an isolated test database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	owner, ownerToken := seedSession(t, ctx, db)
	grantee, granteeToken := seedSession(t, ctx, db)
	const origin = "http://localhost:5173"
	login, err := auth.New(db.DB, "localhost", []string{origin})
	if err != nil {
		t.Fatal(err)
	}
	files, err := transfer.New(db.DB, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := New(ctx, db, login, files, origin, false)
	server := httptest.NewServer(g.Handler())
	defer func() {
		cancel()
		server.Close()
		g.Wait()
	}()
	socketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/sft"
	dialer := websocket.Dialer{HandshakeTimeout: 3 * time.Second, Subprotocols: []string{wire.Subprotocol}}
	bad, resp, err := dialer.Dial(socketURL, http.Header{"Origin": {"https://untrusted.example"}})
	if bad != nil {
		bad.Close()
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong Origin should receive 403, got %#v, %v", resp, err)
	}
	resp.Body.Close()

	connect := func() *testConn {
		ws, _, err := dialer.Dial(socketURL, http.Header{"Origin": {origin}})
		if err != nil {
			t.Fatal(err)
		}
		if ws.Subprotocol() != wire.Subprotocol {
			t.Fatalf("negotiated %q", ws.Subprotocol())
		}
		t.Cleanup(func() { _ = ws.Close() })
		return &testConn{t: t, ws: ws}
	}
	up := connect()
	request := up.request(wire.List, wire.ID{}, wire.NoChunk, map[string]string{"scope": "owned"})
	assertCode(t, request, "UNAUTH")
	assertCode(t, up.request(wire.UserProfile, wire.ID{}, wire.NoChunk, nil), "UNAUTH")
	assertCode(t, up.request(wire.OutgoingShares, wire.ID{}, wire.NoChunk, map[string]string{"view": "active"}), "UNAUTH")
	up.attach(ownerToken)
	self := up.request(wire.UserProfile, wire.ID{}, wire.NoChunk, nil)
	assertKind(t, self, wire.UserProfileOK)
	var profile store.UserProfile
	if err := json.Unmarshal(self.Body, &profile); err != nil {
		t.Fatal(err)
	}
	if profile.Username != owner || profile.UserID != strings.TrimPrefix(owner, "gateway-") ||
		profile.Role != "user" || profile.Quota != 104857600 || profile.Used != 0 || profile.Reserved != 0 ||
		strings.Join(profile.Permissions, ",") != "UPLOAD,DOWNLOAD,SHARE" {
		t.Fatalf("unexpected current user profile: %s", self.Body)
	}
	assertCode(t, up.request(wire.UserProfile, wire.ID{}, wire.NoChunk, map[string]string{"username": grantee}), "BAD_REQUEST")
	assertCode(t, up.request(wire.List, wire.ID{}, wire.NoChunk, map[string]string{"Scope": "owned"}), "BAD_REQUEST")
	newUser := "new-" + grantee
	create := map[string]any{"action": "create", "username": newUser}
	assertCode(t, up.request(wire.Admin, wire.ID{}, wire.NoChunk, create), "DENIED")
	search := map[string]string{"action": "users", "role": "user", "search": strings.ToUpper(newUser)}
	assertCode(t, up.request(wire.Admin, wire.ID{}, wire.NoChunk, search), "DENIED")
	adminName, adminToken := seedSession(t, ctx, db)
	if _, err := db.DB.ExecContext(ctx, "UPDATE users SET role='admin' WHERE username=?", adminName); err != nil {
		t.Fatal(err)
	}
	admin := connect()
	admin.attach(adminToken)
	assertKind(t, admin.request(wire.Admin, wire.ID{}, wire.NoChunk, create), wire.OK)
	assertKind(t, admin.request(wire.Admin, wire.ID{}, wire.NoChunk, map[string]any{
		"action": "setAccess", "username": newUser, "enabled": true,
		"permissions": []string{"DOWNLOAD"}, "quotaBytes": 2 * wire.ChunkBytes,
	}), wire.OK)
	users := admin.request(wire.Admin, wire.ID{}, wire.NoChunk, search)
	assertKind(t, users, wire.OK)
	var userPage store.Page[struct {
		store.UserProfile
		CreatedAt time.Time `json:"createdAt"`
	}]
	if err := json.Unmarshal(users.Body, &userPage); err != nil || len(userPage.Items) != 1 ||
		userPage.Items[0].Username != newUser || userPage.Items[0].Role != "user" ||
		userPage.Items[0].CreatedAt.IsZero() || userPage.NextCursor != nil {
		t.Fatalf("unexpected filtered user page: %s (%v)", users.Body, err)
	}
	search["search"] = adminName
	users = admin.request(wire.Admin, wire.ID{}, wire.NoChunk, search)
	assertKind(t, users, wire.OK)
	if err := json.Unmarshal(users.Body, &userPage); err != nil || len(userPage.Items) != 0 {
		t.Fatalf("ordinary-user filter returned an administrator: %s (%v)", users.Body, err)
	}
	invitation := admin.request(wire.Admin, wire.ID{}, wire.NoChunk, map[string]any{"action": "invite", "username": newUser})
	assertKind(t, invitation, wire.OK)
	var invite struct{ InviteToken string }
	if err := json.Unmarshal(invitation.Body, &invite); err != nil || len(invite.InviteToken) != 43 {
		t.Fatal("invalid registration invitation")
	}
	admin.ws.Close()

	first := bytes.Repeat([]byte{0x42}, wire.ChunkBytes)
	second := bytes.Repeat([]byte{0x95}, wire.ChunkBytes)
	last := bytes.Repeat([]byte{0xa6}, 88*1024)
	whole := bytes.Join([][]byte{first, second, last}, nil)
	digest := sha256.Sum256(whole)
	opID, err := wire.NewID()
	if err != nil {
		t.Fatal(err)
	}
	upload := up.request(wire.PutBegin, wire.ID{}, wire.NoChunk,
		map[string]any{"opId": opID, "name": "resume.bin", "size": len(whole), "sha256": hex.EncodeToString(digest[:])})
	assertKind(t, upload, wire.PutReady)
	left := up.send(wire.PutData, upload.TransferID, 0, chunkBody(first))
	right := up.send(wire.PutData, upload.TransferID, 2, chunkBody(last))
	for range 2 {
		ack := up.read()
		assertKind(t, ack, wire.OK)
		switch ack.RequestID {
		case left:
			if ack.ChunkIndex != 0 {
				t.Fatalf("wrong first ACK index: %d", ack.ChunkIndex)
			}
			left = 0
		case right:
			if ack.ChunkIndex != 2 {
				t.Fatalf("wrong last ACK index: %d", ack.ChunkIndex)
			}
			right = 0
		default:
			t.Fatalf("unexpected ACK ID %d", ack.RequestID)
		}
	}
	up.ws.Close()
	up = connect()
	up.attach(ownerToken)
	var status wire.Message
	for range 10 {
		status = up.request(wire.PutStatus, upload.TransferID, wire.NoChunk, nil)
		if status.Kind != wire.Err {
			break
		}
		assertCode(t, status, "BUSY")
		time.Sleep(40 * time.Millisecond)
	}
	assertKind(t, status, wire.PutState)
	var state struct{ Bitmap string }
	if err := json.Unmarshal(status.Body, &state); err != nil || state.Bitmap != "BQ" {
		t.Fatalf("resume expected indexes 0 and 2, got %s: %v", status.Body, err)
	}
	assertKind(t, up.request(wire.PutData, upload.TransferID, 1, chunkBody(second)), wire.OK)
	commit := up.request(wire.PutCommit, upload.TransferID, wire.NoChunk, nil)
	assertKind(t, commit, wire.PutDone)
	var done struct{ FileID wire.ID }
	if err := json.Unmarshal(commit.Body, &done); err != nil || done.FileID == (wire.ID{}) {
		t.Fatalf("bad PUT_DONE %s: %v", commit.Body, err)
	}
	listed := up.request(wire.List, wire.ID{}, wire.NoChunk, map[string]string{"scope": "owned"})
	assertKind(t, listed, wire.ListOK)
	var ownedPage store.FilePage
	if err := json.Unmarshal(listed.Body, &ownedPage); err != nil || len(ownedPage.Items) != 1 ||
		ownedPage.Items[0].Owner != owner || ownedPage.Items[0].FileID != done.FileID.String() ||
		ownedPage.Items[0].CreatedAt.IsZero() || ownedPage.Items[0].SharedAt != nil {
		t.Fatalf("unexpected owned LIST: %s (%v)", listed.Body, err)
	}
	assertMixedTransfers(t, up, done.FileID)

	down := connect()
	down.attach(granteeToken)
	file := map[string]wire.ID{"fileId": done.FileID}
	assertCode(t, down.request(wire.GetBegin, wire.ID{}, wire.NoChunk, file), "DENIED")
	share := map[string]any{"fileId": done.FileID, "grantee": grantee, "allow": true}
	assertKind(t, up.request(wire.ShareSet, wire.ID{}, wire.NoChunk, share), wire.OK)
	grant := store.OutgoingShare{FileID: done.FileID.String(), Name: "resume.bin", Grantee: grantee, Action: "grant"}
	assertOutgoingShares(t, up, "active", grant)
	assertOutgoingShares(t, up, "history", grant)
	assertOutgoingShares(t, down, "active")
	assertOutgoingShares(t, down, "history")
	shared := down.request(wire.List, wire.ID{}, wire.NoChunk, map[string]string{"scope": "shared"})
	assertKind(t, shared, wire.ListOK)
	var sharedPage store.FilePage
	if err := json.Unmarshal(shared.Body, &sharedPage); err != nil || len(sharedPage.Items) != 1 ||
		sharedPage.Items[0].FileID != done.FileID.String() || sharedPage.Items[0].SharedAt == nil ||
		!sharedPage.Items[0].CreatedAt.Equal(ownedPage.Items[0].CreatedAt) ||
		!sharedPage.Items[0].SharedAt.After(sharedPage.Items[0].CreatedAt) {
		t.Fatalf("unexpected shared LIST: %s (%v)", shared.Body, err)
	}
	ready := down.request(wire.GetBegin, wire.ID{}, wire.NoChunk, file)
	assertKind(t, ready, wire.GetReady)
	part := down.request(wire.GetChunk, ready.TransferID, 1, nil)
	assertKind(t, part, wire.GetData)
	if !bytes.Equal(part.Body, chunkBody(second)) {
		t.Fatal("downloaded chunk or digest differs")
	}
	share["allow"] = false
	assertKind(t, up.request(wire.ShareSet, wire.ID{}, wire.NoChunk, share), wire.OK)
	revoke := grant
	revoke.Action = "revoke"
	assertOutgoingShares(t, up, "active")
	assertOutgoingShares(t, up, "history", revoke, grant)
	assertCode(t, down.request(wire.GetChunk, ready.TransferID, 2, nil), "DENIED")
	assertKind(t, up.request(wire.FileDelete, wire.ID{}, wire.NoChunk, file), wire.OK)
	revoke.Deleted = true
	grant.Deleted = true
	assertOutgoingShares(t, up, "active")
	assertOutgoingShares(t, up, "history", revoke, grant)
	assertKind(t, up.request(wire.Logout, wire.ID{}, wire.NoChunk, nil), wire.OK)
	assertCode(t, connect().request(wire.SessionAttach, wire.ID{}, wire.NoChunk, map[string]string{"token": ownerToken}), "UNAUTH")
}

func assertOutgoingShares(t *testing.T, conn *testConn, view string, want ...store.OutgoingShare) {
	t.Helper()
	reply := conn.request(wire.OutgoingShares, wire.ID{}, wire.NoChunk, map[string]string{"view": view})
	assertKind(t, reply, wire.OutgoingSharesOK)
	var page store.Page[store.OutgoingShare]
	if err := json.Unmarshal(reply.Body, &page); err != nil || len(page.Items) != len(want) || page.NextCursor != nil {
		t.Fatalf("unexpected %s share page: %s (%v)", view, reply.Body, err)
	}
	for i, expected := range want {
		item := page.Items[i]
		if item.CreatedAt.IsZero() || item.FileID != expected.FileID || item.Name != expected.Name ||
			item.Grantee != expected.Grantee || item.Action != expected.Action || item.Deleted != expected.Deleted {
			t.Fatalf("unexpected %s share item: %+v (expected %+v)", view, item, expected)
		}
	}
}

func assertMixedTransfers(t *testing.T, conn *testConn, firstFile wire.ID) {
	t.Helper()
	sample := []byte("second test file")
	makeUpload := func(name string) wire.Message {
		op, err := wire.NewID()
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(sample)
		ready := conn.request(wire.PutBegin, wire.ID{}, wire.NoChunk,
			map[string]any{"opId": op, "name": name, "size": len(sample), "sha256": hex.EncodeToString(digest[:])})
		assertKind(t, ready, wire.PutReady)
		return ready
	}
	second := makeUpload("second.bin")
	assertKind(t, conn.request(wire.PutData, second.TransferID, 0, chunkBody(sample)), wire.OK)
	finished := conn.request(wire.PutCommit, second.TransferID, wire.NoChunk, nil)
	assertKind(t, finished, wire.PutDone)
	var published struct{ FileID wire.ID }
	if err := json.Unmarshal(finished.Body, &published); err != nil || published.FileID == (wire.ID{}) {
		t.Fatalf("invalid second file ID: %s (%v)", finished.Body, err)
	}
	getA := conn.request(wire.GetBegin, wire.ID{}, wire.NoChunk, map[string]wire.ID{"fileId": firstFile})
	getB := conn.request(wire.GetBegin, wire.ID{}, wire.NoChunk, map[string]wire.ID{"fileId": published.FileID})
	assertKind(t, getA, wire.GetReady)
	assertKind(t, getB, wire.GetReady)
	putA, putB := makeUpload("third.bin"), makeUpload("fourth.bin")
	want := map[uint32]wire.Kind{
		conn.send(wire.GetChunk, getA.TransferID, 0, nil):              wire.GetData,
		conn.send(wire.PutData, putA.TransferID, 0, chunkBody(sample)): wire.OK,
		conn.send(wire.GetChunk, getB.TransferID, 0, nil):              wire.GetData,
		conn.send(wire.PutData, putB.TransferID, 0, chunkBody(sample)): wire.OK,
	}
	for range 4 {
		reply := conn.read()
		expected, ok := want[reply.RequestID]
		if !ok {
			t.Fatalf("unknown response id %d", reply.RequestID)
		}
		assertKind(t, reply, expected)
		delete(want, reply.RequestID)
	}
	for _, id := range []wire.ID{putA.TransferID, putB.TransferID} {
		assertKind(t, conn.request(wire.PutCancel, id, wire.NoChunk, nil), wire.OK)
	}
	for _, id := range []wire.ID{getA.TransferID, getB.TransferID} {
		assertKind(t, conn.request(wire.GetClose, id, wire.NoChunk, nil), wire.OK)
	}
}

type testConn struct {
	t    *testing.T
	ws   *websocket.Conn
	next uint32
}

func (c *testConn) send(kind wire.Kind, id wire.ID, chunk uint32, data any) uint32 {
	c.t.Helper()
	body, ok := data.([]byte)
	if !ok && data != nil {
		var err error
		body, err = json.Marshal(data)
		if err != nil {
			c.t.Fatal(err)
		}
	}
	c.next++
	m := wire.Message{Kind: kind, RequestID: c.next, TransferID: id, ChunkIndex: chunk, Body: body}
	_ = c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.ws.WriteMessage(websocket.BinaryMessage, m.Encode()); err != nil {
		c.t.Fatal(err)
	}
	return c.next
}

func (c *testConn) read() wire.Message {
	c.t.Helper()
	_ = c.ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := c.ws.ReadMessage()
	if err != nil {
		c.t.Fatal(err)
	}
	m, err := wire.Decode(data)
	if err != nil {
		c.t.Fatal(err)
	}
	return m
}

func (c *testConn) request(kind wire.Kind, id wire.ID, chunk uint32, data any) wire.Message {
	c.t.Helper()
	request := c.send(kind, id, chunk, data)
	reply := c.read()
	if request != reply.RequestID {
		c.t.Fatalf("request %d got response %d", request, reply.RequestID)
	}
	return reply
}

func (c *testConn) attach(token string) {
	c.t.Helper()
	assertKind(c.t, c.request(wire.SessionAttach, wire.ID{}, wire.NoChunk, map[string]string{"token": token}), wire.AuthOK)
}

func chunkBody(data []byte) []byte {
	digest := sha256.Sum256(data)
	return append(digest[:], data...)
}

func assertKind(t *testing.T, reply wire.Message, kind wire.Kind) {
	t.Helper()
	if reply.Kind != kind {
		t.Fatalf("expected type %02x, got %02x %s", byte(kind), byte(reply.Kind), reply.Body)
	}
}

func assertCode(t *testing.T, reply wire.Message, code string) {
	t.Helper()
	assertKind(t, reply, wire.Err)
	var e wire.ProtocolError
	if err := json.Unmarshal(reply.Body, &e); err != nil || e.Code != code {
		t.Fatalf("want %q, got %s: %v", code, reply.Body, err)
	}
}

// WebAuthn signatures are verified by auth's integration test. This fixture
// provides fresh, isolated sessions for testing the socket's resume and ACL flow.
func seedSession(t *testing.T, ctx context.Context, db *store.Store) (string, string) {
	t.Helper()
	id, err := wire.NewID()
	if err != nil {
		t.Fatal(err)
	}
	cred, err := wire.NewID()
	if err != nil {
		t.Fatal(err)
	}
	username := "gateway-" + id.String()
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(token[:])
	if _, err := db.DB.ExecContext(ctx, `INSERT INTO users (id,username,role,enabled,permissions,quota_bytes) VALUES (?,?,'user',1,7,104857600)`, id[:], username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DB.ExecContext(ctx, `INSERT INTO credentials (credential_id,user_id,public_key_cose,credential_json) VALUES (?,?,?,'{}')`, cred[:], id[:], []byte{1}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DB.ExecContext(ctx, `INSERT INTO sessions (token_hash,user_id,credential_id,idle_until,expires_at) VALUES (?,?,?,UTC_TIMESTAMP(6) + INTERVAL 30 MINUTE,UTC_TIMESTAMP(6) + INTERVAL 8 HOUR)`, digest[:], id[:], cred[:]); err != nil {
		t.Fatal(err)
	}
	return username, base64.RawURLEncoding.EncodeToString(token[:])
}
