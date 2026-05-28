// ==========================================================================================
// The backend API for KubeAtlas, handling requests and serving data
// ==========================================================================================

package main

import (
	"log/slog"
	"sync"

	"github.com/benc-uk/go-rest-api/pkg/api"

	"github.com/kubeatlas-org/kubeatlas/server/services"
)

// This is the core struct for the server & API
type KubeatlasAPI struct {
	*api.Base
	kubeService    services.KubeServiceInterface
	eventBroker    *services.KubeEventBroker
	config         Config
	currentContext string
	contexts       []string
	Version        string
	BuildInfo      string
	switchMu       sync.Mutex // serializes context-switch / reconnect; guards kubeService swaps
	connErr        error      // last connection error when kubeService is nil (disconnected boot)
}

type NamespaceListResult struct {
	Namespaces []string `json:"namespaces"`
	// We munge a couple of extra fields into the API response
	// This saves us from having to make a separate request for the version and build info
	ClusterHost      string   `json:"clusterHost"`
	Version          string   `json:"version"`
	BuildInfo        string   `json:"buildInfo"`
	PodLogsEnabled   bool     `json:"podLogsEnabled"`
	MetricsAvailable bool     `json:"metricsAvailable"`
	CurrentContext   string   `json:"currentContext"`
	Contexts         []string `json:"contexts"`
	// Connected is false when the server booted without a reachable cluster; the
	// frontend renders a reconnect prompt instead of the graph. ConnectionError
	// carries the underlying reason for display.
	Connected       bool   `json:"connected"`
	ConnectionError string `json:"connectionError,omitempty"`
}

func NewKubeatlasAPI(conf Config) *KubeatlasAPI {
	broker := services.NewKubeEventBroker(conf.Debug)

	// Discover available kubeconfig contexts before connecting
	contexts, currentCtx, err := services.GetKubeContexts()
	if err != nil {
		slog.Warn("⚠️  could not load kubeconfig contexts", "err", err)
	}

	// Create a new Kubernetes service instance, which will connect to the cluster.
	kubeSvc, err := services.NewKubernetes(broker.Broker, conf.SingleNamespace, "")
	if err != nil {
		// Boot in a disconnected state rather than exiting. The HTTP server still
		// comes up and serves the frontend, which surfaces the error in the browser
		// and lets the operator fix their kubeconfig (or switch context) and
		// reconnect via POST /api/contexts/reconnect — no process restart needed.
		slog.Error("💥 could not connect to Kubernetes — starting in disconnected mode", "err", err)

		s := NewKubeatlasAPIWithService(conf, nil, broker, contexts, currentCtx, version, buildInfo)
		s.connErr = err

		return s
	}

	// Prefer the context name resolved by the service (handles the default context)
	if kubeSvc.ContextName != "" {
		currentCtx = kubeSvc.ContextName
	}

	return NewKubeatlasAPIWithService(conf, kubeSvc, broker, contexts, currentCtx, version, buildInfo)
}

// NewKubeatlasAPIWithService is the testable internal version of NewKubeatlasAPI
func NewKubeatlasAPIWithService(
	conf Config, kubeSvc services.KubeServiceInterface, broker *services.KubeEventBroker,
	contexts []string, currentCtx, version, buildInfo string,
) *KubeatlasAPI {
	return &KubeatlasAPI{
		Base:           api.NewBase("kubeatlas", version, buildInfo, true),
		kubeService:    kubeSvc,
		eventBroker:    broker,
		config:         conf,
		currentContext: currentCtx,
		contexts:       contexts,
		Version:        version,
		BuildInfo:      buildInfo,
	}
}
