package rtc

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

/*
What these guard is an open UDP port on the internet answering things it should
not.

This exists so a browser can time one round trip over the transport a call
actually uses, which means it has to be reachable by anybody about to join one —
and a reachable UDP port that replies to whatever arrives is an amplifier
pointed at whoever forged the source address. So the shape of the check matters
more than the shape of the answer: a binding request is recognised by three
separate things and everything else is dropped in silence.

The answer itself is checked because a browser will not accept a wrong one and
will not say why. A transaction id copied back incorrectly, or an address that
was not obscured with the cookie, is a probe that times out on every relay — and
"every relay is unreachable" is indistinguishable from "the network is bad".
*/

func request(t *testing.T) []byte {
	t.Helper()

	packet := make([]byte, stunHeader)
	binary.BigEndian.PutUint16(packet[0:2], bindRequest)
	binary.BigEndian.PutUint16(packet[2:4], 0)
	binary.BigEndian.PutUint32(packet[4:8], magicCookie)

	for i := 8; i < stunHeader; i++ {
		packet[i] = byte(i)
	}

	return packet
}

func TestABindingRequestIsAnswered(t *testing.T) {
	from := &net.UDPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 51234}

	reply, err := binding(request(t), from)
	if err != nil {
		t.Fatalf("a well formed binding request was refused: %v", err)
	}

	if got := binary.BigEndian.Uint16(reply[0:2]); got != bindSuccess {
		t.Errorf("answered with type %#04x, wanted a binding success", got)
	}

	// A browser matches its answer by this and silently discards anything else,
	// so getting it wrong reads as every relay being unreachable.
	sent := request(t)
	for i := range 12 {
		if reply[8+i] != sent[8+i] {
			t.Fatalf("the transaction id was not copied back at byte %d", i)
		}
	}

	// The address, unmasked the way a client will unmask it.
	if got := binary.BigEndian.Uint16(reply[stunHeader:]); got != xorMappedAddress {
		t.Fatalf("the first attribute was %#04x, wanted XOR-MAPPED-ADDRESS", got)
	}

	value := reply[stunHeader+4:]

	port := binary.BigEndian.Uint16(value[2:4]) ^ uint16(magicCookie>>16)
	if int(port) != from.Port {
		t.Errorf("reported port %d, wanted %d", port, from.Port)
	}

	cookie := make([]byte, 4)
	binary.BigEndian.PutUint32(cookie, magicCookie)

	ip := net.IPv4(
		value[4]^cookie[0], value[5]^cookie[1],
		value[6]^cookie[2], value[7]^cookie[3],
	)

	if !ip.Equal(from.IP) {
		t.Errorf("reported address %s, wanted %s", ip, from.IP)
	}
}

// Everything that is not a binding request, which on an open port is most of
// what arrives. None of it may be answered: a reply to unstructured traffic is
// how a service becomes somebody's amplifier.
func TestNothingElseIsAnswered(t *testing.T) {
	from := &net.UDPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 51234}

	short := request(t)[:12]

	wrongType := request(t)
	binary.BigEndian.PutUint16(wrongType[0:2], 0x0003)

	noCookie := request(t)
	binary.BigEndian.PutUint32(noCookie[4:8], 0xdeadbeef)

	// A length claiming more than arrived, which is the one that would be read
	// past the end of the packet if it were believed.
	lying := request(t)
	binary.BigEndian.PutUint16(lying[2:4], 400)

	for name, packet := range map[string][]byte{
		"too short":          short,
		"not a binding":      wrongType,
		"no magic cookie":    noCookie,
		"a lying length":     lying,
		"nothing at all":     {},
		"unstructured bytes": []byte("hello?"),
	} {
		if _, err := binding(packet, from); err == nil {
			t.Errorf("%s was answered", name)
		}
	}
}

// End to end, because the parsing being right does not mean the socket is.
func TestItAnswersOverTheWire(t *testing.T) {
	// A free port, found by taking one and giving it back. Zero means off in
	// the configuration, so it cannot mean "any" here.
	spare, err := net.ListenUDP("udp", &net.UDPAddr{Port: 0})
	if err != nil {
		t.Fatal(err)
	}

	port := spare.LocalAddr().(*net.UDPAddr).Port
	_ = spare.Close()

	probe, err := Listen(port)
	if err != nil {
		t.Fatal(err)
	}

	if probe == nil {
		t.Fatal("a probe was not started for a port that was configured")
	}

	defer probe.Close()

	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv6loopback, Port: probe.Port()})
	if err != nil {
		client, err = net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: probe.Port()})
		if err != nil {
			t.Fatal(err)
		}
	}

	defer client.Close()

	if _, err := client.Write(request(t)); err != nil {
		t.Fatal(err)
	}

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))

	buffer := make([]byte, 256)
	read, err := client.Read(buffer)
	if err != nil {
		t.Fatalf("no answer came back: %v", err)
	}

	if got := binary.BigEndian.Uint16(buffer[:read][0:2]); got != bindSuccess {
		t.Errorf("answered %#04x over the wire", got)
	}
}

func TestOffIsOff(t *testing.T) {
	// A deployment that did not ask for this has no such port open, rather than
	// one that answers. Zero is what an unset field is.
	probe, err := Listen(0)
	if err != nil {
		t.Fatal(err)
	}

	if probe != nil {
		t.Error("a probe was started for a port that was not configured")
	}
}
