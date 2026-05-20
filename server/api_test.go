package main

import (
	"testing"

	"github.com/kubeatlas-org/kubeatlas/server/services"
)

func TestNewKubeatlasAPIWithService(t *testing.T) {
	mock := &MockKubeService{}
	broker := &services.KubeEventBroker{}
	conf := Config{Port: 8000}
	contexts := []string{"ctx1"}
	currentCtx := "ctx1"
	version := "1.0"
	buildInfo := "build"

	apiSvc := NewKubeatlasAPIWithService(conf, mock, broker, contexts, currentCtx, version, buildInfo)

	if apiSvc == nil {
		t.Fatalf("Expected non-nil API")
	}

	if apiSvc.config.Port != 8000 {
		t.Errorf("Expected port 8000, got %d", apiSvc.config.Port)
	}

	if apiSvc.Version != version {
		t.Errorf("Expected version %s, got %s", version, apiSvc.Version)
	}
}
