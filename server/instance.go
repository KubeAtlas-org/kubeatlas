// ==========================================================================================
// Single-instance coordination
//
// By default only one KubeAtlas runs per user: re-launching detects the running
// instance and opens a browser to it instead of starting a second server (which
// would mean a second full set of cluster informers/watch streams). The running
// instance is recorded in a small per-user state file and confirmed live by
// probing it — so a crashed instance's stale file self-heals on the next launch.
// ==========================================================================================

package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

// instanceState is the on-disk record of the running instance.
type instanceState struct {
	PID     int       `json:"pid"`
	Port    int       `json:"port"`
	URL     string    `json:"url"`
	Started time.Time `json:"started"`
}

// instanceStatePath returns the per-user path of the instance state file,
// creating its parent directory. Prefers XDG_RUNTIME_DIR (Linux runtime dir),
// falling back to the OS user cache dir for portability.
func instanceStatePath() (string, error) {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		var err error

		dir, err = os.UserCacheDir()
		if err != nil {
			return "", err
		}
	}

	dir = filepath.Join(dir, "kubeatlas")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	return filepath.Join(dir, "instance.json"), nil
}

// writeInstanceState atomically records the running instance (temp file + rename
// so a reader never sees a half-written file).
func writeInstanceState(st instanceState) error {
	path, err := instanceStatePath()
	if err != nil {
		return err
	}

	data, err := json.Marshal(st)
	if err != nil {
		return err
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}

// removeInstanceState deletes the state file. Best-effort: a leftover file is
// harmless because findRunningInstance probes for liveness before trusting it.
func removeInstanceState() {
	if path, err := instanceStatePath(); err == nil {
		_ = os.Remove(path)
	}
}

// probeInstance reports whether a live KubeAtlas answers at url. /api/status is
// KubeAtlas's own endpoint and returns 200 regardless of cluster connectivity,
// so it distinguishes us from an unrelated service that grabbed the port.
func probeInstance(url string) bool {
	client := &http.Client{Timeout: 500 * time.Millisecond}

	resp, err := client.Get(url + "/api/status")
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
}

// findRunningInstance returns the recorded instance if one is actually live.
// A stale record (no response) is removed so the caller can claim ownership.
func findRunningInstance() (*instanceState, bool) {
	path, err := instanceStatePath()
	if err != nil {
		return nil, false
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false // no record yet
	}

	var st instanceState
	if err := json.Unmarshal(data, &st); err != nil {
		_ = os.Remove(path) // corrupt; discard
		return nil, false
	}

	if !probeInstance(st.URL) {
		_ = os.Remove(path) // stale (crashed/exited); self-heal
		return nil, false
	}

	return &st, true
}

// focusRunningInstance reports whether another instance is already running for
// this user; when so it opens a browser to it (if enabled) so the caller can
// exit instead of starting a second server. A no-op returning false when
// single-instance coordination is off or PORT was set explicitly (a deliberate
// separate instance).
func focusRunningInstance(config Config, isLoopback bool) bool {
	if !config.SingleInstance || config.PortExplicit {
		return false
	}

	st, ok := findRunningInstance()
	if !ok {
		return false
	}

	slog.Info("👋 KubeAtlas is already running — focusing it", "url", st.URL, "pid", st.PID)

	if config.OpenBrowser && isLoopback {
		openBrowser(st.URL)
	}

	return true
}

// recordInstance writes this process's state file and removes it on Ctrl-C /
// SIGTERM (a normal return is handled by the caller's defer). Best-effort: a
// write failure only forfeits the single-instance convenience.
func recordInstance(port int, url string) {
	if err := writeInstanceState(instanceState{
		PID: os.Getpid(), Port: port, URL: url, Started: time.Now(),
	}); err != nil {
		slog.Warn("could not record single-instance state", "err", err)
		return
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigCh
		removeInstanceState()
		os.Exit(0)
	}()
}
