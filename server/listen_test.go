package main

import (
	"net"
	"testing"
)

// On a free port, listen binds exactly that port.
func TestListen_FreePort(t *testing.T) {
	ln, err := listen("127.0.0.1:0", false)
	if err != nil {
		t.Fatalf("listen on free port: %v", err)
	}
	defer ln.Close()

	if ln.Addr().(*net.TCPAddr).Port == 0 {
		t.Error("expected a concrete bound port, got 0")
	}
}

// When the preferred port is busy and not pinned, listen falls back to a
// different, free port instead of failing.
func TestListen_FallbackWhenBusy(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer occupied.Close()

	busyPort := occupied.Addr().(*net.TCPAddr).Port
	busyAddr := occupied.Addr().String()

	ln, err := listen(busyAddr, false)
	if err != nil {
		t.Fatalf("expected fallback, got error: %v", err)
	}
	defer ln.Close()

	got := ln.Addr().(*net.TCPAddr).Port
	if got == busyPort {
		t.Errorf("fell back to the busy port %d", got)
	}

	if got == 0 {
		t.Error("expected a concrete fallback port, got 0")
	}
}

// An explicitly pinned port that is busy is a hard error, not a silent move.
func TestListen_ExplicitBusyErrors(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer occupied.Close()

	ln, err := listen(occupied.Addr().String(), true)
	if err == nil {
		ln.Close()
		t.Fatal("expected an error for an explicit busy port, got nil")
	}
}
