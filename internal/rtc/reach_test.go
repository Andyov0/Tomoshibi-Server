package rtc

import (
	"context"
	"net"
	"testing"
)

/*
 * The check that tells a relay which is switched on from one a call can be held
 * on.
 *
 * These are two different questions and this deployment breaks on the second.
 * Signalling is TCP and media is UDP on another port, allowed through by
 * different rules, so a relay whose media port has been closed by a firewall
 * change answers the signalling check in eleven milliseconds and shows green
 * while every call sent to it arrives with no sound and no picture.
 *
 * Tested against the real responder over a real socket rather than against a
 * fake, because what is being asserted is that these two speak the same
 * protocol. A test with a stub on the other end would pass with either side
 * wrong in the same way.
 */

func TestMediaIsReachableWhereTheResponderIsListening(t *testing.T) {
	// A port the operating system has just confirmed is free, rather than zero.
	// Zero is off — a deployment that has not asked for a probe gets no open
	// port rather than one that answers — so Listen(0) hands back a nil probe
	// and a test written against it asserts on nothing. It failed that way
	// first, which is the test doing its job on itself.
	held, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket: %v", err)
	}
	port := held.LocalAddr().(*net.UDPAddr).Port
	held.Close()

	probe, err := Listen(port)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	if probe == nil {
		t.Fatal("Listen was given a real port and started nothing")
	}
	defer probe.Close()

	address := net.JoinHostPort("127.0.0.1", itoa(probe.Port()))

	asked, answered, took := Carrying(context.Background(), address)
	if !asked {
		t.Fatal("an address was given and nothing was asked")
	}
	if !answered {
		t.Fatal("the responder did not answer its own protocol")
	}
	if took <= 0 {
		t.Errorf("answered in %v, want a duration", took)
	}
}

func TestMediaIsUnreachableWhereNothingIsListening(t *testing.T) {
	// A port nothing holds. Bound and released, so it is one the operating
	// system has just confirmed is free rather than one guessed at.
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket: %v", err)
	}
	address := conn.LocalAddr().String()
	conn.Close()

	asked, answered, _ := Carrying(context.Background(), address)
	if !asked {
		t.Fatal("an address was given and nothing was asked")
	}
	if answered {
		t.Error("a port nothing is listening on answered")
	}
}

// A relay the deployment never gave a probe port to. Most of them, on most
// deployments, and reporting those as unreachable would take a working fleet
// offline over a setting nobody had filled in.
func TestARelayWithNoProbePortIsNotAsked(t *testing.T) {
	asked, answered, _ := Carrying(context.Background(), "")
	if asked {
		t.Error("a relay with no probe port was asked anyway")
	}
	if answered {
		t.Error("a relay with no probe port was reported as answering")
	}
}

// Something is listening, and it is not this. An open UDP port on the internet
// is sent scans and other people's mistakes, and any packet coming back would
// otherwise read as the relay answering.
func TestSomethingThatIsNotAResponderDoesNotCount(t *testing.T) {
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket: %v", err)
	}
	defer conn.Close()

	go func() {
		buffer := make([]byte, 128)
		n, from, err := conn.ReadFrom(buffer)
		if err != nil || n == 0 {
			return
		}

		// Twenty bytes of the wrong thing, which is long enough to pass a length
		// check and is not a binding response.
		_, _ = conn.WriteTo(make([]byte, 20), from)
	}()

	_, answered, _ := Carrying(context.Background(), conn.LocalAddr().String())
	if answered {
		t.Error("a port that answered with something else was counted as a relay")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}

	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}

	return string(digits)
}
