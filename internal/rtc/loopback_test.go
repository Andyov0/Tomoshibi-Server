package rtc

import (
	"context"
	"net"
	"testing"
	"time"
)

/*
The fault this guards is slow rather than broken, which is why it survived a
deployment unnoticed.

A control node running a relay beside it dials that relay by its published name.
The name resolves to the machine's own public address, and a packet sent to your
own public address usually never comes back — so the connection is not refused,
it waits. Every management call took twelve seconds and the slowest page answered
502 because nginx gave up first. Nothing in any log said anything was wrong: the
relay was up, the page drew eventually, and the whole surface was simply slow.

So what is asserted here is that a dial to an address this machine holds goes
through the loopback interface, and that everything else is left alone.
*/

// listenLocal starts a listener on 127.0.0.1 and returns its port.
func listenLocal(t *testing.T) (string, net.Listener) {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = listener.Close() })

	_, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	return port, listener
}

// A name resolving to one of this machine's own addresses is turned around at
// the socket. Tested with localhost, which resolves to 127.0.0.1 — an address
// every machine holds — so the assertion does not depend on what this
// particular host's interfaces look like.
func TestOwnAddressGoesThroughLoopback(t *testing.T) {
	port, listener := listenLocal(t)

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()

	dialer := newLoopback()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort("localhost", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	select {
	case got := <-accepted:
		defer got.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("the listener never saw the connection")
	}

	host, _, err := net.SplitHostPort(conn.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}

	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		t.Errorf("the connection left from %s; a dial to this machine's own address should "+
			"go through loopback rather than out to the network", host)
	}
}

// Anything not this machine is dialled where it was addressed. A dialler that
// sent everything to loopback would pass the test above and report on every
// relay in the fleet using this machine's own media server.
//
// Asserted on where the connection went rather than on whether it failed. An
// unreachable address is not unreachable everywhere: a machine behind a
// transparent proxy has every address answered, and a test written as "this
// must fail" passes there for the wrong reason and fails here for another.
func TestAnotherMachineIsDialledWhereItWasAddressed(t *testing.T) {
	port, listener := listenLocal(t)
	defer listener.Close()

	dialer := newLoopback()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort("203.0.113.1", port))
	if err != nil {
		// Which is the ordinary outcome: the address is reserved for
		// documentation and routes nowhere. Nothing was turned around, which is
		// what this is about.
		return
	}
	defer conn.Close()

	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		t.Fatal(err)
	}

	if host != "203.0.113.1" {
		t.Errorf("a dial addressed to 203.0.113.1 ended up at %s; only this machine's own "+
			"addresses may be turned around", host)
	}
}

// A name that does not resolve must fail as it always would, rather than being
// turned into something else on the way.
func TestAnUnresolvableNameFailsNormally(t *testing.T) {
	dialer := newLoopback()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if conn, err := dialer.DialContext(ctx, "tcp", "nothing.invalid:443"); err == nil {
		conn.Close()
		t.Fatal("a name that resolves to nothing was dialled successfully")
	}
}

// The address list is read once and kept, so a management page redrawing every
// few seconds does not walk the interfaces on every request.
func TestAddressesAreReadOnce(t *testing.T) {
	dialer := newLoopback()

	first := dialer.addresses()
	second := dialer.addresses()

	if len(first) == 0 {
		t.Fatal("no local addresses were found at all; every dial would go to the network")
	}

	// Same map, not merely an equal one.
	if &first == &second {
		return
	}

	for addr := range first {
		if !second[addr] {
			t.Errorf("the address list changed between calls, so it is being re-read")
		}
	}
}
