// ==========================================================================================
// SSE streaming, namespace list, and data fetch handlers
// ==========================================================================================

package main

import (
	"errors"
	"net/http"
	"time"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
)

// Establish the SSE connection for streaming updates each client
func (s *KubeatlasAPI) handleSSE(w http.ResponseWriter, r *http.Request) {
	clientID, ok := requireClientID(w, r)
	if !ok {
		return
	}

	if err := s.eventBroker.Stream(clientID, w, *r); err != nil {
		logging.FromContext(r.Context()).Error("💥 SSE broker stream error", "err", err)
	}
}

// Returns namespaces, cluster host, version, and build info in a single response.
func (s *KubeatlasAPI) handleNamespaceList(w http.ResponseWriter, r *http.Request) {
	log := logging.FromContext(r.Context())
	log.Info("🔍 fetching list of namespaces")

	// Disconnected boot: no cluster connection. Return a 200 the frontend can act
	// on (the error to show, plus the contexts it may switch to), rather than an
	// error status, so the page renders a reconnect prompt instead of breaking.
	if s.kubeService == nil {
		msg := "not connected to a Kubernetes cluster"
		if s.connErr != nil {
			msg = s.connErr.Error()
		}

		s.ReturnJSON(w, NamespaceListResult{
			Connected:       false,
			ConnectionError: msg,
			Version:         s.Version,
			BuildInfo:       s.BuildInfo,
			PodLogsEnabled:  s.config.EnablePodLogs,
			CurrentContext:  s.currentContext,
			Contexts:        s.contexts,
		})

		return
	}

	var (
		namespaces []string
		err        error
	)

	if s.config.SingleNamespace != "" {
		namespaces = []string{s.config.SingleNamespace}
	} else {
		t0 := time.Now()
		namespaces, err = s.kubeService.GetNamespaces()

		logging.LogServiceCall(r.Context(), "GetNamespaces", time.Since(t0))

		if err != nil {
			problem.Wrap(500, r.RequestURI, "namespaces", err).Send(w)
			return
		}

		if re := s.config.NameSpaceFilterRegexp; re != nil {
			filtered := make([]string, 0, len(namespaces))

			for _, ns := range namespaces {
				if !re.MatchString(ns) {
					filtered = append(filtered, ns)
				}
			}

			if len(filtered) == 0 {
				problem.Wrap(500, r.RequestURI, "no namespaces found",
					errors.New("no namespaces match the filter")).Send(w)

				return
			}

			namespaces = filtered
		}
	}

	res := NamespaceListResult{
		Connected:        true,
		ClusterHost:      s.kubeService.GetClusterHost(),
		Namespaces:       namespaces,
		Version:          s.Version,
		BuildInfo:        s.BuildInfo,
		PodLogsEnabled:   s.config.EnablePodLogs,
		MetricsAvailable: s.kubeService.MetricsAvailable(),
		CurrentContext:   s.currentContext,
		Contexts:         s.contexts,
	}

	s.ReturnJSON(w, res)
}

// Return the resources for a specific namespace
func (s *KubeatlasAPI) handleFetchData(w http.ResponseWriter, r *http.Request) {
	clientID, ok := requireClientID(w, r)
	if !ok {
		return
	}

	ns := chi.URLParam(r, "namespace")
	allNamespaces := ns == AllNamespacesSentinel
	logging.FromContext(r.Context()).Info("🍵 fetching resources", "namespace", ns)

	if s.config.SingleNamespace != "" && ns != s.config.SingleNamespace {
		problem.Wrap(403, r.RequestURI, "single namespace mode",
			errors.New("only namespace permitted is:"+s.config.SingleNamespace)).Send(w)
		return
	}

	// Atomically moves the client into the namespace SSE group so it only receives
	// events for this namespace going forward. All-namespaces clients land in the
	// shared "_all_" group that the namespaced event handlers also fan out to.
	s.eventBroker.MoveClientToGroup(clientID, ns)

	if !allNamespaces && !s.kubeService.CheckNamespaceExists(ns) {
		problem.Wrap(404, r.RequestURI, "namespace not found", errors.New("namespace does not exist")).Send(w)
		return
	}

	fetchNS := ns
	if allNamespaces {
		fetchNS = ""
	}

	t0 := time.Now()
	data, err := s.kubeService.FetchNamespace(fetchNS)
	logging.LogServiceCall(r.Context(), "FetchNamespace", time.Since(t0), "namespace", fetchNS)

	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch data", err).Send(w)
		return
	}

	s.ReturnJSON(w, data)
}

// Return cluster-scoped resources (Nodes, PVs, etc.)
func (s *KubeatlasAPI) handleFetchClusterData(w http.ResponseWriter, r *http.Request) {
	log := logging.FromContext(r.Context())
	log.Info("🍵 fetching cluster-scoped resources")

	t0 := time.Now()
	data, err := s.kubeService.FetchClusterResources()

	logging.LogServiceCall(r.Context(), "FetchClusterResources", time.Since(t0))

	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch cluster data", err).Send(w)
		return
	}

	s.ReturnJSON(w, data)
}
