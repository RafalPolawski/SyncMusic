package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/RafalPolawski/SyncMusic/internal/protocol"
)

const (
	writeTimeout     = 10 * time.Second
	pingInterval     = 20 * time.Second
	readIdleTimeout  = 45 * time.Second
	controlQueueSize = 64
	maxMessageBytes  = 256 << 10
)

// notSent marks that a connection has not received any queue/context yet.
const notSent = math.MaxUint64

type controlMsg struct {
	data []byte
	pong *protocol.Pong // stamped with T2 right before writing
	// closeCode, when set, closes the connection after all earlier
	// control messages were written.
	closeCode   websocket.StatusCode
	closeReason string
}

// conn is one WebSocket connection. Writes are funnelled through a single
// writer goroutine: control messages (pongs, acks) go first, then the latest
// room state and presence. State and presence are coalesced: if a slow link
// has not sent the previous snapshot yet it is simply replaced, so a phone
// on a bad network always catches up with the newest state instead of
// draining a backlog.
type conn struct {
	hub *Hub
	ws  *websocket.Conn
	log *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	control chan controlMsg
	notify  chan struct{}

	mu              sync.Mutex
	pendingState    []byte
	pendingQueueV   uint64 // queue version included in pendingState (notSent if none)
	pendingContextV uint64
	pendingPresence []byte

	// Versions the client has actually received; written by the writer.
	sentQueueV   atomic.Uint64
	sentContextV atomic.Uint64

	lastRead atomic.Int64 // unix nanos

	// Set once during hello, read-only afterwards.
	clientID string
	room     *Room
}

func newConn(h *Hub, ws *websocket.Conn, log *slog.Logger) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{
		hub:     h,
		ws:      ws,
		log:     log,
		ctx:     ctx,
		cancel:  cancel,
		control: make(chan controlMsg, controlQueueSize),
		notify:  make(chan struct{}, 1),
	}
	c.sentQueueV.Store(notSent)
	c.sentContextV.Store(notSent)
	c.lastRead.Store(time.Now().UnixNano())
	return c
}

// sendControl queues a control message. When the queue is full the client is
// hopelessly behind and the connection is closed; it will reconnect and
// receive a fresh snapshot.
func (c *conn) sendControl(v any) {
	var m controlMsg
	if p, ok := v.(*protocol.Pong); ok {
		m.pong = p
	} else {
		b, err := json.Marshal(v)
		if err != nil {
			c.log.Error("marshal message", "err", err)
			return
		}
		m.data = b
	}
	select {
	case c.control <- m:
	case <-c.ctx.Done():
	default:
		c.log.Warn("client too slow, closing connection")
		c.close(websocket.StatusPolicyViolation, "too slow")
	}
}

// closeAfter queues an orderly close behind already queued messages, so an
// error explaining the close reaches the client first.
func (c *conn) closeAfter(code websocket.StatusCode, reason string) {
	select {
	case c.control <- controlMsg{closeCode: code, closeReason: reason}:
	case <-c.ctx.Done():
	default:
		c.close(code, reason)
	}
}

// setState replaces the pending state snapshot.
func (c *conn) setState(data []byte, queueV, contextV uint64) {
	c.mu.Lock()
	c.pendingState = data
	c.pendingQueueV = queueV
	c.pendingContextV = contextV
	c.mu.Unlock()
	c.wake()
}

// setPresence replaces the pending presence snapshot.
func (c *conn) setPresence(data []byte) {
	c.mu.Lock()
	c.pendingPresence = data
	c.mu.Unlock()
	c.wake()
}

func (c *conn) wake() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *conn) close(code websocket.StatusCode, reason string) {
	c.cancel()
	_ = c.ws.Close(code, reason)
}

func (c *conn) write(data []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, data)
}

func (c *conn) writeLoop() {
	defer c.cancel()
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		// Drain control messages first: pongs must leave immediately for
		// accurate clock synchronisation.
		select {
		case m := <-c.control:
			if err := c.writeControl(m); err != nil {
				return
			}
			continue
		default:
		}
		c.mu.Lock()
		state, qv, cv := c.pendingState, c.pendingQueueV, c.pendingContextV
		presence := c.pendingPresence
		c.pendingState, c.pendingPresence = nil, nil
		c.mu.Unlock()
		if state != nil {
			if err := c.write(state); err != nil {
				return
			}
			if qv != notSent {
				c.sentQueueV.Store(qv)
			}
			if cv != notSent {
				c.sentContextV.Store(cv)
			}
			continue
		}
		if presence != nil {
			if err := c.write(presence); err != nil {
				return
			}
			continue
		}
		select {
		case <-c.ctx.Done():
			return
		case m := <-c.control:
			if err := c.writeControl(m); err != nil {
				return
			}
		case <-c.notify:
		case <-ping.C:
			if time.Since(time.Unix(0, c.lastRead.Load())) > readIdleTimeout {
				c.log.Info("closing idle connection")
				c.close(websocket.StatusGoingAway, "idle")
				return
			}
			go func() {
				ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
				defer cancel()
				if err := c.ws.Ping(ctx); err != nil && c.ctx.Err() == nil {
					c.close(websocket.StatusGoingAway, "ping timeout")
				}
			}()
		}
	}
}

func (c *conn) writeControl(m controlMsg) error {
	if m.closeCode != 0 {
		c.close(m.closeCode, m.closeReason)
		return errors.New("closed")
	}
	data := m.data
	if m.pong != nil {
		m.pong.T2 = c.hub.nowFloat()
		b, err := json.Marshal(m.pong)
		if err != nil {
			return err
		}
		data = b
	}
	return c.write(data)
}

// readLoop processes client messages until the connection ends.
func (c *conn) readLoop() {
	defer c.cancel()
	for {
		_, data, err := c.ws.Read(c.ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) && websocket.CloseStatus(err) == -1 {
				c.log.Debug("websocket read ended", "err", err)
			}
			return
		}
		received := c.hub.nowFloat()
		c.lastRead.Store(time.Now().UnixNano())
		msg, err := protocol.Decode(data)
		if err != nil {
			c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "bad_message", Message: err.Error()})
			continue
		}
		switch m := msg.(type) {
		case *protocol.Ping:
			c.sendControl(&protocol.Pong{Type: protocol.TypePong, ID: m.ID, T0: m.T0, T1: received})
		case *protocol.Hello:
			if c.room != nil {
				c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "already_joined", Message: "hello may only be sent once"})
				continue
			}
			c.handleHello(m)
		default:
			if c.room == nil {
				c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "not_joined", Message: "send hello first"})
				continue
			}
			c.room.post(c.ctx, clientEvent{conn: c, msg: msg})
		}
	}
}

func (c *conn) handleHello(m *protocol.Hello) {
	if m.Protocol != protocol.Version {
		c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "protocol_mismatch",
			Message: "client and server versions differ, please reload the app"})
		// Keep reading until the writer has delivered the error and closed.
		c.closeAfter(websocket.StatusPolicyViolation, "protocol mismatch")
		return
	}
	roomName, ok := NormalizeRoomName(m.Room)
	if !ok {
		c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "bad_room", Message: "invalid room name"})
		return
	}
	clientID := sanitizeClientID(m.ClientID)
	if clientID == "" {
		c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "bad_client", Message: "invalid client id"})
		return
	}
	c.clientID = clientID
	r, err := c.hub.join(c, joinInfo{
		roomName: roomName,
		name:     sanitizeName(m.Name),
		format:   m.Format,
		quality:  m.Quality,
	})
	if err != nil {
		c.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "join_failed", Message: err.Error()})
		return
	}
	c.room = r
}
