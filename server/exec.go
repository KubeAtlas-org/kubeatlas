// ==========================================================================================
// WebSocket handler for interactive pod exec/shell
// ==========================================================================================

package main

import (
	"encoding/binary"
	"io"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/kubeatlas-org/kubeatlas/server/logging"
)

// Binary frame types sent over the WebSocket
const (
	frameData   = 0 // raw terminal bytes (PTY output)
	frameResize = 1 // 4 bytes: uint16 LE cols, uint16 LE rows
	frameError  = 2 // error message as UTF-8 string
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

// execWsWriter writes PTY output to the WebSocket as binary data frames.
type execWsWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *execWsWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	msg := make([]byte, 1+len(p))
	msg[0] = frameData
	copy(msg[1:], p)

	if err := w.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
		return 0, err
	}

	return len(p), nil
}

func (w *execWsWriter) writeError(text string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	msg := append([]byte{frameError}, []byte(text)...)
	_ = w.conn.WriteMessage(websocket.BinaryMessage, msg)
}

// termSizeQueue delivers terminal resize events to the SPDY executor.
type termSizeQueue struct {
	ch chan remotecommand.TerminalSize
}

func (t *termSizeQueue) Next() *remotecommand.TerminalSize {
	size, ok := <-t.ch
	if !ok {
		return nil
	}

	return &size
}

// handleExec upgrades an HTTP connection to WebSocket and starts an interactive
// exec session into the specified pod/container.
//
// Route: GET /ws/exec/{namespace}/{pod}?container=<name>
//
// Binary protocol (client → server):
//   - byte 0 = frameData:   remaining bytes are PTY input
//   - byte 0 = frameResize: bytes 1-2 = uint16 LE cols, bytes 3-4 = uint16 LE rows
//
// Binary protocol (server → client):
//   - byte 0 = frameData:  remaining bytes are PTY output
//   - byte 0 = frameError: remaining bytes are UTF-8 error text
func (s *KubeatlasAPI) handleExec(w http.ResponseWriter, r *http.Request) {
	ns := chi.URLParam(r, "namespace")
	pod := chi.URLParam(r, "pod")
	container := r.URL.Query().Get("container")

	log := logging.FromContext(r.Context()).With(
		"namespace", ns, "pod", pod, "container", container)

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Error("💥 WebSocket upgrade failed for exec", "err", err)
		return
	}

	defer conn.Close()

	log.Info("🐚 exec session started")

	writer := &execWsWriter{conn: conn}
	sizeQ := &termSizeQueue{ch: make(chan remotecommand.TerminalSize, 4)}

	// pipeR/pipeW form the stdin pipe from WebSocket to SPDY
	pipeR, pipeW := io.Pipe()

	// Run the SPDY exec in a goroutine; signal done via channel
	ctx := r.Context()
	execDone := make(chan error, 1)

	go func() {
		execDone <- s.kubeService.ExecPod(ctx, ns, pod, container, pipeR, writer, sizeQ)
	}()

	// Read WebSocket frames until the connection closes or exec finishes
readLoop:
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break // client disconnected
		}

		if len(msg) == 0 {
			continue
		}

		switch msg[0] {
		case frameData:
			if len(msg) > 1 {
				if _, err := pipeW.Write(msg[1:]); err != nil {
					break readLoop // stdin pipe closed; exec is done
				}
			}

		case frameResize:
			if len(msg) >= 5 {
				cols := binary.LittleEndian.Uint16(msg[1:3])
				rows := binary.LittleEndian.Uint16(msg[3:5])
				select {
				case sizeQ.ch <- remotecommand.TerminalSize{Width: cols, Height: rows}:
				default:
				}
			}
		}
	}

	// Close the write-end of the pipe so the SPDY stdin reader gets EOF
	pipeW.Close()
	close(sizeQ.ch)

	if execErr := <-execDone; execErr != nil {
		log.Warn("🐚 exec session ended with error", "err", execErr)
		writer.writeError(execErr.Error())
	} else {
		log.Info("🐚 exec session closed cleanly")
	}
}
