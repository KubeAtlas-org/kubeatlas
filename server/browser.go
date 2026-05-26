// ==========================================================================================
// Best-effort "open the UI in the default browser on startup" helper
// ==========================================================================================

package main

import (
	"log/slog"
	"os/exec"
	"runtime"
)

// openBrowser opens url in the OS default browser. It is best-effort: on a
// headless box (no browser, no display) the launcher command simply fails, which
// is logged at debug level and never blocks or fails startup. The command runs
// detached (Start, not Run) so it never holds up the server.
func openBrowser(url string) {
	var (
		cmd  string
		args []string
	)

	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "windows":
		cmd = "rundll32"
		args = []string{"url.dll,FileProtocolHandler"}
	default: // linux, *bsd, etc.
		cmd = "xdg-open"
	}

	args = append(args, url)

	if err := exec.Command(cmd, args...).Start(); err != nil {
		slog.Debug("could not open browser", "url", url, "err", err)
	}
}
