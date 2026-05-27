package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestInstanceState_RoundTrip(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	want := instanceState{PID: 4242, Port: 8137, URL: "http://127.0.0.1:8137", Started: time.Now()}
	if err := writeInstanceState(want); err != nil {
		t.Fatalf("write: %v", err)
	}

	path, _ := instanceStatePath()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}

	var got instanceState
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if got.PID != want.PID || got.Port != want.Port || got.URL != want.URL {
		t.Errorf("roundtrip mismatch: got %+v, want %+v", got, want)
	}

	removeInstanceState()

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("state file should be gone after removeInstanceState")
	}
}

// A live instance answering /api/status is found.
func TestFindRunningInstance_Live(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/status" {
			w.WriteHeader(http.StatusOK)
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if err := writeInstanceState(instanceState{PID: os.Getpid(), URL: srv.URL}); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, ok := findRunningInstance(); !ok {
		t.Error("expected to find the live instance")
	}
}

// A recorded instance that no longer answers is treated as stale and its file
// removed, so the caller can claim ownership.
func TestFindRunningInstance_Stale(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	// Start then immediately close, leaving a URL whose port is no longer served.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := srv.URL
	srv.Close()

	if err := writeInstanceState(instanceState{PID: 999999, URL: deadURL}); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, ok := findRunningInstance(); ok {
		t.Error("expected the stale instance to be rejected")
	}

	path, _ := instanceStatePath()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("stale state file should have been removed")
	}
}
