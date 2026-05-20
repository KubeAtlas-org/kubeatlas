// ==========================================================================================
// Metrics handlers — pod and node CPU/memory usage
// ==========================================================================================

package main

import (
	"errors"
	"net/http"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"
)

// Return CPU/memory metrics for pods in a namespace
func (s *KubeatlasAPI) handlePodMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.kubeService.MetricsAvailable() {
		problem.Wrap(404, r.RequestURI, "metrics not available",
			errors.New("metrics-server is not installed")).Send(w)

		return
	}

	ns := chi.URLParam(r, "namespace")
	if ns == AllNamespacesSentinel {
		ns = ""
	}

	metrics, err := s.kubeService.GetPodMetrics(ns)
	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch pod metrics", err).Send(w)
		return
	}

	s.ReturnJSON(w, metrics)
}

// Return CPU/memory metrics for all nodes
func (s *KubeatlasAPI) handleNodeMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.kubeService.MetricsAvailable() {
		problem.Wrap(404, r.RequestURI, "metrics not available",
			errors.New("metrics-server is not installed")).Send(w)

		return
	}

	metrics, err := s.kubeService.GetNodeMetrics()
	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch node metrics", err).Send(w)
		return
	}

	s.ReturnJSON(w, metrics)
}
