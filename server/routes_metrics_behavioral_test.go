package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestHandlePodMetrics(t *testing.T) {
	mock := &MockKubeService{
		fetchData: map[string][]unstructured.Unstructured{
			"metrics": {{}},
		},
		metrics: true,
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/metrics/pods/{namespace}", apiSvc.handlePodMetrics)

	req := httptest.NewRequest("GET", "/api/metrics/pods/default", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}
}

func TestHandlePodMetrics_Error(t *testing.T) {
	mock := &MockKubeService{
		fetchError: errors.New("metrics error"),
		metrics:    true,
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/metrics/pods/{namespace}", apiSvc.handlePodMetrics)

	req := httptest.NewRequest("GET", "/api/metrics/pods/default", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleNodeMetrics(t *testing.T) {
	mock := &MockKubeService{
		fetchData: map[string][]unstructured.Unstructured{
			"metrics": {{}},
		},
		metrics: true,
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/metrics/nodes", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNodeMetrics(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}
}

func TestHandleNodeMetrics_Error(t *testing.T) {
	mock := &MockKubeService{
		fetchError: errors.New("metrics error"),
		metrics:    true,
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/metrics/nodes", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNodeMetrics(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}
