package main

import (
	"testing"
)

func TestParseConfig(t *testing.T) {
	tests := []struct {
		name     string
		env      map[string]string
		wantPort int
		wantLog  bool
		wantBind string
	}{
		{
			name:     "defaults",
			env:      map[string]string{},
			wantPort: 8000,
			wantLog:  true,
			wantBind: "127.0.0.1",
		},
		{
			name: "custom values",
			env: map[string]string{
				"PORT":             "9000",
				"DISABLE_POD_LOGS": "true",
				"BIND_ADDRESS":     "0.0.0.0",
				"DEBUG":            "true",
				"SINGLE_NAMESPACE": "myns",
			},
			wantPort: 9000,
			wantLog:  false,
			wantBind: "0.0.0.0",
		},
		{
			name: "malformed port",
			env: map[string]string{
				"PORT": "abc",
			},
			wantPort: 8000, // should fallback to default
			wantLog:  true,
			wantBind: "127.0.0.1",
		},
		{
			name: "malformed bool",
			env: map[string]string{
				"DISABLE_POD_LOGS": "notabool",
			},
			wantPort: 8000,
			wantLog:  true, // should fallback to default
			wantBind: "127.0.0.1",
		},
		{
			name: "namespace filter",
			env: map[string]string{
				"NAMESPACE_FILTER": "^prod-.*",
			},
			wantPort: 8000,
			wantLog:  true,
			wantBind: "127.0.0.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(key string) string {
				return tt.env[key]
			}

			cfg := parseConfig(getenv)

			if cfg.Port != tt.wantPort {
				t.Errorf("parseConfig() Port = %v, want %v", cfg.Port, tt.wantPort)
			}

			if cfg.EnablePodLogs != tt.wantLog {
				t.Errorf("parseConfig() EnablePodLogs = %v, want %v", cfg.EnablePodLogs, tt.wantLog)
			}

			if cfg.BindAddress != tt.wantBind {
				t.Errorf("parseConfig() BindAddress = %v, want %v", cfg.BindAddress, tt.wantBind)
			}

			if tt.env["DEBUG"] == "true" && !cfg.Debug {
				t.Errorf("parseConfig() Debug = false, want true")
			}

			if tt.env["SINGLE_NAMESPACE"] != "" && cfg.SingleNamespace != tt.env["SINGLE_NAMESPACE"] {
				t.Errorf("parseConfig() SingleNamespace = %v, want %v", cfg.SingleNamespace, tt.env["SINGLE_NAMESPACE"])
			}

			if filter, ok := tt.env["NAMESPACE_FILTER"]; ok {
				if cfg.NameSpaceFilter != filter {
					t.Errorf("parseConfig() NameSpaceFilter = %v, want %v", cfg.NameSpaceFilter, filter)
				}

				if cfg.NameSpaceFilterRegexp == nil {
					t.Errorf("parseConfig() NameSpaceFilterRegexp is nil for valid regex")
				}
			}
		})
	}
}

func TestParseConfig_OpenBrowser(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"default standalone opens", map[string]string{}, true},
		{"dev (STATIC_DIR) does not open", map[string]string{"STATIC_DIR": "public"}, false},
		{"OPEN_BROWSER=true forces on in dev", map[string]string{"STATIC_DIR": "public", "OPEN_BROWSER": "true"}, true},
		{"OPEN_BROWSER=false forces off", map[string]string{"OPEN_BROWSER": "false"}, false},
		{"malformed OPEN_BROWSER falls back to default", map[string]string{"OPEN_BROWSER": "notabool"}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := parseConfig(func(k string) string { return tt.env[k] })
			if cfg.OpenBrowser != tt.want {
				t.Errorf("parseConfig() OpenBrowser = %v, want %v", cfg.OpenBrowser, tt.want)
			}
		})
	}
}

func TestGetConfig(t *testing.T) {
	// Simply call it to ensure no panics and coverage
	_ = getConfig()
}
