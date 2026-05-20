// ==========================================================================================
// The backend API for KubeAtlas, handling requests and serving data
// ==========================================================================================

package main

import (
	"log/slog"
	"os"
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
	switchMu       sync.Mutex // serializes concurrent context-switch requests
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
}

func NewKubeatlasAPI(conf Config) *KubeatlasAPI {
	broker := services.NewKubeEventBroker(conf.Debug)

	// Discover available kubeconfig contexts before connecting
	contexts, currentCtx, _ := services.GetKubeContexts()

	// Create a new Kubernetes service instance, which will connect to the cluster
	kubeSvc, err := services.NewKubernetes(broker.Broker, conf.SingleNamespace, "")
	if err != nil {
		slog.Error("💥 error connecting to Kubernetes, system will exit", "err", err)
		os.Exit(1)
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
