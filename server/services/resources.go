// ==========================================================================================
// Kubernetes resource CRUD operations — fetch, get, update, delete
// ==========================================================================================

package services

import (
	"context"
	"log/slog"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/dynamicinformer"
)

// Get namespaces
func (k *Kubernetes) GetNamespaces() ([]string, error) {
	out := []string{}

	// Use the dynamicClient to get the list of namespaces
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}

	l, err := k.client.Resource(gvr).List(context.TODO(), metaV1.ListOptions{})
	if err != nil {
		slog.Error("💥 failed to get namespaces", "err", err)
		return nil, err
	}

	// Iterate over the namespaces and add them to the list
	for _, ns := range l.Items {
		out = append(out, ns.GetName())
	}

	return out, nil
}

// Validate if a namespace exists in the cluster
func (k *Kubernetes) CheckNamespaceExists(ns string) bool {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}

	// Try to get the namespace
	_, err := k.client.Resource(gvr).Get(context.TODO(), ns, metaV1.GetOptions{})

	return err == nil
}

// listFromCache returns objects from the shared informer cache via the Lister API.
// ns == "" means all-namespaces. Cluster-scoped resources should pass ns == "".
// Results are deep-copied: mutating the returned items must not poison the
// cache for other readers.
func listFromCache(
	factory dynamicinformer.DynamicSharedInformerFactory,
	gvr schema.GroupVersionResource,
	ns string,
) ([]unstructured.Unstructured, error) {
	lister := factory.ForResource(gvr).Lister()

	var (
		objs []runtime.Object
		err  error
	)

	if ns == "" {
		objs, err = lister.List(labels.Everything())
	} else {
		objs, err = lister.ByNamespace(ns).List(labels.Everything())
	}

	if err != nil {
		slog.Error("💥 failed to list from cache", "resource", gvr.Resource, "err", err)
		return nil, err
	}

	out := make([]unstructured.Unstructured, 0, len(objs))

	for _, o := range objs {
		u, ok := o.(*unstructured.Unstructured)
		if !ok {
			continue
		}

		out = append(out, *u.DeepCopy())
	}

	return out, nil
}

// Retrieves all resources in a namespace and returns them in a big ol' map.
// An empty ns lists resources across all namespaces (native K8s semantics).
// Reads from the shared informer cache — see kubernetes.go for the watcher setup.
func (k *Kubernetes) FetchNamespace(ns string) (map[string][]unstructured.Unstructured, error) {
	data := make(map[string][]unstructured.Unstructured, 17)

	gvrs := map[string]schema.GroupVersionResource{
		"pods":                     {Group: "", Version: "v1", Resource: "pods"},
		"services":                 {Group: "", Version: "v1", Resource: "services"},
		"deployments":              {Group: "apps", Version: "v1", Resource: "deployments"},
		"replicasets":              {Group: "apps", Version: "v1", Resource: "replicasets"},
		"statefulsets":             {Group: "apps", Version: "v1", Resource: "statefulsets"},
		"daemonsets":               {Group: "apps", Version: "v1", Resource: "daemonsets"},
		"jobs":                     {Group: "batch", Version: "v1", Resource: "jobs"},
		"cronjobs":                 {Group: "batch", Version: "v1", Resource: "cronjobs"},
		"ingresses":                {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
		"networkpolicies":          {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
		"configmaps":               {Group: "", Version: "v1", Resource: "configmaps"},
		"secrets":                  {Group: "", Version: "v1", Resource: "secrets"},
		"persistentvolumeclaims":   {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
		"events":                   {Group: "", Version: "v1", Resource: "events"},
		"horizontalpodautoscalers": {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
	}

	if k.UseEndpointSlices {
		gvrs["endpointslices"] = schema.GroupVersionResource{
			Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices",
		}
	} else {
		gvrs["endpoints"] = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "endpoints"}
	}

	for key, gvr := range gvrs {
		items, _ := listFromCache(k.factory, gvr, ns)
		data[key] = items
	}

	// Strip clutter and redact sensitive data on the deep copies
	for _, items := range data {
		for i := range items {
			redactSensitiveData(&items[i])
		}
	}

	return data, nil
}

// FetchClusterResources retrieves all cluster-scoped resources (Nodes, PVs, etc.)
// from the shared informer cache.
func (k *Kubernetes) FetchClusterResources() (map[string][]unstructured.Unstructured, error) {
	data := make(map[string][]unstructured.Unstructured, 2)

	nodeList, _ := listFromCache(k.clusterFactory,
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}, "")
	data["nodes"] = nodeList

	pvList, _ := listFromCache(k.clusterFactory,
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "persistentvolumes"}, "")
	data["persistentvolumes"] = pvList

	for _, items := range data {
		for i := range items {
			items[i].SetManagedFields(nil)
		}
	}

	return data, nil
}

// GetResource fetches a single resource by namespace (empty for cluster-scoped), kind, and name.
// Strips managedFields and redacts Secret/ConfigMap data before returning.
func (k *Kubernetes) GetResource(ns, kind, name string) (*unstructured.Unstructured, error) {
	gvr, err := k.kindToGVR(kind)
	if err != nil {
		return nil, err
	}

	var obj *unstructured.Unstructured

	if ns == "" {
		obj, err = k.client.Resource(gvr).Get(context.TODO(), name, metaV1.GetOptions{})
	} else {
		obj, err = k.client.Resource(gvr).Namespace(ns).Get(context.TODO(), name, metaV1.GetOptions{})
	}

	if err != nil {
		return nil, err
	}

	redactSensitiveData(obj)

	return obj, nil
}

// UpdateResource replaces a Kubernetes resource with the provided object.
// The object must include a valid resourceVersion for optimistic concurrency.
// ns should be empty for cluster-scoped resources.
func (k *Kubernetes) UpdateResource(ns string, obj *unstructured.Unstructured) error {
	kind := obj.GetKind()

	gvr, err := k.kindToGVR(kind)
	if err != nil {
		return err
	}

	if ns == "" {
		_, err = k.client.Resource(gvr).Update(context.TODO(), obj, metaV1.UpdateOptions{})
	} else {
		_, err = k.client.Resource(gvr).Namespace(ns).Update(context.TODO(), obj, metaV1.UpdateOptions{})
	}

	return err
}

// DeleteResource deletes a Kubernetes resource by namespace, kind, and name
func (k *Kubernetes) DeleteResource(ns, kind, name string) error {
	gvr, err := k.kindToGVR(kind)
	if err != nil {
		return err
	}

	return k.client.Resource(gvr).Namespace(ns).Delete(context.TODO(), name, metaV1.DeleteOptions{})
}

// redactSensitiveData removes managedFields and replaces Secret/ConfigMap data values with *REDACTED*.
func redactSensitiveData(u *unstructured.Unstructured) {
	u.SetManagedFields(nil)

	kind := u.GetKind()
	if kind == "Secret" || kind == "ConfigMap" {
		if data, ok := u.Object["data"].(map[string]interface{}); ok {
			for k := range data {
				data[k] = "*REDACTED*"
			}
		}
	}
}
