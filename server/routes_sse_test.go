package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/go-chi/chi/v5"
	"github.com/kubeatlas-org/kubeatlas/server/services"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/remotecommand"
)

// MockKubeService implements services.KubeServiceInterface
type MockKubeService struct {
	namespaces  []string
	nsError     error
	exists      bool
	fetchData   map[string][]unstructured.Unstructured
	fetchError  error
	getResource *unstructured.Unstructured
	getError    error
	updateError error
	deleteError error
	scaleError  error
	crdInfo     []services.CRDInfo
	metrics     bool
	podLogs     string
	clusterHost string
}

func (m *MockKubeService) GetNamespaces() ([]string, error)    { return m.namespaces, m.nsError }
func (m *MockKubeService) CheckNamespaceExists(ns string) bool { return m.exists }
func (m *MockKubeService) FetchNamespace(ns string) (map[string][]unstructured.Unstructured, error) {
	return m.fetchData, m.fetchError
}
func (m *MockKubeService) FetchClusterResources() (map[string][]unstructured.Unstructured, error) {
	return m.fetchData, m.fetchError
}
func (m *MockKubeService) GetResource(ns, kind, name string) (*unstructured.Unstructured, error) {
	return m.getResource, m.getError
}
func (m *MockKubeService) UpdateResource(ns string, obj *unstructured.Unstructured) error {
	return m.updateError
}
func (m *MockKubeService) DeleteResource(ns, kind, name string) error { return m.deleteError }
func (m *MockKubeService) ScaleResource(ns, kind, name string, replicas int32) error {
	return m.scaleError
}
func (m *MockKubeService) RestartResource(ns, kind, name string) error {
	return m.updateError
}
func (m *MockKubeService) MetricsAvailable() bool { return m.metrics }
func (m *MockKubeService) GetClusterHost() string { return m.clusterHost }
func (m *MockKubeService) GetPodLogs(
	ns, podName, container string, lineCount int, previous, timestamps bool,
) (string, error) {
	return m.podLogs, m.fetchError
}
func (m *MockKubeService) StreamPodLogs(
	ctx context.Context, ns, podName, container string,
	lineCount int, previous, timestamps bool, w io.Writer,
) error {
	_, _ = w.Write([]byte("streaming logs"))
	return nil
}
func (m *MockKubeService) ExecPod(
	ctx context.Context, ns, pod, container string,
	stdin io.Reader, stdout io.Writer, resizeQueue remotecommand.TerminalSizeQueue,
) error {
	return nil
}
func (m *MockKubeService) GetPodMetrics(ns string) ([]unstructured.Unstructured, error) {
	return m.fetchData["metrics"], m.fetchError
}
func (m *MockKubeService) GetNodeMetrics() ([]unstructured.Unstructured, error) {
	return m.fetchData["metrics"], m.fetchError
}
func (m *MockKubeService) DiscoverCRDs() ([]services.CRDInfo, error) {
	return m.crdInfo, m.fetchError
}
func (m *MockKubeService) GetCRDResources(ns, group, version, resource string) ([]unstructured.Unstructured, error) {
	return m.fetchData["cr"], m.fetchError
}
func (m *MockKubeService) Close() {}

func TestHandleNamespaceList(t *testing.T) {
	mock := &MockKubeService{
		namespaces: []string{"default", "kube-system", "myns"},
		metrics:    true,
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		config:      Config{},
		Version:     "1.0",
		BuildInfo:   "build",
	}

	req := httptest.NewRequest("GET", "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNamespaceList(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleNamespaceList() status = %v, want %v", rec.Code, http.StatusOK)
	}

	var res NamespaceListResult

	_ = json.Unmarshal(rec.Body.Bytes(), &res)

	if len(res.Namespaces) != 3 {
		t.Errorf("Expected 3 namespaces, got %d", len(res.Namespaces))
	}
}

func TestHandleNamespaceList_Error(t *testing.T) {
	mock := &MockKubeService{
		nsError: errors.New("k8s error"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNamespaceList(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500 on k8s error, got %v", rec.Code)
	}
}

func TestHandleNamespaceList_Filtered(t *testing.T) {
	mock := &MockKubeService{
		namespaces: []string{"default", "kube-system", "myns"},
	}

	filter, _ := regexp.Compile("^kube-.*")
	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		config: Config{
			NameSpaceFilterRegexp: filter,
		},
	}

	req := httptest.NewRequest("GET", "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNamespaceList(rec, req)

	var res NamespaceListResult

	_ = json.Unmarshal(rec.Body.Bytes(), &res)

	for _, ns := range res.Namespaces {
		if ns == "kube-system" {
			t.Errorf("Expected 'kube-system' to be filtered out")
		}
	}
}

func TestHandleNamespaceList_SingleNamespace(t *testing.T) {
	mock := &MockKubeService{
		namespaces: []string{"default", "myns"},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		config: Config{
			SingleNamespace: "myns",
		},
	}

	req := httptest.NewRequest("GET", "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNamespaceList(rec, req)

	var res NamespaceListResult

	_ = json.Unmarshal(rec.Body.Bytes(), &res)

	if len(res.Namespaces) != 1 || res.Namespaces[0] != "myns" {
		t.Errorf("Expected only 'myns', got %v", res.Namespaces)
	}
}

func TestHandleNamespaceList_AllFiltered(t *testing.T) {
	mock := &MockKubeService{
		namespaces: []string{"kube-system"},
	}

	filter, _ := regexp.Compile("^kube-.*")
	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		config: Config{
			NameSpaceFilterRegexp: filter,
		},
	}

	req := httptest.NewRequest("GET", "/api/namespaces", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleNamespaceList(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500 when all namespaces filtered, got %v", rec.Code)
	}
}

func TestHandleFetchData(t *testing.T) {
	mock := &MockKubeService{
		exists: true,
		fetchData: map[string][]unstructured.Unstructured{
			"pods": {
				{
					Object: map[string]interface{}{
						"apiVersion": "v1",
						"kind":       "Pod",
						"metadata": map[string]interface{}{
							"name": "test-pod",
						},
					},
				},
			},
		},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		eventBroker: services.NewKubeEventBroker(false),
		config:      Config{},
	}

	r := chi.NewRouter()
	r.Get("/api/fetch/{namespace}", apiSvc.handleFetchData)

	req := httptest.NewRequest("GET", "/api/fetch/default?clientID=test-client", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleFetchData() status = %v, want %v", rec.Code, http.StatusOK)
	}
}

func TestHandleFetchData_Forbidden(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
		config: Config{
			SingleNamespace: "myns",
		},
	}

	r := chi.NewRouter()
	r.Get("/api/fetch/{namespace}", apiSvc.handleFetchData)

	req := httptest.NewRequest("GET", "/api/fetch/default?clientID=test", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("Expected 403, got %v", rec.Code)
	}
}

func TestHandleFetchData_NotFound(t *testing.T) {
	mock := &MockKubeService{
		exists: false,
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		eventBroker: services.NewKubeEventBroker(false),
	}

	r := chi.NewRouter()
	r.Get("/api/fetch/{namespace}", apiSvc.handleFetchData)

	req := httptest.NewRequest("GET", "/api/fetch/nonexistent?clientID=test", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("Expected 404, got %v", rec.Code)
	}
}

func TestHandleFetchData_Error(t *testing.T) {
	mock := &MockKubeService{
		exists:     true,
		fetchError: errors.New("fetch error"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		eventBroker: services.NewKubeEventBroker(false),
	}

	r := chi.NewRouter()
	r.Get("/api/fetch/{namespace}", apiSvc.handleFetchData)

	req := httptest.NewRequest("GET", "/api/fetch/default?clientID=test", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500, got %v", rec.Code)
	}
}

func TestHandleFetchClusterData(t *testing.T) {
	mock := &MockKubeService{
		fetchData: map[string][]unstructured.Unstructured{
			"nodes": {{}},
		},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/fetch-cluster", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleFetchClusterData(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleFetchClusterData() status = %v, want %v", rec.Code, http.StatusOK)
	}
}

func TestHandleFetchClusterData_Error(t *testing.T) {
	mock := &MockKubeService{
		fetchError: errors.New("cluster error"),
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
	}

	req := httptest.NewRequest("GET", "/api/fetch-cluster", nil)
	rec := httptest.NewRecorder()

	apiSvc.handleFetchClusterData(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500 on cluster fetch error, got %v", rec.Code)
	}
}

func TestHandleFetchData_AllNamespaces(t *testing.T) {
	mock := &MockKubeService{
		exists: true,
		fetchData: map[string][]unstructured.Unstructured{
			"pods": {{}},
		},
	}

	apiSvc := &KubeatlasAPI{
		Base:        api.NewBase("test", "1.0", "build", true),
		kubeService: mock,
		eventBroker: services.NewKubeEventBroker(false),
	}

	r := chi.NewRouter()
	r.Get("/api/fetch/{namespace}", apiSvc.handleFetchData)

	req := httptest.NewRequest("GET", "/api/fetch/_all_?clientID=test", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200, got %v", rec.Code)
	}
}

func TestHandleFetchData_NoClientID(t *testing.T) {
	apiSvc := &KubeatlasAPI{
		Base: api.NewBase("test", "1.0", "build", true),
	}

	r := chi.NewRouter()
	r.Get("/api/fetch/{namespace}", apiSvc.handleFetchData)

	req := httptest.NewRequest("GET", "/api/fetch/default", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %v", rec.Code)
	}
}
