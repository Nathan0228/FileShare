// Package auth manages WebAuthn ceremonies and resumable login sessions.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	"github.com/go-webauthn/webauthn/webauthn"

	"sft/internal/store"
	"sft/internal/wire"
)

const (
	challengeTTL   = 120 * time.Second
	sessionTTL     = 8 * time.Hour
	idleTTL        = 30 * time.Minute
	maxCredentials = 8
	secretBytes    = 32
)

type Service struct {
	db      *sql.DB
	method  *webauthn.WebAuthn
	origins []string
}

// State belongs to a single WebSocket. Origin is set once from the validated
// handshake and the state must not be copied after use.
type State struct {
	Origin string

	mu      sync.Mutex
	account wire.ID
	session [sha256.Size]byte
	active  bool
	pending *pendingChallenge
}

type Identity struct {
	UserID      wire.ID
	Role        string
	Permissions uint8
	Token       string
}

type Challenge struct {
	ChallengeID string `json:"challengeId"`
	Options     any    `json:"options"`
}

type ceremony uint8

const (
	enrollment ceremony = iota + 1
	login
)

type pendingChallenge struct {
	id         string
	kind       ceremony
	account    wire.ID
	inviteHash [sha256.Size]byte
	data       *webauthn.SessionData
}

type account struct {
	ID          wire.ID
	Username    string
	Role        string
	Permissions uint8
	Credentials []webauthn.Credential
}

func (a account) WebAuthnID() []byte                         { return a.ID[:] }
func (a account) WebAuthnName() string                       { return a.Username }
func (a account) WebAuthnDisplayName() string                { return a.Username }
func (a account) WebAuthnCredentials() []webauthn.Credential { return a.Credentials }

func New(db *sql.DB, rpID string, origins []string) (*Service, error) {
	if db == nil || rpID == "" || len(origins) == 0 {
		return nil, errors.New("authentication requires a database, RP ID and frontend origin")
	}
	for _, origin := range origins {
		u, err := url.Parse(origin)
		if err != nil || !validOrigin(u, rpID) {
			return nil, fmt.Errorf("invalid frontend origin for WebAuthn RP ID: %q", origin)
		}
	}
	var timeout = webauthn.TimeoutConfig{Enforce: true, Timeout: challengeTTL}
	configuredOrigins := slices.Clone(origins)
	method, err := webauthn.New(&webauthn.Config{
		RPDisplayName:         "Secure File Transfer",
		RPID:                  rpID,
		RPOrigins:             configuredOrigins,
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationRequired,
		},
		Timeouts: webauthn.TimeoutsConfig{Login: timeout, Registration: timeout},
	})
	if err != nil {
		return nil, fmt.Errorf("configure WebAuthn: %w", err)
	}
	return &Service{db: db, method: method, origins: configuredOrigins}, nil
}

func validOrigin(u *url.URL, rpID string) bool {
	if u == nil || u.Opaque != "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return false
	}
	host := u.Hostname()
	if host != rpID {
		return false
	}
	ip := net.ParseIP(host)
	return u.Scheme == "https" || (u.Scheme == "http" && (host == "localhost" || ip.IsLoopback()))
}

func (s *Service) origin(state *State) (string, error) {
	if slices.Contains(s.origins, state.Origin) {
		return state.Origin, nil
	}
	if state.Origin == "" && len(s.origins) == 1 {
		return s.origins[0], nil
	}
	return "", wire.E("UNAUTH", false)
}

func (s *Service) EnrollBegin(ctx context.Context, state *State, inviteToken string) (Challenge, error) {
	hash, err := parseSecret(inviteToken)
	if err != nil {
		return Challenge{}, err
	}
	origin, err := s.origin(state)
	if err != nil {
		return Challenge{}, err
	}
	userID, err := readInvite(ctx, s.db, hash, time.Now().UTC())
	if err != nil {
		return Challenge{}, err
	}
	if err := state.allowAccount(userID); err != nil {
		return Challenge{}, err
	}
	user, err := readAccountByID(ctx, s.db, userID, false)
	if err != nil {
		return Challenge{}, err
	}
	if err := loadCredentials(ctx, s.db, &user); err != nil {
		return Challenge{}, err
	}
	if len(user.Credentials) >= maxCredentials {
		return Challenge{}, wire.E("QUOTA", false)
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(user.Credentials))
	for _, credential := range user.Credentials {
		exclusions = append(exclusions, boundedDescriptor(credential))
	}
	options, data, err := s.method.BeginRegistration(user,
		webauthn.WithRegistrationOrigin(origin),
		webauthn.WithCredentialParameters([]protocol.CredentialParameter{{
			Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgES256,
		}}),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementPreferred),
		webauthn.WithExclusions(exclusions),
	)
	if err != nil {
		return Challenge{}, fmt.Errorf("begin credential enrollment: %w", err)
	}
	return state.begin(pendingChallenge{kind: enrollment, account: userID, inviteHash: hash, data: data}, options.Response)
}

func (s *Service) EnrollFinish(ctx context.Context, state *State, challengeID string, response json.RawMessage) error {
	pending, err := state.consume(enrollment, challengeID, time.Now())
	if err != nil {
		return err
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(response)
	if err != nil {
		return wire.E("UNAUTH", false)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	user, err := readAccountByID(ctx, tx, pending.account, true)
	if err != nil {
		return err
	}
	if err := loadCredentials(ctx, tx, &user); err != nil {
		return err
	}
	if len(user.Credentials) >= maxCredentials {
		return wire.E("QUOTA", false)
	}
	credential, err := s.method.CreateCredential(user, *pending.data, parsed)
	if err != nil || len(credential.ID) == 0 || len(credential.ID) > 1023 {
		return wire.E("UNAUTH", false)
	}
	now := time.Now().UTC()
	if err := consumeInvite(ctx, tx, pending.inviteHash, user.ID, now); err != nil {
		return err
	}
	if err := saveCredential(ctx, tx, user.ID, credential); err != nil {
		var duplicate *mysql.MySQLError
		if errors.As(err, &duplicate) && duplicate.Number == 1062 {
			return wire.E("CONFLICT", false)
		}
		return err
	}
	if err := auditSuccess(ctx, tx, user.ID, "ENROLL", "OK"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Service) LoginBegin(ctx context.Context, state *State, username string) (Challenge, error) {
	if !store.ValidUsername(username) {
		return Challenge{}, wire.E("UNAUTH", false)
	}
	origin, err := s.origin(state)
	if err != nil {
		return Challenge{}, err
	}
	user, err := readAccountByName(ctx, s.db, username)
	if err != nil {
		return Challenge{}, err
	}
	if err := state.allowAccount(user.ID); err != nil {
		return Challenge{}, err
	}
	if err := loadCredentials(ctx, s.db, &user); err != nil {
		return Challenge{}, err
	}
	if len(user.Credentials) == 0 {
		return Challenge{}, wire.E("UNAUTH", false)
	}
	allowed := make([]protocol.CredentialDescriptor, 0, len(user.Credentials))
	for _, credential := range user.Credentials {
		allowed = append(allowed, boundedDescriptor(credential))
	}
	options, data, err := s.method.BeginLogin(user,
		webauthn.WithLoginOrigin(origin),
		webauthn.WithUserVerification(protocol.VerificationRequired),
		webauthn.WithAllowedCredentials(allowed),
	)
	if err != nil {
		return Challenge{}, fmt.Errorf("begin credential login: %w", err)
	}
	return state.begin(pendingChallenge{kind: login, account: user.ID, data: data}, options.Response)
}

func (s *Service) LoginFinish(ctx context.Context, state *State, challengeID string, response json.RawMessage) (Identity, error) {
	pending, err := state.consume(login, challengeID, time.Now())
	if err != nil {
		return Identity{}, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
	if err != nil {
		return Identity{}, wire.E("UNAUTH", false)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback()
	user, err := readAccountByID(ctx, tx, pending.account, true)
	if err != nil {
		return Identity{}, err
	}
	if err := loadCredentials(ctx, tx, &user); err != nil {
		return Identity{}, err
	}
	credential, err := s.method.ValidateLogin(user, *pending.data, parsed)
	if err != nil {
		return Identity{}, wire.E("UNAUTH", false)
	}
	if err := updateCredential(ctx, tx, user.ID, credential); err != nil {
		return Identity{}, err
	}
	token, hash := newSecret()
	if err := saveSession(ctx, tx, hash, user.ID, credential.ID, time.Now().UTC()); err != nil {
		return Identity{}, err
	}
	result := "OK"
	if credential.Authenticator.CloneWarning {
		result = "COUNTER_WARNING"
	}
	if err := auditSuccess(ctx, tx, user.ID, "AUTH", result); err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, err
	}
	if err := state.bind(user.ID, hash); err != nil {
		return Identity{}, err
	}
	return Identity{UserID: user.ID, Role: user.Role, Permissions: user.Permissions, Token: token}, nil
}

func boundedDescriptor(credential webauthn.Credential) protocol.CredentialDescriptor {
	descriptor := credential.Descriptor()
	// Keep the reply size bounded regardless of optional browser hints.
	descriptor.Transport = nil
	return descriptor
}

func (s *State) allowAccount(id wire.ID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.account != (wire.ID{}) && s.account != id {
		return wire.E("UNAUTH", false)
	}
	return nil
}

func (s *State) begin(pending pendingChallenge, options any) (Challenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.account != (wire.ID{}) && s.account != pending.account {
		return Challenge{}, wire.E("UNAUTH", false)
	}
	pending.id = rand.Text()
	s.pending = &pending
	return Challenge{ChallengeID: pending.id, Options: options}, nil
}

func (s *State) consume(kind ceremony, id string, now time.Time) (*pendingChallenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.pending
	if pending == nil || pending.kind != kind || pending.id != id {
		return nil, wire.E("UNAUTH", false)
	}
	s.pending = nil
	if !pending.data.Expires.After(now) || (s.account != (wire.ID{}) && s.account != pending.account) {
		return nil, wire.E("UNAUTH", false)
	}
	return pending, nil
}

func newSecret() (string, [sha256.Size]byte) {
	var raw [secretBytes]byte
	rand.Read(raw[:])
	return base64.RawURLEncoding.EncodeToString(raw[:]), sha256.Sum256(raw[:])
}

func parseSecret(token string) ([sha256.Size]byte, error) {
	var raw [secretBytes]byte
	if len(token) != base64.RawURLEncoding.EncodedLen(len(raw)) {
		return [sha256.Size]byte{}, wire.E("UNAUTH", false)
	}
	n, err := base64.RawURLEncoding.Strict().Decode(raw[:], []byte(token))
	if err != nil || n != len(raw) {
		return [sha256.Size]byte{}, wire.E("UNAUTH", false)
	}
	return sha256.Sum256(raw[:]), nil
}
