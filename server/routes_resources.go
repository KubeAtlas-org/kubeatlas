// ==========================================================================================
// Resource CRUD handlers — delete, YAML view, YAML apply
// ==========================================================================================

package main

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	sigsYaml "sigs.k8s.io/yaml"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
)

// Delete a Kubernetes resource by namespace, kind, and name
func (s *KubeatlasAPI) handleDeleteResource(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Client-ID") == "" {
		http.Error(w, "Missing X-Client-ID header", http.StatusForbidden)
		return
	}

	ns := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")

	logging.FromContext(r.Context()).Info("🗑️ deleting resource", "kind", kind, "name", name, "namespace", ns)

	if err := s.kubeService.DeleteResource(ns, kind, name); err != nil {
		problem.Wrap(500, r.RequestURI, "delete resource", err).Send(w)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Return YAML for a single resource; namespace is "_" for cluster-scoped kinds
func (s *KubeatlasAPI) handleResourceYAML(w http.ResponseWriter, r *http.Request) {
	ns := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")

	if ns == "_" {
		ns = ""
	}

	logging.FromContext(r.Context()).Info("📄 fetching YAML", "kind", kind, "name", name, "namespace", ns)

	t0 := time.Now()
	obj, err := s.kubeService.GetResource(ns, kind, name)
	logging.LogServiceCall(r.Context(), "GetResource", time.Since(t0), "kind", kind, "name", name)

	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch resource", err).Send(w)
		return
	}

	yamlBytes, err := sigsYaml.Marshal(obj.Object)
	if err != nil {
		problem.Wrap(500, r.RequestURI, "marshal yaml", err).Send(w)
		return
	}

	s.ReturnText(w, string(yamlBytes))
}

// Apply (replace) a resource from YAML submitted in the request body
func (s *KubeatlasAPI) handleApplyResourceYAML(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Client-ID") == "" {
		http.Error(w, "Missing X-Client-ID header", http.StatusForbidden)
		return
	}

	ns := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")

	if ns == "_" {
		ns = ""
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "read body", err).Send(w)
		return
	}

	obj, err := parseAndValidateResource(body, kind, name)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "invalid resource", err).Send(w)
		return
	}

	logging.FromContext(r.Context()).Info("📝 applying YAML", "kind", kind, "name", name, "namespace", ns)

	if err = s.kubeService.UpdateResource(ns, obj); err != nil {
		problem.Wrap(500, r.RequestURI, "apply resource", err).Send(w)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// parseAndValidateResource converts YAML bytes to an unstructured Kubernetes object
// and validates that the Name and Kind match the expected values.
// This is extracted from handleApplyResourceYAML to enable unit and fuzz testing.
func parseAndValidateResource(yamlBytes []byte, expectedKind, expectedName string) (*unstructured.Unstructured, error) {
	jsonBytes, err := sigsYaml.YAMLToJSON(yamlBytes)
	if err != nil {
		return nil, errors.New("invalid YAML: " + err.Error())
	}

	obj := &unstructured.Unstructured{}
	if err = obj.UnmarshalJSON(jsonBytes); err != nil {
		return nil, errors.New("unmarshal YAML: " + err.Error())
	}

	if obj.GetName() != expectedName || obj.GetKind() != expectedKind {
		return nil, errors.New("resource mismatch: YAML name/kind does not match URL")
	}

	return obj, nil
}
