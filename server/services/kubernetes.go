// ==========================================================================================
// Core Kubernetes service — connection, struct definition, and informer setup
// ==========================================================================================

package services

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/benc-uk/go-rest-api/pkg/sse"
	coreV1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/kubeatlas-org/kubeatlas/server/services/events"
)

// KubeServiceInterface defines the methods that the Kubernetes service must implement.
// This allows for behavioral mocking in tests.
type KubeServiceInterface interface {
	GetNamespaces() ([]string, error)
	CheckNamespaceExists(ns string) bool
	FetchNamespace(ns string) (map[string][]unstructured.Unstructured, error)
	FetchClusterResources() (map[string][]unstructured.Unstructured, error)
	GetResource(ns, kind, name string) (*unstructured.Unstructured, error)
	UpdateResource(ns string, obj *unstructured.Unstructured) error
	DeleteResource(ns, kind, name string) error
	ScaleResource(ns, kind, name string, replicas int32) error
	RestartResource(ns, kind, name string) error
	GetPodLogs(ns, podName, container string, lineCount int, previous, timestamps bool) (string, error)
	StreamPodLogs(
		ctx context.Context, ns, podName, container string,
		lineCount int, previous, timestamps bool, w io.Writer,
	) error
	ExecPod(
		ctx context.Context, ns, pod, container string,
		stdin io.Reader, stdout io.Writer, resizeQueue remotecommand.TerminalSizeQueue,
	) error
	GetPodMetrics(ns string) ([]unstructured.Unstructured, error)
	GetNodeMetrics() ([]unstructured.Unstructured, error)
	DiscoverCRDs() ([]CRDInfo, error)
	GetCRDResources(ns, group, version, resource string) ([]unstructured.Unstructured, error)
	MetricsAvailable() bool
	GetClusterHost() string
	Close()
}

// Kubernetes is a service that connects to a Kubernetes cluster and provides access to its resources
type Kubernetes struct {
	client            *dynamic.DynamicClient
	clientSet         *kubernetes.Clientset
	restConfig        *rest.Config
	cancelFn          context.CancelFunc
	factory           dynamicinformer.DynamicSharedInformerFactory // namespaced informers (per singleNamespace, or all)
	clusterFactory    dynamicinformer.DynamicSharedInformerFactory // cluster-scoped informers (Nodes, PVs)
	ClusterHost       string
	ContextName       string // resolved kubeconfig context name
	KubeVersion       string
	UseEndpointSlices bool
	metricsAvail      bool
	crdRegistry       map[string]schema.GroupVersionResource // kind → GVR for discovered CRDs
}

func (k *Kubernetes) MetricsAvailable() bool {
	return k.metricsAvail
}

func (k *Kubernetes) GetClusterHost() string {
	return k.ClusterHost
}

// loadKubeConfig returns the REST config and the resolved kubeconfig context name.
func loadKubeConfig(contextName string) (*rest.Config, string, error) {
	slog.Info("⚓ using kubeconfig")

	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	configOverrides := &clientcmd.ConfigOverrides{}

	if contextName != "" {
		configOverrides.CurrentContext = contextName
		slog.Info("⚓ using explicit context", "context", contextName)
	}

	kubeConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, configOverrides)

	restConfig, err := kubeConfig.ClientConfig()
	if err != nil {
		return nil, "", err
	}

	// Resolve the context name that was actually used
	raw, _ := kubeConfig.RawConfig()
	resolvedCtx := raw.CurrentContext

	return restConfig, resolvedCtx, nil
}

func NewKubernetes(
	sseBroker *sse.Broker[events.KubeEvent], singleNamespace string, contextName string,
) (*Kubernetes, error) {
	kubeConfig, resolvedContext, err := loadKubeConfig(contextName)
	if err != nil {
		return nil, err
	}

	slog.Info("🌐 kubernetes host", "host", kubeConfig.Host)

	// DiscoveryClient is used to discover the Kubernetes API resources
	// It is used to check the server version and capabilities
	discClient, err := discovery.NewDiscoveryClientForConfig(kubeConfig)
	if err != nil {
		return nil, err
	}

	// Validate the connection to the Kubernetes API by checking the server version
	serverVersion, err := discClient.ServerVersion()
	if err != nil {
		slog.Error("⛔ failed to connect to Kubernetes API", "err", err)
		return nil, err
	}

	slog.Info("✅ connected to Kubernetes API", "version", serverVersion.String())

	// See https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/
	useEndpointSlices := shouldUseEndpointSlices(serverVersion.Major, serverVersion.Minor)
	if useEndpointSlices {
		slog.Info("🔄 Kubernetes ≥1.33 — using EndpointSlices for service endpoints")
	}

	// Detect metrics-server availability for CPU/memory usage
	metricsAvailable := false

	_, err = discClient.ServerResourcesForGroupVersion("metrics.k8s.io/v1beta1")
	if err == nil {
		slog.Info("✅ metrics API available (metrics-server detected)")

		metricsAvailable = true
	} else {
		slog.Warn("⚠️ metrics API not available, CPU/memory columns disabled")
	}

	// Use the dynamic client to interact with the Kubernetes API
	// This allows us to work with any resource type without needing to know the schema in advance
	dynamicClient, err := dynamic.NewForConfig(kubeConfig)
	if err != nil {
		return nil, err
	}

	// ClientSet is the standard Kubernetes client for interacting with the API
	// It is used for operations that require the full client, such as getting logs
	clientSet, err := kubernetes.NewForConfig(kubeConfig)
	if err != nil {
		return nil, err
	}

	namespace := coreV1.NamespaceAll // Work in all namespaces
	if singleNamespace != "" {
		namespace = singleNamespace
		slog.Info("🔑 authorized for a single namespace", "namespace", namespace)
	}

	slog.Info("👀 setting up resource watchers")

	factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(
		dynamicClient, time.Minute, namespace, nil)

	// Separate factory for cluster-scoped resources (Nodes, PVs) — always watches all
	clusterFactory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(
		dynamicClient, time.Minute, coreV1.NamespaceAll, nil)

	// Add listening event handlers for ALL resources we want to track
	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "networking.k8s.io",
		Version: "v1", Resource: "ingresses"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "networking.k8s.io",
		Version: "v1", Resource: "networkpolicies"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "",
		Version: "v1", Resource: "persistentvolumeclaims"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "events"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "autoscaling", Version: "v2",
		Resource: "horizontalpodautoscalers"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	if useEndpointSlices {
		_, _ = factory.ForResource(schema.GroupVersionResource{Group: "discovery.k8s.io",
			Version: "v1", Resource: "endpointslices"}).
			Informer().
			AddEventHandler(events.GetHandlerFuncs(sseBroker))
	} else {
		_, _ = factory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "endpoints"}).
			Informer().
			AddEventHandler(events.GetHandlerFuncs(sseBroker))
	}

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	_, _ = factory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}).
		Informer().
		AddEventHandler(events.GetHandlerFuncs(sseBroker))

	// Cluster-scoped resource watchers — use SendToAll (not namespace groups)
	_, _ = clusterFactory.ForResource(schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}).
		Informer().
		AddEventHandler(events.GetClusterHandlerFuncs(sseBroker))

	_, _ = clusterFactory.ForResource(schema.GroupVersionResource{
		Group: "", Version: "v1", Resource: "persistentvolumes",
	}).Informer().AddEventHandler(events.GetClusterHandlerFuncs(sseBroker))

	// Use a cancellable context so informers can be stopped when switching contexts
	ctx, cancelFn := context.WithCancel(context.Background())

	factory.Start(ctx.Done())
	clusterFactory.Start(ctx.Done())

	// WaitForCacheSync with a 60s timeout so context switches don't hang indefinitely
	syncCtx, syncCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer syncCancel()

	factory.WaitForCacheSync(syncCtx.Done())
	clusterFactory.WaitForCacheSync(syncCtx.Done())

	return &Kubernetes{
		client:            dynamicClient,
		clientSet:         clientSet,
		restConfig:        kubeConfig,
		cancelFn:          cancelFn,
		factory:           factory,
		clusterFactory:    clusterFactory,
		ClusterHost:       kubeConfig.Host,
		ContextName:       resolvedContext,
		UseEndpointSlices: useEndpointSlices,
		KubeVersion:       serverVersion.String(),
		metricsAvail:      metricsAvailable,
	}, nil
}

// Close stops the informer factories by canceling the background context.
// Call this after replacing the service instance during a context switch.
func (k *Kubernetes) Close() {
	if k.cancelFn != nil {
		k.cancelFn()
	}
}

// GetKubeContexts returns the list of context names from kubeconfig and the active context.
func GetKubeContexts() (contexts []string, current string, err error) {
	raw, loadErr := clientcmd.NewDefaultClientConfigLoadingRules().Load()
	if loadErr != nil {
		return nil, "", loadErr
	}

	names := make([]string, 0, len(raw.Contexts))
	for name := range raw.Contexts {
		names = append(names, name)
	}

	sort.Strings(names)

	return names, raw.CurrentContext, nil
}

// kindToGVR maps a resource kind string to the corresponding GroupVersionResource
func (k *Kubernetes) kindToGVR(kind string) (schema.GroupVersionResource, error) {
	kindMap := map[string]schema.GroupVersionResource{
		"Pod":                     {Group: "", Version: "v1", Resource: "pods"},
		"Service":                 {Group: "", Version: "v1", Resource: "services"},
		"Deployment":              {Group: "apps", Version: "v1", Resource: "deployments"},
		"ReplicaSet":              {Group: "apps", Version: "v1", Resource: "replicasets"},
		"StatefulSet":             {Group: "apps", Version: "v1", Resource: "statefulsets"},
		"DaemonSet":               {Group: "apps", Version: "v1", Resource: "daemonsets"},
		"Job":                     {Group: "batch", Version: "v1", Resource: "jobs"},
		"CronJob":                 {Group: "batch", Version: "v1", Resource: "cronjobs"},
		"Ingress":                 {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
		"NetworkPolicy":           {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
		"ConfigMap":               {Group: "", Version: "v1", Resource: "configmaps"},
		"Secret":                  {Group: "", Version: "v1", Resource: "secrets"},
		"PersistentVolumeClaim":   {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
		"HorizontalPodAutoscaler": {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
		"Node":                    {Group: "", Version: "v1", Resource: "nodes"},
		"PersistentVolume":        {Group: "", Version: "v1", Resource: "persistentvolumes"},
	}

	gvr, ok := kindMap[kind]
	if ok {
		return gvr, nil
	}

	// Fallback: check CRD registry for custom resource kinds
	if k.crdRegistry != nil {
		gvr, ok = k.crdRegistry[kind]
		if ok {
			return gvr, nil
		}
	}

	return schema.GroupVersionResource{}, errors.New("unsupported resource kind: " + kind)
}

// shouldUseEndpointSlices returns true if the Kubernetes version is 1.33 or higher.
// Logic extracted from NewKubernetes for testing.
func shouldUseEndpointSlices(major, minor string) bool {
	minorStr := strings.TrimRight(minor, "+")
	minorInt, _ := strconv.Atoi(minorStr)

	return major == "1" && minorInt >= 33
}
