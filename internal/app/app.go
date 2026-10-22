// Package app is the HTTP surface: the client, the join endpoint, and the
// signalling paths forwarded to the embedded media server.
//
// All three share one origin, which is what makes the whole thing usable from
// another machine. Camera access and secure WebSockets both require a secure
// context, and one origin means one certificate to arrange rather than two, with
// no cross-origin rules to satisfy in between.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

// App holds what the handlers need.
type App struct {
	conf *config.Config
	// store is nil on a relay, which records nothing.
	store *store.Store
	limit *limit.Limiter
	// media is nil on a control node, which starts no media server of its own.
	// Every use is guarded; the signalling paths are simply not mounted.
	media   *rtc.Server
	web     http.Handler
	tripKey []byte
	admin   *admin.API
	// control is how a host's mute or removal reaches the media server holding
	// the room. The same one the management pages act through, because there is
	// one and two ways to reach it is how they come to disagree. Nil where this
	// deployment holds no media at all.
	control admin.Control
	// The same object as control, kept typed for the one thing that needs more
	// than the Control interface: handing every relay a renewed certificate.
	cluster *rtc.Cluster

	// fleet answers which node a relay is. The cluster, on a control node, and
	// nil on a deployment holding its own media — which has one node and never
	// asks.
	fleet wondering
	// relays is where a control node sends clients. Empty everywhere else.
	relays *relays
	// enrolment is set where a relay may bring itself up from a script.
	enrolment *admin.Enrolment
	// reach remembers which relays answered, so a client is not offered one
	// nobody can get to. Nil until a cluster is wired in, and nil is the
	// answer "everything is worth offering", which is right for a deployment
	// with no relays to be wrong about.
	reach *reach

	// apps is what the download page's endpoints keep: where the Mac builds
	// are, the App Store Connect client, and the invitation budgets. Nil on a
	// relay, which serves no pages.
	apps *appsDesk

	// relayed is what the watch relay remembers between requests: whether
	// each grantor's Emby grant stood when last asked, and what has been
	// carried under each. See watchledger.go.
	relayed watchLedger

	stop    chan struct{}
	closing sync.Once

	// clock is what the invitation paths read the time from, and nil is the
	// wall clock. A field so that a test can put a link's window around a fixed
	// instant rather than around whatever moment the test happens to run at —
	// a window computed from now and checked against a later now is a test that
	// passes or fails by how long the machine took.
	clock func() time.Time
}

// now is the time by this application's clock.
func (a *App) now() time.Time {
	if a.clock != nil {
		return a.clock().UTC()
	}

	return time.Now().UTC()
}

// New assembles the application.
//
// media may be nil, which is what a control node passes: it signs tokens for
// meetings held on relays elsewhere and has no media server to forward to.
func New(conf *config.Config, st *store.Store, media *rtc.Server, web http.Handler, tripKey []byte) *App {
	a := &App{
		conf:    conf,
		store:   st,
		limit:   limit.New(conf.Meet.JoinRate, conf.Meet.JoinBurst, conf.Meet.Hops()),
		media:   media,
		web:     web,
		tripKey: tripKey,
		admin:   admin.New(conf, media, st, tripKey),
		relays:  newRelays(conf, st),
		stop:    make(chan struct{}),
	}

	// A full deployment acts on its own media server. A control node has none
	// yet and is given the cluster later, by UseCluster.
	if media != nil {
		a.control = media.Manage(conf.Key, conf.Secret)
	}

	// The download page's endpoints, wherever pages are served. A relay keeps
	// no store and serves none, and is left without them rather than given a
	// desk it would never be asked at.
	if st != nil {
		a.apps = newAppsDesk(conf)
	}

	// Guarded on the store alone: a relay keeps none, and a sweeper with nothing
	// to sweep would dereference it on its first tick.
	//
	// It used to be guarded on the room retention as well, from when ageing out
	// names was the only thing this timer did. That quietly turned off the
	// sessions, the arrivals and the trend on any deployment configured to keep
	// its room names for ever — which is an offered setting, says nothing about
	// any of those three, and left the finest resolution of the trend writing
	// eight and a half thousand buckets a day with nothing ever taking one
	// away.
	if st != nil {
		go a.forgetting()

		// And copies of it, on the same condition and for a stronger reason:
		// this is the only place the relay definitions, the accounts and the
		// administrators exist, and a store truncated to nothing opens without
		// an error and reports no buckets.
		//
		go a.copying()
	}

	return a
}

// Close stops what the application started.
//
// Two things, both on tickers of their own. The management sampler fills a trend
// that would otherwise have gaps wherever nobody happened to be looking, and
// left running it would go on asking a media server that is shutting down for
// figures nobody will read. The sweeper below takes the store's one writer, and
// a shutdown that leaves it holding that is a shutdown that waits on it.
//
// Guarded, because a server can be shut down from more than one direction — a
// signal and a failed listener both arrive here — and closing a channel twice is
// a panic during the one moment nobody is watching the logs.
func (a *App) Close() {
	a.closing.Do(func() { close(a.stop) })
	a.admin.Close()
}

// How much of the store one sweep may clear before letting go.
//
// bbolt admits a single writer and a join is a write, so the number that matters
// is not how fast this finishes but how long it holds the door. A thousand keys
// is a few milliseconds; a bucket that has been allowed to grow is cleared over
// a series of them with joins in between, rather than in one transaction that
// every caller waits behind.
const sweepBatch = 1000

// How often the sweep runs.
//
// The thing it measures is a month old, so an hour is not a schedule chosen for
// timeliness — it is chosen so that a server which is restarted daily and one
// which runs for a year behave the same.
const sweepEvery = time.Hour

// forgetting ages out names nobody has joined for a while.
//
// Once at once, because a deployment restarted every night would otherwise never
// reach the first tick, and then on the hour.
func (a *App) forgetting() {
	ticker := time.NewTicker(sweepEvery)
	defer ticker.Stop()

	for {
		a.forget()
		a.sweep()

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}

// sweep clears the two records that are kept only while they are true.
//
// Neither gates anything — an expired session is already refused by whoever
// reads it, and an arrival past its window is already ignored — so this is
// housekeeping rather than enforcement, and a failure is logged and left. What
// it prevents is a file that grows by one entry per sign-in and one per join,
// forever, holding rows about calls that ended months ago.
//
// It ran nowhere until now. Both sweepers were written next to the records they
// clear and neither was ever called, which is the kind of omission that costs
// nothing on the day it is made and is invisible for as long as the deployment
// is young.
func (a *App) sweep() {
	now := time.Now().UTC()

	if gone, err := a.store.SweepSessions(now); err != nil {
		slog.Error("failed to sweep the sessions", "error", err)
	} else if gone > 0 {
		slog.Info("swept expired sessions", "gone", gone)
	}

	// The third one, missed the same way as the first two: written beside the
	// records it clears, and never called. Expired invites are refused when read,
	// so this is growth rather than a fault — one row per link ever minted,
	// forever.
	if gone, err := a.store.SweepInvites(now); err != nil {
		slog.Error("failed to sweep the invites", "error", err)
	} else if gone > 0 {
		slog.Info("swept expired invites", "gone", gone)
	}

	// On the same timer as the arrivals, because a knock is the shortest-lived
	// record here and one nobody swept would be a bucket that only grows.
	if gone, err := a.store.SweepKnocks(now); err != nil {
		slog.Error("failed to sweep knocks", "error", err)
	} else if gone > 0 {
		slog.Info("swept knocks nobody answered", "gone", gone)
	}

	if gone, err := a.store.SweepMeetings(now); err != nil {
		slog.Error("failed to sweep arranged meetings", "error", err)
	} else if gone > 0 {
		slog.Info("swept arranged meetings nobody can still be waiting for", "gone", gone)
	}

	if gone, err := a.store.SweepArrivals(now, a.conf.Meet.Rooms.Remember); err != nil {
		slog.Error("failed to sweep the arrivals", "error", err)
	} else if gone > 0 {
		slog.Info("swept old arrivals", "gone", gone)
	}

	if gone, err := a.store.SweepTrend(now); err != nil {
		slog.Error("failed to sweep the trend", "error", err)
	} else if gone > 0 {
		slog.Info("swept trend buckets past their resolution's retention", "gone", gone)
	}

	// The tickets the media server relay agreed to carry. Each is refused past
	// its expiry when read, so this is growth again: a row per film anybody
	// granted Emby ever chose, and one per playlist and segment of it.
	if gone, err := a.store.SweepWatchTickets(now); err != nil {
		slog.Error("failed to sweep the watch tickets", "error", err)
	} else if gone > 0 {
		slog.Info("swept expired watch tickets", "gone", gone)
	}
}

// forget clears one sweep's worth, and keeps going while there is more.
//
// A retention of zero keeps every name for ever, and is an offered setting. The
// guard is here rather than at the caller because the arithmetic below turns
// that setting into its exact opposite without saying a word: a cutoff of this
// instant is a cutoff every name ever joined falls before, so the sweep meant to
// respect "keep them for ever" would take all of them on its first pass. It was
// safe only for as long as the timer itself was switched off when the retention
// was zero, and the timer now has three other records to sweep.
func (a *App) forget() {
	if a.conf.Meet.Rooms.Remember <= 0 {
		return
	}

	since := time.Now().Add(-a.conf.Meet.Rooms.Remember)
	total := 0

	for {
		gone, err := a.store.Forget(since, sweepBatch)
		if err != nil {
			slog.Error("failed to forget rooms nobody has joined", "error", err)
			return
		}

		total += gone

		// A full batch means there is probably more. Anything short is the end
		// of it, and so is a shutdown that arrived mid-sweep: what is left will
		// still be there for whoever starts next.
		if gone < sweepBatch {
			break
		}

		select {
		case <-a.stop:
			return
		default:
		}
	}

	if total > 0 {
		slog.Info("forgot rooms nobody had joined for a while",
			"rooms", total, "unused for", a.conf.Meet.Rooms.Remember)
	}
}

// Handler builds the router.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	// Only where there is a media server to forward to. A control node has
	// none: these paths belong to the relays, whose addresses it hands out.
	if a.media != nil {
		for _, path := range rtc.Paths {
			mux.Handle(path, a.media.Handler())
		}
	}

	// A relay is the signalling paths above and nothing else.
	//
	// Returned here rather than by skipping each registration below, because
	// the point is not that the client and the join endpoint are unnecessary on
	// a relay — it is that they must not be there. A relay reachable at a name
	// somebody could type is one that would serve a join endpoint signing
	// tokens against a store it does not keep, and management pages for
	// administrators it was told nothing about.
	if a.conf.Meet.Role == config.RoleRelay {
		// Nothing but the upgrade, on a network that probes for websites.
		//
		// Registered before the endpoints below rather than instead of them, so
		// that turning this off restores them without the routes having moved.
		if a.conf.Meet.Silent {
			// Except this one, which is registered before the return rather
			// than after it.
			//
			// silence() already lets a request carrying credentials through —
			// that was written for exactly this, and its comment records the
			// first version having silenced the control node along with
			// everybody else, so the dashboard reported every relay
			// unreachable while calls ran on them perfectly. The route then
			// moved below this return, which recreated the same outage by a
			// different mechanism: the request passed the silence and found no
			// handler, fell through to the /twirp/ catch-all, and was offered
			// to a media server that does not serve it.
			mux.Handle("GET "+rtc.StatsPath,
				rtc.StatsHandler(a.media, a.conf.Key, a.conf.Secret, admin.Started))
			a.takesCertificates(mux)

			return silence(mux)
		}

		// No health endpoint, and this is deliberate rather than an omission.
		//
		// A relay has no use for one. Both things that ever measured it — the
		// control node's dashboard and the client choosing where to call —
		// time the signalling upgrade instead, which is the request a call
		// actually makes and therefore the honest thing to measure.
		//
		// What it did have was a use to somebody else. A relay in mainland China
		// is probed by something that sends an ordinary HTTPS request and reads
		// the answer; a port that replies is a website, and an unregistered one
		// is taken off the air. An endpoint answering 204 to anybody who asks is
		// that probe's evidence, served continuously and by us. There is nothing
		// to gain by keeping it and a deployment to lose.

		// This relay's own counters, for a control node's dashboard. Behind the
		// deployment's credentials: the figures say how many people are in calls
		// here and how much is flowing, which is exactly the shape of thing that
		// should not be readable by whoever finds the port.
		mux.Handle("GET "+rtc.StatsPath,
			rtc.StatsHandler(a.media, a.conf.Key, a.conf.Secret, admin.Started))
		a.takesCertificates(mux)

		return mux
	}

	// What the watch relay has carried for each person granted it, for the
	// accounts page. Handed over here rather than in New because this is where
	// both halves exist however the application was assembled.
	a.admin.UseSpent(&a.relayed)

	// Registered before the client's fallback, and only where somebody
	// configured an administrator. Absent that, these paths are not refused —
	// they do not exist, and answer like any other address nobody claimed.
	a.admin.Mount(mux)

	mux.HandleFunc("POST /api/rooms/{room}/join", a.join)
	mux.HandleFunc("GET /api/deployment", a.deployment)
	mux.HandleFunc("GET /api/music/{what}", a.music)
	mux.HandleFunc("GET /api/watch/{what}", a.watch)

	// The pages somebody uses to look after their own account, which are not
	// the management pages and never overlap with them.
	a.mountAccounts(mux)
	mux.HandleFunc("GET /api/relays", a.relayList)

	// The two a machine being brought up calls, and the only management paths
	// with no session behind them: the token in the script is what authenticates
	// them, and there is no administrator sitting at a machine minutes into its
	// life. Registered only where enrolment was configured.
	if a.enrolment != nil {
		a.admin.MountEnrolment(mux)
		mux.HandleFunc("GET /download/tomoshibi", a.binary)

		// The install script, without a session and without the secret in it,
		// so that bringing a relay up is one command copied onto a fresh
		// machine rather than a file carried onto it. What authorises the
		// enrolment is the secret the operator passes in the environment, which
		// this never sees.
		mux.HandleFunc("GET /install", a.admin.PublicInstall)
	}
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	// Registered without a method, because a route that matched fewer methods
	// than the wildcards above would be an ambiguity the router refuses to
	// resolve. Anything not claimed by a route above is the client.
	// Anything under /api that no route above claimed. Without this it reaches
	// the client's fallback and comes back as the document with a 200, which
	// tells a caller that a misspelled endpoint worked and hands a script an
	// HTML page where it expected JSON.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		fail(w, http.StatusNotFound, reasonNoSuchEndpoint)
	})

	// The management document, served only where somebody configured an
	// administrator. Not refused when they have not: it is not there, and the
	// address answers exactly like any other nobody claimed. A sign-in page on
	// a deployment with nobody to sign in would be a door fitted to a wall.
	mux.HandleFunc("GET /admin", a.manage)
	mux.HandleFunc("GET /admin/", a.manage)

	a.mountHost(mux)
	a.mountInvites(mux)
	a.mountKnocks(mux)
	a.mountMeetings(mux)

	mux.HandleFunc("GET /account", a.ownAccount)
	mux.HandleFunc("GET /account/", a.ownAccount)

	// The download page and what it asks, beside the account page because it
	// is the same document behind the same sign-in.
	a.mountApps(mux)

	// The statements that let the Android app and the Apple apps open this
	// deployment's links. Below the relay's return above on purpose: a relay's
	// address is in no link anybody opens, and answering here would make it a
	// website. See assetlinks.go and universal.go.
	a.mountAssetLinks(mux)
	a.mountAppleSiteAssociation(mux)

	mux.Handle("/", a.web)

	return mux
}

type joinRequest struct {
	// Relay is the name of the relay this client measured as fastest.
	//
	// A name from the list at /api/relays and never an address, so the worst a
	// forged one can do is pick a different relay of ours — and an unknown one
	// is ignored entirely. Empty from any client that did not measure, which is
	// every client under the other policies.
	Relay string `json:"relay"`

	// Identity a client was given previously, if it has one.
	Identity string `json:"identity"`
	// Name they would like to be called.
	Name string `json:"name"`
	// Passphrase turning that name into one nobody else can wear.
	//
	// Typed so that logging this struct cannot leak it, and read only from the
	// body: a query parameter would reach the access log, the browser history,
	// and any Referer sent onward.
	Passphrase room.Passphrase `json:"passphrase"`
}

type joinResponse struct {
	// URL is where to open the signalling WebSocket.
	URL string `json:"url"`
	// Token authorises this one room under this one identity.
	Token string `json:"token"`
	// Identity is what the bearer will be known as.
	Identity string `json:"identity"`
	// Room is the name that was actually authorised, after normalisation.
	Room string `json:"room"`
	// Holding is what to call the machine the meeting is actually on, where that
	// is not the machine this client dialled.
	//
	// Said by this server rather than worked out by the client. The client used
	// to compare the relay it was sent to against the region the media server
	// reports for the node holding the room, which only ever worked on a
	// deployment that had bothered to set a region on every relay — and none of
	// these had, so the two were never different, and a call being forwarded
	// looked exactly like one that was not. This server picked both machines and
	// is the only thing that knows.
	Holding string `json:"holding,omitempty"`

	// Forward is the relay to send media through, where that is not the machine
	// holding the room.
	//
	// Present only when the two come apart, which is the only time it means
	// anything: a client given this uses it as its sole candidate route, so
	// sending it when the call is already going to the right place would add a
	// hop and a delay to every meeting for nothing.
	Forward *rtc.Forwarding `json:"forward,omitempty"`

	// Relay is what to call the machine this call was sent to.
	//
	// Sent so a person in a call can be told where it is being held in the
	// words the picker used, rather than being shown an address and left to
	// work it out. Empty on a deployment that holds its own media, where the
	// question does not arise.
	Relay string `json:"relay,omitempty"`

	// Region is the deployment's own label for the relay this person's browser
	// chose — measured or picked — where they were given it. Not the one the
	// join ended on after sending them to the meeting's holder or through a
	// bridge, and not the one holding the meeting; empty wherever the choice
	// was not theirs. See where it is taken in join.
	//
	// What it says is where the person probably is, which is a thing a client
	// has no other honest way to learn and one thing turns on: a viewer who came
	// in through a relay in mainland China cannot reach YouTube, and is given
	// the relayed copy of a video at once rather than after the seconds it
	// takes YouTube's script to fail to arrive. Wrong in the other direction it
	// costs more: a viewer abroad told they are in the mainland has every video
	// sent through this deployment, for nothing. So it is said only where it is
	// known, and an empty one leaves the client trying YouTube first. The same
	// label /api/relays already gives everybody, sent here because the client
	// would otherwise have to find it in that list by a name that may be a
	// label.
	Region string `json:"region,omitempty"`
}

// What a client needs to know about the server it reached, before anybody has
// typed anything into it.
type deployment struct {
	// OpenedBy is who may use a name nobody has used before.
	OpenedBy room.Opening `json:"openedBy"`

	// JoinedBy is who may enter one that has been used.
	//
	// Sent because the join screen was saying the wrong thing without it. Under
	// the middle opening policy it read "anybody can join one that already
	// exists", which was true of every deployment until there was a setting
	// that made it false — and it went on saying so to people who were about to
	// be turned away.
	JoinedBy room.Joining `json:"joinedBy"`

	// Source is where the code running here can be read.
	//
	// Required rather than courteous. This is licensed under the AGPL, whose
	// thirteenth section says that offering people the use of a program over a
	// network obliges the operator to offer them its source — and the people
	// being offered the use of this one are on a web page, so the offer has to
	// be on the web page. It is configurable because a deployment running a
	// changed copy owes its visitors that copy and not this one.
	Source string `json:"source"`

	// Build is the commit this server was built from, empty where that is not
	// known.
	//
	// So a page can tell it is older than the server it came from. A client is
	// loaded once and kept for as long as the tab is open, and a fix to how a
	// call sounds reached nobody who had the page open already: somebody who
	// left and rejoined after a deployment rejoined on the code from before it,
	// which is how a sound fix was first reported as not working.
	Build string `json:"build,omitempty"`
}

// manage serves the management document.
func (a *App) manage(w http.ResponseWriter, r *http.Request) {
	if !a.admin.Configured() {
		http.NotFound(w, r)
		return
	}

	// Rewritten rather than redirected, so that the address stays where
	// somebody typed it and a reload lands in the same place.
	r = r.Clone(r.Context())
	r.URL.Path = "/admin.html"

	a.web.ServeHTTP(w, r)
}

// ownAccount serves the page somebody looks after their own account on, and
// the download page, which is the same document showing another part of it.
//
// Served whether or not they have one, and whether or not they are signed in:
// what is behind it is a sign-in form, and a page that 404s for anybody without
// a session would mean the only way to reach it was to already have reached it.
// Nothing here is disclosed by the document — the accounts are behind the API.
func (a *App) ownAccount(w http.ResponseWriter, r *http.Request) {
	// Except where there is nowhere to keep accounts. A relay holds no store, so
	// on one this address names nothing rather than serving a form that could
	// never sign anybody in.
	if a.store == nil {
		http.NotFound(w, r)
		return
	}

	// Rewritten rather than redirected, for the reason the management page is:
	// the address stays where somebody typed it and a reload lands in the same
	// place.
	r = r.Clone(r.Context())
	r.URL.Path = "/account.html"

	a.web.ServeHTTP(w, r)
}

// join authorises a client for a room.
//
// The client may send back the identity it was given before, so that reloading a
// tab keeps the same one. Without that, a refresh looks to everybody else like a
// second participant arriving while the first is still being cleaned up.
//
// It is also where a name nobody has used is either opened or refused, because
// this is the only moment anybody asks for one. There is no other endpoint to
// put that on: rooms are not created here, they are named, and this is where a
// name is first written down.
func (a *App) join(w http.ResponseWriter, r *http.Request) {
	// Charged first, so a refused caller costs a header lookup rather than a
	// signature.
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	name := strings.ToLower(r.PathValue("room"))
	if !room.ValidName(name) {
		fail(w, http.StatusBadRequest, reasonBadRoom)
		return
	}

	// A body that is absent or unreadable is still a request for a fresh
	// identity rather than a parse error the caller can do nothing about.
	var body joinRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// Whether this caller may use a name nobody has used before.
	//
	// Under the policy every deployment starts with, everybody may, and the
	// signature below is never derived — the ordering here is what keeps the
	// common case free. Under the other one, an administrator is recognised by
	// the signature their passphrase produces, which is the one the token is
	// about to carry anyway: the door needed no mechanism that was not already
	// standing here, only for somebody to look at what it had already worked out.
	// Asked once and used twice: whether this passphrase belongs to an
	// administrator decides both whether a room nobody has used may be opened
	// and whether a relay reserved for administrators may be asked for.
	// Whether this passphrase belongs to an administrator — and every guess at
	// that question charged to the same budget the management sign-in spends
	// from.
	//
	// This door asks the identical question and answers it in a way somebody can
	// read: a reserved relay refuses, a room nobody has used opens, and the host
	// endpoint says "admin". Held to ten a second with no ceiling, against a
	// sign-in held to ten a minute with one, it was the cheaper door by a factor
	// of sixty and it was not counted as a door at all. A dictionary that takes
	// centuries at one takes an afternoon at the other.
	//
	// Charged only where a passphrase was actually offered. An empty one belongs
	// to everybody who joins an open room, and counting those would rate-limit
	// the ordinary case to protect against a guess nobody made.
	isAdmin := false
	if !body.Passphrase.Empty() {
		attempt, allowed := a.admin.Guessing().Take(limit.Caller(r, a.conf.Meet.Hops()))
		if !allowed {
			fail(w, http.StatusTooManyRequests, reasonRateLimited)
			return
		}

		_, isAdmin = config.Administrator(a.administrators(), body.Passphrase, a.tripKey)

		if !isAdmin {
			attempt.Failed()
		}
		attempt.Settled()
	}

	// A relay somebody may not use is refused rather than quietly swapped.
	//
	// The alternative was falling back to whichever relay the policy would have
	// chosen, which leaves somebody looking at a call held somewhere they did
	// not pick with nothing anywhere saying why — and, worse, no way to tell
	// that from the picker having worked.
	//
	// Except into a meeting that is already there. Reserving a relay is about
	// who may start a call on it, not about keeping out the people they invited:
	// an administrator who opened a room on their own machine and sent the link
	// round meant for those people to arrive. So a room already held on that
	// relay lets anybody with the link in — to that room, on that relay, and
	// nowhere else.
	if invited, _ := a.store.HeldOn(name); !isAdmin && a.relays.reserved(body.Relay) && invited != body.Relay {
		fail(w, http.StatusForbidden, reasonRelayNotAllowed)
		return
	}

	// Refused at the door, which is the only moment anybody asks to come in.
	//
	// Before the room is opened and before a token is minted, because a refusal
	// after either would leave a name recorded or a credential issued for
	// somebody who is not getting in. An administrator is not checked against
	// this: locking oneself out of one's own deployment by blocking one's own
	// account is a mistake with no way back from the page that made it.
	if !isAdmin && !body.Passphrase.Empty() {
		trip := room.Trip(a.tripKey, strings.TrimSpace(string(body.Passphrase)))

		if account, ok := a.store.AccountBySignature(trip); ok && account.Blocked {
			fail(w, http.StatusForbidden, reasonBlocked)
			return
		}
	}

	// Three settings, and the middle one is the useful one. Anonymous visitors
	// have a signature drawn from nothing that changes on every tab, so under
	// BySigned they can join any room they are told about and cannot make one —
	// which is the difference between a meeting server and a thing strangers
	// find and use.
	// Whoever they are signed in as, from the cookie rather than from anything
	// they sent. This is what makes an account's picture theirs: it is worn by
	// somebody with a session and not by anybody who typed the right passphrase
	// into a join form, which would make the picture a second credential and a
	// weaker one.
	//
	// Read before the opening policy as well as before the token, because being
	// signed in is a way of having proved a name. Somebody who signed in at
	// their own page has no reason to type their passphrase again, and under the
	// middle setting that left them unable to start a room — signed in, known to
	// this server by name, and refused for having nothing in a field they had
	// already answered somewhere else.
	signature := ""
	if account, ok := a.signedIn(r); ok && !account.Blocked {
		signature = account.Trip
	}

	// What the token is minted from: the caller's own answers, except for a
	// guest of a room held under a scope, who carries neither.
	passphrase, account := body.Passphrase, signature

	// What they are called, and whether an invitation let them in. A guest of
	// a scoped room wears the name their link was made for, where it was made
	// for one, rather than whatever they typed.
	display, guest := body.Name, false

	// A name held under a scope has a door of its own, and none of the three
	// below applies to it: not the opening policy, not the joining policy, and
	// not a reservation, which a scoped name cannot have. See scope.go.
	_, scope := room.Split(name)
	scoped := scope != ""

	if scoped {
		invite, ok := a.admitScoped(w, r, name, scope, isAdmin, signature, body.Passphrase)
		if !ok {
			return
		}

		if invite != nil {
			passphrase, account, guest = "", "", true

			if invite.Name != "" {
				display = invite.Name
			}
		}
	}

	// Already decided for a scoped name, and nothing below can take it back:
	// every setting only adds to who may open one.
	//
	// Being signed in opens a room only for somebody who was not refused the
	// open permission. What it does not touch is a passphrase belonging to
	// nobody, which under the middle setting opens a room as it always did:
	// that is what the setting means, and an account refused the permission
	// can sign out and type one like anybody else. What it does refuse is that
	// account's own passphrase typed into the field, which would otherwise be
	// the permission undone by not signing in.
	//
	// Asked only where the policy asks it: each is a walk of the accounts.
	mayOpen := isAdmin || scoped
	signedOpens := func() bool { return signature != "" && a.holds(signature, store.PermOpen) }

	switch a.opening() {
	case room.ByAnyone:
		mayOpen = true
	case room.BySigned:
		mayOpen = mayOpen || signedOpens() || (!body.Passphrase.Empty() && a.typedOpens(body.Passphrase))

	// An account, and not a passphrase somebody set themselves.
	//
	// No fallback where a deployment has no accounts, unlike the joining
	// policy: an administrator can always open a room whatever this says, so
	// this is never a locked door with no key.
	case room.ByAccounts:
		mayOpen = mayOpen || signedOpens()
	}

	// Whether this name has been used before, asked before it is written down,
	// because the answer decides which of the two doors this person is at: a
	// name nobody has used is an opening and a name somebody has is a joining,
	// and the deployment may have different rules for each.
	//
	// A store that will not answer says "unused", and that is deliberate — but
	// it is safe only in company. It sends everybody to the opening door, and
	// the opening door is decided by OpenRoom, which lets a join through and
	// says so loudly when the store will not answer. So an outage admits people
	// rather than turning them away, which is this deployment's standing rule:
	// a store that cannot tell an unused name from one a meeting is happening in
	// must not end the meeting.
	//
	// Making this fail closed on its own would look like the careful change and
	// would turn a store outage into every call on the deployment dropping and
	// nobody able to rejoin. The two halves have to keep agreeing.
	//
	// Not asked of a scoped name, whose door has already been decided and does
	// not turn on whether anybody has said it before.
	known := !scoped && a.store.Used(name)

	// The second door, which did not exist. A room here is a name and nothing
	// else, so knowing the name was the whole of the check — which is a fine
	// model for names that are long and given out carefully, and a bad one for a
	// meeting called 223223. What made it hard to see is that the setting next
	// to it is called "signed", which sounds like signed in and means "typed
	// something into the passphrase box".
	// Redeemed once, here, and the answer carried to both places that need it.
	//
	// The door asks whether they were invited and the block near the end of this
	// handler asks again so it can leave the token in a cookie — and redeeming
	// counts, so asking twice counted twice. Nothing reads that count yet, which
	// is why this is a wrong number rather than a broken door; it is kept
	// precisely because it cannot be recovered later, so recording it wrong is
	// worse than not recording it.
	//
	// A scoped room's door has redeemed it already, and asking here would count
	// it twice.
	invited := guest || (known && a.invited(r, name))

	if known && !a.mayJoin(r, name, isAdmin, signature, body.Passphrase, invited) {
		fail(w, http.StatusForbidden, reasonNotInvited)
		return
	}

	// Before the token rather than after it, and waited for rather than sent
	// off, because this is no longer only an observation: whether the name has
	// ever been used is the answer, and it has to be settled before anybody is
	// authorised for it.
	// A name somebody else has arranged a meeting on is theirs until it begins.
	// Refused here, at the opening, rather than sorted out afterwards by
	// taking the room from whoever got there first — see the store's header
	// for what taking it cost. Administrators are not refused anything.
	if !known && !isAdmin && !scoped {
		claimant := signature
		if claimant == "" && !body.Passphrase.Empty() {
			claimant = room.Trip(a.tripKey, strings.TrimSpace(string(body.Passphrase)))
		}

		if a.reservedFor(name, claimant, time.Now().UTC()) {
			fail(w, http.StatusForbidden, reasonNotOpen)
			return
		}
	}

	switch _, err := a.store.OpenRoom(name, mayOpen); {
	case errors.Is(err, store.ErrNotOpen):
		fail(w, http.StatusForbidden, reasonNotOpen)
		return

	case err != nil:
		// Let through, loudly. A store that will not answer cannot tell a name
		// nobody has used from one a meeting is happening in, so refusing here
		// would turn people out of a room that was already open — the one case
		// this policy was never meant to touch. The lost tally is the rest of
		// the cost.
		slog.Error("failed to record a join", "room", name, "error", err)
	}

	grant, err := room.Authorise(a.conf.Key, a.conf.Secret, room.Request{
		Room:       name,
		Identity:   body.Identity,
		Display:    display,
		Passphrase: passphrase,
		Account:    account,
		TripKey:    a.tripKey,
		TTL:        a.conf.Meet.TokenTTL,
	})
	if err != nil {
		slog.Error("failed to authorise a join", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	// Picked once and used twice: the address to dial and the name to call it.
	// Asking twice would be two independent choices, and under round robin they
	// would not be the same one.
	//
	// A room already being held somewhere goes back there, whoever is asking and
	// whatever they measured. That is not a preference — a meeting lives on one
	// server, and sending the second person somewhere else means their
	// signalling is forwarded and their measurement was spent on a machine that
	// will not carry their call. It is also what lets somebody into a reserved
	// relay they were invited to.
	// Two relays, and for the first person in a room the same one.
	//
	// `entry` is the machine this client dials and `holding` is the machine the
	// meeting is on. They come apart because a meeting lives on exactly one
	// node: the media server binds a room to whoever opened it, and everybody
	// after that is forwarded there no matter what they picked.
	//
	// That used to be settled by moving the client — the picked relay was
	// discarded and they were sent to the holder — which made choosing a server
	// mean nothing for everybody but the first arrival, and left relays bought
	// for the routes into them carrying no calls at all. Now the choice is kept
	// and the media is forwarded through it instead.
	// An operator may have said where this person should come in, which beats
	// what their browser measured. Taken rather than read: it moves somebody
	// once, for the call they are being moved out of, and a pin that outlived
	// that would overrule every choice they made afterwards without appearing
	// anywhere they could see it.
	wanted := body.Relay
	if pinned := a.store.TakePin(name, body.Identity); pinned != "" {
		wanted = pinned
	}

	entry := a.relays.pick(name, wanted, r, a.conf.Meet.TrustProxy, isAdmin)
	holding := entry

	// Where this person probably is, taken now, before anything below sends
	// them through another machine — and only where it says something about
	// them: the relay their own browser named and was given. See
	// joinResponse.Region for what reads it and what a wrong answer costs.
	//
	// Read off the entry at the end of the join, it was wrong whenever the join
	// moved them: somebody abroad whose relay does not forward, joining a
	// meeting held in Shanghai, was sent to Shanghai and told CN-East, and every
	// YouTube video of theirs went through this deployment; somebody in
	// Shanghai bridged to Hong Kong was told Hong Kong and went back to waiting
	// on YouTube. Nor is the relay picked for somebody who named none, or named
	// one that is not ours, a statement about them: that one is a hash of the
	// room's name over the fleet, and most of this fleet is in the mainland. A
	// placement pinned by an operator is about the meeting, not the person. All
	// of those say nothing, and a client told nothing tries YouTube first.
	arrived := ""
	if body.Relay != "" && entry.Name == body.Relay {
		arrived = entry.Region
	}

	// Where the meeting already is, if there still is one.
	//
	// The note is checked against the media server rather than believed on its
	// own. It used to be believed for two hours, and that is what made a room
	// come back to the same machine after it had ended: somebody closed a call,
	// opened another under the same name a minute later, and was sent to the
	// relay the old one had been on — which reads as the server choice being
	// ignored, because it was.
	//
	// Asked of one relay rather than all of them: any node answers for the whole
	// cluster, and the first one that answers ends the question. Where none can
	// be reached the note is believed, which is the old behaviour and the safe
	// direction — keeping a live meeting together matters more than being right
	// about a dead one.
	held, placed := a.store.HeldOn(name)

	// A host walking into a meeting they arranged goes where they said it would
	// be held, and that is read as a deliberate placement so the branch below
	// treats it exactly as one made from the management pages. Over a guess,
	// not only over nothing: the record may hold the note the host's own
	// earlier visit left, and a note is not a choice. Written down as a
	// placement the moment the meeting begins. See arrangedPlacement.
	if !placed {
		if there, ok := a.arrangedPlacement(name, grant, time.Now().UTC()); ok {
			held, placed = there, true
		}
	}

	// An instruction is carried out; a guess is checked first.
	//
	// Moving a room ends the call that is being moved, so at the moment the note
	// is read there is never a meeting to confirm it — which meant every move
	// was undone by the first person to come back, and the note rewritten to
	// wherever the measurement pointed. The difference is not what was written
	// but who wrote it and why.
	if held != "" && held != entry.Name && placed {
		// Looked up among every relay this deployment has rather than among the
		// ones currently taking calls, and nothing about the machine's state is
		// allowed to change the answer.
		//
		// A placement is not this server choosing where to hold a meeting; it is
		// a record of somebody having chosen, and the only thing left to work
		// out is which machine they meant. Read through the ordinary lookup it
		// went through a filter for enabled relays and another for reachable
		// ones, so a placement onto a machine that had been taken out of service
		// — or that the control node was briefly unable to open a socket to —
		// fell through to the automatic choice with nothing said. That is the
		// server deciding, on a suspicion, against somebody who had already
		// decided.
		if there, ok := a.relays.everywhere(held); ok {
			holding = there

			// Said once per join rather than never. The room goes where it was
			// put — that is the rule — and an operator who took the machine out
			// of service and forgot a room was pinned to it should find that out
			// from a log rather than from a meeting.
			if !there.Enabled {
				slog.Warn("a room is placed on a relay that is not taking calls, and is going there anyway",
					"room", name, "relay", held)
			}

			a.pinTo(r.Context(), name, there)
		} else {
			// The chosen machine is not one this deployment has any more. Said
			// out loud rather than shrugged off, because the alternative is a
			// room quietly going somewhere nobody asked for while the page still
			// names the machine that was chosen — which is the whole class of
			// fault this placement exists to end.
			slog.Error("a room is placed on a relay this deployment does not have",
				"room", name, "relay", held)
		}
	} else if held != "" && held != entry.Name {
		if a.meeting(r, name) {
			if there, ok := a.relays.named(held); ok {
				holding = there
			}
		} else if err := a.store.ReleaseRoom(name); err != nil {
			// Cleared rather than left to age out, so the next join does not ask
			// the same question again for the next two hours.
			slog.Error("failed to release a room that has ended", "room", name, "error", err)
		}
	}

	// A machine that can carry this call, where the one they landed on cannot.
	//
	// Sent there outright rather than being left connected to one relay with
	// their media going through another: two names on a screen are already one
	// more than most people want to think about, and three — one of which
	// carries nothing — is a diagram. Where there is no such machine, nothing
	// changes and the call goes directly to the room, which is what happened
	// before any of this existed.
	if holding.Name != entry.Name && !pairable(entry, holding) {
		if bridge, ok := a.relays.bridging(holding, isAdmin); ok {
			entry = bridge
		}
	}

	// What the client is told to send its media through, where that is not
	// simply the machine holding the room.
	var forward *rtc.Forwarding

	if holding.Name != entry.Name {
		switch relayed, err := a.forwarding(entry, holding); {
		case err != nil:
			// Minted from nothing, which should not happen and must not become
			// a client gathering candidates against a TURN server it cannot
			// authenticate to — that is a call that never connects, where
			// sending them to the holder is a call that does.
			slog.Error("failed to mint forwarding credentials",
				"relay", entry.Name, "room", name, "error", err)

			entry = holding

		case relayed != nil:
			forward = relayed

		default:
			// This pair does not forward: the relay runs no TURN server, whoever
			// pays for it has said not to, or the two are on opposite sides of a
			// border and sending media the long way round would be worse than not
			// choosing at all. All three are real answers rather than
			// misconfigurations, and all three end the same way — the call goes
			// straight to the machine holding the room, which is what everybody
			// got before forwarding existed.
			entry = holding
		}
	}

	// The machine the meeting is on, not the one this client dialled. Noting the
	// entry would move the room to whichever door the next person came through,
	// which is the opposite of what this record is for.
	//
	// Written after everything that could refuse this join has not: a room
	// recorded as being somewhere nobody was actually sent would send the next
	// person there for no reason.
	if holding.Name != "" {
		if err := a.store.HoldRoom(name, holding.Name); err != nil {
			slog.Error("failed to note where a room is held", "room", name, "error", err)
		}
	}

	// An invite, where one was sent. Redeemed after the identity exists, because
	// it is spent on a person rather than on a page load: the same identity
	// coming back through the same link is a reload, and turning it away would
	// be the single-use limit working exactly as specified and failing at what
	// it is for.
	//
	// It does not open a name nobody has used. An invitation is to a meeting
	// that exists, and one that could open a room would be a way around the
	// setting deciding who may.
	if invited {
		keepInvite(w, r, r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https")
	}

	// Whoever first spoke the name answers for the room. Nothing happens on any
	// join but the first — a later arrival becoming host by walking in is the
	// fault this guards against, and it would be invisible until somebody used
	// it.
	//
	// Except under a scope, where nobody does: every member runs the room, and
	// a host recorded here would be one who might later leave the scope and keep
	// the room answering to them. See scope.go.
	if !scoped {
		a.hostOnOpening(name, grant)
	}
	a.beginArranged(name, grant)

	// Written down because nothing else will know it.
	//
	// The media server holds the room and sees a signalling socket from a relay;
	// it cannot say where somebody actually came from or which machine they came
	// in through. This server saw both, here, once. Neither is recoverable
	// afterwards, and both are the first thing anybody asks when a call is going
	// badly for one person and nobody else.
	if err := a.store.Arrived(name, grant.Identity, store.Arrival{
		Address: limit.Caller(r, a.conf.Meet.Hops()),
		Relay:   entry.Shown(),
		Holding: elsewhere(entry, holding),
		// What they called themselves. The media server has this for a call in
		// progress and there is no media server to ask about one that ended, so
		// a history without it is a page of addresses and hex.
		Name:      display,
		Forwarded: forward != nil,
		// And what they came in with, which is the next thing asked: a
		// browser or one of the apps, and which (device.go).
		Client: clientOf(r.UserAgent()),
		At:     time.Now().UTC(),
	}); err != nil {
		// Not a reason to refuse the join. The note is for whoever is watching,
		// and turning somebody away from a meeting because a management page
		// would be missing a line is the wrong trade by a wide margin.
		slog.Error("failed to note an arrival", "room", name, "error", err)
	}

	// Noted, where the signature belongs to an account. Nothing is recorded
	// about anybody else: an anonymous visitor's signature is drawn from
	// nothing and differs in every tab, so a list of them would be a list of
	// tabs.
	if mark, ok := room.SignatureOf(grant.Identity); ok && mark.Proven {
		a.store.AccountSeen(mark.Trip, time.Now().UTC())
	}

	respond(w, joinResponse{
		URL:      a.signallingURLFor(a.signalsFor(r.Context(), name, entry, holding), r),
		Token:    grant.Token,
		Identity: grant.Identity,
		Room:     name,
		Relay:    entry.Shown(),
		Region:   arrived,
		Holding:  elsewhere(entry, holding),
		Forward:  forward,
	})
}

// relayEntry is one relay as a client is told about it.
type relayEntry struct {
	// Name is what the client sends back after measuring. The relay is
	// identified by this and never by its address, so that a client's answer
	// can only ever select one of ours.
	Name string `json:"name"`

	// URL is the WebSocket origin, sent only where it is needed.
	//
	// A relay that answers STUN does not need it here: the picker measures over
	// UDP to Probe, and the address a call is held at arrives in the join for
	// the one relay chosen. So it is withheld from anybody without a management
	// session — a visitor's network log then holds the machine they were sent
	// to rather than the whole fleet.
	//
	// A relay with no probe does need it, because opening this is the only way
	// left to time it, and a relay reported as having timed out when nothing was
	// tried is worse than a visible address. Sending it for those is the honest
	// trade: one address instead of six.
	//
	// None of this is a secret kept. Anybody who joins learns one address and
	// anybody watching their own traffic learns it regardless; what this stops
	// is the whole fleet being readable by anybody who opens the page. What
	// keeps a relay for administrators is the refusal at the join.
	URL string `json:"url,omitempty"`

	// Region is the deployment's own label, shown to somebody who wants to know
	// where their call is being held. Never used to choose under this policy —
	// that is what the measurement is for.
	Region string `json:"region,omitempty"`

	// Label is what a person is shown instead of the name.
	//
	// Sent because this list is now offered to somebody choosing, not only to a
	// script measuring. "sh" is a fine key and a poor thing to put in front of
	// a person deciding where to hold a meeting.
	Label string `json:"label,omitempty"`

	// Lat and Lon put it on the globe. Absent where nobody has said where the
	// machine is, and a relay without them is left off rather than guessed at.
	Lat float64 `json:"lat,omitempty"`
	Lon float64 `json:"lon,omitempty"`

	// Probe is where this relay answers STUN binding requests, as host:port. A
	// client with one times a single round trip over UDP; a client without one
	// times the signalling socket, which is three over TLS.
	Probe string `json:"probe,omitempty"`

	// Maintenance marks a relay that is here but not taking calls.
	//
	// Sent rather than the relay being left out, so a picker can show it greyed
	// instead of hiding it: one that vanishes looks deleted, and somebody who
	// used it yesterday has no way to tell those apart.
	Maintenance bool `json:"maintenance,omitempty"`

	// Fallback marks a relay the deployment keeps in reserve. Sent so that a
	// picker can say so rather than presenting it as an equal choice — a person
	// who picks it should know they are asking for the long way round.
	Fallback bool `json:"fallback,omitempty"`

	// AdminOnly marks one that only an administrator may use. It is only ever
	// sent to an administrator — anybody else does not receive the relay at all
	// — so this is a label rather than a gate: whoever sees it should know that
	// what they are looking at is not on everybody else's list.
	AdminOnly bool `json:"adminOnly,omitempty"`
}

// relayList is what a client measures before it joins.
//
// Answered under every policy rather than only under probe, because the list is
// also the honest answer to where a meeting might be held, and a client that
// wants to show somebody that is not doing anything it needs permission for.
// Under the other policies a client's measurement is simply not consulted.
//
// Empty on a full deployment, which holds its own media and has nothing to
// choose between. A client seeing an empty list measures nothing and joins as
// it always did.
func (a *App) relayList(w http.ResponseWriter, r *http.Request) {
	// Whether the person reading this is signed into the management pages,
	// which decides how much of each relay they are told rather than which
	// relays they are told about. Everybody is shown every machine (see
	// offered); only an administrator is shown where it is.
	admin := false
	if a.admin != nil {
		_, admin = a.admin.SessionOf(r)
	}

	list := a.relays.offered()

	entries := make([]relayEntry, 0, len(list))
	for _, relay := range list {
		entry := relayEntry{
			Name: relay.Name, Region: relay.Region,
			Label: relay.Shown(), Probe: relay.Probe,
			Lat: relay.Lat, Lon: relay.Lon,
			Fallback: relay.Fallback, AdminOnly: relay.AdminOnly,
			Maintenance: !relay.Enabled,
		}

		// Where it is needed, which is an administrator or a relay that cannot
		// be measured any other way — and never a reserved one to anybody else.
		//
		// That last clause was missing. A reserved machine with no probe handed
		// its address to any stranger who asked for the list: not access, since
		// the join refuses the relay by name, but the address of an internal
		// machine given away by a page that does not know who is reading it.
		if admin || (relay.Probe == "" && !relay.AdminOnly) {
			entry.URL = relay.URL
		}

		entries = append(entries, entry)
	}

	respond(w, relayListResponse{
		Relays: entries,
		Fleet:  fleetCount{Online: a.relays.answering(), Total: len(a.relays.all())},
		// Said rather than inferred, so a client does not have to guess from an
		// empty list whether measuring would be listened to. Under anything but
		// probe it would not be, and measuring would be a delay before every
		// join that changed nothing.
		Measure: a.conf.Meet.RelayPolicy == config.PickProbe && len(entries) > 1,
	})
}

type relayListResponse struct {
	Relays []relayEntry `json:"relays"`
	// Measure says whether this deployment will act on a measurement.
	Measure bool `json:"measure"`
	// Fleet is how many relays there are and how many are answering.
	//
	// Both numbers, because either alone says nothing: three answering is
	// excellent out of three and alarming out of eleven. Counted from the same
	// two lists the choosing uses, so a page cannot disagree with what a join
	// would actually do.
	Fleet fleetCount `json:"fleet"`
}

type fleetCount struct {
	Online int `json:"online"`
	Total  int `json:"total"`
}

// binary serves the build this control node is running to a relay installing
// itself.
//
// The same file rather than a download from anywhere else, so a fleet cannot
// drift apart by version: every relay runs what the control node runs, because
// that is literally the file it was given.
//
// Open, like the client is. It is a build of a published program and carries no
// secret; what a relay needs and must not be given away travels through the
// enrolment endpoint, which is behind the secret.
func (a *App) binary(w http.ResponseWriter, r *http.Request) {
	path := a.conf.Meet.Enrol.Binary
	if path == "" {
		if resolved, err := os.Executable(); err == nil {
			path = resolved
		}
	}

	if path == "" {
		fail(w, http.StatusServiceUnavailable, "no_binary")
		return
	}

	file, err := os.Open(path)
	if err != nil {
		slog.Error("failed to open the binary for a relay", "path", path, "error", err)
		fail(w, http.StatusServiceUnavailable, "no_binary")
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "no_binary")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="tomoshibi"`)

	// ServeContent rather than io.Copy: it handles ranges and conditional
	// requests, which matter for a fifty-megabyte file fetched over a link that
	// may drop halfway.
	http.ServeContent(w, r, "tomoshibi", info.ModTime(), file)
}

// deployment is what a client needs to know before somebody types a room name.
//
// Open to anybody, and deliberately silent about the caller. Whether this
// particular person may open a room turns on a passphrase they have not typed
// yet, and an endpoint that would answer that is a way of testing a guessed
// administrator's passphrase — a faster one than the sign-in page, which is
// rate limited for precisely that reason.
func (a *App) deployment(w http.ResponseWriter, _ *http.Request) {
	respond(w, deployment{OpenedBy: a.opening(), JoinedBy: a.joining(), Source: a.conf.Meet.SourceURL, Build: buildID})
}

// opening is who may use a name nobody has used, as this deployment can
// actually enforce it.
func (a *App) opening() room.Opening {
	return a.store.Opening().InEffect(len(a.administrators()))
}

// administrators is the live list, or the configured one where there is no
// management surface to keep it.
//
// Both callers ask the same question — may this passphrase open a room, and is
// there anybody an administrator-only setting could ever be satisfied by — and
// both have to see somebody added on a page without a restart. The fallback is
// not a nicety: a deployment built without management pages still reads its
// configuration file, and answering none there would quietly open every room.
func (a *App) administrators() []config.Admin {
	if a.admin == nil {
		return a.conf.Meet.Admins
	}

	return a.admin.Administrators()
}

// signallingURL is where this client should open its WebSocket.
//
// Derived from the request rather than from the bound address, because the bound
// address is frequently a wildcard and always the server's own view. A caller
// reached us somehow, and that host is by definition one that works for them.
func (a *App) signallingURL(r *http.Request) string {
	return a.signallingURLFor(store.Relay{}, r)
}

// signallingURLFor is where a client joining this room should open its
// WebSocket.
//
// The room matters because of what the relay policies do with it: gathering a
// meeting onto one relay is the difference between media crossing between
// machines and staying on one, and that is only possible if the answer depends
// on which meeting is being joined rather than on who is joining it.
//
// Order is deliberate. A configured relay list is a deployment saying where
// media lives, and it outranks public_url — which on a control node describes
// where the *client* is served and would send everybody to a machine running no
// media server at all.
func (a *App) signallingURLFor(chosen store.Relay, r *http.Request) string {
	if chosen.URL != "" {
		return chosen.URL
	}

	if a.conf.Meet.PublicURL != "" {
		return a.conf.Meet.PublicURL
	}

	scheme := "ws"
	if r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https" {
		scheme = "wss"
	}

	host := r.Host
	if a.conf.Meet.TrustProxy {
		if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" {
			host = forwarded
		}
	}

	return scheme + "://" + host
}

// signalsFor is the relay a client opens its signalling to: the one it was
// sent to, or for a relay that carries media only (store.Relay SignalVia) one
// that signals for itself (relays.signalling).
//
// A new room is put on the media relay first, where that is where it is to be
// held: the cluster creates a room on the node that receives its first
// signalling, and that would be the other relay, taking the media with it to
// the wrong side of the border. Where no relay can carry the signalling the
// client signals to its own relay as before, which is a call that may be
// intercepted rather than one that certainly fails.
func (a *App) signalsFor(ctx context.Context, room string, entry, holding store.Relay) store.Relay {
	if entry.SignalVia == "" {
		return entry
	}

	via, ok := a.relays.signalling(entry.SignalVia)
	if !ok {
		slog.Warn("a relay signals through another and none can carry it, so its clients signal to it directly",
			"relay", entry.Name, "via", entry.SignalVia)
		return entry
	}

	if via.Name != entry.SignalVia {
		slog.Warn("a relay signals through one that is not answering, so its clients signal through another",
			"relay", entry.Name, "via", entry.SignalVia, "instead", via.Name)
	}

	if holding.Name == entry.Name {
		a.pinTo(ctx, room, entry)
	}

	return via
}

// forwardedProto reads the scheme a proxy terminated, when there is one to
// believe.
func forwardedProto(r *http.Request, trust bool) string {
	if !trust {
		return ""
	}
	return r.Header.Get("X-Forwarded-Proto")
}

func respond(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("failed to write a response", "error", err)
	}
}

// Reasons a request is refused.
//
// Codes rather than sentences, because a sentence has a language and this
// server has no business knowing which one the reader wants. Content
// negotiation would let it guess, but then the same message exists twice —
// once here in Go and once in the client's dictionaries — in two formats and
// two build systems, and the two drift apart with nothing to notice.
//
// So the client owns every word it shows, and this owns only what happened.
const (
	reasonRateLimited    = "rate_limited"
	reasonBadRoom        = "invalid_room"
	reasonNotOpen        = "room_not_open"
	reasonNotInvited     = "not_invited"
	reasonServerError    = "server_error"
	reasonNoSuchEndpoint = "no_such_endpoint"
	// reasonBlocked is somebody an administrator has refused. A code like every
	// other, so the page says it in the reader's own language — and a plain one,
	// because a refusal dressed up as a server fault sends somebody to look for
	// a problem that is not there.
	reasonBlocked = "blocked"
	// The refusals an account holder can meet on their own page.
	reasonNotYours = "not_yours"
	// A person named in a request who is not somebody this can act on: not in
	// the room, not a valid identity, or the caller themselves.
	reasonNoSuchPerson = "no_such_person"
	// reasonNotProven is a room handed to somebody whose identity was drawn
	// from nothing, who is there and cannot hold it. Apart from the code
	// above, which the client says as "they have already left": said to a host
	// looking at the guest in question, still in the call, that was a sentence
	// about somebody else, and it sent them looking for a fault in the roster
	// rather than for a passphrase.
	reasonNotProven = "not_proven"
	// A relay named in a request that this deployment does not have.
	reasonNoSuchRelay = "no_such_relay"
	// The media server did not answer, so nothing was done. Distinct from a
	// refusal: nothing about the request was wrong.
	reasonMediaUnreachable = "media_unreachable"
	// An invite that is not here, has run out, or has already let somebody in.
	// Three codes rather than one, because they are three different sentences to
	// the person holding the link and only one of them means "ask for another".
	reasonNoSuchInvite  = "no_such_invite"
	reasonInviteExpired = "invite_expired"
	// reasonInviteNotYet is a link used before the time it was made for, which
	// is a fourth sentence: the link is right, and the moment is not.
	reasonInviteNotYet = "invite_not_yet"
	// reasonNameLong is a name for somebody else, longer than a name may be.
	reasonNameLong = "name_too_long"
	// The meeting a link was to has ended, which is not the same as the link
	// having expired: it is a link to nothing rather than a link that ran out,
	// and that is the difference between "ask for another" and "you missed it".
	reasonPassphraseShort = "passphrase_too_short"
	reasonPassphraseSame  = "passphrase_unchanged"
	reasonPassphraseTaken = "passphrase_in_use"
	reasonAvatarLarge     = "avatar_too_large"
	reasonNotAnImage      = "not_an_image"
	// reasonRelayNotAllowed is a relay kept for administrators, asked for by
	// somebody who is not one.
	reasonRelayNotAllowed = "relay_not_allowed"
)

func fail(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
}

// takesCertificates lets the control node hand this relay a renewed certificate.
//
// Only where one is served from a file this process owns. A relay behind a
// proxy that terminates TLS has no certificate to replace, and writing one
// would put a file on disk that nothing reads and that expires unwatched.
func (a *App) takesCertificates(mux *http.ServeMux) {
	if a.conf.Meet.TLSCert == "" || a.conf.Meet.TLSKey == "" {
		return
	}

	mux.Handle("PUT "+rtc.CertificatePath, rtc.CertificateHandler(
		a.conf.Meet.TLSCert, a.conf.Meet.TLSKey, a.conf.Key, a.conf.Secret))
}

// Watching starts the management side's sampling.
//
// Passed through rather than done during construction: the sampler reads the
// cluster and the enrolment, and those are attached afterwards. See
// admin.Watching.
func (a *App) Watching() {
	if a.admin != nil {
		a.admin.Watching()
	}
}

// pinTo puts a placed room on the machine it was placed on, before anybody is
// authorised to join it.
//
// Without this a placement decided almost nothing. Signalling goes to the relay
// the client dialled, and where the room does not yet exist that relay's node
// creates it — wherever the cluster's own selector says, which is the automatic
// choice the placement exists to replace. What the placement did on its own was
// arrange forwarding towards a machine the meeting was not on and put that
// machine's name on the page, so the record and the screen agreed with each
// other and disagreed with the meeting. That is the fault that had somebody
// reading Nanjing off a panel while the call was in Hong Kong.
//
// Idempotent, and cheap after the first time: creating a room that is already
// assigned to a node keeps the assignment and returns success. Which is also
// why this does not move a meeting already in progress — a room that exists
// stays where it is, and ending it so everybody comes back is a separate action
// somebody has to ask for.
//
// The node is asked for rather than remembered. A media server's identifier is
// minted when its process starts, so a cached one is wrong from the next restart
// until it is noticed, and pinning a room to a node that no longer exists is a
// room nobody can join at all — a worse failure than the one being fixed, and a
// silent one.
// wondering is the one question the join path has for the fleet: which node a
// relay is, right now.
//
// Named rather than taking the cluster whole, for the reason the management API
// names twelve of these — a gate that can only be exercised with a real cluster
// behind it is a gate nothing tests, and this one decides where every meeting on
// a placed room is held.
type wondering interface {
	AskStats(ctx context.Context, relay string) (rtc.Stats, error)
}

func (a *App) pinTo(ctx context.Context, room string, there store.Relay) {
	if a.fleet == nil || a.control == nil || there.URL == "" {
		return
	}

	// Bounded, because this is on the path of somebody waiting to be let into a
	// call. A relay that has stopped answering must cost them a moment, not the
	// join: the placement is still written, the forwarding is still arranged,
	// and the room goes where the cluster puts it — which is exactly where it
	// went before any of this existed.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	stats, err := a.fleet.AskStats(ctx, there.URL)
	if err != nil || stats.Node == "" {
		slog.Warn("could not ask a relay which node it is, so a placed room goes wherever the cluster puts it",
			"room", room, "relay", there.Name, "error", err)
		return
	}

	if err := a.control.Hold(ctx, room, stats.Node); err != nil {
		slog.Warn("could not put a placed room on the machine it was placed on",
			"room", room, "relay", there.Name, "node", stats.Node, "error", err)
	}
}

// mayJoin decides whether somebody may enter a room that already exists.
//
// Only called for a name that has been used. A name nobody has used is an
// opening and is decided by `rooms.opened_by`, which is a different question:
// a deployment may well want anybody with an account to hold a meeting and
// still not want a stranger who guessed the name to be in it.
//
// The host is admitted because they must be. They come back to their own
// meeting with the passphrase they opened it with and no invite — nobody sent
// them one — and a rule that shut the host out of the room they are running
// would be worse than the one it replaces.
func (a *App) mayJoin(
	r *http.Request, name string, isAdmin bool, signature string, said room.Passphrase, invited bool,
) bool {
	switch a.joining() {
	case room.ByWhoeverKnows:
		return true

	case room.ByAccount:
		// An account and nothing else. An invite is a thing the room gave out
		// and this is a deployment that has said it does not accept those.
		return isAdmin || signature != ""
	}

	// ByInvitation: anything the deployment or the room itself handed over.
	if isAdmin || signature != "" {
		return true
	}

	if invited {
		return true
	}

	// The host, by the mark their passphrase makes. Compared against what was
	// written down when the room was opened, so it is the person who opened it
	// rather than anybody who has since typed a passphrase.
	if !said.Empty() {
		if host := a.store.HostOf(name); host != "" && host == room.Trip(a.tripKey, string(said)) {
			return true
		}
	}

	return false
}

// joining is the join policy, resolved against whether anybody could satisfy it.
func (a *App) joining() room.Joining {
	return a.store.Joining(a.conf.Meet.Rooms.JoinedBy).InEffect(a.store.AccountCount())
}
