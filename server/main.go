// ==========================================================================================
// The backend server for KubeAtlas, serving the web application via templates
// - and connecting to the Kubernetes cluster
// ==========================================================================================

package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
)

// Version and build info are set at build time using -ldflags
var version = "0.0.0"
var buildInfo = "No build info available"

func main() {
	config := getConfig()

	logging.Init(config.LogLevel, config.LogFormat)

	addr := fmt.Sprintf("%s:%d", config.BindAddress, config.Port)
	slog.Info("🚀 starting KubeAtlas",
		"version", version,
		"address", addr,
		"log_level", config.LogLevel,
		"log_format", config.LogFormat)
	slog.Debug("🔧 configuration", "config", fmt.Sprintf("%+v", config))

	if config.BindAddress != "127.0.0.1" && config.BindAddress != "localhost" {
		slog.Warn("⚠️  not binding to localhost — server is reachable on external network interfaces")
		slog.Warn("⚠️  this configuration is unsupported and may result in critical security vulnerabilities")
	}

	r := chi.NewRouter()

	// This configures the core server, handling pretty much everything
	api := NewKubeatlasAPI(config)
	r.Use(api.SimpleCORSMiddleware)
	r.Use(hostValidationMiddleware(config.BindAddress))
	r.Use(requestLogger)

	api.AddHealthEndpoint(r, "health", nil)
	api.AddStatusEndpoint(r, "api/status")

	api.AddRoutes(r)

	//nolint:gosec
	httpServer := &http.Server{
		Addr:    addr,
		Handler: r,
		// ReadHeaderTimeout prevents Slowloris-style DoS attacks where a client
		// holds a connection open by sending headers slowly. This does not affect
		// established SSE or WebSocket connections, only the initial handshake.
		ReadHeaderTimeout: 5 * time.Second,
	}

	if err := httpServer.ListenAndServe(); err != nil {
		slog.Error("💥 server failed to start", "err", err)
		os.Exit(1)
	}
}
