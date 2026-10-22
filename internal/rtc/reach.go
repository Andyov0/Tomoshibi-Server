package rtc

import (
	"context"
	"crypto/rand"
	"net"
	"time"
)

/*
Asking a relay whether media can reach it, rather than whether it is switched on.

The health check opens a TCP connection to the signalling port and closes it,
and the comment on it argues that the difference between a machine being up and
a relay working is a fair trade, because a relay broken above the socket shows
up as calls failing rather than as a green row.

There is one way for a relay to be broken that the argument misses, and it is
the way these break. Signalling is TCP and media is UDP, on a different port,
and the two are allowed through by different rules — a host firewall, a cloud
provider's security group, an nftables mapping that did not survive a reboot.
When the UDP port stops being reachable and the TCP one does not, the relay
answers the check in eleven milliseconds, shows green, and is handed calls that
every participant then fails to get any media on. It is a green row, and it is
the most common way a relay here goes wrong.

A STUN binding request closes it, and closes it without reintroducing what the
TCP-only check exists to avoid. The thing that takes a mainland relay off the
air is an HTTPS request that gets an answer; this is a UDP packet to a port
chosen not to be 3478, answered only where the deployment turned the responder
on, and it is exactly the packet the browser's own measurement sends.
*/

// asking is a STUN binding request: one packet, asking for one back.
//
// Named for what it does rather than for what it is, because the responder in
// this package already has a binding() that reads one.
func asking() []byte {
	packet := make([]byte, 20)

	// A binding request, and the magic cookie that tells STUN apart from
	// everything else that arrives on an open UDP port.
	packet[0], packet[1] = 0x00, 0x01
	packet[4], packet[5], packet[6], packet[7] = 0x21, 0x12, 0xa4, 0x42
	_, _ = rand.Read(packet[8:])

	return packet
}

// Carrying says whether a relay's media port answers, and how quickly.
//
// The empty address is not a failure. Most deployments have no probe port and
// most relays in one that does may not have been given theirs yet, and a check
// that reported those as unreachable would take a working fleet offline over a
// setting nobody had filled in.
func Carrying(ctx context.Context, address string) (asked, answered bool, took time.Duration) {
	if address == "" {
		return false, false, 0
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	deadline, _ := ctx.Deadline()

	var dialer net.Dialer

	conn, err := dialer.DialContext(ctx, "udp", address)
	if err != nil {
		return true, false, 0
	}
	defer conn.Close()

	_ = conn.SetDeadline(deadline)

	started := time.Now()

	if _, err := conn.Write(asking()); err != nil {
		return true, false, 0
	}

	reply := make([]byte, 128)

	n, err := conn.Read(reply)
	if err != nil || n < 20 {
		return true, false, time.Since(started)
	}

	// A binding response and not merely something. An open UDP port on the
	// internet is sent scans and other people's mistakes, and any of them would
	// otherwise read as the relay answering.
	if reply[0] != 0x01 || reply[1] != 0x01 {
		return true, false, time.Since(started)
	}

	return true, true, time.Since(started)
}
