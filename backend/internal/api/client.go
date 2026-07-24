package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	maxMessageSize = 512
	readDeadline   = 60 * time.Second
	writeWait      = 10 * time.Second
	pingPeriod     = readDeadline * 9 / 10
	sendBuffer     = 256
)

// Client is one user's socket. ReadPump and WritePump each run in their own
// goroutine and each closes the connection in its own defer, so the upgrade
// handler must not close it.
type Client struct {
	Hub    *Hub
	Conn   *websocket.Conn
	Send   chan WSMessage
	UserID uuid.UUID

	// typing rate-limits inbound typing frames. Only ReadPump touches it, so it
	// needs no mutex.
	typing typingLimiter
}

const (
	typingRefillPerSec = 0.5 // 1 token per 2s
	typingBurst        = 3.0
)

// typingLimiter is a token bucket sized so a well-behaved client (one frame per
// TYPING_THROTTLE) never sees it, while a client sending per-keystroke gets ~1
// frame in 30 through. Burst 3 absorbs the reconnect case, where a few frames
// can legitimately arrive close together.
type typingLimiter struct {
	tokens float64
	last   time.Time
}

func (l *typingLimiter) allow() bool {
	now := time.Now()
	if l.last.IsZero() {
		l.last = now
		l.tokens = typingBurst
	}
	l.tokens = math.Min(typingBurst, l.tokens+now.Sub(l.last).Seconds()*typingRefillPerSec)
	l.last = now

	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

// ReadPump pumps messages from the socket to the hub. A malformed payload is
// answered with KindInvalidJSON and the connection stays open; any other read
// error ends the connection.
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.Unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	_ = c.Conn.SetReadDeadline(time.Now().Add(readDeadline))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(readDeadline))
	})

	for {
		var msg WSMessage
		if err := c.Conn.ReadJSON(&msg); err != nil {
			if isJSONError(err) {
				// The frame was read fine, it just wasn't valid JSON for our
				// envelope. Tell the sender and keep the connection open.
				c.trySend(WSMessage{
					Kind:    KindInvalidJSON,
					Message: "this message should be a valid json",
				})
				continue
			}

			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Warn("websocket closed unexpectedly", "error", err, "user_id", c.UserID)
			}
			return
		}

		// Drop an over-limit typing frame here, on the abusive socket's own
		// goroutine, before it costs the hub a channel send and a scheduling
		// slot. Silently: an error response would amplify the very flood it means
		// to stop. The client throttle is advisory; this is the limit that holds.
		if msg.Kind == KindTyping && !c.typing.allow() {
			continue
		}

		// SenderID is taken from the authenticated socket, never from the payload.
		c.Hub.Inbound <- Inbound{SenderID: c.UserID, Msg: msg}
	}
}

// WritePump pumps messages from the hub to the socket and keeps the connection
// alive with pings.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// The hub closed the channel: say goodbye properly.
				_ = c.Conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(
					websocket.CloseNormalClosure, ""))
				return
			}

			if err := c.Conn.WriteJSON(msg); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// trySend queues a message straight to this client without going through the
// hub. Non-blocking: a client whose buffer is full is already being dropped.
func (c *Client) trySend(msg WSMessage) {
	defer func() {
		// The hub may have closed Send concurrently after dropping this client.
		_ = recover()
	}()

	select {
	case c.Send <- msg:
	default:
	}
}

// isJSONError reports whether ReadJSON failed on the payload rather than on the
// connection.
func isJSONError(err error) bool {
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	return errors.As(err, &syntaxErr) || errors.As(err, &typeErr)
}
