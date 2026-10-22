package admin

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"tomoshibi/internal/guess"

	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/remote"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"

	"github.com/livekit/protocol/livekit"
)

// Media is what these pages need to know about the server they run beside.
//
// An interface rather than the server itself, and not for the sake of one: the
// gates in front of every endpoint below could not be exercised without a
// running media server, so they were not — the whole of this file sat at nothing
// while the rules it enforces were tested somewhere they were never asked.
type Media interface {
	Stats() *livekit.NodeStats
	Throughput() (in, out float64, window time.Duration)
	Node() (id string, ip string)
}

// Control is what they need to ask of rooms, and occasionally do to them.
type Control interface {
	Rooms(ctx context.Context) ([]*livekit.Room, error)
	Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error)
	Remove(ctx context.Context, room, identity string) error
	Mute(ctx context.Context, room, identity, track string) error
	Close(ctx context.Context, room string) error
	// Announce tells everybody in a room something, which is how they are told
	// that being disconnected means "come back" rather than "it is over".
	Announce(ctx context.Context, room, topic string, data []byte) error
	Tell(ctx context.Context, room, identity, topic string, data []byte) error

	// Hold creates a room on one named node, which is what makes moving a room
	// move it: closing one destroys it everywhere, and the next arrival creates
	// it again wherever they came in.
	Hold(ctx context.Context, room, node string) error
}

// Names is what they need of the record of names that have been used.
//
// The third of these, and added for the reason the first two were: the moment a
// gate in front of an endpoint needs something concrete behind it, the gate can
// only be exercised by standing the concrete thing up, and so it stops being
// exercised at all. This one arrived with the switch deciding who may open a
// room, which is the last rule on these pages that should go untested.
type Names interface {
	Rooms() ([]store.Named, error)
	Opening() room.Opening
	SetOpening(opening room.Opening) error

	// Joining is who may enter a room that already exists, which is the other
	// half of the door and the half that had no setting at all.
	Joining(configured room.Joining) room.Joining
	SetJoining(joining room.Joining) error
	AccountCount() int

	// HeldOn says which relay a room is on, and Arrivals what was seen of the
	// people in it when they were let in.
	//
	// Both are here because the media server cannot answer either. It reports a
	// room from whichever node was asked, and it sees each participant over a
	// signalling socket from a relay — so the machine it names is the machine
	// that answered, and the address it holds is the relay's. This server chose
	// the machine and saw the address, once, at the join.
	HeldOn(room string) (string, bool)
	Arrivals(room string) map[string]store.Arrival

	// Visits is every join recorded against a room, newest first, which is a
	// different question from who is in it now and outlives the call.
	Visits(room string, limit int) ([]store.Visit, int)

	// ForgetRoom removes a name and everything written against it, which is a
	// different action from clearing where it is held.
	ForgetRoom(room string) (bool, error)
}

// Roster is where the administrators are kept.
//
// Its own interface rather than a method on the one above, for the reason the
// package names narrow ones at all: this is the list that decides who may open
// these pages, and a test that exercises the gate has to be able to hand over a
// list somebody wrote down without also standing up a database.
type Roster interface {
	Admins() ([]store.Admin, error)
	AddAdmin(admin store.Admin) error
	UpdateAdmin(admin store.Admin) error
	RemoveAdmin(trip string) error
	ReplaceAdminTrip(from, to string) error

	// ChangeAdminPerms changes the grants it is given, leaves the rest as
	// stored, and touches nothing else; UpdateAdmin carries the stored grants
	// over rather than writing them.
	ChangeAdminPerms(trip string, changes map[string]bool) error

	// ChangeAdminCan gives or takes away the finer capabilities it is given
	// and leaves the rest of the list as stored, answering with the list as
	// written. What one box of a custom role sends; see roster.go.
	ChangeAdminCan(trip string, changes map[string]bool) ([]string, error)
}

// Settings is the deployment-wide switches for what a deployment that relays
// nothing relays anyway: a media server's films, YouTube, and Bilibili's
// bangumi.
//
// Its own interface, apart from the room policies in Names, because it is read
// and written behind its own capability and a test of that gate should not have
// to stand up a record of every room ever used to hold two booleans.
type Settings interface {
	EmbyRelay() bool
	SetEmbyRelay(on bool) error
	YouTubeRelay() bool
	SetYouTubeRelay(on bool) error
	BangumiRelay() bool
	SetBangumiRelay(on bool) error
}

// Spent is what the media server relay has carried on each grantor's behalf.
//
// Keyed by the grantor's signature, counted in memory by whatever relays the
// films, and shown beside the grant on the accounts and administrators pages.
// Since this process started and no further back: the figure is there to show
// who is spending the deployment's bandwidth now, and a total that survived
// restarts would need a bucket of its own and a decision about when it resets.
type Spent interface {
	EmbySpent() map[string]uint64

	// YouTubeSpent is what the YouTube relay has carried, for everybody
	// together, since the same start. One figure rather than one per person:
	// most of a video is pieces the gateway signed, which cannot be traced to
	// whoever resolved it, and a figure per person made of the rest would say
	// everybody had spent next to nothing.
	YouTubeSpent() uint64

	// BangumiSpent is what the bangumi relay has carried, for everybody
	// together, since the same start: the figure shown beside its switch, as
	// YouTube's is beside its own.
	BangumiSpent() uint64

	// MoveSpent carries a person's figure across when their passphrase, and
	// so their signature, changes; without it the page put them back to
	// nought.
	MoveSpent(from, to string)
}

// API is the management surface.
type API struct {
	conf     *config.Config
	sessions *Sessions
	control  Control
	media    Media
	store    Names
	roster   Roster
	ledger   Ledger
	relays   Relays
	// settings is the media server relay switch. Nil where there is no store.
	settings Settings
	// spent says what the relay has carried for each grantor. Nil until
	// something that relays is attached; the pages then show no figure.
	spent Spent
	// placing is where a room is held and where one person comes in. Nil where
	// there is no store, which is a relay: it decides nothing about where
	// anything goes.
	placing Placing
	probe   Reachable
	// fleet reads the counters of the relays this node does not run. Nil on a
	// full deployment, which reads its own.
	fleet Fleet
	// enrolment is what a new relay is told; nil where bringing one up from a
	// page is not configured.
	enrolment *Enrolment
	// remote is the apps' remote.json, where the lobby's notice and the
	// feature switches are written (remote.go). Nil where there is no store or
	// no apps directory, which the pages are told rather than shown a notice
	// that was never kept anywhere.
	remote Remote
	// onRelaysChanged lets the choosing side drop its cache the moment this
	// list moves, so a relay added here is used by the very next join.
	onRelaysChanged func()
	log             *Log
	history         *History
	stop            chan struct{}

	// heed is how long a warning that somebody's call is about to end is given
	// to reach them before it ends (moving.go). Zero in the tests that build
	// an API by hand, where nothing is on the other end to hear it.
	heed    time.Duration
	closing sync.Once
}

// New assembles it.
//
// media is nil on a control node, which starts no media server of its own: the
// calls it authorises are held on relays elsewhere, and there is nothing on this
// machine to ask about them. The interfaces are left nil rather than filled with
// something that pretends, so that a page which needs one says it cannot find
// out — see [API.attached].
func New(conf *config.Config, media *rtc.Server, st *store.Store, tripKey []byte) *API {
	// A nil *store.Store put into an interface is an interface that is not nil,
	// so the trend is only handed one where there is one to hand over — the
	// same trap the media guard below is written against, and the same cure.
	var kept Loads
	if st != nil {
		kept = st
	}

	api := &API{
		conf:    conf,
		store:   st,
		log:     NewLog(),
		history: NewHistory(kept),
		stop:    make(chan struct{}),
		heed:    heedWarning,
	}

	// Signing in asks the store, and falls back to the file where there is no
	// store — which is a relay, where none of this is mounted anyway. The file
	// is also what answers before the store has been adopted from, so a
	// deployment being started for the first time is not briefly locked out of
	// itself.
	api.sessions = NewSessions(api.Administrators, tripKey)

	// The relay list is the store's, where a page's changes go. Nil on a
	// deployment without one, which is a relay.
	if st != nil {
		api.relays = st
		api.roster = st
		api.ledger = st
		api.placing = st
		api.settings = st

		// Only where there is a directory to keep it in. A *remote.File for no
		// directory is a value, not nil, and put into the interface it would
		// be an interface that is not nil either: the pages would offer to
		// publish a notice and every press would fail to write it.
		if dir := conf.Meet.Apps.MacDir; dir != "" {
			api.remote = remote.At(dir)
		}

		// So that restarting the process does not sign everybody out. It used
		// to, and during an afternoon of deployments that reads as the sign-in
		// being broken rather than as the server having been restarted.
		api.sessions.Remember(st)
	}

	// Assigned inside the guard and never outside it. A nil *rtc.Server put
	// into an interface field is an interface that is not nil — it carries the
	// type — so `api.media != nil` would be true and the first method call on
	// it would be a nil dereference at the far end of a request. Left unset,
	// the field is genuinely nil and [API.attached] can be trusted.
	if media != nil {
		api.media = media
		api.control = media.Manage(conf.Key, conf.Secret)
	}

	return api
}

// Watching starts the sampling that fills the trend.
//
// Separate from New, and called after the cluster and the enrolment are in
// place, because the sampler reads the fields those set. Started inside New it
// raced them: the goroutine was running before UseCluster assigned `control`,
// `probe` and `fleet`, so the first sample read three fields while another
// goroutine wrote them.
//
// The race detector found it in a test that attaches a cluster, which is what
// startup does — the same write to the same words a moment later. What it
// costs in practice is one sample, at the moment of least interest, and what
// it costs in principle is that the answer is undefined. Ordering is the fix
// rather than a mutex: the fields are written once, during assembly, and read
// for the life of the process, so there is nothing to guard afterwards and a
// lock on every read would be paying for the wrong thing.
//
// Sampled on its own schedule rather than when a page asks. A trend with a gap
// wherever nobody was looking is not a trend, and the first thing anybody does
// with one is read the gap as quiet.
func (a *API) Watching() {
	if a == nil || !a.Configured() {
		return
	}

	go a.history.Watch(a.stop, a.sample)
}

// Close stops sampling.
//
// Guarded, because a server can be shut down from more than one direction — a
// signal and a failed listener both arrive here — and closing a channel twice
// is a panic during the one moment nobody is watching the logs.
func (a *API) Close() {
	a.closing.Do(func() { close(a.stop) })
}

// sample reads one moment for the history.
//
// From the media server in this process where there is one, and from every
// relay where there is not. The second half is the whole of what makes this
// chart worth drawing on the deployment that actually has it: a control node
// carries no media at all, so it was recording a moment of nothing, five
// seconds apart, for ever. The line was flat because every reading in it was
// zero — not because the measurement was wrong, which is what it looked like
// and what was investigated twice.
func (a *API) sample() Sample {
	// local and not attached: every figure below is read from the media server
	// in this process, and a control node has none however many relays it can
	// reach. Guarded on the wrong one of the two, this sampler ran a second
	// after a control node started, dereferenced a nil media server, and took
	// the process down — on a timer, so the crash arrived detached from
	// anything anybody had just done.
	if a.local() {
		stats := a.media.Stats()
		in, out, _ := a.media.Throughput()

		return Sample{
			At: time.Now().UTC(), In: in, Out: out,
			Rooms: stats.GetNumRooms(), Clients: stats.GetNumClients(),
			Nack: stats.GetNackPerSec(),
		}
	}

	return a.fleetSample()
}

// fleetSample adds up what every relay is carrying.
//
// One round of requests every five seconds, to machines this node already dials
// on a timer for the page beside this one. That is the cost, and it is worth
// saying what it buys: without it the only figure a control node can honestly
// report about media is zero, and a deployment whose entire purpose is to hold
// meetings somewhere else would have a load chart that is a straight line at the
// bottom for ever.
//
// A relay that does not answer contributes nothing rather than breaking the
// sample. That understates the moment, which is the right way to be wrong here —
// a gap in a trend reads as quiet, and quiet is closer to the truth than a hole.
func (a *API) fleetSample() Sample {
	at := Sample{At: time.Now().UTC()}

	if a.fleet == nil {
		return at
	}

	// Short of the sampling interval, so a slow relay delays the reading rather
	// than colliding with the next one.
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	reading := readFleet(ctx, a.fleet, nil)

	var nack float64
	var answered int

	for _, node := range reading.Nodes {
		if !node.Reachable {
			continue
		}

		answered++
		at.In += node.Stats.InPerSec
		at.Out += node.Stats.OutPerSec
		at.Rooms += node.Stats.Rooms
		at.Clients += node.Stats.Clients
		nack += float64(node.Stats.NackPerSec)
	}

	// Averaged rather than summed, because it is a rate of loss and not an
	// amount of anything: eleven relays each losing one packet a second is not
	// eleven times worse than one relay doing it.
	if answered > 0 {
		at.Nack = float32(nack / float64(answered))
	}

	return at
}

// UseCluster points the management pages at relays elsewhere.
//
// A control node has no media server of its own, so without this every page
// about rooms or participants answers that it cannot find out — which is true
// and useless, since those pages exist to answer exactly those questions. Given
// a cluster they work as a full deployment's do: the questions go to whichever
// relay answers, and redis makes any one of them speak for all.
func (a *API) UseCluster(cluster *rtc.Cluster) {
	if cluster == nil {
		return
	}

	a.control = cluster
	a.probe = cluster
	a.fleet = cluster
}

// UseEnrolment lets relays be brought up from the management pages.
//
// Off unless configured, and deliberately so: what an enrolment hands over is
// the secret every relay signs with, the redis password and a private key. A
// deployment that has not said where those live does not get an endpoint that
// gives them away.
func (a *API) UseEnrolment(enrolment *Enrolment) {
	a.enrolment = enrolment
}

// OnRelaysChanged registers what to run when the relay list moves.
func (a *API) OnRelaysChanged(fn func()) {
	a.onRelaysChanged = fn
}

// UseSpent lets the pages show what the media server relay has carried for
// each person granted it.
func (a *API) UseSpent(spent Spent) {
	if a == nil {
		return
	}

	a.spent = spent
}

// moveSpent carries somebody's figure to their new signature, where there is a
// relay counting at all.
func (a *API) moveSpent(from, to string) {
	if a.spent != nil && from != to {
		a.spent.MoveSpent(from, to)
	}
}

// spending reads the relay's figures once for a page.
func (a *API) spending() map[string]uint64 {
	if a.spent == nil {
		return nil
	}

	return a.spent.EmbySpent()
}

// Configured reports whether this deployment has a management surface at all.
func (a *API) Configured() bool {
	return a.sessions.Configured()
}

// attached says whether there is a media server on this machine to ask about.
//
// False on a control node. The calls it authorises are held on relays
// elsewhere, and what those relays are doing is not visible from here: every
// figure on these pages comes from the embedded server's own counters, and
// there is no embedded server.
//
// Both halves are checked because they are set together and a future caller
// should not have to know that. Neither is ever a nil pointer inside a non-nil
// interface — see the guard in New, which is what makes this test meaningful.
func (a *API) attached() bool {
	return a.control != nil
}

// local says whether the figures that only a media server knows about itself are
// available: throughput, node identity, hardware counters.
//
// Distinct from attached, because the two became different questions the moment
// a control node could reach relays it does not run. It can list their rooms
// and remove somebody from one; it cannot report their CPU, because those
// counters are read from the process holding them.
func (a *API) local() bool {
	return a.media != nil
}

// detached answers a page that wanted a media server on a node that has none.
//
// 503 rather than 404. The distinction is the honest one — the endpoint exists
// and this deployment is configured for it, but the thing it reports on is on
// another machine — and it is the difference between an operator concluding
// they mistyped an address and concluding they are looking at the wrong half of
// a deployment.
func (a *API) detached(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "no_media_here"})
}

// Mount registers the endpoints.
//
// Nothing is registered when no administrator is configured, so the paths do
// not merely refuse — they are not there, and the client fallback answers them
// like any other unknown address.
// administrators is the live list, as everything that recognises somebody reads
// it.
//
// The store first and the configuration file behind it. The file is the starting
// value and the way back in when a store has been lost: somebody who can edit it
// on the host can always put themselves back, and that is deliberate, because
// the alternative is a deployment that has locked out its own owner.
func (a *API) Administrators() []config.Admin {
	// Nil where no management surface was built, which is a relay. Callers on
	// that side ask this to decide whether an administrator exists at all, and
	// the honest answer for a machine with no management pages is none.
	if a == nil {
		return nil
	}

	if a.roster != nil {
		if stored, err := a.roster.Admins(); err == nil && len(stored) > 0 {
			list := make([]config.Admin, 0, len(stored))
			for _, one := range stored {
				list = append(list, one.Configured())
			}

			return list
		}
	}

	return a.conf.Meet.Admins
}

func (a *API) Mount(mux *http.ServeMux) {
	if !a.Configured() {
		return
	}

	mux.HandleFunc("POST /api/admin/session", a.open)
	mux.HandleFunc("DELETE /api/admin/session", a.close)
	mux.HandleFunc("GET /api/admin/session", a.whoami)

	mux.HandleFunc("GET /api/admin/now", a.observe(a.now))
	mux.HandleFunc("GET /api/admin/history", a.observe(a.trend))
	mux.HandleFunc("GET /api/admin/rooms", a.observe(a.rooms))
	mux.HandleFunc("GET /api/admin/rooms/{room}/participants", a.observe(a.participants))
	mux.HandleFunc("GET /api/admin/rooms/{room}/visits", a.observe(a.visits))
	mux.HandleFunc("GET /api/admin/runtime", a.observe(a.runtime))
	mux.HandleFunc("GET /api/admin/policy", a.observe(a.readPolicy))
	mux.HandleFunc("GET /api/admin/relays", a.observe(a.listRelays))
	// One row's own measurement. A reading and not a change, so it asks for no
	// more than the list it comes from does.
	mux.HandleFunc("GET /api/admin/relays/{relay}/check", a.observe(a.checkRelay))

	// Adding a relay decides where other people's calls are held, which is
	// authority over the fleet rather than the same kind as reading a figure.
	mux.HandleFunc("POST /api/admin/relays", a.need(config.ManageRelays, a.addRelay))
	mux.HandleFunc("PATCH /api/admin/relays/{relay}", a.need(config.ManageRelays, a.editRelay))
	mux.HandleFunc("DELETE /api/admin/relays/{relay}", a.need(config.ManageRelays, a.dropRelay))
	// The install script, served to somebody signed in because it carries the
	// enrolment secret — which is a relay of one's own, and so the same
	// capability as adding one, and not a reading despite being a GET.
	mux.HandleFunc("GET /api/admin/relays/script", a.need(config.ManageRelays, a.installScript))
	mux.HandleFunc("GET /api/admin/relays/command", a.need(config.ManageRelays, a.installCommand))
	mux.HandleFunc("PUT /api/admin/relays/order", a.need(config.ManageRelays, a.orderRelays))

	// Who else may open these pages. Reading the list needs observe; changing
	// it needs moderate and nothing finer, because being able to grant an
	// ability is that ability — anybody who could appoint a moderator would be
	// one. The administrators' Emby grants are edited here too, and so share
	// the gate.
	mux.HandleFunc("GET /api/admin/admins", a.observe(a.roles))
	mux.HandleFunc("POST /api/admin/admins", a.moderate(a.addRole))
	mux.HandleFunc("PATCH /api/admin/admins/{trip}", a.moderate(a.changeRole))
	mux.HandleFunc("DELETE /api/admin/admins/{trip}", a.moderate(a.dropRole))

	// Changing one's own passphrase needs no capability beyond being signed in.
	// It is not an administrative act on the deployment; it is somebody looking
	// after their own credential, and requiring moderate for it would mean an
	// observer could never rotate theirs.
	mux.HandleFunc("POST /api/admin/admins/me/passphrase", a.observe(a.changeOwnPassphrase))

	// The accounts an administrator hands out. Reading needs observe; making
	// and changing one needs the accounts capability, because an account is a
	// way in. Ticking somebody's Emby asks for moderate on top, inside the
	// handler, because it is a field of a request this gate has already let
	// through.
	mux.HandleFunc("GET /api/admin/accounts", a.observe(a.accounts))
	mux.HandleFunc("POST /api/admin/accounts", a.need(config.ManageAccounts, a.addAccount))
	mux.HandleFunc("PATCH /api/admin/accounts/{name}", a.need(config.ManageAccounts, a.changeAccount))
	mux.HandleFunc("DELETE /api/admin/accounts/{name}", a.need(config.ManageAccounts, a.dropAccount))

	// The deployment-wide switches: who may open and enter rooms, and whether
	// a media server's films are relayed at all.
	mux.HandleFunc("PUT /api/admin/policy", a.need(config.ManageSettings, a.setPolicy))
	mux.HandleFunc("GET /api/admin/settings", a.observe(a.readSettings))
	mux.HandleFunc("PUT /api/admin/settings", a.need(config.ManageSettings, a.setSettings))

	// What the apps are told between releases: the lobby's notice and which
	// features are off. The same kind of decision as the switches above, and
	// behind the same capability. See remote.go.
	mux.HandleFunc("GET /api/admin/remote/notice", a.observe(a.readNotice))
	mux.HandleFunc("PUT /api/admin/remote/notice", a.need(config.ManageSettings, a.setNotice))
	mux.HandleFunc("GET /api/admin/remote/switches", a.observe(a.readSwitches))
	mux.HandleFunc("PUT /api/admin/remote/switches", a.need(config.ManageSettings, a.setSwitches))

	mux.HandleFunc("DELETE /api/admin/rooms/{room}", a.need(config.ManageRooms, a.closeRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{room}/participants/{identity}", a.need(config.ManageRooms, a.removeOne))
	mux.HandleFunc("POST /api/admin/rooms/{room}/participants/{identity}/mute", a.need(config.ManageRooms, a.muteOne))
	mux.HandleFunc("PUT /api/admin/rooms/{room}/relay", a.need(config.ManageRooms, a.placeRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{room}/relay", a.need(config.ManageRooms, a.freeRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{room}/record", a.need(config.ManageRooms, a.forgetRoom))
	mux.HandleFunc("PUT /api/admin/rooms/{room}/participants/{identity}/relay", a.need(config.ManageRooms, a.placePerson))
}

// MountEnrolment registers the endpoint a new relay claims its configuration
// from.
//
// Separate from Mount because it is the one management path with no session
// behind it: the machine claiming it has no administrator sitting at it, and
// the token it carries is the authentication. Registered only where enrolment
// was configured, so a deployment that did not ask for this has no such
// address rather than one that refuses.
func (a *API) MountEnrolment(mux *http.ServeMux) {
	if a.enrolment == nil {
		return
	}

	mux.HandleFunc("POST /api/enrol", a.claim)
	mux.HandleFunc("POST /api/enrol/taken", a.taken)
}

// open signs somebody in.
func (a *API) open(w http.ResponseWriter, r *http.Request) {
	caller := limit.Caller(r, a.conf.Meet.Hops())

	attempt, allowed := a.sessions.limit.Take(caller)
	if !allowed {
		a.log.Record(Entry{Action: "sign in", Trip: "-", Failed: true, Reason: "too many attempts"})
		refuse(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}
	defer attempt.Settled()

	var body struct {
		// Name narrows the guess to one person.
		//
		// Without it every attempt is checked against every administrator at
		// once, so a list of leaked passphrases run at this endpoint succeeds if
		// any one person on the deployment ever reused one. With it, an attacker
		// has to be right about who as well as what.
		Name       string          `json:"name"`
		Passphrase room.Passphrase `json:"passphrase"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	session, token, ok := a.sessions.Open(body.Name, body.Passphrase)
	if !ok {
		attempt.Failed()
		// Recorded without anything derived from what was typed. A rejected
		// passphrase is still a passphrase, and one of these logs is going to
		// be read by somebody it does not belong to.
		a.log.Record(Entry{Action: "sign in", Trip: "-", Failed: true, Reason: "not an administrator"})
		refuse(w, http.StatusUnauthorized, "refused")
		return
	}

	Grant(w, token, secureRequest(r, a.conf.Meet.TrustProxy))
	a.log.Record(Entry{Action: "sign in", Trip: session.Trip, Name: session.Name})

	respond(w, whoami{Trip: session.Trip, Name: session.Name, Can: capabilities(session)})
}

func (a *API) close(w http.ResponseWriter, r *http.Request) {
	if session, ok := a.sessions.Of(r); ok {
		a.log.Record(Entry{Action: "sign out", Trip: session.Trip, Name: session.Name})
	}

	a.sessions.Close(r)
	Revoke(w, secureRequest(r, a.conf.Meet.TrustProxy))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) whoami(w http.ResponseWriter, r *http.Request) {
	session, ok := a.sessions.Of(r)
	if !ok {
		refuse(w, http.StatusUnauthorized, "signed_out")
		return
	}

	respond(w, whoami{Trip: session.Trip, Name: session.Name, Can: capabilities(session)})
}

type whoami struct {
	Trip string   `json:"trip"`
	Name string   `json:"name,omitempty"`
	Can  []string `json:"can"`
}

// capabilities spells out what a session may do, including what it holds by
// default and what moderate carries with it, so a page can ask for the one it
// wants by name rather than knowing which others imply it.
func capabilities(session Session) []string {
	return capabilitiesOf(config.Admin{Trip: session.Trip, Can: session.Can})
}

// observe, need and moderate are the gates.
//
// Observe and the rest are separate because the halves differ by more than
// degree: watching answers the question somebody debugging a call has, and
// acting changes what another person is experiencing, at once and with no
// warning. Bound together, the choice becomes give everybody the second or
// nobody the first. The acting half is cut further by what it acts on; see
// config.ManageRooms and its neighbours.
func (a *API) observe(next func(Session, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return a.gate(config.Observe, next)
}

func (a *API) need(
	capability string,
	next func(Session, http.ResponseWriter, *http.Request),
) http.HandlerFunc {
	return a.gate(capability, next)
}

func (a *API) moderate(next func(Session, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return a.gate(config.Moderate, next)
}

func (a *API) gate(
	capability string,
	next func(Session, http.ResponseWriter, *http.Request),
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !FromHere(r) {
			refuse(w, http.StatusForbidden, "cross_site")
			return
		}

		session, ok := a.sessions.Of(r)
		if !ok {
			refuse(w, http.StatusUnauthorized, "signed_out")
			return
		}

		if !session.Allows(capability) {
			a.log.Record(Entry{
				Action: "refused", Trip: session.Trip, Name: session.Name,
				Failed: true, Reason: "not allowed to " + capability,
			})
			refuse(w, http.StatusForbidden, "not_allowed")
			return
		}

		next(session, w, r)
	}
}

// trend is the load over a stretch of time.
//
// The range comes back with the points, and so does the width of a bucket. A
// bare list of points cannot be read: the same array describes an hour or half
// a year depending on figures the caller would otherwise have to assume, and
// what it asked for is not what it got whenever a resolution has aged out from
// under the question. It also cannot say how much of a range the server
// actually had — a deployment three days old asked for six months answers
// honestly only if it says where its points begin.
func (a *API) trend(_ Session, w http.ResponseWriter, r *http.Request) {
	span, from, to, err := askedFor(r.URL.Query(), time.Now().UTC())
	if err != nil {
		// One code for a span nobody keeps and for a range that will not parse,
		// because the page says the same thing about both: that is not a stretch
		// of time this server can answer for. And the code rather than the
		// sentence, because the sentence is said in one of four languages and
		// this server does not know which.
		refuse(w, http.StatusBadRequest, "no_such_span")
		return
	}

	points, step := a.history.Over(from, to)

	respond(w, map[string]any{
		"span":   span,
		"step":   step.Seconds(),
		"from":   from,
		"to":     to,
		"points": points,
	})
}

// now is the one screen that answers "how is it going".
func (a *API) now(_ Session, w http.ResponseWriter, r *http.Request) {
	// A control node holds no media and reads its relays instead. The shape
	// differs because the thing being described differs: one process has a node
	// identity and a load, and a fleet has a list of them and a sum.
	if !a.local() {
		if a.fleet == nil {
			a.detached(w)
			return
		}

		reading := readFleet(r.Context(), a.fleet, a.relayNames())

		respond(w, map[string]any{
			"since":    Started.UTC(),
			"fleet":    true,
			"nodes":    reading.Nodes,
			"asked":    reading.Asked,
			"answered": reading.Answered,
			"rooms":    reading.Totals.Rooms,
			"clients":  reading.Totals.Clients,
			"tracks":   map[string]int32{"in": reading.Totals.TracksIn, "out": reading.Totals.TracksOut},
			"bytes": map[string]any{
				"in": reading.Totals.BytesIn, "out": reading.Totals.BytesOut,
				"inPerSec": reading.Totals.InPerSec, "outPerSec": reading.Totals.OutPerSec,
				"window": reading.Totals.Window,
			},
			"packets": map[string]any{
				"nackTotal": reading.Totals.NackTotal, "nackPerSec": reading.Totals.NackPerSec,
			},
			"cpu": map[string]any{"count": reading.Totals.CPUs, "load": reading.Totals.Load},
		})
		return
	}

	stats := a.media.Stats()
	in, out, window := a.media.Throughput()
	id, ip := a.media.Node()

	respond(w, map[string]any{
		"node":    map[string]string{"id": id, "ip": ip},
		"since":   Started.UTC(),
		"rooms":   stats.GetNumRooms(),
		"clients": stats.GetNumClients(),
		"tracks":  map[string]int32{"in": stats.GetNumTracksIn(), "out": stats.GetNumTracksOut()},
		"bytes": map[string]any{
			"in": stats.GetBytesIn(), "out": stats.GetBytesOut(),
			// From the list of measured rates rather than the flat field beside
			// them, which the protocol marks deprecated and the media server
			// never assigns. The window is sent with them: ten seconds of mean
			// is not an instantaneous reading, and a figure that does not say
			// which it is gets read as the wrong one.
			"inPerSec": in, "outPerSec": out, "window": window.Seconds(),
		},
		"packets": map[string]any{
			"nackTotal": stats.GetNackTotal(), "nackPerSec": stats.GetNackPerSec(),
		},
		"cpu": map[string]any{"count": stats.GetNumCpus(), "load": stats.GetCpuLoad()},
	})
}

func (a *API) rooms(_ Session, w http.ResponseWriter, r *http.Request) {
	if !a.attached() {
		a.detached(w)
		return
	}

	// Answered even where the media servers cannot be reached.
	//
	// Half of this page comes from the store and needs no media server at all:
	// the names this deployment has seen, when they were last used, and where an
	// operator has said each one goes. Refusing the whole endpoint took that
	// away too — so the page went blank at precisely the moment somebody opened
	// it to find out what was wrong, and it went blank in a way that said
	// nothing about which half had failed.
	//
	// Said in the answer rather than in a status, because the answer is useful.
	// A page that knows the live half is missing can draw the rest and mark it;
	// a page that got a 502 can only apologise.
	live, err := a.control.Rooms(r.Context())
	if err != nil {
		slog.Error("failed to list rooms", "error", err)
	}

	seen, err := a.store.Rooms()
	if err != nil {
		slog.Warn("failed to read the room history", "error", err)
		seen = nil
	}

	// Where each live room actually is.
	//
	// The media server will not say. It reports the room from whichever node
	// answered, and every node answers for the whole cluster, so the field that
	// looks like it should hold this holds the machine that was asked. This
	// server chose the machine at the join and wrote it down, which is the only
	// record of it anywhere.
	//
	// So this is the relay people *enter* by, which is not necessarily the node
	// holding the media: the cluster picks that when the room is created. The
	// two used to drift apart, and an operator reading "Nanjing" off this page
	// while the meeting was on Hong Kong reasonably concluded the page was
	// lying. It was not, quite — it was answering a different question than the
	// one being asked of it.
	//
	// They agree now because a move pins the node as well as writing this down,
	// and because every relay forwards, so the entry is the machine whose line
	// the media is actually on. The count on the fleet page is what to compare
	// against when they ever look like disagreeing again.
	answer := map[string]any{
		"live":  liveRooms(live, a.wherever()),
		"known": knownRooms(seen, a.wherever()),
	}

	if err != nil {
		// Named rather than left to be inferred from an empty list, which is
		// what a deployment holding no calls looks like and is the one reading
		// this must not be confused with.
		answer["liveUnavailable"] = true
	}

	respond(w, answer)
}

// knownRooms flattens what the store holds.
//
// Its own shape nests the record inside a wrapper carrying the name, which is
// how it is keyed rather than how it reads. Handed over as it stands, every
// caller would have to know that.
//
// Placements are marked here as well as on the live list, and this is the half
// that matters more. A pin on a meeting somebody is in is visible by being
// looked at; a pin on a name nobody has used for a month is the one that gets
// forgotten, and it is waiting to send the next meeting of that name somewhere
// nobody remembers choosing. Marked on the live list alone, the only rooms whose
// placement could be seen would be the ones whose placement was least likely to
// surprise anybody.
func knownRooms(seen []store.Named, held func(string) (string, bool)) []map[string]any {
	out := make([]map[string]any, 0, len(seen))
	for _, one := range seen {
		row := map[string]any{
			"name":      one.Name,
			"firstSeen": one.Room.Created,
			"lastSeen":  one.Room.Seen,
			"joins":     one.Room.Joins,
		}

		if held != nil {
			if where, placed := held(one.Name); placed && where != "" {
				row["relay"] = where
				row["placed"] = true
			}
		}

		out = append(out, row)
	}

	return out
}

// wherever answers, for a room, the name a person would recognise the machine
// holding it by.
//
// The store keys relays by a short name typed at a prompt on the machine being
// brought up; what an operator reads on a page is the label. Resolved here
// rather than in the store because the store holds the room record and knows
// nothing about labels, and resolved once per listing rather than per room so a
// page with forty calls does not read the relay list forty times.
func (a *API) wherever() func(string) (string, bool) {
	if a.store == nil {
		return nil
	}

	shown := map[string]string{}

	if a.relays != nil {
		if list, err := a.relays.Relays(); err == nil {
			for _, relay := range list {
				shown[relay.Name] = relay.Shown()
			}
		}
	}

	return func(name string) (string, bool) {
		held, placed := a.store.HeldOn(name)
		if held == "" {
			return "", false
		}

		// The key where the relay has since been removed, which is worth saying:
		// a call held on a machine that is no longer in the list is exactly the
		// situation somebody needs to be told about.
		if label, ok := shown[held]; ok {
			return label, placed
		}

		return held, placed
	}
}

// The second half of what `held` answers is whether somebody chose the machine
// or a join left it behind, and it is on the page for one reason: a placement
// now stands until it is cleared. It used to expire, which meant a pin nobody
// remembered making went away on its own — invisible, and harmless because it
// was temporary. Standing for good, invisible would be a room that ignores every
// later choice with nothing anywhere to say why.
func liveRooms(rooms []*livekit.Room, held func(string) (string, bool)) []map[string]any {
	out := make([]map[string]any, 0, len(rooms))
	for _, one := range rooms {
		row := map[string]any{
			"name":         one.GetName(),
			"sid":          one.GetSid(),
			"participants": one.GetNumParticipants(),
			"publishers":   one.GetNumPublishers(),
			"createdAt":    time.Unix(one.GetCreationTime(), 0).UTC(),
		}

		if held != nil {
			if where, placed := held(one.GetName()); where != "" {
				row["relay"] = where
				row["placed"] = placed
			}
		}

		out = append(out, row)
	}

	return out
}

func (a *API) participants(_ Session, w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("room")

	if !a.attached() {
		a.detached(w)
		return
	}

	people, err := a.control.Participants(r.Context(), name)
	if err != nil {
		// A room nobody is in is not a fault. The page that asks this now opens
		// for a name out of the history as well as for a call in progress, and
		// the media server's answer for one of those is that it has never heard
		// of it — which is the truth and is a list of nobody, not an error to
		// put in front of somebody who asked what happened in a meeting.
		if errors.Is(err, rtc.ErrNoSuchRoom) {
			respond(w, []map[string]any{})
			return
		}

		slog.Error("failed to list participants", "room", name, "error", err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	// What was seen of each of them at the door, which the media server cannot
	// know: by the time it sees somebody they arrived over a signalling socket
	// from a relay, so the address it holds is the relay's.
	arrived := map[string]store.Arrival{}
	if a.store != nil {
		arrived = a.store.Arrivals(name)
	}

	out := make([]map[string]any, 0, len(people))
	for _, one := range people {
		signature, _ := room.SignatureOf(one.GetIdentity())

		row := map[string]any{
			"identity":  one.GetIdentity(),
			"name":      one.GetName(),
			"sid":       one.GetSid(),
			"state":     one.GetState().String(),
			"joinedAt":  time.Unix(one.GetJoinedAt(), 0).UTC(),
			"publisher": one.GetIsPublisher(),
			"trip": map[string]any{
				"mark": signature.Trip, "proven": signature.Proven,
				"account": signature.Account,
			},
			"tracks": tracksOf(one),
		}

		if arrival, ok := arrived[one.GetIdentity()]; ok {
			row["address"] = arrival.Address
			row["relay"] = arrival.Relay
			row["holding"] = arrival.Holding
			row["forwarded"] = arrival.Forwarded
			if arrival.Client != nil {
				row["client"] = arrival.Client
			}
		}

		out = append(out, row)
	}

	respond(w, out)
}

// tracksOf is the panel that would have answered several questions at a glance.
//
// What resolution a picture is actually being sent at, which codec carried it,
// and what the layers underneath it are — all of it known to the media server
// and, until now, visible only by reading the client's source and inferring.
func tracksOf(one *livekit.ParticipantInfo) []map[string]any {
	out := make([]map[string]any, 0, len(one.GetTracks()))

	for _, track := range one.GetTracks() {
		layers := make([]map[string]any, 0, len(track.GetLayers()))
		for _, layer := range track.GetLayers() {
			layers = append(layers, map[string]any{
				"quality": layer.GetQuality().String(),
				"width":   layer.GetWidth(),
				"height":  layer.GetHeight(),
				"bitrate": layer.GetBitrate(),
			})
		}

		out = append(out, map[string]any{
			"sid":       track.GetSid(),
			"source":    track.GetSource().String(),
			"kind":      track.GetType().String(),
			"muted":     track.GetMuted(),
			"width":     track.GetWidth(),
			"height":    track.GetHeight(),
			"mime":      track.GetMimeType(),
			"simulcast": track.GetSimulcast(),
			"layers":    layers,
		})
	}

	return out
}

// runtime reports what the process is actually running with.
//
// What it resolved to, not what the file says. More than one afternoon has gone
// into working out whether a setting took effect, by reading the source of the
// thing that consumes it. The process knows; it may as well answer.
//
// The API key is shown and the secret is not. The key names which credential is
// in use, which is the question; the secret signs tokens for every room on this
// deployment, and a management page is not a reason to put it on a screen.
func (a *API) runtime(_ Session, w http.ResponseWriter, _ *http.Request) {
	rtcConf := a.conf.LiveKit.RTC

	respond(w, map[string]any{
		"meet": map[string]any{
			"listen":     a.conf.Meet.Listen,
			"publicURL":  a.conf.Meet.PublicURL,
			"tokenTTL":   a.conf.Meet.TokenTTL.String(),
			"joinRate":   a.conf.Meet.JoinRate,
			"joinBurst":  a.conf.Meet.JoinBurst,
			"trustProxy": a.conf.Meet.TrustProxy,
			"database":   a.conf.Meet.Database,
			"admins":     len(a.Administrators()),
			// What the pages draw their bandwidth bars and their "busy" mark
			// against. Sent rather than assumed: it was a constant in the client
			// and therefore right on exactly one kind of link.
			"linkMbits": a.conf.Meet.LinkMbits,
			// Watching together, and what this deployment will relay of it.
			// Read-only here: direct_only is the file's, and the switch beside
			// it is changed from the settings rather than from this panel. Sent
			// because whether a deployment relays video at all was, until
			// now, a question answered only by reading a file on the host.
			"watch": a.watching(),
		},
		"rooms": a.currentPolicy(),
		"rtc": map[string]any{
			"nodeIP":        rtcConf.NodeIP.V4,
			"useExternalIP": rtcConf.UseExternalIP,
			"udpPort":       rtcConf.UDPPort.Start,
			"tcpPort":       rtcConf.TCPPort,
			"bindAddresses": a.conf.LiveKit.BindAddresses,
			"httpPort":      a.conf.LiveKit.Port,
		},
		"credentials": map[string]any{"key": a.conf.Key},
		"codecs":      codecNames(a.conf),
	})
}

func codecNames(conf *config.Config) []string {
	out := make([]string, 0, len(conf.LiveKit.Room.EnabledCodecs))
	for _, codec := range conf.LiveKit.Room.EnabledCodecs {
		out = append(out, codec.Mime)
	}

	return out
}

// Who may open a room, in the three forms worth telling apart.
//
// One number would be enough to draw a switch and not enough to explain it. The
// three separate the choice somebody made from the file it started in and from
// what the deployment can actually carry out, which is how the two ways this
// goes quietly wrong become visible instead: a file edited after first run and
// obeyed by nothing, and a policy asking for an administrator on a deployment
// that has none.
type policy struct {
	// OpenedBy is what the server is doing.
	OpenedBy room.Opening `json:"openedBy"`

	// Chosen is what was last set, before it was reconciled against whether
	// anybody exists who could satisfy it.
	Chosen room.Opening `json:"chosen"`

	// JoinedBy is who may enter a room that already exists, and ChosenJoin what
	// was set before it was reconciled against whether anybody could satisfy it.
	JoinedBy       room.Joining `json:"joinedBy"`
	ChosenJoin     room.Joining `json:"chosenJoin"`
	ConfiguredJoin room.Joining `json:"configuredJoin"`

	// Configured is the configuration file's value, which is the starting one
	// and nothing more.
	Configured room.Opening `json:"configured"`

	// Remember is how long a name stays used after the last join, in seconds,
	// or nought where names are kept for ever.
	//
	// Beside the policy rather than somewhere of its own, because it is the
	// other half of the same sentence: this says who may open a room and that
	// says how long one stays open. Somebody reading the switch without it is
	// reading half a rule.
	Remember int64 `json:"remember"`
}

func (a *API) currentPolicy() policy {
	chosen := a.store.Opening()
	joining := a.store.Joining(a.conf.Meet.Rooms.JoinedBy)

	return policy{
		OpenedBy:       chosen.InEffect(len(a.Administrators())),
		Chosen:         chosen,
		Configured:     a.conf.Meet.Rooms.OpenedBy,
		JoinedBy:       joining.InEffect(a.store.AccountCount()),
		ChosenJoin:     joining,
		ConfiguredJoin: a.conf.Meet.Rooms.JoinedBy,
		Remember:       int64(a.conf.Meet.Rooms.Remember / time.Second),
	}
}

func (a *API) readPolicy(_ Session, w http.ResponseWriter, _ *http.Request) {
	respond(w, a.currentPolicy())
}

// setPolicy changes who may open a room.
//
// Under the settings capability rather than observation, and by some distance
// the furthest reaching thing behind any gate here. Closing a room ends one
// meeting; this decides whether anybody outside a short list can start one at
// all, and it goes on deciding after whoever set it has signed out and
// forgotten.
func (a *API) setPolicy(session Session, w http.ResponseWriter, r *http.Request) {
	var body struct {
		OpenedBy room.Opening `json:"openedBy"`
		JoinedBy room.Joining `json:"joinedBy"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable_request")
		return
	}

	// One at a time, because the page offers them as two controls and a request
	// carrying only the one that moved must not silently reset the other.
	if body.JoinedBy != "" {
		// Offered rather than Valid. "anyone" is a setting this server
		// understands and is not one the pages hand out: it is written in a
		// file by somebody who meant it, not chosen from a list by whoever has
		// the page open.
		if !body.JoinedBy.Offered() {
			refuse(w, http.StatusBadRequest, "no_such_policy")
			return
		}

		if err := a.store.SetJoining(body.JoinedBy); err != nil {
			a.record(session, "set joining", "", string(body.JoinedBy), err)
			refuse(w, http.StatusInternalServerError, "store_unavailable")
			return
		}

		a.record(session, "set joining", "", string(body.JoinedBy), nil)

		if body.OpenedBy == "" {
			respond(w, a.currentPolicy())
			return
		}
	}

	// Offered rather than Valid, for the reason the joining half is: the two
	// settings that let anybody start a meeting are written in a file by
	// somebody who meant them, not chosen from a list by whoever has the page
	// open.
	if !body.OpenedBy.Offered() {
		refuse(w, http.StatusBadRequest, "no_such_policy")
		return
	}

	err := a.store.SetOpening(body.OpenedBy)
	a.record(session, "set who may open a room", "", string(body.OpenedBy), err)

	if err != nil {
		slog.Error("failed to set who may open a room", "error", err)
		refuse(w, http.StatusInternalServerError, "store_unwritable")
		return
	}

	respond(w, a.currentPolicy())
}

// watching is the state of watching together, as the runtime panel and the
// settings page both show it.
type watching struct {
	// Configured is whether there is a gateway at all. Without one there is
	// no watching together and the other two mean nothing.
	Configured bool `json:"configured"`

	// DirectOnly is the file's meet.watch.direct_only: every viewer plays a
	// video from where they are, and nothing is relayed — except, with the
	// switches below on, films chosen by somebody granted Emby, YouTube for
	// whoever cannot reach it, and Bilibili's bangumi for everybody.
	DirectOnly bool `json:"directOnly"`

	// EmbyRelay is the switch in the store.
	EmbyRelay bool `json:"embyRelay"`

	// YouTubeRelay is the other switch in the store.
	YouTubeRelay bool `json:"youtubeRelay"`

	// YouTubeSpent is what has been relayed of YouTube since this process
	// started, in bytes: shown beside its switch, because a switch that
	// relays for everybody with no grant to withdraw is one somebody will
	// want to see the cost of.
	YouTubeSpent uint64 `json:"youtubeSpent"`

	// BangumiRelay is the third switch in the store, and the one that is on
	// until somebody turns it off.
	BangumiRelay bool `json:"bangumiRelay"`

	// BangumiSpent is what has been relayed of bangumi since this process
	// started, in bytes, beside its switch for the reason YouTube's is: every
	// episode is relayed for every viewer, on nobody's grant.
	BangumiSpent uint64 `json:"bangumiSpent"`
}

func (a *API) watching() watching {
	read := watching{
		Configured: a.conf.Meet.Watch.URL != "",
		DirectOnly: a.conf.Meet.Watch.DirectOnly,
	}

	if a.settings != nil {
		read.EmbyRelay = a.settings.EmbyRelay()
		read.YouTubeRelay = a.settings.YouTubeRelay()
		read.BangumiRelay = a.settings.BangumiRelay()
	}

	if a.spent != nil {
		read.YouTubeSpent = a.spent.YouTubeSpent()
		read.BangumiSpent = a.spent.BangumiSpent()
	}

	return read
}

// readSettings answers what the deployment-wide switches are.
func (a *API) readSettings(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.settings == nil {
		a.detached(w)
		return
	}

	respond(w, a.watching())
}

// setSettings turns the media server relay, the YouTube relay or the bangumi
// relay on or off.
//
// Behind the settings capability, beside who may open a room, because it is the
// same kind of decision: it goes on deciding after whoever made it has signed
// out, and it decides for everybody. Turning the media server relay on relays
// nothing by itself — nobody holds the Emby grant until somebody ticks it, and
// every grant starts unticked — so that switch is the one place a deployment
// can stop all of it at once without finding and unticking each person. The
// YouTube relay has no grant under it: on, it relays YouTube for everybody who
// cannot reach it, at once. Nor has the bangumi relay, which relays every
// bangumi episode for everybody, and is the one a deployment starts with on.
//
// Each switch is changed only where the request names it, for the reason the
// two halves of the room policy are: a page changing one should not quietly
// reset the other to whatever it last read.
func (a *API) setSettings(session Session, w http.ResponseWriter, r *http.Request) {
	if a.settings == nil {
		a.detached(w)
		return
	}

	var body struct {
		EmbyRelay    *bool `json:"embyRelay"`
		YouTubeRelay *bool `json:"youtubeRelay"`
		BangumiRelay *bool `json:"bangumiRelay"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil ||
		body.EmbyRelay == nil && body.YouTubeRelay == nil && body.BangumiRelay == nil {
		refuse(w, http.StatusBadRequest, "unreadable_request")
		return
	}

	for _, one := range []struct {
		to     *bool
		set    func(bool) error
		action string
	}{
		{body.EmbyRelay, a.settings.SetEmbyRelay, "set the media server relay"},
		{body.YouTubeRelay, a.settings.SetYouTubeRelay, "set the YouTube relay"},
		{body.BangumiRelay, a.settings.SetBangumiRelay, "set the bangumi relay"},
	} {
		if one.to == nil {
			continue
		}

		said := "off"
		if *one.to {
			said = "on"
		}

		err := one.set(*one.to)
		a.record(session, one.action, "", said, err)

		if err != nil {
			slog.Error("failed to "+one.action, "error", err)
			refuse(w, http.StatusInternalServerError, "store_unwritable")
			return
		}
	}

	respond(w, a.watching())
}

func (a *API) closeRoom(session Session, w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("room")

	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Close(r.Context(), name); err != nil {
		a.record(session, "close room", name, "", err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "close room", name, "", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) removeOne(session Session, w http.ResponseWriter, r *http.Request) {
	name, identity := r.PathValue("room"), r.PathValue("identity")

	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Remove(r.Context(), name, identity); err != nil {
		a.record(session, "remove participant", name, identity, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "remove participant", name, identity, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) muteOne(session Session, w http.ResponseWriter, r *http.Request) {
	name, identity := r.PathValue("room"), r.PathValue("identity")

	var body struct {
		Track string `json:"track"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	if body.Track == "" {
		refuse(w, http.StatusBadRequest, "no_track")
		return
	}

	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Mute(r.Context(), name, identity, body.Track); err != nil {
		a.record(session, "mute track", name, identity, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "mute track", name, identity, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) record(session Session, action, roomName, target string, err error) {
	entry := Entry{
		Action: action, Trip: session.Trip, Name: session.Name,
		Room: roomName, Target: target,
	}

	if err != nil {
		entry.Failed = true
		entry.Reason = err.Error()
	}

	a.log.Record(entry)
}

// statusOf and reasonOf keep a room that has ended apart from a server that has
// stopped answering. One of those is somebody watching a page while a call
// finishes; the other is worth waking up for.
func statusOf(err error) int {
	if errors.Is(err, rtc.ErrNoSuchRoom) {
		return http.StatusNotFound
	}

	return http.StatusBadGateway
}

func reasonOf(err error) string {
	if errors.Is(err, rtc.ErrNoSuchRoom) {
		return "no_such_room"
	}

	return "media_server_unreachable"
}

func respond(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("failed to write a management response", "error", err)
	}
}

// FromHere reports whether a request that changes something came from these
// pages rather than from somebody else's.
//
// The session cookies are SameSite=Strict, which was meant to be the whole of
// the defence and is most of it. What it misses is that "site" is wider than
// "origin": a page on any sibling subdomain is the same site, its cookie goes
// along, and a form it posts as text/plain reaches an endpoint that reads its
// body without asking what kind it was. The deployment this runs on shares its
// registrable domain with a good many other services, so that is not a
// theoretical neighbour. Sec-Fetch-Site is set by the browser and cannot be
// written by the page, and it says same-origin only for a request from this
// exact origin.
//
// A request that does not carry it at all is let through, because only browsers
// send it and only browsers carry a cookie somebody else can borrow; the
// watchdog and the enrolment script send none. An older browser that predates
// the header still has the cookie's own attribute between it and a stranger's
// page.
//
// Reading is not asked, because a page on another origin cannot read what comes
// back, and refusing it would cost nothing an attacker needs.
func FromHere(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		return true
	}

	site := r.Header.Get("Sec-Fetch-Site")

	return site == "" || site == "same-origin"
}

func refuse(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
}

// secureRequest decides whether the session cookie may be marked Secure.
//
// A Secure cookie is dropped by the browser over plain HTTP, so marking one on
// a deployment reached without TLS would sign somebody out at the moment they
// signed in. Everything real is behind TLS; a plain-HTTP localhost is somebody
// working on this.
func secureRequest(r *http.Request, trustProxy bool) bool {
	if r.TLS != nil {
		return true
	}

	return trustProxy && r.Header.Get("X-Forwarded-Proto") == "https"
}

// SessionOf says whether a request carries a live management session.
//
// For the parts of the application outside these pages that have to know: the
// relay list is published to everybody and holds back the relays reserved for
// administrators, and an administrator reading it should see their own.
//
// A request that changes something and came from another origin carries no
// session here, whatever cookie it brought. The meeting endpoints honour this
// cookie for closing a room, removing somebody and moving a call, so checking
// only at the management API's own gate would have left every one of those open
// to a page on a sibling subdomain.
func (a *API) SessionOf(r *http.Request) (Session, bool) {
	if a == nil || a.sessions == nil || !FromHere(r) {
		return Session{}, false
	}

	return a.sessions.Of(r)
}

// Guessing is the budget every door that takes a passphrase spends from.
//
// Shared rather than one each, because they check the same secret. The
// management sign-in was held to ten a minute with a ceiling on the whole
// endpoint, and the room join — which also asks whether a passphrase belongs to
// an administrator, and says so in its answer — was held to ten a second with
// no ceiling at all. Sixty times the rate through a door nobody had counted as
// a door, and a dictionary that would take centuries at one of them takes an
// afternoon at the other.
func (a *API) Guessing() *guess.Attempts {
	if a == nil || a.sessions == nil {
		return nil
	}

	return a.sessions.limit
}

// visits answers what has happened in one room.
//
// Separate from participants, which asks the media server who is in a room and
// therefore answers nothing at all about a room nobody is in. Every question an
// operator has about a meeting that has ended — who was here, when, from what
// address, through which machine — is about rows this server wrote at the join
// and is unanswerable from anywhere else.
//
// Available for a name that has never been used, which answers with nothing.
// Refusing there would make the page ask twice: once to find out whether the
// name is known, and again for the history.
func (a *API) visits(_ Session, w http.ResponseWriter, r *http.Request) {
	if a.store == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))

	// A ceiling, because this is drawn on a page. A room somebody has held every
	// weekday for a month is a few hundred rows and a name somebody is hammering
	// is however many the rate limiter allowed.
	found, total := a.store.Visits(name, 500)

	// Who a mark belongs to, where this deployment knows.
	//
	// The typed name is what somebody called themselves and is the only thing on
	// the row anybody could have made up. The mark is not: an account's is held
	// and an administrator's is derived from their passphrase, so resolving one
	// against the two lists says who it actually was — and says it for rows
	// written before the typed name was recorded at all, which is every row this
	// deployment already had.
	named := map[string]string{}

	for _, admin := range a.Administrators() {
		if admin.Name != "" {
			named[admin.Trip] = admin.Name
		}
	}

	if a.ledger != nil {
		if accounts, err := a.ledger.Accounts(); err == nil {
			for _, account := range accounts {
				named[account.Trip] = account.Name
			}
		}
	}

	out := make([]map[string]any, 0, len(found))
	for _, one := range found {
		row := map[string]any{
			"identity": one.Identity,
			"at":       one.At.UTC(),
		}

		// The mark and what kind it is, which is the difference between somebody
		// this deployment has heard of and somebody who typed a passphrase of
		// their own — and between both of those and a guest, whose mark is drawn
		// from nothing and is a different string in every tab.
		if mark, ok := room.SignatureOf(one.Identity); ok {
			row["trip"] = mark.Trip

			switch {
			case mark.Account:
				row["kind"] = "account"
			case mark.Proven:
				row["kind"] = "passphrase"
			default:
				row["kind"] = "guest"
			}

			if who := named[mark.Trip]; who != "" {
				row["account"] = who
			}
		}

		// Only what there is. A row of blanks reads as a row of things that were
		// nought rather than as a row about a join recorded by an older version
		// that did not write them down.
		for key, value := range map[string]string{
			"name": one.Name, "address": one.Address,
			"relay": one.Relay, "holding": one.Holding,
		} {
			if value != "" {
				row[key] = value
			}
		}

		if one.Forwarded {
			row["forwarded"] = true
		}

		// What they came in with, for joins recorded since it was kept.
		if one.Client != nil {
			row["client"] = one.Client
		}

		out = append(out, row)
	}

	answer := map[string]any{"room": name, "visits": out}

	// Said only where it is true, so a page can draw the number without having
	// to decide whether it is worth mentioning.
	if total > len(out) {
		answer["total"] = total
	}

	respond(w, answer)
}

// forgetRoom removes a name from the list of names this server has seen.
//
// Its own path rather than the one that closes a room, because they are
// different things done for different reasons: closing ends a meeting and
// leaves the name, and this leaves any meeting alone and removes the name. A
// deployment that used one verb for both would have an operator ending a call
// while trying to tidy a list.
//
// What it is for is the placement. A name carries where an operator said it
// goes, and that now stands until somebody says otherwise — so a name used once
// for a test keeps a machine assigned to it until it ages out, and there was no
// way to be rid of it except waiting. Clearing the placement alone is the other
// control on this row; this is for a name that should not be in the list at all.
func (a *API) forgetRoom(session Session, w http.ResponseWriter, r *http.Request) {
	if a.store == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))

	// Not while somebody is in it.
	//
	// The record is what says the name has been used, and removing it turns the
	// room back into a name nobody has opened — so the next person to arrive at
	// a call that is still running is treated as opening it, and on a deployment
	// that lets anybody open a name, let in. Tidying a list must not open a door
	// into a meeting in progress.
	//
	// Said as a refusal with its own reason rather than done quietly, because
	// the operator can close the room first and then do this, and being told
	// that is more use than either half happening on its own.
	// And only where that could actually be established.
	//
	// The first version asked and carried on when the asking failed, which is
	// the wrong direction and was invisible: a media server that will not answer
	// turned the guard off rather than turning the button off, so an outage was
	// exactly when a name could be forgotten out from under a call in progress.
	// Caught by pressing it against a deployment whose relays do not implement
	// the question — the guard had never once run.
	//
	// A deployment with no media at all is a different thing and not a failure:
	// it holds no calls, so there is nothing to be in the way.
	if a.attached() {
		live, err := a.control.Rooms(r.Context())
		if err != nil {
			slog.Error("failed to check whether a room is in use before forgetting it",
				"room", name, "error", err)
			refuse(w, http.StatusBadGateway, "media_server_unreachable")
			return
		}

		for _, one := range live {
			if strings.EqualFold(one.GetName(), name) {
				refuse(w, http.StatusConflict, "room_in_use")
				return
			}
		}
	}

	found, err := a.store.ForgetRoom(name)
	if err != nil {
		a.record(session, "forget room", name, "", err)
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	if !found {
		refuse(w, http.StatusNotFound, "no_such_room")
		return
	}

	a.record(session, "forget room", name, "", nil)

	respond(w, map[string]any{"room": name, "forgotten": true})
}
