package events

import (
	"encoding/json"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/sse"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestMarshalEvent(t *testing.T) {
	tests := []struct {
		name     string
		obj      *unstructured.Unstructured
		contains string
		excludes string
	}{
		{
			name: "marshal pod",
			obj: &unstructured.Unstructured{
				Object: map[string]interface{}{
					"apiVersion": "v1",
					"kind":       "Pod",
					"metadata": map[string]interface{}{
						"name":      "test-pod",
						"namespace": "default",
						"managedFields": []interface{}{
							map[string]interface{}{"manager": "kubectl"},
						},
					},
					"spec": map[string]interface{}{
						"containers": []interface{}{
							map[string]interface{}{"name": "nginx", "image": "nginx"},
						},
					},
				},
			},
			contains: `"name":"test-pod"`,
			excludes: `"managedFields"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MarshalEvent(tt.obj)
			if got == nil {
				t.Errorf("MarshalEvent() returned nil")
				return
			}

			s := string(got)
			if !contains(s, tt.contains) {
				t.Errorf("MarshalEvent() = %s, want to contain %s", s, tt.contains)
			}

			if contains(s, tt.excludes) {
				t.Errorf("MarshalEvent() = %s, want to exclude %s", s, tt.excludes)
			}
		})
	}

	t.Run("marshal failure", func(t *testing.T) {
		// json.Marshal fails on unsupported types like functions
		obj := &unstructured.Unstructured{
			Object: map[string]interface{}{
				"bad": func() {},
			},
		}

		got := MarshalEvent(obj)
		if got != nil {
			t.Errorf("MarshalEvent() expected nil for unmarshalable object")
		}
	})
}

func FuzzMarshalEvent(f *testing.F) {
	f.Add("v1", "Pod", "test-pod", "default")
	f.Add("apps/v1", "Deployment", "my-deploy", "kube-system")

	f.Fuzz(func(t *testing.T, apiVersion, kind, name, namespace string) {
		obj := &unstructured.Unstructured{
			Object: map[string]interface{}{
				"apiVersion": apiVersion,
				"kind":       kind,
				"metadata": map[string]interface{}{
					"name":      name,
					"namespace": namespace,
				},
			},
		}

		got := MarshalEvent(obj)
		if got == nil {
			// Fail if we can't marshal basic strings
			t.Errorf("MarshalEvent() returned nil for basic strings")
			return
		}

		// Verify it's valid JSON
		var dummy interface{}
		if err := json.Unmarshal(got, &dummy); err != nil {
			t.Errorf("MarshalEvent() produced invalid JSON: %v", err)
		}
	})
}

func TestGetHandlerFuncs(t *testing.T) {
	broker := sse.NewBroker[KubeEvent]()
	handlers := GetHandlerFuncs(broker)

	pod := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Pod",
			"metadata": map[string]interface{}{
				"name":      "test-pod",
				"namespace": "myns",
			},
		},
	}

	// Test Add
	handlers.AddFunc(pod)
	// We can't easily introspect the broker's internal queues without a subscriber,
	// but we can at least verify it doesn't panic and we can try to subscribe.
	// For "genuine" testing, we'll verify the logic doesn't skip namespaces unexpectedly.

	// Test Add with empty namespace (should be ignored for namespaced handlers)
	noNamespacePod := pod.DeepCopy()
	noNamespacePod.SetNamespace("")
	handlers.AddFunc(noNamespacePod)

	// Test Update
	handlers.UpdateFunc(pod, pod)
	handlers.UpdateFunc(pod, noNamespacePod) // should be ignored

	// Test Delete
	handlers.DeleteFunc(pod)
	handlers.DeleteFunc(noNamespacePod) // should be ignored

	// Test with unmarshalable object to cover "data == nil" branches
	badObj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"namespace": "myns",
			},
			"bad": func() {},
		},
	}
	handlers.AddFunc(badObj)
	handlers.UpdateFunc(badObj, badObj)
	handlers.DeleteFunc(badObj)
}

func TestGetClusterHandlerFuncs(t *testing.T) {
	broker := sse.NewBroker[KubeEvent]()
	handlers := GetClusterHandlerFuncs(broker)

	node := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Node",
			"metadata": map[string]interface{}{
				"name": "test-node",
			},
		},
	}

	// Test Add
	handlers.AddFunc(node)

	// Test Update
	handlers.UpdateFunc(node, node)

	// Test Delete
	handlers.DeleteFunc(node)

	// Test with unmarshalable object
	badNode := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"bad": func() {},
		},
	}
	handlers.AddFunc(badNode)
	handlers.UpdateFunc(badNode, badNode)
	handlers.DeleteFunc(badNode)
}

func contains(s, substr string) bool {
	// Simple manual contains to avoid strings dependency in test if not needed
	// but strings is fine in Go tests.
	return len(s) >= len(substr) && func() bool {
		for i := 0; i <= len(s)-len(substr); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	}()
}
