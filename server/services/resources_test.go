package services

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestRedactSensitiveData(t *testing.T) {
	tests := []struct {
		name     string
		kind     string
		data     map[string]interface{}
		expected map[string]interface{}
	}{
		{
			name: "redact secret",
			kind: "Secret",
			data: map[string]interface{}{
				"data": map[string]interface{}{
					"password": "secret-value",
					"token":    "token-value",
				},
			},
			expected: map[string]interface{}{
				"data": map[string]interface{}{
					"password": "*REDACTED*",
					"token":    "*REDACTED*",
				},
			},
		},
		{
			name: "redact configmap",
			kind: "ConfigMap",
			data: map[string]interface{}{
				"data": map[string]interface{}{
					"api-key": "key-value",
				},
			},
			expected: map[string]interface{}{
				"data": map[string]interface{}{
					"api-key": "*REDACTED*",
				},
			},
		},
		{
			name: "no redaction for pod",
			kind: "Pod",
			data: map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{},
				},
			},
			expected: map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			obj := &unstructured.Unstructured{
				Object: map[string]interface{}{
					"kind": tt.kind,
				},
			}
			for k, v := range tt.data {
				obj.Object[k] = v
			}

			// Call the actual function
			redactSensitiveData(obj)

			// Verify results
			if tt.kind == "Secret" || tt.kind == "ConfigMap" {
				data := obj.Object["data"].(map[string]interface{})
				for k, v := range tt.expected["data"].(map[string]interface{}) {
					if data[k] != v {
						t.Errorf("expected %s = %v, got %v", k, v, data[k])
					}
				}
			}
		})
	}
}

func FuzzRedactSensitiveData(f *testing.F) {
	f.Add("Secret", "key1", "val1")
	f.Add("ConfigMap", "key2", "val2")
	f.Add("Pod", "key3", "val3")

	f.Fuzz(func(t *testing.T, kind, key, val string) {
		obj := &unstructured.Unstructured{
			Object: map[string]interface{}{
				"kind": kind,
				"data": map[string]interface{}{
					key: val,
				},
			},
		}

		// Call the actual function
		redactSensitiveData(obj)

		// Validation
		if kind == "Secret" || kind == "ConfigMap" {
			data := obj.Object["data"].(map[string]interface{})
			if data[key] != "*REDACTED*" {
				t.Errorf("Expected %s to be redacted for kind %s", key, kind)
			}
		} else {
			data := obj.Object["data"].(map[string]interface{})
			if data[key] != val {
				t.Errorf("Expected %s to remain %s for kind %s", key, val, kind)
			}
		}
	})
}
