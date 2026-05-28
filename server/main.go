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
	isLoopback := config.BindAddress == "127.0.0.1" || config.BindAddress == "localhost"

	slog.Info("🚀 starting KubeAtlas",
		"version", version,
		"address", addr,
		"log_level", config.LogLevel,
		"log_format", config.LogFormat)
	slog.Debug("🔧 configuration", "config", fmt.Sprintf("%+v", config))

	if !isLoopback {
		slog.Warn("⚠️  not binding to localhost — server is reachable on external network interfaces")
		slog.Warn("⚠️  this configuration is unsupported and may result in critical security vulnerabilities")
	}

	// Single-instance: if one is already running for this user, focus it and exit
	// rather than starting a second server + informer set.
	if focusRunningInstance(config, isLoopback) {
		return
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
		Handler: r,
		// ReadHeaderTimeout prevents Slowloris-style DoS attacks where a client
		// holds a connection open by sending headers slowly. This does not affect
		// established SSE or WebSocket connections, only the initial handshake.
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Bind before opening the browser so it connects to a live socket rather than
	// racing the listener. A busy default port falls back to a free one (see listen).
	ln, err := listen(addr, config.PortExplicit)
	if err != nil {
		logListenError(err, config.Port, config.PortExplicit)
		os.Exit(1)
	}

	port := ln.Addr().(*net.TCPAddr).Port
	if port != config.Port {
		slog.Warn("⚠️  requested port was in use — bound a free port instead",
			"requested", config.Port, "listening", port)
	}

	slog.Info("👂 listening", "address", fmt.Sprintf("%s:%d", config.BindAddress, port))

	url := fmt.Sprintf("http://%s:%d", config.BindAddress, port)

	// Record ourselves as the running instance so a later launch finds and
	// focuses us; clean up on normal return (the signal path is handled inside
	// recordInstance). PORT-explicit runs are deliberate separate instances and
	// don't participate in this bookkeeping.
	if config.SingleInstance && !config.PortExplicit {
		recordInstance(port, url)

		defer removeInstanceState()
	}

	// Auto-open the UI for the standalone binary. Loopback only: a non-loopback
	// bind is typically headless/remote, where there's no local browser to open
	// and the URL wouldn't point at this host anyway.
	if config.OpenBrowser && isLoopback {
		slog.Info("🌐 opening browser", "url", url)

		go openBrowser(url)
	}

	if err := httpServer.Serve(ln); err != nil {
		slog.Error("💥 server failed to start", "err", err)
		os.Exit(1)
	}
}
