package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	kubeatlas "github.com/kubeatlas-org/kubeatlas"
)

// TestResolveStaticFS_Embedded: with no STATIC_DIR, the server serves from the
// embedded copy, so a built binary is self-contained.
func TestResolveStaticFS_Embedded(t *testing.T) {
	fsys := resolveStaticFS("", kubeatlas.PublicFS())

	srv := http.StripPrefix("/public/", http.FileServerFS(fsys))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/js/main.js", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("embedded js/main.js: got status %d, want 200", rec.Code)
	}
}

// TestResolveStaticFS_Disk: with STATIC_DIR set, the server serves that
// directory from disk — the dev loop that lets you edit public/ without a
// rebuild. t.TempDir keeps this cross-platform.
func TestResolveStaticFS_Disk(t *testing.T) {
	const body = "console.log('from disk');"

	dir := t.TempDir()

	if err := os.MkdirAll(filepath.Join(dir, "js"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(dir, "js", "main.js"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	fsys := resolveStaticFS(dir, kubeatlas.PublicFS())

	srv := http.StripPrefix("/public/", http.FileServerFS(fsys))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/js/main.js", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("disk js/main.js: got status %d, want 200", rec.Code)
	}

	if got := rec.Body.String(); got != body {
		t.Fatalf("disk js/main.js: got %q, want %q", got, body)
	}
}
