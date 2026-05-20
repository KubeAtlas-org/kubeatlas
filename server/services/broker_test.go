package services

import (
	"testing"
)

func TestKubeEventBroker_MoveClientToGroup(t *testing.T) {
	broker := NewKubeEventBroker(false)
	clientID := "client-1"
	groupA := "namespace-a"
	groupB := "namespace-b"

	// Add client to group A
	broker.AddToGroup(clientID, groupA)

	if !containsStr(broker.GetGroupClients(groupA), clientID) {
		t.Fatalf("Expected client in group A")
	}

	// Move client to group B
	broker.MoveClientToGroup(clientID, groupB)

	// Verify client is NOT in group A anymore
	if containsStr(broker.GetGroupClients(groupA), clientID) {
		t.Errorf("Expected client to be removed from group A")
	}

	// Verify client IS in group B
	if !containsStr(broker.GetGroupClients(groupB), clientID) {
		t.Errorf("Expected client to be added to group B")
	}
}

func containsStr(slice []string, s string) bool {
	for _, item := range slice {
		if item == s {
			return true
		}
	}

	return false
}
