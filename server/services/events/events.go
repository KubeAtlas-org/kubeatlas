// ==========================================================================================
// SSE event types and informer handler factories for Kubernetes resource changes
// ==========================================================================================

package events

import (
	"encoding/json"
	"log/slog"

	"github.com/benc-uk/go-rest-api/pkg/sse"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/cache"
)

// KubeEvent is used by the SSE broker to send events to connected clients
type KubeEvent struct {
	// EventType is the type of event, e.g. "add", "update", "delete" or "ping"
	EventType EventTypeEnum
	// ObjectJSON is the Kubernetes resource pre-marshaled to JSON once at event creation,
	// so it is not re-marshaled for every connected SSE client.
	ObjectJSON json.RawMessage
}

// EventTypeEnum is an enum for the type of event
type EventTypeEnum string

const (
	// AddEvent is triggered when a resource is added
	AddEvent EventTypeEnum = "add"
	// UpdateEvent is triggered when a resource is updated
	UpdateEvent EventTypeEnum = "update"
	// DeleteEvent is triggered when a resource is deleted
	DeleteEvent EventTypeEnum = "delete"
	// PingEvent is a heartbeat event to keep the connection alive
	PingEvent EventTypeEnum = "ping"

	// AllNamespacesGroup is a shared SSE group that receives every namespaced event,
	// so clients watching "all namespaces" land in a single fan-out group.
	AllNamespacesGroup = "_all_"
)

// MarshalEvent marshals an unstructured object to JSON for SSE delivery.
// managedFields are stripped first to reduce payload size.
// Returns nil on marshal error (caller should skip the event).
func MarshalEvent(u *unstructured.Unstructured) json.RawMessage {
	u.SetManagedFields(nil)

	b, err := json.Marshal(u.Object)
	if err != nil {
		slog.Error("💥 failed to marshal event object",
			"namespace", u.GetNamespace(), "name", u.GetName(), "err", err)
		return nil
	}

	return b
}

// GetHandlerFuncs returns event handlers for namespaced resources.
// Events are sent to the namespace group so only clients watching that namespace receive them.
func GetHandlerFuncs(b *sse.Broker[KubeEvent]) cache.ResourceEventHandlerFuncs {
	return cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			u := obj.(*unstructured.Unstructured)
			namespace := u.GetNamespace()
			if namespace == "" {
				return
			}

			data := MarshalEvent(u)
			if data == nil {
				return
			}

			ev := KubeEvent{EventType: AddEvent, ObjectJSON: data}
			b.SendToGroup(namespace, ev)
			b.SendToGroup(AllNamespacesGroup, ev)
		},

		UpdateFunc: func(oldObj, newObj interface{}) {
			u := newObj.(*unstructured.Unstructured)
			namespace := u.GetNamespace()
			if namespace == "" {
				return
			}

			data := MarshalEvent(u)
			if data == nil {
				return
			}

			ev := KubeEvent{EventType: UpdateEvent, ObjectJSON: data}
			b.SendToGroup(namespace, ev)
			b.SendToGroup(AllNamespacesGroup, ev)
		},

		DeleteFunc: func(obj interface{}) {
			u := obj.(*unstructured.Unstructured)
			namespace := u.GetNamespace()
			if namespace == "" {
				return
			}

			data := MarshalEvent(u)
			if data == nil {
				return
			}

			ev := KubeEvent{EventType: DeleteEvent, ObjectJSON: data}
			b.SendToGroup(namespace, ev)
			b.SendToGroup(AllNamespacesGroup, ev)
		},
	}
}

// GetClusterHandlerFuncs returns event handlers for cluster-scoped resources.
// Unlike GetHandlerFuncs, these use SendToAll (not namespace groups) and do NOT skip empty namespaces.
func GetClusterHandlerFuncs(b *sse.Broker[KubeEvent]) cache.ResourceEventHandlerFuncs {
	return cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			u := obj.(*unstructured.Unstructured)

			data := MarshalEvent(u)
			if data == nil {
				return
			}

			b.SendToAll(KubeEvent{
				EventType:  AddEvent,
				ObjectJSON: data,
			})
		},

		UpdateFunc: func(oldObj, newObj interface{}) {
			u := newObj.(*unstructured.Unstructured)

			data := MarshalEvent(u)
			if data == nil {
				return
			}

			b.SendToAll(KubeEvent{
				EventType:  UpdateEvent,
				ObjectJSON: data,
			})
		},

		DeleteFunc: func(obj interface{}) {
			u := obj.(*unstructured.Unstructured)

			data := MarshalEvent(u)
			if data == nil {
				return
			}

			b.SendToAll(KubeEvent{
				EventType:  DeleteEvent,
				ObjectJSON: data,
			})
		},
	}
}
