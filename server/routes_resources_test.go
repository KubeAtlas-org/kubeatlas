package main

import (
	"testing"
)

func TestParseAndValidateResource(t *testing.T) {
	tests := []struct {
		name         string
		yamlBytes    []byte
		expectedKind string
		expectedName string
		wantErr      bool
	}{
		{
			name: "valid pod",
			yamlBytes: []byte(`
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
  - name: nginx
    image: nginx
`),
			expectedKind: "Pod",
			expectedName: "test-pod",
			wantErr:      false,
		},
		{
			name: "kind mismatch",
			yamlBytes: []byte(`
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
`),
			expectedKind: "Service",
			expectedName: "test-pod",
			wantErr:      true,
		},
		{
			name: "name mismatch",
			yamlBytes: []byte(`
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
`),
			expectedKind: "Pod",
			expectedName: "other-pod",
			wantErr:      true,
		},
		{
			name:         "invalid yaml",
			yamlBytes:    []byte(`: invalid`),
			expectedKind: "Pod",
			expectedName: "test-pod",
			wantErr:      true,
		},
		{
			name: "missing metadata",
			yamlBytes: []byte(`
apiVersion: v1
kind: Pod
`),
			expectedKind: "Pod",
			expectedName: "test-pod",
			wantErr:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseAndValidateResource(tt.yamlBytes, tt.expectedKind, tt.expectedName)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseAndValidateResource() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func FuzzParseAndValidateResource(f *testing.F) {
	// Seed the corpus
	f.Add([]byte(`
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
`), "Pod", "test-pod")

	f.Add([]byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-deploy
`), "Deployment", "my-deploy")

	f.Add([]byte("invalid yaml"), "Pod", "test-pod")
	f.Add([]byte(""), "", "")

	f.Fuzz(func(t *testing.T, data []byte, kind, name string) {
		// The function should never panic, regardless of the input
		_, _ = parseAndValidateResource(data, kind, name)
	})
}
