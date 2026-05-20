// ==========================================================================================
// Custom Resource Definition discovery and instance listing
// ==========================================================================================

package services

import (
	"context"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// CRDInfo holds the metadata needed to list instances of a Custom Resource Definition
type CRDInfo struct {
	Group    string `json:"group"`
	Version  string `json:"version"`
	Resource string `json:"resource"`
	Kind     string `json:"kind"`
	Scope    string `json:"scope"` // "Namespaced" or "Cluster"
}

// DiscoverCRDs finds all Custom Resource Definitions in the cluster
func (k *Kubernetes) DiscoverCRDs() ([]CRDInfo, error) {
	crdGVR := schema.GroupVersionResource{
		Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions",
	}

	list, err := k.client.Resource(crdGVR).List(context.TODO(), metaV1.ListOptions{})
	if err != nil {
		return nil, err
	}

	crds := make([]CRDInfo, 0, len(list.Items))

	for _, item := range list.Items {
		spec, ok := item.Object["spec"].(map[string]interface{})
		if !ok {
			continue
		}

		group, _ := spec["group"].(string)
		scope, _ := spec["scope"].(string)
		names, _ := spec["names"].(map[string]interface{})

		if names == nil {
			continue
		}

		kind, _ := names["kind"].(string)
		plural, _ := names["plural"].(string)

		// Pick the served+storage version, or the first available
		version := ""

		versions, _ := spec["versions"].([]interface{})
		for _, v := range versions {
			vm, _ := v.(map[string]interface{})
			if vm == nil {
				continue
			}

			served, _ := vm["served"].(bool)
			if !served {
				continue
			}

			vName, _ := vm["name"].(string)
			if version == "" {
				version = vName
			}

			storage, _ := vm["storage"].(bool)
			if storage {
				version = vName

				break
			}
		}

		if group == "" || version == "" || kind == "" || plural == "" {
			continue
		}

		crds = append(crds, CRDInfo{
			Group:    group,
			Version:  version,
			Resource: plural,
			Kind:     kind,
			Scope:    scope,
		})
	}

	// Populate CRD registry so kindToGVR can resolve custom resource kinds
	registry := make(map[string]schema.GroupVersionResource, len(crds))
	for _, crd := range crds {
		registry[crd.Kind] = schema.GroupVersionResource{
			Group: crd.Group, Version: crd.Version, Resource: crd.Resource,
		}
	}

	k.crdRegistry = registry

	return crds, nil
}

// GetCRDResources fetches instances of a CRD in a namespace (or cluster-wide if ns is empty)
func (k *Kubernetes) GetCRDResources(ns, group, version, resource string) ([]unstructured.Unstructured, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: resource}

	var (
		list *unstructured.UnstructuredList
		err  error
	)

	if ns == "" {
		list, err = k.client.Resource(gvr).List(context.TODO(), metaV1.ListOptions{Limit: 500})
	} else {
		list, err = k.client.Resource(gvr).Namespace(ns).List(context.TODO(), metaV1.ListOptions{Limit: 500})
	}

	if err != nil {
		return nil, err
	}

	// Strip managedFields
	for i := range list.Items {
		list.Items[i].SetManagedFields(nil)
	}

	return list.Items, nil
}
