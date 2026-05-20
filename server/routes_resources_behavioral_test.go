package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestHandleDeleteResource(t *testing.T) {
	mock := &MockKubeService{}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Delete("/api/resource/{namespace}/{kind}/{name}", apiSvc.handleDeleteResource)

	req := httptest.NewRequest("DELETE", "/api/resource/default/Pod/test-pod", nil)
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("Expected 204, got %v", rec.Code)
	}
}

func TestHandleDeleteResource_Error(t *testing.T) {
	mock := &MockKubeService{
		deleteError: errors.New("delete failed"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Delete("/api/resource/{namespace}/{kind}/{name}", apiSvc.handleDeleteResource)

	req := httptest.NewRequest("DELETE", "/api/resource/default/Pod/test-pod", nil)
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleResourceYAML(t *testing.T) {
	mock := &MockKubeService{
		getResource: &unstructured.Unstructured{
			Object: map[string]interface{}{
				"apiVersion": "v1",
				"kind":       "Pod",
				"metadata": map[string]interface{}{
					"name": "test-pod",
				},
			},
		},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/resource/{namespace}/{kind}/{name}/yaml", apiSvc.handleResourceYAML)

	req := httptest.NewRequest("GET", "/api/resource/default/Pod/test-pod/yaml?clientID=test", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "kind: Pod") {
		t.Errorf("Expected YAML output, got %s", rec.Body.String())
	}
}

func TestHandleApplyResourceYAML_Success(t *testing.T) {
	mock := &MockKubeService{}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/yaml", apiSvc.handleApplyResourceYAML)

	yamlBody := `
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: default
`
	req := httptest.NewRequest("POST", "/api/resource/default/Pod/test-pod/yaml", strings.NewReader(yamlBody))
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("Expected 204, got %v: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleDeleteResource_NoClientID(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Delete("/api/resource/{namespace}/{kind}/{name}", apiSvc.handleDeleteResource)

	req := httptest.NewRequest("DELETE", "/api/resource/default/Pod/test-pod", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected 403, got %v", rec.Code)
	}
}

func TestHandleResourceYAML_Error(t *testing.T) {
	mock := &MockKubeService{
		getError: errors.New("get failed"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/resource/{namespace}/{kind}/{name}/yaml", apiSvc.handleResourceYAML)

	req := httptest.NewRequest("GET", "/api/resource/default/Pod/test-pod/yaml", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleApplyResourceYAML_Error(t *testing.T) {
	mock := &MockKubeService{
		updateError: errors.New("update failed"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/yaml", apiSvc.handleApplyResourceYAML)

	yamlBody := "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test-pod"
	req := httptest.NewRequest("POST", "/api/resource/default/Pod/test-pod/yaml", strings.NewReader(yamlBody))
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleApplyResourceYAML_InvalidYAML(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/yaml", apiSvc.handleApplyResourceYAML)

	req := httptest.NewRequest("POST", "/api/resource/default/Pod/test-pod/yaml", strings.NewReader("invalid yaml"))
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %v", rec.Code)
	}
}

func TestHandleApplyResourceYAML_NoClientID(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/yaml", apiSvc.handleApplyResourceYAML)

	req := httptest.NewRequest("POST", "/api/resource/default/Pod/test-pod/yaml", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected 403, got %v", rec.Code)
	}
}
