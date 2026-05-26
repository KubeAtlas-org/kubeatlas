// ==========================================================================================
// HTTP route registration and shared handler utilities
// ==========================================================================================

package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"

	kubeatlas "github.com/kubeatlas-org/kubeatlas"
	"github.com/kubeatlas-org/kubeatlas/server/logging"
	"github.com/kubeatlas-org/kubeatlas/server/services/events"
)

// AllNamespacesSentinel is the URL-path value that selects cross-namespace mode.
// It is identical to events.AllNamespacesGroup so MoveClientToGroup lands the client
// in the same bucket the namespaced event handlers fan out to.
const AllNamespacesSentinel = events.AllNamespacesGroup

// All application routes are defined here
func (s *KubeatlasAPI) AddRoutes(r *chi.Mux) {
	// Frontend assets: serve from STATIC_DIR on disk when set (dev: live edit
	// and reload), otherwise from the copy embedded in the binary (self-contained
	// deployment — see embed.go at the repo root).
	staticFS := s.staticFS()

	r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			f, err := staticFS.Open("index.html")
			if err != nil {
				http.Error(w, "index.html not found", http.StatusInternalServerError)
				return
			}
			defer f.Close()
			// Zero modtime: caching is already disabled by noCache, so skip
			// Last-Modified / If-Modified-Since handling.
			http.ServeContent(w, r, "index.html", time.Time{}, f.(io.ReadSeeker))
		})).ServeHTTP(w, r)
	})

	publicFS := http.StripPrefix("/public/", noCache(http.FileServerFS(staticFS)))
	r.HandleFunc("/public/*", publicFS.ServeHTTP)

	// Special route for SSE streaming events to connected clients
	r.HandleFunc("/updates", s.handleSSE)

	// REST API routes. handleNamespaceList, context switch, and reconnect work in
	// the disconnected state (they report it / recover from it); everything that
	// dereferences the live cluster is wrapped in requireCluster so a disconnected
	// boot returns 503 instead of panicking on a nil kubeService.
	r.Get("/api/namespaces", s.handleNamespaceList)
	r.Get("/api/fetch/{namespace}", s.requireCluster(s.handleFetchData))
	r.Get("/api/fetch-cluster", s.requireCluster(s.handleFetchClusterData))
	r.Get("/api/logs/{namespace}/{podname}", s.requireCluster(s.handlePodLogs))
	r.Get("/api/resource/{namespace}/{kind}/{name}/yaml", s.requireCluster(s.handleResourceYAML))
	r.Put("/api/resource/{namespace}/{kind}/{name}/yaml", s.requireCluster(s.handleApplyResourceYAML))
	r.Delete("/api/resources/{namespace}/{kind}/{name}", s.requireCluster(s.handleDeleteResource))
	r.Get("/api/metrics/{namespace}/pods", s.requireCluster(s.handlePodMetrics))
	r.Get("/api/metrics/nodes", s.requireCluster(s.handleNodeMetrics))
	r.Put("/api/resources/{namespace}/{kind}/{name}/scale", s.requireCluster(s.handleScaleResource))
	r.Post("/api/resources/{namespace}/{kind}/{name}/restart", s.requireCluster(s.handleRestartResource))
	r.Get("/api/crds", s.requireCluster(s.handleCRDList))
	r.Get("/api/crds/{group}/{version}/{resource}/{namespace}", s.requireCluster(s.handleCRDResources))
	r.Post("/api/contexts/switch", s.handleContextSwitch)
	r.Post("/api/contexts/reconnect", s.handleReconnect)

	// WebSocket exec/shell
	r.Get("/ws/exec/{namespace}/{pod}", s.requireCluster(s.handleExec))
}

// requireClientID extracts the clientID query param, returning false and writing a 400 if absent.
// As a side effect, attaches client_id to the per-request logger so subsequent
// logging.FromContext(r.Context()) calls inherit it.
func requireClientID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.URL.Query().Get("clientID")
	if id == "" {
		http.Error(w, "clientID is required", http.StatusBadRequest)

		return "", false
	}

	ctx := r.Context()
	logger := logging.FromContext(ctx).With("client_id", id)
	*r = *r.WithContext(logging.WithLogger(ctx, logger))

	return id, true
}

// requireCluster guards routes that dereference the live cluster. When the
// server booted in disconnected mode (no reachable cluster), kubeService is nil;
// short-circuit with 503 rather than panicking. Once a reconnect succeeds the
// wrapped handlers serve normally again.
func (s *KubeatlasAPI) requireCluster(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.kubeService == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "not connected to a Kubernetes cluster")
			return
		}

		h(w, r)
	}
}

// writeJSONError sends a minimal JSON error body. New code uses this in place of
// the benc-uk problem package, which the server is migrating away from.
func writeJSONError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "detail": detail})
}

// noCache wraps a handler and disables caching on every response.
// Prevents browsers from serving stale JS/HTML between reloads during development.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		h.ServeHTTP(w, r)
	})
}

// staticFS returns the filesystem the frontend is served from. When STATIC_DIR
// is set it reads from that directory on disk (the dev loop: edit a file under
// public/ and reload, no rebuild). Otherwise it returns the assets embedded in
// the binary, making a bare `kubeatlas` deployable on its own.
func (s *KubeatlasAPI) staticFS() fs.FS {
	return resolveStaticFS(s.config.StaticDir, kubeatlas.PublicFS())
}

// resolveStaticFS returns the disk directory when staticDir is set, otherwise
// the embedded filesystem. Split out from staticFS so the selection is unit
// testable without constructing a KubeatlasAPI (which connects to a cluster).
func resolveStaticFS(staticDir string, embedded fs.FS) fs.FS {
	if staticDir != "" {
		return os.DirFS(staticDir)
	}

	return embedded
}

// flushWriter wraps a ResponseWriter and flushes after every write for streaming
type flushWriter struct {
	w io.Writer
	f http.Flusher
}

func (fw *flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	fw.f.Flush()

	return n, err
}
