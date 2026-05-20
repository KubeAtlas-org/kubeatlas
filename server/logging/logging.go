// ==========================================================================================
// Structured logging — log/slog wrapper with per-request context propagation
// ==========================================================================================

package logging

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"os"
	"strings"
	"time"
)

// SlowServiceCallThreshold is the duration above which a Kubernetes-service
// call is logged at warn level. 500ms picks up "noticeably slow" reads
// (informer cache misses, large list responses) without firing on healthy
// sub-100ms hits.
const SlowServiceCallThreshold = 500 * time.Millisecond

// LogServiceCall emits a warn-level "slow service call" line if `dur` exceeds
// SlowServiceCallThreshold. Call sites pass a request context so the entry
// inherits request_id / client_id. No-op for fast calls — the request-level
// log already records overall duration.
func LogServiceCall(ctx context.Context, op string, dur time.Duration, attrs ...any) {
	if dur < SlowServiceCallThreshold {
		return
	}

	all := make([]any, 0, len(attrs)+4)
	all = append(all, "op", op, "duration_ms", dur.Milliseconds())
	all = append(all, attrs...)

	FromContext(ctx).Warn("🐌 slow service call", all...)
}

type ctxKey int

const (
	loggerKey ctxKey = iota
	requestIDKey
)

// Init installs a slog handler as the default logger.
// level: "debug" | "info" | "warn" | "error" (anything else → info).
// format: "json" → JSONHandler, otherwise TextHandler (plain stdlib, no color).
func Init(level, format string) {
	opts := &slog.HandlerOptions{Level: parseLevel(level)}

	var handler slog.Handler
	if strings.EqualFold(format, "json") {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}

	slog.SetDefault(slog.New(handler))
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// FromContext returns the request-scoped logger stored on ctx, or slog.Default()
// if none is present. Use this in HTTP handlers to inherit request_id/client_id.
func FromContext(ctx context.Context) *slog.Logger {
	if ctx == nil {
		return slog.Default()
	}

	if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok && l != nil {
		return l
	}

	return slog.Default()
}

// WithLogger returns a new context carrying logger as its request-scoped logger.
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, logger)
}

// WithRequestID stores a request ID on the context (used by middleware so handlers
// can read it back without re-parsing the logger). Mostly informational.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestID returns the request ID from the context, or "" if unset.
func RequestID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}

	if id, ok := ctx.Value(requestIDKey).(string); ok {
		return id
	}

	return ""
}

// NewRequestID generates an 8-byte hex string (16 chars). Used by middleware
// to tag each incoming request.
func NewRequestID() string {
	var b [8]byte

	if _, err := rand.Read(b[:]); err != nil {
		return "00000000"
	}

	return hex.EncodeToString(b[:])
}
