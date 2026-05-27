// ==========================================================================================
// TCP listener with a "port already in use" fallback
// ==========================================================================================

package main

import (
	"log/slog"
	"net"
)

// listen binds a TCP listener on addr. When the port was not pinned explicitly
// (portExplicit) and binding fails — almost always because the port is already
// in use — it falls back to an OS-assigned free port on the same host rather
// than dying. 8000 is a common port, so a click-and-run binary shouldn't refuse
// to start just because something (often a previous instance) holds it. The
// caller reads the actual bound port from the returned listener's Addr.
//
// We deliberately don't inspect the error to decide whether to fall back: the
// "address in use" errno is not portable (Windows reports WSAEADDRINUSE, which
// isn't in the standard syscall package), and for an unpinned port the intent is
// simply "give me a working port" regardless of why the preferred one failed.
//
// An explicit PORT is respected: if the user asked for a specific port and it
// can't be bound, that's a hard error, not a silent move to a different one.
func listen(addr string, portExplicit bool) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, nil
	}

	if portExplicit {
		return nil, err
	}

	host, _, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		return nil, err // surface the original bind error, not the parse error
	}

	// Port 0 asks the kernel for any free port.
	return net.Listen("tcp", net.JoinHostPort(host, "0"))
}

// logListenError reports a bind failure. An explicit PORT that won't bind is
// almost always already in use, so point the user at the fix.
func logListenError(err error, port int, portExplicit bool) {
	if portExplicit {
		slog.Error("💥 could not bind the requested port — it may be in use; set PORT to another or free it",
			"port", port, "err", err)
		return
	}

	slog.Error("💥 server failed to start", "err", err)
}
