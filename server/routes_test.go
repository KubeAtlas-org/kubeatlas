package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestNoCache(t *testing.T) {
	handler := noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	headers := []string{"Cache-Control", "Pragma"}
	for _, h := range headers {
		if rec.Header().Get(h) == "" {
			t.Errorf("noCache() missing header: %s", h)
		}
	}
}

func TestRequireClientID(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		wantID     string
		wantOK     bool
		wantStatus int
	}{
		{
			name:       "valid id",
			query:      "?clientID=user-123",
			wantID:     "user-123",
			wantOK:     true,
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing id",
			query:      "",
			wantID:     "",
			wantOK:     false,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/"+tt.query, nil)
			rec := httptest.NewRecorder()

			id, ok := requireClientID(rec, req)

			if id != tt.wantID {
				t.Errorf("requireClientID() id = %v, want %v", id, tt.wantID)
			}

			if ok != tt.wantOK {
				t.Errorf("requireClientID() ok = %v, want %v", ok, tt.wantOK)
			}

			if !ok && rec.Code != tt.wantStatus {
				t.Errorf("requireClientID() status = %v, want %v", rec.Code, tt.wantStatus)
			}
		})
	}
}

func TestAddRoutes(t *testing.T) {
	apiSvc := &KubeatlasAPI{}
	r := chi.NewRouter()
	apiSvc.AddRoutes(r)
}

type mockFlusher struct {
	flushed bool
}

func (m *mockFlusher) Flush() {
	m.flushed = true
}

func TestFlushWriter(t *testing.T) {
	rec := httptest.NewRecorder()
	mf := &mockFlusher{}
	fw := &flushWriter{w: rec, f: mf}

	data := []byte("test")
	n, err := fw.Write(data)

	if err != nil {
		t.Errorf("flushWriter.Write() error = %v", err)
	}

	if n != len(data) {
		t.Errorf("flushWriter.Write() n = %v, want %v", n, len(data))
	}

	if !mf.flushed {
		t.Errorf("flushWriter.Write() did not call Flush()")
	}

	if rec.Body.String() != "test" {
		t.Errorf("flushWriter.Write() body = %v, want %v", rec.Body.String(), "test")
	}
}
