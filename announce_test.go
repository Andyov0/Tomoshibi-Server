package main

import (
	"bytes"
	"log/slog"
	"net"
	"strings"
	"testing"
)

/*
Where the start says the client can be opened.

A listener on a loopback address was announced as reachable on the network,
at the machine's outward address, with a warning to put it behind HTTPS before
using it from another machine — on every local deployment, about a door that
was not there (the health check of 2026-10-29). And a listener bound to one
address was announced at whatever address the routing table would use to go
outward, which need not be the one it listens on.
*/

func announced(t *testing.T, addr net.Addr, secure bool) string {
	t.Helper()

	var out bytes.Buffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&out, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })

	announce(addr, secure)

	return out.String()
}

func TestALoopbackListenerIsNotOnTheNetwork(t *testing.T) {
	for _, ip := range []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback} {
		got := announced(t, &net.TCPAddr{IP: ip, Port: 19420}, false)

		if strings.Contains(got, "reachable on the network") {
			t.Errorf("a listener on %s was announced on the network:\n%s", ip, got)
		}
		if !strings.Contains(got, "http://localhost:19420/") {
			t.Errorf("the local address was not announced for %s:\n%s", ip, got)
		}
	}
}

func TestAListenerOnOneAddressIsAnnouncedThere(t *testing.T) {
	got := announced(t, &net.TCPAddr{IP: net.IPv4(192, 0, 2, 10), Port: 8080}, false)

	if !strings.Contains(got, "http://192.0.2.10:8080/") || !strings.Contains(got, "cameras need a secure page") {
		t.Errorf("a listener on 192.0.2.10 was not announced at its own address, with the warning:\n%s", got)
	}

	got = announced(t, &net.TCPAddr{IP: net.IPv4(192, 0, 2, 10), Port: 8443}, true)
	if !strings.Contains(got, "https://192.0.2.10:8443/") || strings.Contains(got, "cameras need a secure page") {
		t.Errorf("a secure listener on 192.0.2.10 was not announced plainly at its own address:\n%s", got)
	}
}
