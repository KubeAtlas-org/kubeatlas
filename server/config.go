// ==========================================================================================
// Server configuration via environment variables
// ==========================================================================================

package main

import (
	"log/slog"
	"os"
	"regexp"
	"strconv"
)

// Config holds the configuration for the system
type Config struct {
	Port                  int
	PortExplicit          bool // PORT was set to a valid value; don't fall back to a free port if busy
	NameSpaceFilter       string
	NameSpaceFilterRegexp *regexp.Regexp
	SingleNamespace       string
	Debug                 bool
	EnablePodLogs         bool
	BindAddress           string
	LogLevel              string // debug | info | warn | error (default: info)
	LogFormat             string // text | json (default: text)
	StaticDir             string // serve frontend from this dir instead of the embedded copy
	Dev                   bool   // dev-loop mode (KUBEATLAS_DEV): flips the UX defaults below off
	OpenBrowser           bool   // open the default browser on startup (loopback binds only)
	SingleInstance        bool   // detect an already-running instance and focus it instead of starting another
}

// Parse the environment variables and return a Config struct
// Also provides default values if the environment variables are not set
func getConfig() Config {
	return parseConfig(os.Getenv)
}

// envBool parses a boolean env var via getenv, returning def when it is unset or
// not a valid bool.
func envBool(getenv func(string) string, key string, def bool) bool {
	if s := getenv(key); s != "" {
		if b, err := strconv.ParseBool(s); err == nil {
			return b
		}
	}

	return def
}

// parseConfig is the testable internal version of getConfig
func parseConfig(getenv func(string) string) Config {
	// Default values
	port := 8000
	portExplicit := false

	if portEnv := getenv("PORT"); portEnv != "" {
		if p, err := strconv.Atoi(portEnv); err == nil {
			port = p
			portExplicit = true
		}
	}

	singleNamespace := getenv("SINGLE_NAMESPACE")
	nameSpaceFilter := getenv("NAMESPACE_FILTER")

	var nameSpaceFilterRegexp *regexp.Regexp

	if nameSpaceFilter != "" {
		r, err := regexp.Compile(nameSpaceFilter)
		if err != nil {
			slog.Warn("⚠️  NAMESPACE_FILTER is not a valid regex — filter will be ignored",
				"pattern", nameSpaceFilter, "err", err)
		} else {
			nameSpaceFilterRegexp = r
		}
	}

	enablePodLogs := !envBool(getenv, "DISABLE_POD_LOGS", false)
	debug := envBool(getenv, "DEBUG", false)

	bindAddress := "127.0.0.1"
	if s := getenv("BIND_ADDRESS"); s != "" {
		bindAddress = s
	}

	// LOG_LEVEL takes precedence; DEBUG=true acts as an alias for level=debug.
	logLevel := "info"
	if debug {
		logLevel = "debug"
	}

	if s := getenv("LOG_LEVEL"); s != "" {
		logLevel = s
	}

	logFormat := "text"

	if s := getenv("LOG_FORMAT"); s != "" {
		logFormat = s
	}

	staticDir := getenv("STATIC_DIR")

	// KUBEATLAS_DEV marks the dev loop (set by `make run`). It flips
	// the end-user UX conveniences off — auto-opening a tab and the single-instance
	// guard both fight air's restart-on-edit. It does NOT change how the app
	// behaves otherwise; STATIC_DIR independently controls asset source.
	//
	// Single instance is the only supported mode: re-launching focuses the running
	// instance rather than starting another. The dev loop is the lone exception;
	// an explicit PORT (handled at bind time) is a deliberate separate server.
	// (Viewing several clusters at once is a future multi-cluster feature, not
	// multiple processes.) OPEN_BROWSER overrides the browser default either way.
	dev := envBool(getenv, "KUBEATLAS_DEV", false)
	openBrowser := envBool(getenv, "OPEN_BROWSER", !dev)
	singleInstance := !dev

	return Config{
		Port:                  port,
		PortExplicit:          portExplicit,
		NameSpaceFilter:       nameSpaceFilter,
		NameSpaceFilterRegexp: nameSpaceFilterRegexp,
		SingleNamespace:       singleNamespace,
		Debug:                 debug,
		EnablePodLogs:         enablePodLogs,
		BindAddress:           bindAddress,
		LogLevel:              logLevel,
		LogFormat:             logFormat,
		StaticDir:             staticDir,
		Dev:                   dev,
		OpenBrowser:           openBrowser,
		SingleInstance:        singleInstance,
	}
}
