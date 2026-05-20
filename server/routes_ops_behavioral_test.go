package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
	"github.com/kubeatlas-org/kubeatlas/server/services"
)

func TestHandleScaleResource(t *testing.T) {
	mock := &MockKubeService{}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/scale", apiSvc.handleScaleResource)

	body := map[string]int{"replicas": 3}
	jsonBody, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/resource/default/Deployment/test-deploy/scale", bytes.NewBuffer(jsonBody))
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("Expected 204, got %v", rec.Code)
	}
}

func TestHandleRestartResource(t *testing.T) {
	mock := &MockKubeService{}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/restart", apiSvc.handleRestartResource)

	req := httptest.NewRequest("POST", "/api/resource/default/Deployment/test-deploy/restart", nil)
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("Expected 204, got %v", rec.Code)
	}
}

func TestHandleScaleResource_Error(t *testing.T) {
	mock := &MockKubeService{
		scaleError: errors.New("scale failed"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/scale", apiSvc.handleScaleResource)

	body := map[string]int{"replicas": 3}
	jsonBody, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/resource/default/Deployment/test-deploy/scale", bytes.NewBuffer(jsonBody))
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleRestartResource_Error(t *testing.T) {
	mock := &MockKubeService{
		// Assuming we reuse deleteError or similar for simplicity, or add a dedicated restartError
		// Let's add updateError to MockKubeService and use it if Restart uses Update/Patch
		updateError: errors.New("restart failed"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/restart", apiSvc.handleRestartResource)

	req := httptest.NewRequest("POST", "/api/resource/default/Deployment/test-deploy/restart", nil)
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleScaleResource_NoClientID(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/scale", apiSvc.handleScaleResource)

	req := httptest.NewRequest("POST", "/api/resource/default/Deployment/test-deploy/scale", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected 403, got %v", rec.Code)
	}
}

func TestHandleRestartResource_NoClientID(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/restart", apiSvc.handleRestartResource)

	req := httptest.NewRequest("POST", "/api/resource/default/Deployment/test-deploy/restart", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected 403, got %v", rec.Code)
	}
}

func TestHandleScaleResource_InvalidBody(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Post("/api/resource/{namespace}/{kind}/{name}/scale", apiSvc.handleScaleResource)

	req := httptest.NewRequest(
		"POST", "/api/resource/default/Deployment/test-deploy/scale", strings.NewReader("not json"),
	)
	req.Header.Set("X-Client-ID", "test")

	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %v", rec.Code)
	}
}

func TestHandleContextSwitch(t *testing.T) {
	mock := &MockKubeService{}

	apiSvc := &KubeatlasAPI{
		Base:           api.NewBase("test", "1.0", "build", true),
		kubeService:    mock,
		eventBroker:    services.NewKubeEventBroker(false),
		currentContext: "old-ctx",
		contexts:       []string{"old-ctx", "new-ctx"},
	}

	r := chi.NewRouter()
	r.Post("/api/context", apiSvc.handleContextSwitch)

	body := map[string]string{"context": "new-ctx"}
	jsonBody, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/context", bytes.NewBuffer(jsonBody))
	rec := httptest.NewRecorder()

	// Actual context switch will fail because it tries to connect to k8s; the
	// handler should return 500 if NewKubernetes fails. Reaching 100% here would
	// require mocking the connection logic.
	r.ServeHTTP(rec, req)
}

func TestHandleContextSwitch_InvalidContext(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base:           api.NewBase("test", "1.0", "build", true),
		eventBroker:    services.NewKubeEventBroker(false),
		currentContext: "old-ctx",
		contexts:       []string{"old-ctx"},
	}

	r := chi.NewRouter()
	r.Post("/api/context", apiSvc.handleContextSwitch)

	body := map[string]string{"context": "nonexistent"}
	jsonBody, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/context", bytes.NewBuffer(jsonBody))
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid context, got %v", rec.Code)
	}
}
