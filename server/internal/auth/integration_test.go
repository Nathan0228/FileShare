package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"

	"sft/internal/store"
	"sft/internal/wire"
)

func TestPasskeyAndResumeAgainstDatabase(t *testing.T) {
	dsn := os.Getenv("SFT_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("SFT_AUTH_TEST_DSN points to a disposable database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	uid, err := wire.NewID()
	if err != nil {
		t.Fatal(err)
	}
	username := "test-" + uid.String()
	if _, err := db.DB.ExecContext(ctx, `INSERT INTO users (id, username, role, permissions) VALUES (?, ?, 'user', 7)`, uid[:], username); err != nil {
		t.Fatal(err)
	}
	invite, inviteHash := newSecret()
	if _, err := db.DB.ExecContext(ctx, `INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		inviteHash[:], uid[:], time.Now().UTC().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	const rpID = "localhost"
	const origin = "http://localhost:5173"
	service, err := New(db.DB, rpID, []string{origin})
	if err != nil {
		t.Fatal(err)
	}
	connection := &State{Origin: origin}
	registration, err := service.EnrollBegin(ctx, connection, invite)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credentialID := make([]byte, 32)
	rand.Read(credentialID)
	credentialText := base64.RawURLEncoding.EncodeToString(credentialID)
	creation := registration.Options.(protocol.PublicKeyCredentialCreationOptions)
	creationClientData := testJSON(t, map[string]any{"type": "webauthn.create", "challenge": creation.Challenge.String(), "origin": origin})
	coseKey, err := webauthncbor.Marshal(map[int]any{
		1: 2, 3: -7, -1: 1, -2: key.X.FillBytes(make([]byte, 32)), -3: key.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}
	registrationData := append(testAuthenticatorData(rpID, 0x45, 0), make([]byte, 16)...)
	registrationData = binary.BigEndian.AppendUint16(registrationData, uint16(len(credentialID)))
	registrationData = append(registrationData, credentialID...)
	registrationData = append(registrationData, coseKey...)
	attestation, err := webauthncbor.Marshal(map[string]any{
		"fmt": "none", "authData": registrationData, "attStmt": map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	registrationReply := testCredential(t, credentialText, map[string]string{
		"clientDataJSON":    base64.RawURLEncoding.EncodeToString(creationClientData),
		"attestationObject": base64.RawURLEncoding.EncodeToString(attestation),
	})
	if err := service.EnrollFinish(ctx, connection, registration.ChallengeID, registrationReply); err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnrollBegin(ctx, &State{Origin: origin}, invite); err == nil {
		t.Fatal("registration invitation accepted twice")
	}
	challenge, err := service.LoginBegin(ctx, connection, username)
	if err != nil {
		t.Fatal(err)
	}
	request := challenge.Options.(protocol.PublicKeyCredentialRequestOptions)
	clientData := testJSON(t, map[string]any{"type": "webauthn.get", "challenge": request.Challenge.String(), "origin": origin})
	data := testAuthenticatorData(rpID, 0x05, 1)
	clientDigest := sha256.Sum256(clientData)
	signedDigest := sha256.Sum256(append(data, clientDigest[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, key, signedDigest[:])
	if err != nil {
		t.Fatal(err)
	}
	assertion := testCredential(t, credentialText, map[string]string{
		"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
		"authenticatorData": base64.RawURLEncoding.EncodeToString(data),
		"signature":         base64.RawURLEncoding.EncodeToString(signature),
		"userHandle":        base64.RawURLEncoding.EncodeToString(uid[:]),
	})
	identity, err := service.LoginFinish(ctx, connection, challenge.ChallengeID, assertion)
	if err != nil || identity.UserID != uid || identity.Token == "" || identity.Permissions != 7 {
		t.Fatalf("valid assertion failed to establish a session: %v", err)
	}
	resumed := &State{Origin: origin}
	if identity, err := service.Attach(ctx, resumed, identity.Token); err != nil || identity.UserID != uid {
		t.Fatalf("valid session failed to resume: %v", err)
	}
	if _, err := db.DB.ExecContext(ctx, `UPDATE credentials SET revoked_at = UTC_TIMESTAMP(6) WHERE credential_id = ?`, credentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(ctx, resumed, false); err == nil {
		t.Fatal("revoked credential retained access")
	}
}

func testAuthenticatorData(rpID string, flags byte, counter uint32) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	data := append(rpHash[:], flags)
	return binary.BigEndian.AppendUint32(data, counter)
}

func testCredential(t *testing.T, credentialID string, response map[string]string) json.RawMessage {
	t.Helper()
	return testJSON(t, map[string]any{
		"id": credentialID, "rawId": credentialID, "type": "public-key", "response": response,
		"clientExtensionResults": map[string]any{},
	})
}

func testJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
