// ==========================================================================================
// Pod exec — interactive shell sessions via SPDY
// ==========================================================================================

package services

import (
	"context"
	"io"

	coreV1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// ExecPod opens an interactive exec session into a container using SPDY.
// stdin and stdout are bridged from/to the caller; stderr is merged into stdout.
// resizeQueue delivers terminal resize events during the session.
func (k *Kubernetes) ExecPod(
	ctx context.Context,
	namespace, pod, container string,
	stdin io.Reader, stdout io.Writer,
	resizeQueue remotecommand.TerminalSizeQueue,
) error {
	option := &coreV1.PodExecOptions{
		Container: container,
		Command:   []string{"sh"},
		Stdin:     true,
		Stdout:    true,
		Stderr:    true,
		TTY:       true,
	}

	req := k.clientSet.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(namespace).
		SubResource("exec").
		VersionedParams(option, scheme.ParameterCodec)

	exec, err := remotecommand.NewSPDYExecutor(k.restConfig, "POST", req.URL())
	if err != nil {
		return err
	}

	return exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             stdin,
		Stdout:            stdout,
		Stderr:            stdout, // merge stderr into stdout for display
		Tty:               true,
		TerminalSizeQueue: resizeQueue,
	})
}
