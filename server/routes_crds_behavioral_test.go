package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
	"github.com/kubeatlas-org/kubeatlas/server/services"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestHandleCRDList(t *testing.T) {
	mock := &MockKubeService{
		crdInfo: []services.CRDInfo{
			{Kind: "Test", Group: "test.com", Version: "v1", Resource: "tests", Scope: "Namespaced"},
		},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/crds", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleCRDList(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}
}

func TestHandleCRDList_Error(t *testing.T) {
	mock := &MockKubeService{
		fetchError: errors.New("crd error"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/crds", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleCRDList(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleCRDResources(t *testing.T) {
	mock := &MockKubeService{
		fetchData: map[string][]unstructured.Unstructured{
			"cr": {{}},
		},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/crds/{group}/{version}/{resource}/{namespace}", apiSvc.handleCRDResources)

	req := httptest.NewRequest("GET", "/api/crds/test.com/v1/tests/default", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}
}

func TestHandleCRDResources_Error(t *testing.T) {
	mock := &MockKubeService{
		fetchError: errors.New("cr error"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/crds/{group}/{version}/{resource}/{namespace}", apiSvc.handleCRDResources)

	req := httptest.NewRequest("GET", "/api/crds/test.com/v1/tests/default", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}
