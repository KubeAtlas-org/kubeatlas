// ==========================================================================================
// Pod log fetching and streaming
// ==========================================================================================

package services

import (
	"context"
	"errors"
	"io"
	"log/slog"

	coreV1 "k8s.io/api/core/v1"
)

// Retrieves the logs of a specific pod in a given namespace
func (k *Kubernetes) GetPodLogs(
	ns, podName, container string, lineCount int, previous, timestamps bool,
) (string, error) {
	if ns == "" || podName == "" {
		return "", errors.New("namespace or pod name is empty")
	}

	if lineCount <= 0 {
		lineCount = 100 // Default to 100 lines if not specified
	}

	// Get the lines of logs from the pod
	req := k.clientSet.CoreV1().Pods(ns).GetLogs(podName, &coreV1.PodLogOptions{
		TailLines:  &[]int64{int64(lineCount)}[0], // We pass in how many lines we want to get
		Container:  container,
		Previous:   previous,
		Timestamps: timestamps,
	})

	logs, err := req.DoRaw(context.TODO())
	if err != nil {
		slog.Error("💥 failed to get pod logs", "pod", podName, "namespace", ns, "err", err)
		return "", err
	}

	return string(logs), nil
}

// StreamPodLogs streams live logs from a pod to the given writer, following until ctx is canceled
func (k *Kubernetes) StreamPodLogs(
	ctx context.Context, ns, podName, container string, lineCount int, previous, timestamps bool, w io.Writer,
) error {
	if ns == "" || podName == "" {
		return errors.New("namespace or pod name is empty")
	}

	if lineCount <= 0 {
		lineCount = 100
	}

	req := k.clientSet.CoreV1().Pods(ns).GetLogs(podName, &coreV1.PodLogOptions{
		TailLines:  &[]int64{int64(lineCount)}[0],
		Follow:     !previous, // can't follow previous container logs
		Container:  container,
		Previous:   previous,
		Timestamps: timestamps,
	})

	stream, err := req.Stream(ctx)
	if err != nil {
		slog.Error("💥 failed to stream pod logs", "pod", podName, "namespace", ns, "err", err)
		return err
	}
	defer stream.Close()

	errCh := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(w, stream)
		errCh <- copyErr
	}()

	select {
	case err = <-errCh:
	case <-ctx.Done():
		err = ctx.Err()
	}

	return err
}
