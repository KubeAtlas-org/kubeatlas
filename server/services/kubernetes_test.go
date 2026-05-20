package services

import (
	"testing"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

func TestKindToGVR(t *testing.T) {
	k := &Kubernetes{
		crdRegistry: map[string]schema.GroupVersionResource{
			"MyCustomResource": {Group: "example.com", Version: "v1", Resource: "mycustomresources"},
		},
	}

	tests := []struct {
		kind    string
		want    schema.GroupVersionResource
		wantErr bool
	}{
		{
			kind: "Pod",
			want: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
		},
		{
			kind: "Deployment",
			want: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"},
		},
		{
			kind: "Node",
			want: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"},
		},
		{
			kind: "MyCustomResource",
			want: schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "mycustomresources"},
		},
		{
			kind:    "UnknownKind",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.kind, func(t *testing.T) {
			got, err := k.kindToGVR(tt.kind)
			if (err != nil) != tt.wantErr {
				t.Errorf("Kubernetes.kindToGVR() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if !tt.wantErr && got != tt.want {
				t.Errorf("Kubernetes.kindToGVR() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestShouldUseEndpointSlices(t *testing.T) {
	tests := []struct {
		major string
		minor string
		want  bool
	}{
		{"1", "32", false},
		{"1", "33", true},
		{"1", "33+", true},
		{"1", "34", true},
		{"2", "0", false},
	}

	for _, tt := range tests {
		t.Run(tt.major+"."+tt.minor, func(t *testing.T) {
			if got := shouldUseEndpointSlices(tt.major, tt.minor); got != tt.want {
				t.Errorf("shouldUseEndpointSlices() = %v, want %v", got, tt.want)
			}
		})
	}
}
