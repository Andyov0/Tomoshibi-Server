package app

import (
	"context"
	"net"
	"net/netip"
	"sync"
	"time"
)

/*
What a stranger is told about where the relays are.

/api/relays is answered to anybody, because a browser measures the relays
before it has signed in to anything. It used to answer with every relay,
including the ones kept for administrators, and with each one's probe address
as it was typed — usually a name under the deployment's relay domain. One
request listed the fleet by name, silent mainland machines included, and a
name is what the networks those machines sit on filter by.

So a stranger is not told about a relay kept for administrators at all, and is
given a probe as the address it resolves to rather than the name: the browser
needs somewhere to send one STUN packet, and an address is that. A name that
will not resolve is left out, and that relay goes unmeasured rather than named.
*/

// How long an answer about a probe's address is kept, and how long a failure.
const (
	probeKept   = 10 * time.Minute
	probeMissed = time.Minute
)

// How long resolving the probes may hold up the list.
const probeResolving = 1500 * time.Millisecond

type resolvedProbe struct {
	address string
	at      time.Time
}

// probeBook holds what each probe's host resolved to.
type probeBook struct {
	mu   sync.Mutex
	held map[string]resolvedProbe
	// lookup is the resolver, replaceable in a test.
	lookup func(ctx context.Context, host string) ([]netip.Addr, error)
}

// addresses answers each probe as address:port, resolving the ones it has no
// fresh answer for together and within probeResolving. A probe whose host
// cannot be resolved maps to "".
func (b *probeBook) addresses(probes []string) map[string]string {
	now := time.Now()
	out := make(map[string]string, len(probes))
	var missing []string

	b.mu.Lock()
	if b.held == nil {
		b.held = map[string]resolvedProbe{}
	}

	for _, probe := range probes {
		host, port, err := net.SplitHostPort(probe)
		if err != nil {
			out[probe] = ""
			continue
		}

		if addr, err := netip.ParseAddr(host); err == nil {
			out[probe] = net.JoinHostPort(addr.String(), port)
			continue
		}

		if held, ok := b.held[probe]; ok {
			keep := probeKept
			if held.address == "" {
				keep = probeMissed
			}

			if now.Sub(held.at) < keep {
				out[probe] = held.address
				continue
			}
		}

		missing = append(missing, probe)
	}
	b.mu.Unlock()

	if len(missing) == 0 {
		return out
	}

	lookup := b.lookup
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeResolving)
	defer cancel()

	var (
		wg    sync.WaitGroup
		found sync.Map
	)

	for _, probe := range missing {
		wg.Add(1)

		go func() {
			defer wg.Done()

			host, port, _ := net.SplitHostPort(probe)

			addrs, err := lookup(ctx, host)
			if err != nil || len(addrs) == 0 {
				return
			}

			// The control node's own answer is not always the world's. A
			// relay it reaches through a local forwarder (SH ChinaTelecom, by
			// an /etc/hosts line to 127.0.0.1 that a socat carries on) resolves
			// to loopback here; handed out, that sent every browser's STUN
			// packet to the browser's own machine, the one relay went quiet,
			// and a list where one relay misses over UDP is measured over
			// signalling, which strangers have no address for, so every relay
			// read as down (2026-11-01). Only a public address is handed out;
			// a name that resolves to nothing public here is handed out as the
			// name, as it was before, for the browser to resolve itself.
			for _, addr := range addrs {
				if a := addr.Unmap(); publicAddress(a) {
					found.Store(probe, net.JoinHostPort(a.String(), port))
					return
				}
			}

			found.Store(probe, probe)
		}()
	}

	wg.Wait()

	b.mu.Lock()
	defer b.mu.Unlock()

	for _, probe := range missing {
		address := ""
		if got, ok := found.Load(probe); ok {
			address = got.(string)
		}

		b.held[probe] = resolvedProbe{address: address, at: now}
		out[probe] = address
	}

	return out
}

// publicAddress is an address a stranger's browser can send a packet to: not
// loopback, not private, not link-local, not unspecified or multicast.
func publicAddress(a netip.Addr) bool {
	return a.IsValid() && a.IsGlobalUnicast() && !a.IsPrivate()
}
