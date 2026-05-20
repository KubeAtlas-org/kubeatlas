// ==========================================================================================
// HTTP route registration and shared handler utilities
// ==========================================================================================

package main

import (
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
	"github.com/kubeatlas-org/kubeatlas/server/services/events"
)

// AllNamespacesSentinel is the URL-path value that selects cross-namespace mode.
// It is identical to events.AllNamespacesGroup so MoveClientToGroup lands the client
// in the same bucket the namespaced event handlers fan out to.
const AllNamespacesSentinel = events.AllNamespacesGroup

// All application routes are defined here
func (s *KubeatlasAPI) AddRoutes(r *chi.Mux) {
	r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, "public/index.html")
		})).ServeHTTP(w, r)
	})

	publicFS := http.StripPrefix("/public/", noCache(http.FileServer(http.Dir("public"))))
	r.HandleFunc("/public/*", publicFS.ServeHTTP)

	// Special route for SSE streaming events to connected clients
	r.HandleFunc("/updates", s.handleSSE)

	// REST API routes
	r.Get("/api/namespaces", s.handleNamespaceList)
	r.Get("/api/fetch/{namespace}", s.handleFetchData)
	r.Get("/api/fetch-cluster", s.handleFetchClusterData)
	r.Get("/api/logs/{namespace}/{podname}", s.handlePodLogs)
	r.Get("/api/resource/{namespace}/{kind}/{name}/yaml", s.handleResourceYAML)
	r.Put("/api/resource/{namespace}/{kind}/{name}/yaml", s.handleApplyResourceYAML)
	r.Delete("/api/resources/{namespace}/{kind}/{name}", s.handleDeleteResource)
	r.Get("/api/metrics/{namespace}/pods", s.handlePodMetrics)
	r.Get("/api/metrics/nodes", s.handleNodeMetrics)
	r.Put("/api/resources/{namespace}/{kind}/{name}/scale", s.handleScaleResource)
	r.Post("/api/resources/{namespace}/{kind}/{name}/restart", s.handleRestartResource)
	r.Get("/api/crds", s.handleCRDList)
	r.Get("/api/crds/{group}/{version}/{resource}/{namespace}", s.handleCRDResources)
	r.Post("/api/contexts/switch", s.handleContextSwitch)

	// WebSocket exec/shell
	r.Get("/ws/exec/{namespace}/{pod}", s.handleExec)
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

// noCache wraps a handler and disables caching on every response.
// Prevents browsers from serving stale JS/HTML between reloads during development.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		h.ServeHTTP(w, r)
	})
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
