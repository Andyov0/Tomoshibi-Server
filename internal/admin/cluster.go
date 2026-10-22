package admin

import (
	"context"
	"sort"
	"sync"
	"time"

	"tomoshibi/internal/rtc"
)

// Fleet is how a control node reads the counters of the machines it does not
// run.
//
// Separate from Control, which asks about rooms. These are the figures only the
// process holding a media server can see — throughput, tracks, CPU — and the
// reason a control node's dashboard was empty: there is no media server here,
// and none of this can be worked out from redis.
type Fleet interface {
	// Relays is the addresses to read, live, so a relay added on a page is
	// included without a restart.
	Relays() []string
	AskStats(ctx context.Context, relay string) (rtc.Stats, error)
}

// nodeReading is one relay's answer, or the reason there was not one.
type nodeReading struct {
	Name string `json:"name"`
	URL  string `json:"url"`

	// What an operator calls the machine and where it is, carried here so the
	// page can group and label without asking a second endpoint for the list it
	// is already looking at. The two lists would drift for a second on every
	// change, and the second of them arrives while the page is drawn.
	Label  string `json:"label,omitempty"`
	Region string `json:"region,omitempty"`

	// How long this relay took to answer, in milliseconds.
	//
	// A round trip to the machine and back, which is the only latency figure
	// this page can honestly report — it is what the control node measures by
	// doing the thing it was going to do anyway. It is not what a caller will
	// see, and the page says so.
	TookMs int64 `json:"tookMs,omitempty"`

	// Reachable separates a relay holding no calls from one that did not
	// answer. Both would otherwise show as zeros, and the difference between
	// "quiet" and "down" is the whole reason somebody opens this page.
	Reachable bool   `json:"reachable"`
	Detail    string `json:"detail,omitempty"`

	rtc.Stats
}

// fleetReading is every relay, plus the totals across them.
type fleetReading struct {
	Nodes []nodeReading `json:"nodes"`

	// Totals sum only the relays that answered. A sum that silently included
	// zeros for the unreachable ones would fall when a machine went down and
	// read as calls ending.
	Totals rtc.Stats `json:"totals"`

	Answered int `json:"answered"`
	Asked    int `json:"asked"`
}

// readFleet asks every relay at once and adds up what comes back.
//
// In parallel because this is drawn on a page somebody is waiting in front of,
// and in turn the wait would be the sum of every relay's latency — including
// the full timeout of any that is down, which is the case the page is most
// often opened to look at.
func readFleet(ctx context.Context, fleet Fleet, named map[string]relayLook) fleetReading {
	relays := fleet.Relays()

	reading := fleetReading{Asked: len(relays), Nodes: make([]nodeReading, len(relays))}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var wait sync.WaitGroup
	for i, url := range relays {
		look := named[url]
		reading.Nodes[i] = nodeReading{
			URL: url, Name: look.Name, Label: look.Label, Region: look.Region,
		}

		wait.Add(1)
		go func(i int, url string) {
			defer wait.Done()

			started := time.Now()
			stats, err := fleet.AskStats(ctx, url)
			took := time.Since(started)

			if err != nil {
				reading.Nodes[i].Detail = err.Error()
				return
			}

			reading.Nodes[i].Reachable = true
			reading.Nodes[i].Stats = stats
			reading.Nodes[i].TookMs = took.Milliseconds()
		}(i, url)
	}
	wait.Wait()

	// In the order the deployment lists its relays, so a page redrawn every few
	// seconds does not reorder itself under whoever is reading it. Goroutines
	// finish in whatever order the network allows, which is not an order
	// anybody wants to watch.
	//
	// The list's order rather than alphabetical, which is what this was. An
	// operator sorts that list by hand and the sorting means something — near
	// first, or the ones that carry the traffic first — and answering with it
	// alphabetised threw that away and grouped the fleet page's regions in an
	// order matching nothing else in the interface. Where a relay is not in the
	// list at all it sorts last, by name, rather than at an arbitrary nought.
	sort.Slice(reading.Nodes, func(i, j int) bool {
		left, leftKnown := named[reading.Nodes[i].URL]
		right, rightKnown := named[reading.Nodes[j].URL]

		if leftKnown != rightKnown {
			return leftKnown
		}

		if leftKnown && left.Order != right.Order {
			return left.Order < right.Order
		}

		if reading.Nodes[i].Name != reading.Nodes[j].Name {
			return reading.Nodes[i].Name < reading.Nodes[j].Name
		}

		return reading.Nodes[i].URL < reading.Nodes[j].URL
	})

	var weighted float64

	for _, node := range reading.Nodes {
		if !node.Reachable {
			continue
		}

		reading.Answered++

		reading.Totals.Rooms += node.Rooms
		reading.Totals.Clients += node.Clients
		reading.Totals.TracksIn += node.TracksIn
		reading.Totals.TracksOut += node.TracksOut
		reading.Totals.BytesIn += node.BytesIn
		reading.Totals.BytesOut += node.BytesOut
		reading.Totals.InPerSec += node.InPerSec
		reading.Totals.OutPerSec += node.OutPerSec
		reading.Totals.NackTotal += node.NackTotal
		reading.Totals.NackPerSec += node.NackPerSec
		reading.Totals.CPUs += node.CPUs

		// Weighted by cores rather than added.
		//
		// A node's load is already a fraction of that node, so eleven machines
		// each half busy summed to 5.5 — a number that reads as a percentage,
		// is rendered as one wherever a load is, and would have said the fleet
		// was at five hundred and fifty per cent. Nothing shows this total
		// today, which is the only reason it never did.
		//
		// Weighted because the machines are not the same size: a four-core
		// relay at full load and a sixteen-core one idle is not a fleet at half.
		weighted += float64(node.Load) * float64(node.CPUs)

		// The widest window of any relay, not the sum. Rates measured over
		// different windows cannot be added into a rate over their total; the
		// honest thing to report is the coarsest of them, so nobody reads a
		// ten-second mean as a two-second one.
		if node.Window > reading.Totals.Window {
			reading.Totals.Window = node.Window
		}
	}

	if reading.Totals.CPUs > 0 {
		reading.Totals.Load = float32(weighted / float64(reading.Totals.CPUs))
	}

	return reading
}

// relayLook is what a page needs to draw a relay it already has the counters
// for: the name it is keyed by, the name a person reads, and where it is.
type relayLook struct {
	Name   string
	Label  string
	Region string

	// Order is where this relay sits in the deployment's own list, which is
	// hand-sorted and therefore meant.
	Order int
}

// relayNames maps an address back to the name it was given, for a page that
// should say "tokyo" rather than an address somebody has to recognise.
func (a *API) relayNames() map[string]relayLook {
	named := map[string]relayLook{}

	if a.relays == nil {
		return named
	}

	list, err := a.relays.Relays()
	if err != nil {
		return named
	}

	for at, relay := range list {
		named[relay.URL] = relayLook{
			Name: relay.Name, Label: relay.Label, Region: relay.Region, Order: at,
		}
	}

	return named
}
