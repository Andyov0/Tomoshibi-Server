package rtc

import (
	"context"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

/*
A control node that runs a relay beside it reaches that relay by the name it
publishes, which resolves to the machine's own public address — and on most
hosts a packet sent to your own public address does not come back. Some routers
do it, most do not, and a cloud network almost never does. The connection is not
refused; it is simply never answered, so every request waits out its timeout.

Nothing looks broken. The relay is up, the page eventually draws, and the
management surface merely takes six seconds a panel. The one deployment where
this was measured spent twelve seconds per call and answered 502 on the slowest
page, because nginx gave up first.

So a connection to an address this machine already holds is turned around at the
socket rather than sent to the network. The name is left alone, which matters:
the certificate is issued for it, and rewriting the URL to 127.0.0.1 would make
every one of these calls fail verification instead of merely being slow.
*/

// loopback dials through the local interface whenever the destination is an
// address this machine holds.
type loopback struct {
	dialer *net.Dialer

	once  sync.Once
	local map[string]bool

	// declared is what a deployment said this machine answers on, for the
	// addresses NAT keeps off the interfaces.
	declared map[string]bool
}

// newLoopback builds a dialler that turns connections to this machine around.
//
// extra names addresses this machine answers on that its interfaces do not
// carry. Behind NAT — which is most cloud machines and every container — the
// public address is mapped rather than held, so reading the interfaces finds
// the private one and misses the address the relay actually publishes. Without
// this the short-circuit never fires on exactly the deployments that need it.
func newLoopback(extra ...string) *loopback {
	l := &loopback{dialer: &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}}

	l.declared = map[string]bool{}
	for _, addr := range extra {
		if addr = strings.TrimSpace(addr); addr != "" {
			l.declared[addr] = true
		}
	}

	return l
}

// addresses is every address this machine answers on.
//
// Read once and kept. An address can be added to an interface while a process
// runs, but a relay whose address changed under it has a larger problem than
// this, and re-reading the interface list on every dial would put a syscall in
// front of every management request to save a case that does not happen.
func (l *loopback) addresses() map[string]bool {
	l.once.Do(func() {
		l.local = map[string]bool{}

		// The interfaces, where they can be read, and then the declared
		// addresses either way.
		//
		// This used to return on the error, which skipped the loop below it —
		// and the loop below it is the one that adds what the operator wrote
		// down. So the single setting that exists for the case where a machine
		// cannot work out its own address was thrown away by the failure of the
		// thing it is the answer to. Behind a sync.Once, so it was thrown away
		// for the life of the process.
		if addrs, err := net.InterfaceAddrs(); err == nil {
			for _, addr := range addrs {
				if ipnet, ok := addr.(*net.IPNet); ok {
					l.local[ipnet.IP.String()] = true
				}
			}
		} else {
			slog.Warn("could not read this machine's own addresses, so only the ones declared in "+
				"meet.public_addresses are known to be local", "error", err)
		}

		for addr := range l.declared {
			l.local[addr] = true
		}
	})

	return l.local
}

// DialContext connects, short-circuiting anything that would leave and come
// back.
func (l *loopback) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return l.dialer.DialContext(ctx, network, address)
	}

	// Resolved first, because what is dialled is usually a name. A name that
	// does not resolve is left to the ordinary dialler to fail on, so that the
	// error a caller sees is the one it would have seen anyway.
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return l.dialer.DialContext(ctx, network, address)
	}

	mine := l.addresses()

	for _, ip := range ips {
		if mine[ip.IP.String()] {
			// Loopback rather than the address itself: binding to a public
			// address this machine holds works, but going through the loopback
			// interface is the shorter path and is what makes this eleven
			// milliseconds instead of twelve seconds.
			return l.dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		}
	}

	return l.dialer.DialContext(ctx, network, address)
}
