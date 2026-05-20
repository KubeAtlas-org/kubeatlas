// ==========================================================================================
// CRD handlers — list definitions and fetch instances
// ==========================================================================================

package main

import (
	"net/http"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"
)

// List all discovered CRDs in the cluster
func (s *KubeatlasAPI) handleCRDList(w http.ResponseWriter, r *http.Request) {
	crds, err := s.kubeService.DiscoverCRDs()
	if err != nil {
		problem.Wrap(500, r.RequestURI, "discover CRDs", err).Send(w)
		return
	}

	s.ReturnJSON(w, crds)
}

// List instances of a specific CRD
func (s *KubeatlasAPI) handleCRDResources(w http.ResponseWriter, r *http.Request) {
	group := chi.URLParam(r, "group")
	version := chi.URLParam(r, "version")
	resource := chi.URLParam(r, "resource")
	ns := chi.URLParam(r, "namespace")

	// Use "_" for cluster-scoped CRDs
	if ns == "_" {
		ns = ""
	}

	items, err := s.kubeService.GetCRDResources(ns, group, version, resource)
	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch CRD resources", err).Send(w)
		return
	}

	s.ReturnJSON(w, items)
}
