// ==========================================================================================
// Pod log handlers — fetch and stream
// ==========================================================================================

package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	"github.com/go-chi/chi/v5"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
)

// Pull logs for a specific pod in a namespace
func (s *KubeatlasAPI) handlePodLogs(w http.ResponseWriter, r *http.Request) {
	if !s.config.EnablePodLogs {
		s.ReturnText(w, "Viewing logs has been disabled by the administrator")
		return
	}

	ns := chi.URLParam(r, "namespace")
	podName := chi.URLParam(r, "podname")
	container := r.URL.Query().Get("container")
	previous := r.URL.Query().Get("previous") == "true"
	timestamps := r.URL.Query().Get("timestamps") == "true"

	count := r.URL.Query().Get("max")
	if count == "" {
		count = "100" // Default to 100 lines if not specified
	}

	logCount, err := strconv.Atoi(count)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "invalid log count", err).Send(w)
		return
	}

	if r.URL.Query().Get("follow") == "true" {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")

		fw := &flushWriter{w: w, f: flusher}

		err = s.kubeService.StreamPodLogs(r.Context(), ns, podName, container, logCount, previous, timestamps, fw)
		if err != nil {
			logging.FromContext(r.Context()).Error("💥 log stream ended",
				"namespace", ns, "pod", podName, "err", err)
		}

		return
	}

	t0 := time.Now()
	logs, err := s.kubeService.GetPodLogs(ns, podName, container, logCount, previous, timestamps)
	logging.LogServiceCall(r.Context(), "GetPodLogs", time.Since(t0), "namespace", ns, "pod", podName)

	if err != nil {
		// Note: We don't send a problem response here, as we want to return something even if there's an error
		// This is more graceful as the pod might not be in a state to fetch logs
		logs = "Error fetching logs: " + err.Error()
	}

	s.ReturnText(w, logs)
}
