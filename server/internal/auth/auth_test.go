package auth

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"sft/internal/wire"
)

func TestChallengeIsConnectionBoundAndSingleUse(t *testing.T) {
	state, other := &State{}, &State{}
	now := time.Now()
	challenge, err := state.begin(pendingChallenge{
		kind: login, account: wire.ID{1}, data: &webauthn.SessionData{Expires: now.Add(time.Minute)},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.consume(login, challenge.ChallengeID, now); err == nil {
		t.Fatal("challenge accepted on another connection")
	}
	if _, err := state.consume(enrollment, challenge.ChallengeID, now); err == nil {
		t.Fatal("login challenge accepted as enrollment")
	}
	if _, err := state.consume(login, challenge.ChallengeID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := state.consume(login, challenge.ChallengeID, now); err == nil {
		t.Fatal("challenge replay accepted")
	}
}

func TestExpiredChallengeAndAccountSwitchAreRejected(t *testing.T) {
	state := &State{}
	now := time.Now()
	owner := wire.ID{1}
	challenge, err := state.begin(pendingChallenge{
		kind: enrollment, account: owner, data: &webauthn.SessionData{Expires: now},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := state.consume(enrollment, challenge.ChallengeID, now); err == nil {
		t.Fatal("expired challenge accepted")
	}
	hash := sha256.Sum256([]byte("test"))
	if err := state.bind(owner, hash); err != nil {
		t.Fatal(err)
	}
	state.clear(hash)
	if err := state.bind(wire.ID{2}, hash); err == nil {
		t.Fatal("socket reused across accounts")
	}
}

func TestSecretUsesCanonicalBase64URL(t *testing.T) {
	token, expected := newSecret()
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != 32 || sha256.Sum256(decoded) != expected {
		t.Fatal("token is not raw base64url of a 32-byte secret")
	}
	got, err := parseSecret(token)
	if err != nil || got != expected {
		t.Fatal("canonical token rejected")
	}
	if _, err := parseSecret(token + "="); err == nil {
		t.Fatal("padded token accepted")
	}
}

func TestWebAuthnOptionsMatchFrontend(t *testing.T) {
	service, err := New(&sql.DB{}, "localhost", []string{"http://localhost:5173"})
	if err != nil {
		t.Fatal(err)
	}
	options, session, err := service.method.BeginRegistration(account{ID: wire.ID{1}, Username: "alice"},
		webauthn.WithRegistrationOrigin("http://localhost:5173"))
	if err != nil {
		t.Fatal(err)
	}
	if session.Origin != "http://localhost:5173" || session.UserVerification != protocol.VerificationRequired || options.Response.Timeout != 120000 {
		t.Fatal("registration options do not enforce the expected origin, verification and timeout")
	}
	if _, err := New(&sql.DB{}, "example.com", []string{"http://example.com"}); err == nil {
		t.Fatal("public plaintext frontend accepted")
	}
}
