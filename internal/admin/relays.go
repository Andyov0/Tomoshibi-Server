package admin

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/store"
)

// Relays is what the management pages need of the list of media servers.
//
// An interface for the reason the three above it are: the pages that add and
// remove one are gates, and a gate that needs a real database behind it to be
// exercised is a gate nobody exercises.
type Relays interface {
	Relays() ([]store.Relay, error)
	AddRelay(relay store.Relay) error
	UpdateRelay(relay store.Relay) error
	RemoveRelay(name string) error
	ReorderRelays(names []string) error
	RenameRelay(from, to string) error
}

// Reachable is how a page finds out whether a relay is answering.
//
// Separate from the store because it is a different kind of question: the store
// says what somebody configured, and this says what is true. A relay can be
// listed and unreachable, which is precisely the state an operator opens this
// page to discover.
type Reachable interface {
	Check(ctx context.Context, url string) (ok bool, took time.Duration, detail string)
}

// relayView is one relay as a page sees it: what was configured, plus whether
// it is answering.
type relayView struct {
	Name      string   `json:"name"`
	URL       string   `json:"url"`
	Region    string   `json:"region,omitempty"`
	Label     string   `json:"label,omitempty"`
	Probe     string   `json:"probe,omitempty"`
	Turn      string   `json:"turn,omitempty"`
	Forwards  bool     `json:"forwards,omitempty"`
	Apart     []string `json:"apart,omitempty"`
	Bridge    bool     `json:"bridge,omitempty"`
	SignalVia string   `json:"signalVia,omitempty"`
	Lat       float64  `json:"lat,omitempty"`
	Lon       float64  `json:"lon,omitempty"`
	Fallback  bool     `json:"fallback,omitempty"`
	AdminOnly bool     `json:"adminOnly,omitempty"`
	Enabled   bool     `json:"enabled"`
	Added     string   `json:"added,omitempty"`

	// Reachable and Latency are measured when the page is drawn, from this
	// machine. A client's own measurement may differ and usually will — this is
	// whether the relay is up, not whether it is near anybody.
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latencyMs,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// listRelays draws the relay list, checking each one as it goes.
//
// Checked in parallel and bounded, because this is drawn on a page somebody is
// waiting in front of and one unreachable relay would otherwise hold the whole
// list for as long as its timeout.
func (a *API) listRelays(_ Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	list, err := a.relays.Relays()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	views := make([]relayView, len(list))

	var wait sync.WaitGroup
	for i, relay := range list {
		views[i] = viewOf(relay)

		if a.probe == nil {
			continue
		}

		wait.Add(1)
		go func(i int, url string) {
			defer wait.Done()

			a.measure(r.Context(), &views[i], url)
		}(i, relay.URL)
	}
	wait.Wait()

	respond(w, map[string]any{"relays": views})
}

// checkRelay measures one machine, and only that one.
//
// The list above checks all of them because drawing the page needs every row.
// The button on a row does not, and it used to: it re-read the list, so
// asking whether the machine somebody had just restarted was back cost a dial
// to all eleven — three seconds of waiting for each one that is genuinely
// down, to answer a question about a machine that is not. Worse on the row
// itself, where the spinner stopped when the slowest relay in the fleet
// answered rather than when this one did, which reads as this relay being slow.
//
// The reply is one row in the same shape the list sends, so the page can put it
// where the old reading was rather than reconciling two ideas of a relay.
func (a *API) checkRelay(_ Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	list, err := a.relays.Relays()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	name := r.PathValue("relay")

	for _, relay := range list {
		if relay.Name != name {
			continue
		}

		view := viewOf(relay)
		a.measure(r.Context(), &view, relay.URL)

		respond(w, view)
		return
	}

	refuse(w, http.StatusNotFound, "no_such_relay")
}

// viewOf is a stored relay as a page reads it, before anything is measured.
func viewOf(relay store.Relay) relayView {
	view := relayView{
		Name: relay.Name, URL: relay.URL, Region: relay.Region,
		Label: relay.Label, Probe: relay.Probe,
		Turn: relay.Turn, Forwards: relay.Forwards, Apart: relay.Apart,
		Bridge: relay.Bridge, Lat: relay.Lat, Lon: relay.Lon,
		Fallback: relay.Fallback, AdminOnly: relay.AdminOnly,
		Enabled: relay.Enabled, SignalVia: relay.SignalVia,
	}

	if !relay.Added.IsZero() {
		view.Added = relay.Added.UTC().Format(time.RFC3339)
	}

	return view
}

// measure asks the relay whether it is there, and says so in the view.
//
// A deployment with nothing to ask with leaves the reading at its zero value,
// which says unreachable with no explanation. That is honest: nothing measured
// it, and a page that claimed otherwise would be inventing a result.
func (a *API) measure(ctx context.Context, view *relayView, url string) {
	if a.probe == nil {
		return
	}

	ok, took, detail := a.probe.Check(ctx, url)

	view.Reachable = ok

	// At least one where it answered at all.
	//
	// Milliseconds truncates, and the field is omitempty, so a relay on the same
	// machine — or one on a good local link — answered in under a millisecond,
	// became nought, was omitted, and the page drew nothing where the fastest
	// relay in the fleet should have been. "Answered in 0 ms" was the better
	// half of that; the worse half was a blank.
	if ok {
		view.LatencyMS = max(1, took.Milliseconds())
	}

	view.Detail = detail
}

// addRelay puts a new media server into service.
//
// The reason this is a page rather than a line in a file: a relay is added when
// a machine is brought up, and editing a file and restarting to record that
// would drop every call the control node is holding — for an operation that
// changes nothing about the calls already in progress.
func (a *API) addRelay(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	var body struct {
		Name      string   `json:"name"`
		URL       string   `json:"url"`
		Region    string   `json:"region"`
		Label     string   `json:"label"`
		Turn      string   `json:"turn"`
		Forwards  bool     `json:"forwards"`
		Apart     []string `json:"apart"`
		Bridge    bool     `json:"bridge"`
		Fallback  bool     `json:"fallback"`
		AdminOnly bool     `json:"adminOnly"`
		Enabled   *bool    `json:"enabled"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	relay := store.Relay{
		Name:      strings.TrimSpace(body.Name),
		URL:       strings.TrimSpace(body.URL),
		Region:    strings.TrimSpace(body.Region),
		Label:     strings.TrimSpace(body.Label),
		Turn:      strings.TrimSpace(body.Turn),
		Forwards:  body.Forwards,
		Apart:     trimmed(body.Apart),
		Bridge:    body.Bridge,
		Fallback:  body.Fallback,
		AdminOnly: body.AdminOnly,
		Enabled:   body.Enabled == nil || *body.Enabled,
		Added:     time.Now().UTC(),
	}

	if err := a.relays.AddRelay(relay); err != nil {
		// The store's message names what is wrong with this particular entry,
		// which is worth more to whoever is typing it than a code would be.
		a.log.Record(Entry{
			Action: "add relay", Trip: session.Trip, Target: relay.Name,
			Failed: true, Reason: err.Error(),
		})
		refuse(w, http.StatusBadRequest, relayReason(err))
		return
	}

	a.log.Record(Entry{Action: "add relay", Trip: session.Trip, Target: relay.Name})
	a.changed()

	respond(w, map[string]any{"added": relay.Name})
}

// editRelay changes an address, a region, or whether clients are sent there.
//
// The name is the key and is not editable. A client that measured this relay a
// moment ago will name it at the join, and a rename would leave that client
// falling back as though it had measured nothing.
func (a *API) editRelay(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	name := r.PathValue("relay")

	// Pointers throughout, so that clearing a field and leaving it alone are
	// different requests. An empty string is a thing somebody meant.
	var body struct {
		Probe     *string   `json:"probe"`
		Name      *string   `json:"name"`
		URL       string    `json:"url"`
		Node      *string   `json:"node"`
		Region    *string   `json:"region"`
		Label     *string   `json:"label"`
		Turn      *string   `json:"turn"`
		Forwards  *bool     `json:"forwards"`
		Apart     *[]string `json:"apart"`
		Bridge    *bool     `json:"bridge"`
		Lat       *float64  `json:"lat"`
		Lon       *float64  `json:"lon"`
		Fallback  *bool     `json:"fallback"`
		AdminOnly *bool     `json:"adminOnly"`
		Enabled   *bool     `json:"enabled"`
		SignalVia *string   `json:"signalVia"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	list, err := a.relays.Relays()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	var found *store.Relay
	for i := range list {
		if list[i].Name == name {
			found = &list[i]
			break
		}
	}

	if found == nil {
		refuse(w, http.StatusNotFound, "no_such_relay")
		return
	}

	// Absent fields leave what is there. A page that edits one thing should not
	// have to send back the two it did not touch.
	if strings.TrimSpace(body.URL) != "" {
		found.URL = strings.TrimSpace(body.URL)
	}
	if body.Node != nil {
		found.Node = strings.TrimSpace(*body.Node)
	}
	if body.Region != nil {
		found.Region = strings.TrimSpace(*body.Region)
	}
	if body.Enabled != nil {
		found.Enabled = *body.Enabled
	}

	// Pointers for these three, so that clearing a label and leaving it alone
	// are different requests. An empty string is a thing somebody meant.
	if body.Label != nil {
		found.Label = strings.TrimSpace(*body.Label)
	}
	if body.Probe != nil {
		found.Probe = strings.TrimSpace(*body.Probe)
	}
	if body.Turn != nil {
		found.Turn = strings.TrimSpace(*body.Turn)
	}
	if body.Forwards != nil {
		found.Forwards = *body.Forwards
	}
	if body.Apart != nil {
		found.Apart = trimmed(*body.Apart)
	}
	if body.Bridge != nil {
		found.Bridge = *body.Bridge
	}
	if body.Lat != nil {
		found.Lat = *body.Lat
	}
	if body.Lon != nil {
		found.Lon = *body.Lon
	}
	if body.Fallback != nil {
		found.Fallback = *body.Fallback
	}
	if body.AdminOnly != nil {
		found.AdminOnly = *body.AdminOnly
	}

	// Through a relay that signals for itself and exists, or not at all. One
	// that names itself, a relay that is gone, or one that also signals
	// through another would hand clients an address nobody can complete a
	// call through, and the first anybody would hear of it is a call that
	// never connects.
	//
	// Asked only of a change. The page sends the field back with every save,
	// and a relay left naming one that a rename or a removal had taken away —
	// which both used to do (store.RenameRelay) — could otherwise have nothing
	// about it saved until somebody found the stale field and cleared it.
	if body.SignalVia != nil {
		via := strings.TrimSpace(*body.SignalVia)
		if via != "" && via != found.SignalVia {
			var target *store.Relay
			for i := range list {
				if list[i].Name == via {
					target = &list[i]
				}
			}
			switch {
			case via == name:
				refuse(w, http.StatusBadRequest, "signal_via_itself")
				return
			case target == nil:
				refuse(w, http.StatusBadRequest, "signal_via_unknown")
				return
			case target.SignalVia != "":
				refuse(w, http.StatusBadRequest, "signal_via_chained")
				return
			}
		}
		found.SignalVia = via
	}

	// The name last, and separately, because it is the key. Everything else is a
	// field on a record; this moves the record.
	renamed := name
	if body.Name != nil && strings.TrimSpace(*body.Name) != "" && strings.TrimSpace(*body.Name) != name {
		renamed = strings.TrimSpace(*body.Name)

		if err := a.relays.RenameRelay(name, renamed); err != nil {
			a.log.Record(Entry{
				Action: "rename relay", Trip: session.Trip, Target: name,
				Failed: true, Reason: err.Error(),
			})
			refuse(w, http.StatusBadRequest, relayReason(err))
			return
		}

		found.Name = renamed
	}

	if err := a.relays.UpdateRelay(*found); err != nil {
		a.log.Record(Entry{
			Action: "edit relay", Trip: session.Trip, Target: renamed,
			Failed: true, Reason: err.Error(),
		})
		refuse(w, http.StatusBadRequest, relayReason(err))
		return
	}

	a.log.Record(Entry{Action: "edit relay", Trip: session.Trip, Target: name})
	a.changed()

	respond(w, map[string]any{"updated": name})
}

// dropRelay takes one out of the list entirely.
//
// Calls already on it are not ended: this server has no way to reach into
// another machine's sessions and no business doing so. What stops is being sent
// there. Disabling is the gentler operation and is what an operator usually
// wants; this one is for a machine that is gone.
func (a *API) dropRelay(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	name := r.PathValue("relay")

	removed, found := a.relayNamed(name)
	if !found {
		refuse(w, http.StatusNotFound, "no_such_relay")
		return
	}

	if err := a.relays.RemoveRelay(name); err != nil {
		a.log.Record(Entry{
			Action: "remove relay", Trip: session.Trip, Target: name,
			Failed: true, Reason: err.Error(),
		})
		// Said as itself, since the way on is to change another relay; every
		// other refusal here is a relay that has already gone.
		if errors.Is(err, store.ErrRelaySignalledThrough) {
			refuse(w, http.StatusConflict, relayReason(err))
			return
		}
		refuse(w, http.StatusNotFound, "no_such_relay")
		return
	}

	// And the name that was pointed at it, which nothing was removing.
	//
	// Unpoint was written for this and had no callers, so every relay ever
	// enrolled and later removed left an A record behind. Two things follow
	// from one: the zone accumulates names for machines that are gone, and —
	// the one that matters — a name in that zone goes on resolving to an
	// address the provider is free to hand to somebody else. A record this
	// deployment created, pointing at a stranger's machine, under a host that a
	// client somewhere may still have in a saved link.
	//
	// After the removal rather than before, and not fatal to it. Somebody
	// pressing remove wants the relay to stop being used, and a zone that will
	// not answer must not stand in the way of that.
	// The name is read out of the address rather than made from the relay's
	// own name, which is not the same thing and only looks like it.
	//
	// hostFor builds a host from the prefix a machine enrolled under. That
	// equals the relay's name at enrolment and stops equalling it the moment
	// anybody renames the relay — and renaming is ordinary, because the name
	// somebody types on a machine being set up is short and the name a page
	// shows is not. Removing "GZ Volcano" asked the zone to delete
	// "GZ Volcano.relays.example", which is not a name, while the record it
	// actually had went on resolving.
	//
	// The address is the one thing that cannot drift: it is what clients dial.
	if host := hostOf(removed.URL); host != "" && a.enrolment != nil && a.enrolment.Naming != nil {
		if err := a.enrolment.Naming.Unpoint(host); err != nil {
			slog.Error("failed to remove the DNS record for a relay that was removed",
				"host", host, "error", err)
		} else {
			slog.Info("unpointed a removed relay's name", "host", host)
		}
	}

	a.log.Record(Entry{Action: "remove relay", Trip: session.Trip, Target: name})
	a.changed()

	respond(w, map[string]any{"removed": name})
}

// changed tells whoever is choosing relays that the list moved.
//
// Without it a relay added here would not be offered until the choosing side's
// own cache expired, and the person who added it would be looking at a page
// saying it is there beside a join that does not use it.
func (a *API) changed() {
	if a.onRelaysChanged != nil {
		a.onRelaysChanged()
	}
}

// relayReason turns a store's refusal into a code the page has a sentence for.
//
// Codes and not sentences: the words on a management page are translated into
// four languages there, and an English string returned from here would arrive
// on screen in whichever language the server happened to be written in.
func relayReason(err error) string {
	switch {
	case errors.Is(err, store.ErrRelayExists):
		return "relay_exists"
	case errors.Is(err, store.ErrNoSuchRelay):
		return "no_such_relay"
	case errors.Is(err, store.ErrRelayNoName):
		return "relay_no_name"
	case errors.Is(err, store.ErrRelayLongName):
		return "relay_long_name"
	case errors.Is(err, store.ErrRelayNoURL):
		return "relay_no_url"
	case errors.Is(err, store.ErrRelayBadURL):
		return "relay_bad_url"
	// Added late, and its absence is the shape of fault this whole mapping
	// exists to prevent: a label over the limit came back as the general
	// refusal, so the page said the relay was refused and could not say which
	// field to shorten.
	case errors.Is(err, store.ErrRelayLongLabel):
		return "relay_long_label"
	case errors.Is(err, store.ErrRelayLongTag):
		return "relay_long_region"
	case errors.Is(err, store.ErrRelaySignalledThrough):
		return "relay_signalled_through"
	default:
		return "relay_refused"
	}
}

// orderRelays puts the list in the order a page dragged it into.
//
// The whole list rather than one move, because two administrators each pressing
// an arrow would otherwise interleave into an order neither of them chose.
func (a *API) orderRelays(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	var body struct {
		Names []string `json:"names"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if err := a.relays.ReorderRelays(body.Names); err != nil {
		a.log.Record(Entry{
			Action: "reorder relays", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: err.Error(),
		})

		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	a.log.Record(Entry{Action: "reorder relays", Trip: session.Trip, Name: session.Name})

	if a.onRelaysChanged != nil {
		a.onRelaysChanged()
	}

	respond(w, map[string]any{"ordered": len(body.Names)})
}

// trimmed tidies a list of relay names typed into a field.
//
// Blanks dropped rather than kept, because a trailing comma is how anybody types
// a list and an empty name in this one would be a name no relay has — harmless
// today and exactly the sort of entry somebody later reads as meaningful.
func trimmed(names []string) []string {
	out := make([]string, 0, len(names))

	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" {
			out = append(out, name)
		}
	}

	if len(out) == 0 {
		return nil
	}

	return out
}

// relayNamed finds one relay by name, for the things that need more of it than
// the name.
func (a *API) relayNamed(name string) (store.Relay, bool) {
	list, err := a.relays.Relays()
	if err != nil {
		return store.Relay{}, false
	}

	for _, relay := range list {
		if relay.Name == name {
			return relay, true
		}
	}

	return store.Relay{}, false
}

// hostOf is the host a relay's address names, or "" where it names an address.
//
// A relay dialled by bare address has no name in any zone, so there is nothing
// to remove and nothing to report — two of them here are exactly that. What
// this decides is whether a DNS record is created for a machine and removed
// when it goes, so getting it wrong means a record made for something that is
// not a name.
//
// Parsed rather than cut at the first colon. An IPv6 address is written in
// brackets and is full of colons, so cutting gave "[2001" — which is not an
// address, so it was taken for a hostname, and the deployment would have gone
// looking to make a record for it. No relay here is dialled that way yet, which
// is the only reason it has not happened.
func hostOf(raw string) string {
	trimmed := raw
	if !strings.Contains(trimmed, "://") {
		// url.Parse wants a scheme to find a host. Relays are stored with one,
		// but a bare "host:port" typed into the panel should not be read as a
		// path.
		trimmed = "wss://" + trimmed
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}

	// Hostname strips the port and the brackets around an IPv6 literal, which
	// is what makes the check below work for both kinds.
	host := parsed.Hostname()

	// An address is not a name. net.ParseIP is the only reliable way to tell,
	// because a hostname may be all digits and dots and still be a hostname.
	if host == "" || net.ParseIP(host) != nil {
		return ""
	}

	// Nor is anything with a colon left in it. An IPv6 address written
	// without its brackets ("wss://::1") parses from Go 1.26.1 on, and
	// Hostname takes its last colon for the port's and leaves ":", which is
	// no address and would have been taken for a name; 1.26.0 refused to
	// parse it at all. No name in DNS has a colon.
	if strings.Contains(host, ":") {
		return ""
	}

	return host
}
