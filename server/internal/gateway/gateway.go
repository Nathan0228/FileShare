package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"sft/internal/auth"
	"sft/internal/store"
	"sft/internal/transfer"
	"sft/internal/wire"

	"github.com/gorilla/websocket"
)

const (
	maxConnections = 128
	maxPerIP       = 8
	maxPerAccount  = 4
	receiveBudget  = 96
	authTimeout    = 2 * time.Minute
	pingInterval   = 25 * time.Second
	pongWindow     = 10 * time.Second
	writeTimeout   = 10 * time.Second
)

type Gateway struct {
	ctx         context.Context
	store       *store.Store
	auth        *auth.Service
	transfer    *transfer.Service
	upgrader    websocket.Upgrader
	trustProxy  bool
	limiter     limits
	incoming    chan struct{}
	connections sync.WaitGroup
}

func New(ctx context.Context, db *store.Store, login *auth.Service, files *transfer.Service, origin string, trustProxy bool) *Gateway {
	return &Gateway{
		ctx: ctx, store: db, auth: login, transfer: files, trustProxy: trustProxy,
		upgrader: websocket.Upgrader{
			HandshakeTimeout: 5 * time.Second,
			Subprotocols:     []string{wire.Subprotocol},
			CheckOrigin: func(r *http.Request) bool {
				values := r.Header.Values("Origin")
				return len(values) == 1 && values[0] == origin
			},
		},
		incoming: make(chan struct{}, receiveBudget),
	}
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sft", g.open)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		w.Header().Set("Cache-Control", "no-store")
		if g.ctx.Err() != nil || g.store.DB.PingContext(ctx) != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func (g *Gateway) Wait() {
	// Once the shared context is cancelled, the admission lock prevents a new Add.
	g.limiter.mu.Lock()
	g.limiter.mu.Unlock()
	g.connections.Wait()
}

func (g *Gateway) open(w http.ResponseWriter, r *http.Request) {
	if len(r.URL.RawQuery) != 0 || !websocket.IsWebSocketUpgrade(r) {
		http.Error(w, "WebSocket upgrade required", http.StatusBadRequest)
		return
	}
	if !g.upgrader.CheckOrigin(r) {
		http.Error(w, "origin denied", http.StatusForbidden)
		return
	}
	protocols := websocket.Subprotocols(r)
	if len(protocols) != 1 || protocols[0] != wire.Subprotocol {
		http.Error(w, "sft.v1 subprotocol required", http.StatusBadRequest)
		return
	}
	ip, err := g.clientIP(r)
	if err != nil {
		http.Error(w, "invalid client address", http.StatusBadRequest)
		return
	}
	g.limiter.mu.Lock()
	if g.ctx.Err() != nil || !g.limiter.enter(ip) {
		g.limiter.mu.Unlock()
		w.Header().Set("Retry-After", "5")
		http.Error(w, "connection limit reached", http.StatusTooManyRequests)
		return
	}
	g.connections.Add(1)
	g.limiter.mu.Unlock()
	defer g.connections.Done()
	defer g.limiter.leave(ip)
	id, err := wire.NewID()
	if err != nil {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	socket, err := g.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(g.ctx)
	conn := connection{
		gateway: g, socket: socket, ctx: ctx, cancel: cancel, id: id.String(), ip: ip,
		origin: r.Header.Get("Origin"), inbox: make(chan wire.Message, 8),
		outbox: make(chan outgoing, 8),
	}
	conn.login = &auth.State{Origin: conn.origin}
	conn.run()
}

func (g *Gateway) clientIP(r *http.Request) (netip.Addr, error) {
	if g.trustProxy {
		addr, err := netip.ParseAddr(r.Header.Get("X-SFT-Client-IP"))
		return addr.Unmap(), err
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, err
	}
	addr, err := netip.ParseAddr(host)
	return addr.Unmap(), err
}

type rate struct {
	start time.Time
	count int
}

type limits struct {
	mu       sync.Mutex
	total    int
	byIP     map[netip.Addr]int
	byUser   map[wire.ID]int
	attempts map[string]rate
}

// enter runs under the admission lock so shutdown and the connection count agree.
func (l *limits) enter(ip netip.Addr) bool {
	if l.total >= maxConnections || l.byIP[ip] >= maxPerIP {
		return false
	}
	if l.byIP == nil {
		l.byIP = make(map[netip.Addr]int)
	}
	l.total++
	l.byIP[ip]++
	return true
}

func (l *limits) leave(ip netip.Addr) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.total--
	l.byIP[ip]--
	if l.byIP[ip] == 0 {
		delete(l.byIP, ip)
	}
}

func (l *limits) enterUser(user wire.ID) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byUser[user] >= maxPerAccount {
		return false
	}
	if l.byUser == nil {
		l.byUser = make(map[wire.ID]int)
	}
	l.byUser[user]++
	return true
}

func (l *limits) leaveUser(user wire.ID) {
	if user == (wire.ID{}) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.byUser[user]--
	if l.byUser[user] == 0 {
		delete(l.byUser, user)
	}
}

func (l *limits) permit(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.attempts == nil {
		l.attempts = make(map[string]rate)
	}
	bucket := l.attempts[key]
	if now.Sub(bucket.start) >= time.Minute {
		if len(l.attempts) >= 8192 {
			for k, value := range l.attempts {
				if now.Sub(value.start) >= time.Minute {
					delete(l.attempts, k)
				}
			}
			if len(l.attempts) >= 8192 {
				return false
			}
		}
		bucket = rate{start: now}
	}
	if bucket.count >= max {
		return false
	}
	bucket.count++
	l.attempts[key] = bucket
	return true
}

func errorMessage(id string, request wire.Message, err error) wire.Message {
	var detail *wire.ProtocolError
	if !errors.As(err, &detail) {
		// Database and filesystem details can contain secrets and stay out of the API.
		slog.Error("request failed", "connection", id, "request", request.RequestID, "type", request.Kind, "errorType", fmt.Sprintf("%T", err))
		detail = &wire.ProtocolError{Code: "STORAGE_UNAVAILABLE", Retryable: true}
	}
	return jsonReply(request, wire.Err, detail)
}
