package app

import (
	"hash/fnv"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

// Source is where the live list of relays comes from.
//
// An interface so that the choosing below can be tested against a list somebody
// wrote down, while the running deployment reads the store the management pages
// write to. The alternative — reading config.Meet.Relays directly — was what
// this did first, and it meant a relay added from a page did nothing until the
// process was restarted.
type Source interface {
	Relays() ([]store.Relay, error)
}

// relays chooses which media server a client is told to dial.
//
// Only a control node ever asks. A full deployment is its own relay and answers
// with its own address, which is what [App.signallingURL] already did and still
// does when nothing is listed here.
type relays struct {
	source Source
	policy string

	// reach is what the control node found when it last opened a connection to
	// each relay. Nil on a deployment that never wired a cluster in, which
	// means every relay counts as worth offering.
	reach *reach

	// turn carries the round-robin position. Atomic because joins arrive
	// concurrently and the only thing this counter must not do is hand two
	// callers the same answer by losing an increment.
	turn atomic.Uint64

	// cache holds the last list read, so that a join is not a database read.
	//
	// Short, because the point of keeping this in the store was that a change
	// takes effect without a restart, and a long cache would put the restart
	// back in a different costume. Two seconds is under what anybody notices
	// between pressing save and trying it.
	mu       sync.RWMutex
	cached   []store.Relay
	cachedAt time.Time
}

// How long a read of the relay list is reused.
const relayCacheFor = 2 * time.Second

func newRelays(conf *config.Config, source Source) *relays {
	return &relays{source: source, policy: conf.Meet.RelayPolicy}
}

// live returns the relays clients may be sent to, newest read or cached.
//
// Only the enabled ones. A relay that has been taken out of service still holds
// the calls already on it — this server could not end them and has no business
// doing so — but nobody new is sent there.
func (r *relays) live() []store.Relay {
	if r == nil || r.source == nil {
		return nil
	}

	r.mu.RLock()
	if time.Since(r.cachedAt) < relayCacheFor {
		list := r.cached
		r.mu.RUnlock()
		return list
	}
	r.mu.RUnlock()

	all, err := r.source.Relays()
	if err != nil {
		// The last good list rather than none. A store that will not answer is
		// a reason to keep working from what was already known, not a reason to
		// tell everybody there is nowhere to hold a call.
		slog.Error("failed to read the relays; using the last list", "error", err)

		r.mu.RLock()
		defer r.mu.RUnlock()
		return r.cached
	}

	enabled := make([]store.Relay, 0, len(all))
	for _, relay := range all {
		if relay.Enabled {
			enabled = append(enabled, relay)
		}
	}

	r.mu.Lock()
	r.cached, r.cachedAt = enabled, time.Now()
	r.mu.Unlock()

	return enabled
}

// forget drops the cache, so the next join reads the store.
//
// Called when the management pages change something. Without it a relay just
// added would not be offered for up to the cache's length, and the person who
// added it would be looking at a page that says it is there and a join that
// does not use it.
func (r *relays) forget() {
	if r == nil {
		return
	}

	r.mu.Lock()
	r.cachedAt = time.Time{}
	r.mu.Unlock()
}

// all is every relay, in service or not.
//
// Separate from live because they answer different questions: this is what a
// person should see, and live is what a call may be sent to. Conflating them is
// how a relay out of service comes to hold a meeting.
func (r *relays) all() []store.Relay {
	if r == nil || r.source == nil {
		return nil
	}

	list, err := r.source.Relays()
	if err != nil {
		// The cache, which holds only the enabled ones, is better than nothing
		// and better than an error on a page.
		return r.live()
	}

	return list
}

// watched is what the control node keeps a reading on: every relay taking
// calls, and any that is not but that one taking calls still signals through.
//
// The second half because signalling asks whether the relay it names is
// answering whether or not that relay is taking calls, which is the right
// question — and was being answered from a reading nobody took. The sweep
// looked only at the relays in service, so a relay taken out of service kept
// whatever it had been found to be at that moment, for good. Disabling is the
// gentle way to take a machine away, the one an operator is told to reach for
// first; disabled and then switched off, it went on being handed to every
// client of the media-only relays signalling through it, as answering, and
// none of those calls started. Nothing fell back and nothing was logged. After
// a restart it was the same without the history: a relay never looked at
// counts as answering.
//
// Not every relay out of service. A machine disabled because it is gone would
// be a failed check every half minute for ever, and enough of them would tip a
// sweep into reading as this node's own outage (reach.look), which freezes the
// readings for everybody. Only one still in somebody's path is worth asking.
func (r *relays) watched() []store.Relay {
	live := r.live()

	named := map[string]bool{}
	for _, relay := range live {
		if relay.SignalVia != "" {
			named[relay.SignalVia] = true
		}
	}
	if len(named) == 0 {
		return live
	}

	// A copy, since live may be the cache every join reads.
	list := append([]store.Relay(nil), live...)
	for _, relay := range r.all() {
		if !relay.Enabled && named[relay.Name] {
			list = append(list, relay)
		}
	}

	return list
}

// any reports whether there is anything to choose from.
func (r *relays) any() bool { return len(r.live()) > 0 }

// byName finds a relay a client named, and says whether it is one of ours.
//
// The whole of the trust boundary for the probe policy. A client sends a name
// it was given; anything else — a name from an older configuration, a guess, an
// address somebody hoped would be dialled — finds nothing and is ignored, which
// leaves the caller with the policy's fallback rather than with a meeting sent
// wherever they asked.
func (r *relays) byName(list []store.Relay, name string) (store.Relay, bool) {
	if name == "" {
		return store.Relay{}, false
	}

	for _, relay := range list {
		if relay.Name == name {
			return relay, true
		}
	}

	return store.Relay{}, false
}

// offered is the list a client is shown, which is every relay this deployment
// has: reserved ones, and ones taken out of service.
//
// That is a decision rather than an oversight. A machine that simply vanished
// would look deleted to whoever used it yesterday, and one reserved for
// administrators that vanished would leave an operator wondering where their
// own machine went on the page they run it from. The picker greys out what
// somebody may not take rather than pretending it is not there.
//
// The list protects nothing, and it should not be asked to. What keeps a
// reserved machine reserved is the refusal at the join, which reads the
// passphrase rather than a cookie and therefore works whether or not somebody
// read the name off a colleague's screen. What is withheld here is the address
// (see relayList), which is a different thing from the name.
//
// The argument this used to take is gone, because it never did anything, and a
// parameter that is ignored is a claim the next reader has to disprove.
func (r *relays) offered() []store.Relay {
	return r.reach.keep(r.all())
}

// answering is how many of them answered the last round.
//
// Separate from offered, and deliberately without its fallback. Offering
// everything when nothing answered is right — a control node that has lost its
// own network should not take the fleet down with it — but counting what it
// offered is not counting what is up. The fleet reading on the management page
// was doing exactly that, and so it read eleven of eleven online at the one
// moment it was being consulted to find out whether anything was.
func (r *relays) answering() int {
	return len(r.reach.only(r.all()))
}

// preferred splits a list into the relays to use and the ones held in reserve.
//
// A fallback relay is not a worse relay — it is a relay whose cost is paid in
// distance rather than in quality, and one that should therefore be reached for
// only when the alternative is no call at all. Returning both halves rather than
// filtering keeps that decision here, where the list is already in hand.
func preferred(list []store.Relay) (ordinary, reserve []store.Relay) {
	for _, relay := range list {
		if relay.Fallback {
			reserve = append(reserve, relay)
			continue
		}
		ordinary = append(ordinary, relay)
	}

	return ordinary, reserve
}

// reserved reports whether a name belongs to a relay only administrators may
// use.
//
// Asked before the choosing rather than folded into it, because the two answers are
// different actions: a name nobody has is ignored and the caller gets whichever
// relay the policy chooses, and a name they may not use is refused out loud.
// Falling back silently in the second case leaves somebody looking at a call on
// a machine they did not pick, with nothing anywhere saying why.
func (r *relays) reserved(name string) bool {
	if name == "" {
		return false
	}

	for _, relay := range r.all() {
		if relay.Name == name {
			return relay.AdminOnly
		}
	}

	return false
}

// named finds a relay by name, and says whether it is one of ours and usable.
//
// Out of service counts as not usable: a room recorded as held on a machine
// that has since been taken down should go wherever the policy sends it, not to
// the machine somebody stopped.
// everywhere finds a relay by name among every one this deployment has, whether
// it is taking calls or not.
//
// Separate from named for one caller: a room somebody placed. Every other
// lookup is choosing where to send a call and must not consider a machine that
// has been taken out of service; a placement is not a choice being made, it is
// one that was already made, and the only question left is which machine was
// meant.
//
// Reachability is not consulted either, and that is deliberate. The control
// node's reading is one vantage point on one network and is documented in
// reachable.go as a suspicion rather than a fact — one relay on this fleet
// answers UDP from everywhere except the control node while carrying calls
// perfectly. Letting a suspicion quietly overrule somebody who said where the
// room goes is the whole of what this is not allowed to do.
func (r *relays) everywhere(name string) (store.Relay, bool) {
	if r == nil || name == "" {
		return store.Relay{}, false
	}

	for _, relay := range r.all() {
		if relay.Name == name {
			return relay, true
		}
	}

	return store.Relay{}, false
}

func (r *relays) named(name string) (store.Relay, bool) {
	if r == nil || name == "" {
		return store.Relay{}, false
	}

	for _, relay := range r.live() {
		if relay.Name == name {
			return relay, true
		}
	}

	return store.Relay{}, false
}

// signalling finds the relay to carry the signalling of one that carries media
// only: the one it names, or where that is not answering the nearest other
// that is.
//
// The one named is used whether or not it is taking calls itself. Naming it is
// an operator choosing a path, as a placement is choosing a machine, and
// whether new calls are held there is a different question. Answering is
// what matters, since a socket opened to a machine that is not there is a
// call that never starts — which is why the sweep keeps a reading on the one
// named even once it is out of service (relays.watched). Then any other relay that signals for itself and
// is answering, because the cluster carries signalling from any node to the
// one holding the room, so the worst of them is a slower start; one kept for
// administrators is not among them, since this hands its address to
// everybody joining.
func (r *relays) signalling(name string) (store.Relay, bool) {
	usable := func(relay store.Relay) bool {
		return relay.SignalVia == "" && relay.URL != "" && r.reach.up(relay.URL)
	}

	if named, ok := r.everywhere(name); ok && usable(named) {
		return named, true
	}

	var others []store.Relay
	for _, relay := range r.live() {
		if usable(relay) && !relay.AdminOnly {
			others = append(others, relay)
		}
	}

	return r.reach.quickest(others)
}

// pick returns the relay for this room and this client.
//
// Room first and client second, because the room is what the policies are
// mostly about: gathering a meeting onto one relay is what keeps media from
// being carried twice, and that decision cannot depend on who is asking or the
// second person to join would land somewhere else.
//
// chosen is what a client measured and asked for, empty when it did not ask.
func (r *relays) pick(room string, chosen string, req *http.Request, trustProxy bool, admin bool) store.Relay {
	// Nil where this deployment holds its own media and has no list to choose
	// from. Guarded here rather than at each caller, because "there is nothing
	// to choose" is an answer this function can give and every caller already
	// handles: an empty relay means the deployment's own address is used.
	if r == nil {
		return store.Relay{}
	}

	all := r.live()

	// A relay reserved for administrators is not among the ones anybody else is
	// chosen from, and not one they can ask for by name either. Removed here
	// rather than only from the list that is published, because the published
	// list is a convenience and this is the rule.
	if !admin {
		open := make([]store.Relay, 0, len(all))
		for _, relay := range all {
			if !relay.AdminOnly {
				open = append(open, relay)
			}
		}

		all = open
	}

	// Two preferences, applied in order, and the order is the argument.
	//
	// Reachability first: a relay the control node cannot open a connection to
	// is not a worse choice, it is not a choice. Then the reserve, which is
	// used only when nothing else is available — the setting means "prefer
	// anything else", not "never".
	//
	// Each step falls back to the one before rather than to nothing. A
	// deployment where every relay has stopped answering still has to hold
	// calls somewhere, and the control node's reading is a suspicion formed
	// from one vantage point: refusing to name a relay on the strength of it
	// would turn one machine's bad minute into an outage for everybody.
	ordinary, reserve := preferred(all)

	list := r.reach.only(ordinary)
	if len(list) == 0 {
		list = r.reach.only(reserve)
	}
	if len(list) == 0 {
		list = ordinary
	}
	if len(list) == 0 {
		list = reserve
	}

	// A client that measured a reserve relay as fastest is honoured anyway: it
	// asked for that one specifically, and being told otherwise would be this
	// server overruling a measurement it cannot make itself.
	if r.policy == config.PickProbe && chosen != "" {
		if relay, ok := r.byName(all, chosen); ok {
			return relay
		}
	}

	switch {
	case len(list) == 0:
		return store.Relay{}

	case len(list) == 1:
		// One relay is not a choice, and taking this early keeps the policies
		// below from having to be correct about a case with no alternatives.
		return list[0]

	case r.policy == config.PickProbe:
		// What the client measured, if it is one of ours. A name that is not
		// falls through to the room's own relay: an unmeasured client should
		// still land with the rest of their meeting.
		if relay, ok := r.byName(list, chosen); ok {
			return relay
		}
		return list[int(hashRoom(room)%uint64(len(list)))]

	case r.policy == config.PickRoundRobin:
		// Wraps on overflow, which is the behaviour wanted: the sequence is
		// what matters and it continues across the boundary.
		return list[int(r.turn.Add(1)-1)%len(list)]

	case r.policy == config.PickNearest:
		if region := clientRegion(req, trustProxy); region != "" {
			for _, relay := range list {
				if strings.EqualFold(relay.Region, region) {
					return relay
				}
			}
		}
		// Nothing matched. Falling through to sticky rather than to the first
		// entry, so a client whose region is unknown still lands with the rest
		// of their meeting instead of piling onto whichever relay is listed
		// first.
		fallthrough

	default:
		return list[int(hashRoom(room)%uint64(len(list)))]
	}
}

// hashRoom turns a room name into a stable position in the list.
//
// Stable across processes and restarts, which is the whole point: two control
// nodes behind one address must send the same room to the same relay, and a
// control node that was restarted mid-meeting must not start sending the second
// half of the participants somewhere else.
//
// FNV rather than maphash for exactly that reason — maphash is seeded per
// process and would give a different answer on every start.
func hashRoom(room string) uint64 {
	sum := fnv.New64a()
	_, _ = sum.Write([]byte(room))
	return sum.Sum64()
}

// The header a proxy or CDN sets to say where a client is.
//
// Read rather than derived: working a region out from an address needs a
// database that has to be shipped, kept current, and consulted on a path that
// is otherwise a signature and a write. Every proxy worth putting in front of
// this already knows the answer — Cloudflare sends CF-IPCountry, and anything
// else can be told to set X-Client-Region — so the useful thing is to believe
// one of them rather than to work it out again.
const (
	headerRegion  = "X-Client-Region"
	headerCountry = "CF-IPCountry"
)

// clientRegion reads where a client says it is, when there is a proxy worth
// believing.
//
// Gated on the same trust_proxy that guards the forwarded address and host,
// because it is the same kind of claim: a header nobody upstream overwrites is
// whatever the caller typed. Believing it unguarded would not be a security
// hole here — the worst it buys is a relay of one's choosing — but it would be
// a setting that silently does nothing on a direct deployment and something
// else entirely behind a proxy, which is worse than either.
func clientRegion(req *http.Request, trustProxy bool) string {
	if req == nil || !trustProxy {
		return ""
	}

	if region := strings.TrimSpace(req.Header.Get(headerRegion)); region != "" {
		return region
	}

	return strings.TrimSpace(req.Header.Get(headerCountry))
}

// RelayURLs is where a control node's management pages should look for the
// media it does not hold.
//
// Enabled relays only, and read live rather than captured at start: a relay
// added from a page is asked about immediately, and one taken out of service
// stops being asked. The same list the joins are handed from, which is what
// keeps a page from reporting on a relay clients are no longer sent to.
func (a *App) RelayURLs() []string {
	list := a.relays.live()

	urls := make([]string, 0, len(list))
	for _, relay := range list {
		urls = append(urls, relay.URL)
	}

	return urls
}

// UseCluster points the management pages at the relays.
//
// Also wires the other direction: the pages change the relay list, and the
// choosing side has to hear about it or a relay just added would not be used
// until its cache expired.
func (a *App) UseCluster(cluster *rtc.Cluster) {
	a.admin.UseCluster(cluster)

	// And the certificate, which travels the same way for the same reason: this
	// is the connection that already reaches every relay, and the relays hold
	// nothing that says where to reach back.
	a.cluster = cluster
	a.fleet = cluster
	go a.carrying()

	// And the host's own actions, which reach the same relays through the same
	// client. Set here rather than fetched from the management API when needed,
	// so there is one assignment to read and no way for the two to be pointed at
	// different things.
	a.control = cluster
	a.admin.OnRelaysChanged(a.relays.forget)

	// And the same connection the management pages are drawn from decides which
	// relays clients are offered. The browser cannot tell a relay that refused
	// from one that was never there — both are an error event with nothing on
	// it — and the one that was never there answers sooner, so it wins a
	// measurement it should lose. This is the half of that question the control
	// node can answer.
	a.reach = newReach(cluster.Check)
	a.relays.reach = a.reach

	go a.watching()
}

// UseEnrolment lets relays bring themselves up from a script.
//
// Two things: the management pages gain the script, and the router gains the
// one endpoint a machine with no session calls. Registered here rather than in
// Handler so that a deployment which did not configure enrolment has no such
// address at all, rather than one that refuses.
func (a *App) UseEnrolment(enrolment *admin.Enrolment) {
	a.admin.UseEnrolment(enrolment)
	a.enrolment = enrolment
}

// forwarding mints what a client needs to reach a room through a relay that is
// not holding it, or reports that this pair will not do that.
//
// Three answers rather than two, and the middle one is the point: a nil
// forwarding with no error means the pair declines, which is an ordinary
// outcome and not a fault. An error means the credentials could not be made at
// all, which is a fault and is logged as one.
func (a *App) forwarding(entry, holding store.Relay) (*rtc.Forwarding, error) {
	if !entry.Forwards || entry.Turn == "" {
		// Either it runs no TURN server, or whoever pays for it has said no.
		// Relaying costs a machine two bytes for every one it carries, so that
		// is a question about a bill and a real answer to it.
		return nil, nil
	}

	if !pairable(entry, holding) {
		// Logged rather than silently dropped. An operator who expects a pair to
		// forward and finds it does not has one line to look for, and it names
		// the reason — otherwise this is invisible: the call still connects, it
		// just goes somewhere else.
		slog.Info("refused to forward between relays kept apart",
			"entry", entry.Name, "holding", holding.Name)

		return nil, nil
	}

	relayed, err := rtc.Forward(entry.Turn, a.conf.Key, a.conf.Secret)
	if err != nil {
		return nil, err
	}

	return &relayed, nil
}

// pairable reports whether one relay may carry a call held on another.
//
// Reachability between two machines is a fact about the networks between them
// and nothing here can derive it. Two relays can both be fast, both be in the
// same country, both answer every probe, and still carry nothing usable between
// each other — so which pairs are no good is written down by whoever found out,
// per relay, by name.
//
// Read from both sides. A rule written on one side of a comparison is a rule on
// neither: the pair would forward or not depending on which end a client
// happened to come in at, and the half that was forgotten is the half that
// produces the outage.
//
// This was first written as a rule about regions — same side of the border, same
// network — which is a tidier idea and the wrong one. It forbade pairs that work
// perfectly well, and it meant a region renamed for legibility silently changed
// where media went.
func pairable(entry, holding store.Relay) bool {
	return !apart(entry, holding.Name) && !apart(holding, entry.Name)
}

// bridging finds a relay that can carry a call the picked one cannot.
//
// Only ever consulted when the pair somebody landed on will not work, and it
// returns the machine they should be sent to instead — signalling and all,
// rather than leaving them connected to one machine while their media goes
// through another. Two names on a screen are already one more than most people
// want to think about; three, one of which carries nothing, is a diagram.
//
// A bridge has to satisfy everything an ordinary entry does. It must be in
// service, it must forward, it must have somewhere to forward from, and it must
// be a relay this person is allowed to use — a machine reserved for
// administrators does not stop being reserved by being useful. And it must pair
// with the room's own relay, because a bridge that cannot reach the meeting is
// no more use than the entry that could not.
func (r *relays) bridging(holding store.Relay, isAdmin bool) (store.Relay, bool) {
	for _, candidate := range r.live() {
		switch {
		case !candidate.Bridge, !candidate.Forwards, candidate.Turn == "":
			continue
		case candidate.Name == holding.Name:
			continue
		case candidate.AdminOnly && !isAdmin:
			continue
		case !pairable(candidate, holding):
			continue
		}

		return candidate, true
	}

	return store.Relay{}, false
}

func apart(relay store.Relay, name string) bool {
	for _, other := range relay.Apart {
		if strings.EqualFold(strings.TrimSpace(other), name) {
			return true
		}
	}

	return false
}

// elsewhere names the machine holding a room, when that is not the one being
// dialled.
//
// Empty where they are the same, which is most calls: a panel that says "held
// on" and "reached through" with the same name twice is asking somebody to
// compare two identical strings and conclude nothing.
func elsewhere(entry, holding store.Relay) string {
	if holding.Name == "" || holding.Name == entry.Name {
		return ""
	}

	return holding.Shown()
}
