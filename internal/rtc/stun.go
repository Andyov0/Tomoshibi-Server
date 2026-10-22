package rtc

import (
	"encoding/binary"
	"errors"
	"log/slog"
	"net"
)

/*
A UDP echo a browser can time, on the transport a call actually uses.

The picker measured a relay by opening its signalling socket, which is TCP: a
handshake, a TLS handshake, and an HTTP upgrade, so about three round trips
before anything comes back. It ranks relays correctly — every one of them pays
the same — but as a number it is roughly triple what the call will feel, and a
figure that reads as three times too slow is one nobody believes twice.

The call is UDP. What is wanted is one round trip over UDP, and the only thing a
browser can do that with is ICE: given a STUN server it sends a binding request
and reports back the address it was seen from, and the time to that answer is one
round trip on exactly the path the media will take.

So this answers STUN binding requests and nothing else.

Deliberately not a TURN server, which is the usual way to get this. A TURN server
open to the internet can be made to relay somebody else's traffic, and every one
of these is a machine in somebody's data centre with a bill attached. A binding
responder cannot be made to carry anything: it reads a request, writes the
source address back to the source address, and forgets. The worst it can be used
for is learning one's own address, which is the entire purpose.

Not on 3478 either. The standard port is scanned continuously and answering on it
is an invitation; the port is configured, and every deployment should pick an
unremarkable one.
*/

// What a STUN message looks like, in the parts that matter here.
const (
	stunHeader  = 20
	bindRequest = 0x0001
	bindSuccess = 0x0101
	// magicCookie identifies STUN and is what makes a stray packet on this port
	// distinguishable from a request. RFC 5389.
	magicCookie = 0x2112A442

	xorMappedAddress = 0x0020
	familyIPv4       = 0x01
	familyIPv6       = 0x02
)

// errNotBinding is what anything that is not a binding request comes back as.
//
// Which is most of what will arrive: this is an open UDP port on the internet
// and it will be sent scans, floods and other people's mistakes. All of it is
// dropped without a reply, because replying to unstructured traffic is how a
// service becomes an amplifier.
var errNotBinding = errors.New("not a stun binding request")

// Probe answers STUN binding requests so that a client can time one round trip.
type Probe struct {
	conn *net.UDPConn
}

// Listen starts one on a port.
//
// Returns nil where the port is zero, which is off: a deployment that has not
// asked for this has no such port open, rather than one that answers.
func Listen(port int) (*Probe, error) {
	if port <= 0 {
		return nil, nil
	}

	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, err
	}

	probe := &Probe{conn: conn}
	go probe.serve()

	return probe, nil
}

// Close stops answering.
func (p *Probe) Close() error {
	if p == nil || p.conn == nil {
		return nil
	}

	return p.conn.Close()
}

func (p *Probe) serve() {
	// One buffer for the loop. A binding request is 20 bytes plus whatever
	// attributes a client felt like adding, and anything longer than this is
	// not one — reading it into a larger buffer would only mean carrying it
	// further before dropping it.
	buffer := make([]byte, 1500)

	for {
		read, from, err := p.conn.ReadFromUDP(buffer)
		if err != nil {
			// The only error worth acting on is the socket being closed, which
			// is a shutdown. Everything else on a UDP read is one bad packet.
			if errors.Is(err, net.ErrClosed) {
				return
			}

			continue
		}

		reply, err := binding(buffer[:read], from)
		if err != nil {
			continue
		}

		// Written without waiting for anything. A client that did not get its
		// answer asks again; a server that blocked here on one unreachable
		// address would stop answering everybody else.
		_, _ = p.conn.WriteToUDP(reply, from)
	}
}

// binding reads a request and writes the answer to it.
func binding(packet []byte, from *net.UDPAddr) ([]byte, error) {
	if len(packet) < stunHeader {
		return nil, errNotBinding
	}

	if binary.BigEndian.Uint16(packet[0:2]) != bindRequest {
		return nil, errNotBinding
	}

	if binary.BigEndian.Uint32(packet[4:8]) != magicCookie {
		return nil, errNotBinding
	}

	// The length the sender claims, checked against what arrived. A packet
	// claiming more than it carries is malformed, and answering it would be
	// answering something that was not sent.
	if int(binary.BigEndian.Uint16(packet[2:4])) != len(packet)-stunHeader {
		return nil, errNotBinding
	}

	ip4 := from.IP.To4()

	family := byte(familyIPv6)
	address := from.IP.To16()
	if ip4 != nil {
		family = familyIPv4
		address = ip4
	}

	// XOR-MAPPED-ADDRESS: the port and address obscured with the cookie, which
	// is what stops a middlebox that rewrites addresses from helpfully
	// rewriting this one too.
	value := make([]byte, 4+len(address))
	value[1] = family
	binary.BigEndian.PutUint16(value[2:4], uint16(from.Port)^uint16(magicCookie>>16))

	cookie := make([]byte, 4)
	binary.BigEndian.PutUint32(cookie, magicCookie)

	for i := range address {
		if i < 4 {
			value[4+i] = address[i] ^ cookie[i]
		} else {
			// Beyond the cookie the transaction id continues the mask, which is
			// what RFC 5389 specifies for IPv6.
			value[4+i] = address[i] ^ packet[8+(i-4)]
		}
	}

	reply := make([]byte, 0, stunHeader+4+len(value))

	reply = binary.BigEndian.AppendUint16(reply, bindSuccess)
	reply = binary.BigEndian.AppendUint16(reply, uint16(4+len(value)))
	reply = binary.BigEndian.AppendUint32(reply, magicCookie)
	// The transaction id, copied back. A client matches its answer by this and
	// discards anything else, so getting it wrong is the same as not answering.
	reply = append(reply, packet[8:20]...)

	reply = binary.BigEndian.AppendUint16(reply, xorMappedAddress)
	reply = binary.BigEndian.AppendUint16(reply, uint16(len(value)))
	reply = append(reply, value...)

	return reply, nil
}

// Port says where it is listening, for a deployment that wants to print it.
func (p *Probe) Port() int {
	if p == nil || p.conn == nil {
		return 0
	}

	addr, ok := p.conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return 0
	}

	return addr.Port
}

// Announce says the probe is up, at the level a deployment reads at startup.
func (p *Probe) Announce() {
	if p == nil {
		return
	}

	slog.Info("answering stun binding requests, so clients can time one round trip "+
		"over the transport calls use", "udp", p.Port())
}
