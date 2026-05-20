package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
)

func TestHandlePodLogs(t *testing.T) {
	mock := &MockKubeService{
		podLogs: "test logs",
	}

	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
		config: Config{
			EnablePodLogs: true,
		},
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/logs/{namespace}/{name}/{container}", apiSvc.handlePodLogs)

	req := httptest.NewRequest("GET", "/api/logs/default/test-pod/test-container", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}

	if rec.Body.String() != "test logs" {
		t.Errorf("Expected 'test logs', got %s", rec.Body.String())
	}
}

func TestHandlePodLogs_Disabled(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
		config: Config{
			EnablePodLogs: false,
		},
	}

	r := chi.NewRouter()
	r.Get("/api/logs/{namespace}/{podname}", apiSvc.handlePodLogs)

	req := httptest.NewRequest("GET", "/api/logs/default/test-pod", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "disabled") {
		t.Errorf("Expected 'disabled' message, got %s", rec.Body.String())
	}
}

func TestHandlePodLogs_Error(t *testing.T) {
	mock := &MockKubeService{
		fetchError: errors.New("logs error"),
	}

	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
		config: Config{
			EnablePodLogs: true,
		},
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/logs/{namespace}/{podname}", apiSvc.handlePodLogs)

	req := httptest.NewRequest("GET", "/api/logs/default/test-pod", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "Error fetching logs") {
		t.Errorf("Expected 'Error fetching logs' message, got %s", rec.Body.String())
	}
}

func TestHandlePodLogs_Follow(t *testing.T) {
	mock := &MockKubeService{}

	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
		config: Config{
			EnablePodLogs: true,
		},
		kubeService: mock,
	}

	r := chi.NewRouter()
	r.Get("/api/logs/{namespace}/{podname}", apiSvc.handlePodLogs)

	req := httptest.NewRequest("GET", "/api/logs/default/test-pod?follow=true", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}

	if rec.Body.String() != "streaming logs" {
		t.Errorf("Expected 'streaming logs', got %s", rec.Body.String())
	}
}
