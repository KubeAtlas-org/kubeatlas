// ==========================================================================================
// The backend server for KubeAtlas, serving the web application via templates
// - and connecting to the Kubernetes cluster
// ==========================================================================================

package main

import (
	"fmt"
	"log/slog"
	"net"
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

	// Bind before opening the browser so it connects to a live socket rather than
	// racing the listener.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("💥 server failed to start", "err", err)
		os.Exit(1)
	}

	// Auto-open the UI for the standalone binary. Loopback only: a non-loopback
	// bind is typically headless/remote, where there's no local browser to open
	// and the URL wouldn't point at this host anyway.
	isLoopback := config.BindAddress == "127.0.0.1" || config.BindAddress == "localhost"
	if config.OpenBrowser && isLoopback {
		url := fmt.Sprintf("http://127.0.0.1:%d", config.Port)
		slog.Info("🌐 opening browser", "url", url)

		go openBrowser(url)
	}

	if err := httpServer.Serve(ln); err != nil {
		slog.Error("💥 server failed to start", "err", err)
		os.Exit(1)
	}
}
