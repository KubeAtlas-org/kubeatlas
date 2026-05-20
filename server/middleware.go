// ==========================================================================================
// Security middleware for KubeAtlas
// ==========================================================================================

package main

import (
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
)

// hostValidationMiddleware rejects requests whose Host header doesn't match the bind address
// or standard localhost aliases. This blocks DNS rebinding attacks.
// When bindAddress is "0.0.0.0" the check is skipped entirely — any host is potentially valid
// for LAN access.
func hostValidationMiddleware(bindAddress string) func(http.Handler) http.Handler {
	if bindAddress == "0.0.0.0" {
		return func(next http.Handler) http.Handler { return next }
	}

	allowed := map[string]bool{
		"localhost": true,
		"127.0.0.1": true,
		bindAddress: true,
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := r.Host
			if h, _, err := net.SplitHostPort(host); err == nil {
				host = h
			}

			if !allowed[host] {
				http.Error(w, "Invalid Host header", http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// requestLogger attaches a request_id and per-request *slog.Logger to the
// request context, then logs one summary line on completion. Long-lived
// streams (SSE, WebSocket) still log on completion — for them duration_ms
// reflects the lifetime of the stream.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip noisy static-asset and health-probe traffic.
		switch p := r.URL.Path; {
		case p == "/health",
			p == "/favicon.ico",
			len(p) >= 8 && p[:8] == "/public/":
			next.ServeHTTP(w, r)
			return
		}

		reqID := logging.NewRequestID()
		logger := slog.With("request_id", reqID, "method", r.Method, "path", r.URL.Path)

		ctx := logging.WithRequestID(r.Context(), reqID)
		ctx = logging.WithLogger(ctx, logger)

		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()

		next.ServeHTTP(ww, r.WithContext(ctx))

		dur := time.Since(start)
		// Long-lived streams (SSE, /updates, log follow) legitimately stay open
		// for minutes. Don't fire the slow warn for them — they are duration-by-
		// design, not pathological.
		isStream := r.URL.Path == "/updates" ||
			r.URL.Query().Get("follow") == "true"

		if dur > 1000*time.Millisecond && !isStream {
			logger.Warn("🐌 slow request",
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"duration_ms", dur.Milliseconds(),
			)
		} else {
			logger.Debug("http request",
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"duration_ms", dur.Milliseconds(),
			)
		}
	})
}
