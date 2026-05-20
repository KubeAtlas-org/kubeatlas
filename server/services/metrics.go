// ==========================================================================================
// Kubernetes metrics API — pod and node CPU/memory usage
// ==========================================================================================

package services

import (
	"context"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// GetPodMetrics fetches CPU/memory usage for all pods in a namespace via the metrics API
func (k *Kubernetes) GetPodMetrics(ns string) ([]unstructured.Unstructured, error) {
	gvr := schema.GroupVersionResource{
		Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods",
	}

	list, err := k.client.Resource(gvr).Namespace(ns).List(
		context.TODO(), metaV1.ListOptions{},
	)
	if err != nil {
		return nil, err
	}

	return list.Items, nil
}

// GetNodeMetrics fetches CPU/memory usage for all nodes via the metrics API
func (k *Kubernetes) GetNodeMetrics() ([]unstructured.Unstructured, error) {
	gvr := schema.GroupVersionResource{
		Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes",
	}

	list, err := k.client.Resource(gvr).List(
		context.TODO(), metaV1.ListOptions{},
	)
	if err != nil {
		return nil, err
	}

	return list.Items, nil
}
