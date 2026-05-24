// ==========================================================================================
// Server configuration via environment variables
// ==========================================================================================

package main

import (
	"os"
	"regexp"
	"strconv"
)

// Config holds the configuration for the system
type Config struct {
	Port                  int
	NameSpaceFilter       string
	NameSpaceFilterRegexp *regexp.Regexp
	SingleNamespace       string
	Debug                 bool
	EnablePodLogs         bool
	BindAddress           string
	LogLevel              string // debug | info | warn | error (default: info)
	LogFormat             string // text | json (default: text)
	StaticDir             string // serve frontend from this dir instead of the embedded copy (dev)
}

// Parse the environment variables and return a Config struct
// Also provides default values if the environment variables are not set
func getConfig() Config {
	return parseConfig(os.Getenv)
}

// parseConfig is the testable internal version of getConfig
func parseConfig(getenv func(string) string) Config {
	// Default values
	port := 8000
	nameSpaceFilter := ""
	singleNamespace := ""
	debug := false
	enablePodLogs := true

	if portEnv := getenv("PORT"); portEnv != "" {
		if p, err := strconv.Atoi(portEnv); err == nil {
			port = p
		}
	}

	if s := getenv("SINGLE_NAMESPACE"); s != "" {
		singleNamespace = s
	}

	if s := getenv("NAMESPACE_FILTER"); s != "" {
		nameSpaceFilter = s
	}

	var nameSpaceFilterRegexp *regexp.Regexp
	if nameSpaceFilter != "" {
		nameSpaceFilterRegexp, _ = regexp.Compile(nameSpaceFilter)
	}

	if s := getenv("DISABLE_POD_LOGS"); s != "" {
		if enable, err := strconv.ParseBool(s); err == nil {
			enablePodLogs = !enable
		}
	}

	if debugEnv := getenv("DEBUG"); debugEnv != "" {
		debug, _ = strconv.ParseBool(debugEnv)
	}

	bindAddress := "127.0.0.1"
	if s := getenv("BIND_ADDRESS"); s != "" {
		bindAddress = s
	}

	// LOG_LEVEL takes precedence; DEBUG=true acts as an alias for level=debug.
	logLevel := "info"
	if debug {
		logLevel = "debug"
	}

	if s := os.Getenv("LOG_LEVEL"); s != "" {
		logLevel = s
	}

	logFormat := "text"

	if s := os.Getenv("LOG_FORMAT"); s != "" {
		logFormat = s
	}

	staticDir := getenv("STATIC_DIR")

	return Config{
		Port:                  port,
		NameSpaceFilter:       nameSpaceFilter,
		NameSpaceFilterRegexp: nameSpaceFilterRegexp,
		SingleNamespace:       singleNamespace,
		Debug:                 debug,
		EnablePodLogs:         enablePodLogs,
		BindAddress:           bindAddress,
		LogLevel:              logLevel,
		LogFormat:             logFormat,
		StaticDir:             staticDir,
	}
}
