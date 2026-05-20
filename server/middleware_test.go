package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHostValidationMiddleware(t *testing.T) {
	tests := []struct {
		name        string
		bindAddress string
		requestHost string
		wantStatus  int
	}{
		{
			name:        "allow localhost",
			bindAddress: "127.0.0.1",
			requestHost: "localhost",
			wantStatus:  http.StatusOK,
		},
		{
			name:        "allow bind address",
			bindAddress: "192.168.1.100",
			requestHost: "192.168.1.100",
			wantStatus:  http.StatusOK,
		},
		{
			name:        "reject invalid host",
			bindAddress: "127.0.0.1",
			requestHost: "malicious.com",
			wantStatus:  http.StatusForbidden,
		},
		{
			name:        "allow any on 0.0.0.0",
			bindAddress: "0.0.0.0",
			requestHost: "anyhost.com",
			wantStatus:  http.StatusOK,
		},
		{
			name:        "allow localhost with port",
			bindAddress: "127.0.0.1",
			requestHost: "localhost:8080",
			wantStatus:  http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})
			handler := hostValidationMiddleware(tt.bindAddress)(ok)

			req := httptest.NewRequest("GET", "http://"+tt.requestHost, nil)
			// httptest.NewRequest doesn't always set the Host header correctly from the URL for all versions
			req.Host = tt.requestHost

			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("HostValidationMiddleware() status = %v, want %v", rec.Code, tt.wantStatus)
			}
		})
	}
}
