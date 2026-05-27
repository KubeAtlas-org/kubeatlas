//go:build smoke

// Runtime smoke test: builds the binary and runs it end-to-end to exercise the
// platform-dependent startup behaviour (port binding + fallback, single-instance
// coordination, disconnected boot) on the actual OS. Gated behind the `smoke`
// build tag so it stays out of the normal `go test` run; CI invokes it per-OS
// with `go test -tags smoke`. No cluster needed — a bogus KUBECONFIG forces the
// disconnected path, and OPEN_BROWSER=false keeps it headless.
package main

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"testing"
	"time"
)

var binPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "kubeatlas-smoke")
	if err != nil {
		fmt.Fprintln(os.Stderr, "mktemp:", err)
		os.Exit(1)
	}

	binPath = filepath.Join(dir, "kubeatlas")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}

	if out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build failed: %v\n%s", err, out)
		os.Exit(1)
	}

	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// safeBuffer is a concurrency-safe sink for the child's stderr (os/exec copies
// to it from a goroutine while the test reads it).
type safeBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.b.Write(p)
}

func (s *safeBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.b.String()
}

// start launches the binary with the given extra env on top of a headless,
// cluster-less base. Returns the command and its captured stderr.
func start(t *testing.T, env map[string]string) (*exec.Cmd, *safeBuffer) {
	t.Helper()

	cmd := exec.Command(binPath)
	cmd.Env = append(os.Environ(),
		"OPEN_BROWSER=false",
		"LOG_FORMAT=text",
		"KUBECONFIG="+filepath.Join(t.TempDir(), "nonexistent-kubeconfig"),
	)

	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	buf := &safeBuffer{}
	cmd.Stdout = buf
	cmd.Stderr = buf

	if err := cmd.Start(); err != nil {
		t.Fatalf("start binary: %v", err)
	}

	return cmd, buf
}

func freePort(t *testing.T) int {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer ln.Close()

	return ln.Addr().(*net.TCPAddr).Port
}

// waitForStatus polls /api/status until it answers 200 or the deadline passes.
func waitForStatus(t *testing.T, port int, within time.Duration) {
	t.Helper()

	deadline := time.Now().Add(within)
	url := fmt.Sprintf("http://127.0.0.1:%d/api/status", port)

	for time.Now().Before(deadline) {
		resp, err := http.Get(url) //nolint:gosec,noctx
		if err == nil {
			resp.Body.Close()

			if resp.StatusCode == http.StatusOK {
				return
			}
		}

		time.Sleep(100 * time.Millisecond)
	}

	t.Fatalf("server did not become ready on :%d within %s", port, within)
}

// Anchored to the "listening" log line so it captures the actual bound port,
// not the requested address printed in the startup banner.
var listeningRE = regexp.MustCompile(`listening" address=127\.0\.0\.1:(\d+)`)

// boundPort waits for the "listening" log line and returns the actual port.
func boundPort(t *testing.T, buf *safeBuffer, within time.Duration) int {
	t.Helper()

	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if m := listeningRE.FindStringSubmatch(buf.String()); m != nil {
			var p int

			_, _ = fmt.Sscanf(m[1], "%d", &p)

			return p
		}

		time.Sleep(100 * time.Millisecond)
	}

	t.Fatalf("no listening address in output:\n%s", buf.String())

	return 0
}

// Disconnected boot still serves: no cluster, but the HTTP server comes up.
func TestSmoke_DisconnectedServes(t *testing.T) {
	port := freePort(t)

	cmd, _ := start(t, map[string]string{"PORT": fmt.Sprintf("%d", port)})
	defer func() { _ = cmd.Process.Kill() }()

	waitForStatus(t, port, 15*time.Second)
}

// A busy default port doesn't kill startup: the binary binds a different port.
func TestSmoke_PortFallback(t *testing.T) {
	// Occupy 8000 so the default bind collides and must fall back.
	occupied, err := net.Listen("tcp", "127.0.0.1:8000")
	if err != nil {
		t.Skipf("can't occupy :8000 on this runner (%v) — skipping fallback smoke", err)
	}
	defer occupied.Close()

	cmd, buf := start(t, nil) // no PORT → tries 8000, must fall back
	defer func() { _ = cmd.Process.Kill() }()

	port := boundPort(t, buf, 15*time.Second)
	if port == 8000 {
		t.Fatalf("expected a fallback port, got 8000")
	}

	waitForStatus(t, port, 15*time.Second)
}

// A second launch detects the first and exits instead of starting a second
// server; the first keeps serving.
func TestSmoke_SingleInstance(t *testing.T) {
	runtimeDir := t.TempDir() // shared so the 2nd launch sees the 1st's state file

	first, buf := start(t, map[string]string{"XDG_RUNTIME_DIR": runtimeDir})
	defer func() { _ = first.Process.Kill() }()

	port := boundPort(t, buf, 15*time.Second)
	waitForStatus(t, port, 15*time.Second)

	second, _ := start(t, map[string]string{"XDG_RUNTIME_DIR": runtimeDir})

	done := make(chan error, 1)
	go func() { done <- second.Wait() }()

	select {
	case <-done: // exited on its own — focused the running instance
	case <-time.After(10 * time.Second):
		_ = second.Process.Kill()
		t.Fatal("second instance did not exit — single-instance guard failed")
	}

	// The first instance must still be serving.
	waitForStatus(t, port, 5*time.Second)
}
