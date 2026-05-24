package kubeatlas

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestPublicFSContents asserts the embedded tree contains the files the server
// serves. Running on every CI OS, this is also the cross-platform guard: embed
// paths are always forward-slashed, so a green run on Windows proves the path
// handling holds there too.
func TestPublicFSContents(t *testing.T) {
	f := PublicFS()

	for _, want := range []string{"index.html", "js/main.js", "css", "ext"} {
		if _, err := fs.Stat(f, want); err != nil {
			t.Errorf("embedded asset missing: %s (%v)", want, err)
		}
	}
}

// TestServeEmbeddedAssets exercises the actual serving path against the embedded
// FS — no cluster, no disk — so it validates runtime behavior on whatever OS
// the test runs on (not just compilation).
func TestServeEmbeddedAssets(t *testing.T) {
	f := PublicFS()

	// index.html, served the way the "/" route does.
	idx, err := f.Open("index.html")
	if err != nil {
		t.Fatalf("open index.html: %v", err)
	}
	defer idx.Close()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	http.ServeContent(rec, req, "index.html", time.Time{}, idx.(io.ReadSeeker))

	if rec.Code != http.StatusOK {
		t.Fatalf("index.html: got status %d, want 200", rec.Code)
	}

	if rec.Body.Len() == 0 {
		t.Fatal("index.html: empty body")
	}

	// A static asset, served the way the "/public/*" route does.
	srv := http.StripPrefix("/public/", http.FileServerFS(f))
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/public/js/main.js", nil)
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("js/main.js: got status %d, want 200", rec.Code)
	}

	if rec.Body.Len() == 0 {
		t.Fatal("js/main.js: empty body")
	}
}
