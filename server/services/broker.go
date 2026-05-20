// ==========================================================================================
// SSE event broker — wraps the generic SSE broker for Kubernetes event streaming
// ==========================================================================================

package services

import (
	"log/slog"
	"sync"
	"time"

	"github.com/benc-uk/go-rest-api/pkg/sse"
	"github.com/kubeatlas-org/kubeatlas/server/services/events"
)

// KubeEventBroker wraps the SSE broker to handle Kubernetes events
type KubeEventBroker struct {
	*sse.Broker[events.KubeEvent]
	mu sync.Mutex
}

// MoveClientToGroup atomically removes a client from all groups and adds it to the target group,
// preventing a race where SSE events could be delivered to the wrong namespace.
func (b *KubeEventBroker) MoveClientToGroup(clientID, group string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.RemoveFromAllGroups(clientID)
	b.AddToGroup(clientID, group)
}

// NewKubeEventBroker creates a configured SSE broker for streaming Kubernetes events.
// The `debug` parameter is retained for backward-compatibility with the API constructor;
// detailed event/group dumps now flow through slog at the Debug level (see LOG_LEVEL).
func NewKubeEventBroker(_ bool) *KubeEventBroker {
	// This is the underlying SSE broker that will handle streaming events to connected clients
	broker := sse.NewBroker[events.KubeEvent]()

	// Customize the broker with specific handlers and message adapters
	broker.MessageAdapter = func(ke events.KubeEvent, clientID string) sse.SSE {
		// ObjectJSON is pre-marshaled once at event creation; nothing to do here.
		data := string(ke.ObjectJSON)

		slog.Debug("🔄 sending SSE event",
			"event_type", ke.EventType, "client_id", clientID, "bytes", len(data))

		return sse.SSE{
			Data:  data,
			Event: string(ke.EventType),
		}
	}

	broker.ClientDisconnectedHandler = func(clientID string) {
		slog.Info("🔌 client disconnected", "client_id", clientID)
	}

	broker.ClientConnectedHandler = func(clientID string) {
		slog.Info("⚡ client connected", "client_id", clientID)

		allGroups := broker.GetGroups()
		slog.Debug("🔍 SSE broker state",
			"groups", allGroups, "clients", broker.GetClients())

		for _, group := range allGroups {
			clients := broker.GetGroupClients(group)
			slog.Debug("🔍 SSE group", "group", group, "clients", clients)
		}
	}

	// Start a SSE heartbeat to keep the connection alive, sent to all clients
	go func() {
		for {
			broker.SendToAll(events.KubeEvent{
				EventType: events.PingEvent,
			})
			time.Sleep(10 * time.Second)
		}
	}()

	return &KubeEventBroker{
		Broker: broker,
	}
}
