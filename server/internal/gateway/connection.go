package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"sft/internal/auth"
	"sft/internal/transfer"
	"sft/internal/wire"

	"github.com/gorilla/websocket"
)

const (
	maxDataInFlight = 8
	maxTaskInFlight = 2
	requestTimeout  = 10 * time.Second
	commitTimeout   = 2 * time.Minute
)

type outgoing struct {
	message wire.Message
	guard   func(context.Context) error
}

type taskWindow struct {
	count     atomic.Int32
	exclusive bool
}

type connection struct {
	gateway *Gateway
	socket  *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	id      string
	ip      netip.Addr
	origin  string
	inbox   chan wire.Message
	outbox  chan outgoing
	started atomic.Bool

	// Only the dispatcher changes these fields. Workers receive snapshots.
	login    *auth.State
	files    *transfer.Conn
	userID   wire.ID
	token    string
	windows  map[wire.ID]*taskWindow
	inFlight atomic.Int32
	workers  sync.WaitGroup
}

func (c *connection) run() {
	slog.Info("WebSocket connected", "connection", c.id)
	defer slog.Info("WebSocket disconnected", "connection", c.id)
	c.socket.SetReadLimit(wire.MaxMessage)
	_ = c.socket.SetReadDeadline(time.Now().Add(pingInterval + pongWindow))
	c.socket.SetPongHandler(func(string) error {
		slog.Debug("WebSocket pong", "connection", c.id)
		return c.socket.SetReadDeadline(time.Now().Add(pingInterval + pongWindow))
	})
	var pumps sync.WaitGroup
	pumps.Add(2)
	go func() {
		defer pumps.Done()
		c.writePump()
	}()
	go func() {
		defer pumps.Done()
		c.dispatch()
	}()
	c.readPump()
	c.cancel()
	close(c.inbox)
	_ = c.socket.Close()
	pumps.Wait()
}

func (c *connection) readPump() {
	var requestID uint32
	for c.ctx.Err() == nil {
		kind, data, err := c.socket.ReadMessage()
		if err != nil {
			return
		}
		m, err := wire.Decode(data)
		if kind != websocket.BinaryMessage || err != nil || m.RequestID <= requestID {
			c.closeWith(websocket.CloseProtocolError, "invalid SFT message")
			return
		}
		requestID = m.RequestID
		select {
		case c.gateway.incoming <- struct{}{}:
			select {
			case c.inbox <- m:
				continue
			default:
				<-c.gateway.incoming
			}
		default:
		}
		select {
		case c.outbox <- outgoing{message: errorMessage(c.id, m, wire.E("BUSY", true))}:
		default:
			c.closeWith(websocket.CloseTryAgainLater, "connection queue full")
			return
		}
	}
}

func (c *connection) writePump() {
	defer c.socket.Close()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	timer := time.NewTimer(authTimeout)
	defer timer.Stop()
	for {
		// Give a due heartbeat priority before scheduling another data message.
		select {
		case <-ticker.C:
			if !c.ping() {
				return
			}
		default:
		}
		select {
		case <-c.ctx.Done():
			c.closeWith(websocket.CloseGoingAway, "connection closing")
			return
		case <-timer.C:
			if !c.started.Load() {
				c.closeWith(websocket.ClosePolicyViolation, "authentication timeout")
				return
			}
		case <-ticker.C:
			if !c.ping() {
				return
			}
		case reply := <-c.outbox:
			m := reply.message
			if reply.guard != nil {
				ctx, cancel := context.WithTimeout(c.ctx, 3*time.Second)
				err := reply.guard(ctx)
				cancel()
				if err != nil {
					m = errorMessage(c.id, m, err)
				}
			}
			_ = c.socket.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.socket.WriteMessage(websocket.BinaryMessage, m.Encode()); err != nil {
				return
			}
		}
	}
}

func (c *connection) ping() bool {
	return c.socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(pongWindow)) == nil
}

func (c *connection) closeWith(code int, text string) {
	_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(time.Second))
}

func (c *connection) dispatch() {
	c.windows = make(map[wire.ID]*taskWindow)
	recheck := time.NewTicker(time.Minute)
	defer recheck.Stop()
	defer func() {
		c.workers.Wait()
		c.detach()
	}()
	for {
		select {
		case m, ok := <-c.inbox:
			if !ok {
				return
			}
			if c.ctx.Err() == nil && c.dispatchMessage(m) {
				continue // asynchronous worker owns the queue-budget token
			}
			<-c.gateway.incoming
		case <-recheck.C:
			if c.userID != (wire.ID{}) && c.ctx.Err() == nil {
				ctx, cancel := context.WithTimeout(c.ctx, 3*time.Second)
				_, err := c.gateway.auth.Check(ctx, c.login, false)
				cancel()
				c.detachIfExpired(err)
			}
		}
	}
}

func (c *connection) dispatchMessage(m wire.Message) bool {
	if err := m.ValidateRequest(); err != nil {
		c.send(outgoing{message: errorMessage(c.id, m, err)})
		return false
	}
	ctx, cancel := context.WithTimeout(c.ctx, requestTimeout)
	defer cancel()
	var reply wire.Message
	var err error
	if m.Kind <= wire.Logout {
		reply, err = c.authentication(ctx, m)
	} else {
		if !c.allowRequest(m.Kind) {
			c.send(outgoing{message: errorMessage(c.id, m, wire.E("RATE_LIMIT", true))})
			return false
		}
		var actor auth.Identity
		actor, err = c.gateway.auth.Check(ctx, c.login, true)
		c.detachIfExpired(err)
		if err == nil && c.files == nil {
			err = wire.E("UNAUTH", false)
		}
		if err == nil {
			switch m.Kind {
			case wire.PutData, wire.GetChunk, wire.PutCommit:
				if err = c.startWorker(m, actor); err == nil {
					return true
				}
			case wire.PutPause, wire.PutCancel, wire.GetClose, wire.GetDone:
				if w := c.windows[m.TransferID]; w != nil && w.count.Load() > 0 {
					err = wire.E("BUSY", true)
				} else {
					reply, err = c.control(ctx, m, actor)
				}
			default:
				reply, err = c.control(ctx, m, actor)
			}
		}
	}
	if err != nil {
		reply = errorMessage(c.id, m, err)
	}
	c.send(outgoing{message: reply})
	return false
}

func (c *connection) allowRequest(kind wire.Kind) bool {
	if kind == wire.PutData || kind == wire.GetChunk {
		// Unauthenticated connections are rejected without a database query.
		return c.userID == (wire.ID{}) ||
			c.gateway.limiter.permit("chunks:"+c.userID.String(), 2400) && c.gateway.limiter.permit("global:chunks", 19200)
	}
	return c.gateway.limiter.permit("control-ip:"+c.ip.String(), 1200)
}

func (c *connection) startWorker(m wire.Message, actor auth.Identity) error {
	for id, w := range c.windows {
		if w.count.Load() == 0 {
			delete(c.windows, id)
		}
	}
	if c.inFlight.Load() >= maxDataInFlight {
		return wire.E("BUSY", true)
	}
	window := c.windows[m.TransferID]
	if window != nil && (window.exclusive || m.Kind == wire.PutCommit || window.count.Load() >= maxTaskInFlight) {
		return wire.E("BUSY", true)
	}
	if window == nil {
		window = &taskWindow{exclusive: m.Kind == wire.PutCommit}
		c.windows[m.TransferID] = window
	}
	window.count.Add(1)
	c.inFlight.Add(1)
	currentToken, files := c.token, c.files
	c.workers.Add(1)
	go func() {
		defer c.workers.Done()
		defer func() {
			c.inFlight.Add(-1)
			<-c.gateway.incoming
		}()
		timeout := requestTimeout
		if m.Kind == wire.PutCommit {
			timeout = commitTimeout
		}
		ctx, cancel := context.WithTimeout(c.ctx, timeout)
		reply, err := c.data(ctx, m, actor, currentToken, files)
		cancel()
		if err != nil {
			reply = outgoing{message: errorMessage(c.id, m, err)}
		}
		window.count.Add(-1)
		c.send(reply)
	}()
	return nil
}

func (c *connection) send(reply outgoing) {
	select {
	case c.outbox <- reply:
	case <-c.ctx.Done():
	}
}

func (c *connection) detach() {
	if c.files != nil {
		c.files.Close()
		c.files = nil
	}
	c.gateway.limiter.leaveUser(c.userID)
	c.userID = wire.ID{}
	c.token = ""
	c.login = &auth.State{Origin: c.origin}
}

func (c *connection) detachIfExpired(err error) {
	if c.userID != (wire.ID{}) && hasCode(err, "UNAUTH") {
		c.workers.Wait()
		c.detach()
	}
}

func (c *connection) activate(actor auth.Identity) error {
	if c.userID != actor.UserID {
		if c.userID != (wire.ID{}) {
			return wire.E("UNAUTH", false)
		}
		if !c.gateway.limiter.enterUser(actor.UserID) {
			c.login = &auth.State{Origin: c.origin}
			return wire.E("RATE_LIMIT", true)
		}
		c.userID = actor.UserID
		c.files = c.gateway.transfer.Conn(c.id)
	}
	c.token = actor.Token
	c.started.Store(true)
	return nil
}

func sameActor(current auth.Identity, expected wire.ID, err error) error {
	if err != nil {
		return err
	}
	if current.UserID != expected {
		return wire.E("UNAUTH", false)
	}
	return nil
}

func hasCode(err error, code string) bool {
	var protocol *wire.ProtocolError
	return errors.As(err, &protocol) && protocol.Code == code
}
