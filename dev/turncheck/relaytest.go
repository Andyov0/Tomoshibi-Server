package main

import (
	"fmt"
	"net"
	"os"
	"time"

	"github.com/pion/turn/v5"
	"tomoshibi/internal/rtc"
)

// relayThrough allocates on a TURN server and waits for somebody to send to the
// address it was given.
//
// Allocating proves the credentials and the listening port. It proves nothing
// about the relay range: a server whose allocation port is firewalled hands back
// an address, accepts the permission, and then silently carries nothing — which
// from a browser is a call that negotiates, connects, and has no media in it.
func relayThrough(address, key, secret, peer string) {
	forward, err := rtc.Forward(address, key, secret)
	if err != nil {
		fmt.Println("mint:", err)
		os.Exit(1)
	}

	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	defer conn.Close()

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: address, TURNServerAddr: address, Conn: conn,
		Username: forward.Username, Password: forward.Credential, Realm: "livekit",
	})
	if err != nil {
		fmt.Println("client:", err)
		os.Exit(1)
	}
	defer client.Close()

	if err := client.Listen(); err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}

	relayed, err := client.Allocate()
	if err != nil {
		fmt.Printf("REFUSED %s: %v\n", address, err)
		os.Exit(1)
	}
	defer relayed.Close()

	// The peer has to be permitted before anything it sends is forwarded. This
	// is the step a browser's ICE stack does on its own and the one nothing
	// visible depends on until traffic is expected.
	from, err := net.ResolveUDPAddr("udp4", peer)
	if err != nil {
		fmt.Println("peer:", err)
		os.Exit(1)
	}

	if err := relayed.(interface{ CreatePermissions(...net.Addr) error }).
		CreatePermissions(from); err != nil {
		fmt.Println("permission:", err)
	}

	fmt.Printf("RELAY %s\n", relayed.LocalAddr())

	_ = relayed.SetReadDeadline(time.Now().Add(20 * time.Second))

	buffer := make([]byte, 1500)

	read, sender, err := relayed.ReadFrom(buffer)
	if err != nil {
		fmt.Printf("NOTHING ARRIVED at %s from %s\n", relayed.LocalAddr(), peer)
		fmt.Println("  Which means one of two things, and this cannot tell them apart:")
		fmt.Println("  the relay range is not reachable, or nothing was sent. Only the")
		fmt.Println("  permitted address may send, so unless something at", peer)
		fmt.Println("  addressed", relayed.LocalAddr(), "during those twenty seconds,")
		fmt.Println("  silence here says nothing at all. Use -self to close the loop.")
		os.Exit(1)
	}

	fmt.Printf("OK carried %d bytes from %s\n", read, sender)
}

// through allocates and then sends to its own allocation, so the answer does
// not depend on somebody at the other end doing anything.
//
// Written after the two-step form was read as a verdict. It prints the relayed
// address and waits, which is correct and is not self-contained: run with a
// peer that sends nothing and it reports silence, which reads as the forwarding
// being broken when what it measured was that nobody spoke. Two separate
// conclusions were drawn from that in one afternoon before the code was read.
func through(address, key, secret string, port int) {
	forward, err := rtc.Forward(address, key, secret)
	if err != nil {
		fmt.Println("mint:", err)
		os.Exit(1)
	}

	// The socket that will send, bound first, because the permission has to
	// name the address it will arrive from.
	sending, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	defer sending.Close()

	mine, err := outward(port)
	if err != nil {
		fmt.Println("own address:", err)
		os.Exit(1)
	}

	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	defer conn.Close()

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: address, TURNServerAddr: address, Conn: conn,
		Username: forward.Username, Password: forward.Credential, Realm: "livekit",
	})
	if err != nil {
		fmt.Println("client:", err)
		os.Exit(1)
	}
	defer client.Close()

	if err := client.Listen(); err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}

	relayed, err := client.Allocate()
	if err != nil {
		fmt.Printf("REFUSED %s: %v\n", address, err)
		os.Exit(1)
	}
	defer relayed.Close()

	if err := relayed.(interface{ CreatePermissions(...net.Addr) error }).
		CreatePermissions(mine); err != nil {
		fmt.Println("permission:", err)
		os.Exit(1)
	}

	fmt.Printf("RELAY %s, sending from %s\n", relayed.LocalAddr(), mine)

	// Several, because one lost packet on a path being tested for loss is not
	// an answer.
	target, err := net.ResolveUDPAddr("udp4", relayed.LocalAddr().String())
	if err != nil {
		fmt.Println("target:", err)
		os.Exit(1)
	}

	for range 5 {
		_, _ = sending.WriteTo([]byte("through-the-relay"), target)
		time.Sleep(200 * time.Millisecond)
	}

	_ = relayed.SetReadDeadline(time.Now().Add(5 * time.Second))

	buffer := make([]byte, 1500)

	read, from, err := relayed.ReadFrom(buffer)
	if err != nil {
		fmt.Printf("NOTHING ARRIVED at %s, and this end did send: the relay range is not "+
			"carrying\n", relayed.LocalAddr())
		os.Exit(1)
	}

	fmt.Printf("OK carried %d bytes from %s\n", read, from)
}

// outward is this machine's own address as the relay will see it.
func outward(port int) (*net.UDPAddr, error) {
	// Asking the routing table rather than a service: no packet is sent, and
	// the answer is the address this machine would use to reach the relay.
	probe, err := net.Dial("udp4", "1.1.1.1:53")
	if err != nil {
		return nil, err
	}
	defer probe.Close()

	local, ok := probe.LocalAddr().(*net.UDPAddr)
	if !ok {
		return nil, fmt.Errorf("no address")
	}

	return &net.UDPAddr{IP: local.IP, Port: port}, nil
}
