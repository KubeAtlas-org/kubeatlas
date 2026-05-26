// ==========================================================================================
// Resource operation handlers — scale, restart, context switch
// ==========================================================================================

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
	"github.com/kubeatlas-org/kubeatlas/server/services"
)

// Scale a Deployment, ReplicaSet, or StatefulSet to a given replica count
func (s *KubeatlasAPI) handleScaleResource(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Client-ID") == "" {
		http.Error(w, "Missing X-Client-ID header", http.StatusForbidden)
		return
	}

	ns := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")

	var body struct {
		Replicas int32 `json:"replicas"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		problem.Wrap(400, r.RequestURI, "invalid request body", err).Send(w)
		return
	}

	logging.FromContext(r.Context()).Info("⚖️ scaling resource",
		"kind", kind, "name", name, "namespace", ns, "replicas", body.Replicas)

	if err := s.kubeService.ScaleResource(ns, kind, name, body.Replicas); err != nil {
		problem.Wrap(500, r.RequestURI, "scale resource", err).Send(w)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Trigger a rollout restart for a Deployment, StatefulSet, or DaemonSet
func (s *KubeatlasAPI) handleRestartResource(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Client-ID") == "" {
		http.Error(w, "Missing X-Client-ID header", http.StatusForbidden)
		return
	}

	ns := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")

	logging.FromContext(r.Context()).Info("🔄 restarting resource",
		"kind", kind, "name", name, "namespace", ns)

	if err := s.kubeService.RestartResource(ns, kind, name); err != nil {
		problem.Wrap(500, r.RequestURI, "restart resource", err).Send(w)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Switch the active Kubernetes context; recreates the service and informer factories
func (s *KubeatlasAPI) handleContextSwitch(w http.ResponseWriter, r *http.Request) {
	s.switchMu.Lock()
	defer s.switchMu.Unlock()

	var body struct {
		Context string `json:"context"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		problem.Wrap(400, r.RequestURI, "invalid request body", err).Send(w)
		return
	}

	if body.Context == "" {
		problem.Wrap(400, r.RequestURI, "missing context", errors.New("context name is required")).Send(w)
		return
	}

	if body.Context == s.currentContext {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	validContext := false

	for _, c := range s.contexts {
		if c == body.Context {
			validContext = true
			break
		}
	}

	if !validContext {
		problem.Wrap(400, r.RequestURI, "invalid context",
			fmt.Errorf("context %q does not exist", body.Context)).Send(w)
		return
	}

	log := logging.FromContext(r.Context())
	log.Info("🔄 switching Kubernetes context", "context", body.Context)

	newSvc, err := services.NewKubernetes(s.eventBroker.Broker, s.config.SingleNamespace, body.Context)
	if err != nil {
		problem.Wrap(500, r.RequestURI, "switch context", err).Send(w)
		return
	}

	old := s.kubeService
	s.kubeService = newSvc
	s.currentContext = body.Context

	old.Close()

	log.Info("✅ switched Kubernetes context", "context", body.Context)
	w.WriteHeader(http.StatusNoContent)
}

// Attempt to (re)connect to the cluster, typically after a disconnected boot or
// an unreachable context. It re-reads kubeconfig live — fixing KUBECONFIG and
// hitting retry recovers without restarting the process. On success the new
// service is swapped in (any previous one is closed) and connErr is cleared.
func (s *KubeatlasAPI) handleReconnect(w http.ResponseWriter, r *http.Request) {
	s.switchMu.Lock()
	defer s.switchMu.Unlock()

	log := logging.FromContext(r.Context())
	log.Info("🔄 attempting to connect to Kubernetes")

	// Re-discover contexts in case the user just fixed or added their kubeconfig.
	if contexts, current, err := services.GetKubeContexts(); err == nil {
		s.contexts = contexts
		if s.currentContext == "" {
			s.currentContext = current
		}
	}

	newSvc, err := services.NewKubernetes(s.eventBroker.Broker, s.config.SingleNamespace, s.currentContext)
	if err != nil {
		s.connErr = err
		log.Warn("⚠️  reconnect failed", "err", err)
		writeJSONError(w, http.StatusServiceUnavailable, err.Error())

		return
	}

	if old := s.kubeService; old != nil {
		old.Close()
	}

	s.kubeService = newSvc
	s.connErr = nil

	if newSvc.ContextName != "" {
		s.currentContext = newSvc.ContextName
	}

	log.Info("✅ connected to Kubernetes", "context", s.currentContext)
	w.WriteHeader(http.StatusNoContent)
}
