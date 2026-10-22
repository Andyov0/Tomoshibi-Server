package app

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/store"
)

/*
The films this deployment agreed to relay, and what they have cost.

A ticket is the gateway's name for one resolved video, and says nothing about
who asked for it — the gateway mints one for a YouTube manifest, a Bilibili
file, a pasted address and a media server's film alike, and in the call they
are all the same kind of string. Under a deployment that relays nothing, the
media path has to tell the one it may carry from all the others, and it cannot
ask the gateway: the gateway relays whatever it is handed a ticket for, which is
exactly why this server is the gate.

So the server keeps its own list. resolve, having read the answer and found a
film somebody granted Emby chose, writes the film's ticket and its poster's into
the store under that person's signature, for twelve hours — long enough for a
film started late in an evening to finish, and short enough that a ticket
copied out of a call is not a standing key to the deployment's bandwidth. The
media path relays what that list holds and answers 404 for anything else,
without asking the gateway.

A film is not one ticket but hundreds: a playlist names its variants and their
segments, each under a child name the gateway made ("c" and thirty-two hex
digits, never anything else). Those are added to the list as the playlists that
name them are relayed, under the film's own grant, and only names of that shape
are taken from a playlist, so a playlist could not smuggle a YouTube ticket into
the list by naming it. Kept in the store rather than in memory for the reason
the film's own ticket is: a viewer's player fetches its playlists once, at the
start, and a list lost on a restart would have every segment after it refused
to everybody mid-film.

Every request then asks again whether the grant still stands — the grantor
still holding Emby, not blocked, and the switch still on where it matters —
because taking somebody's grant away is meant to stop what they started, not
only what they would start next. Asked of the store that would be a scan of
every account for every segment of every film being watched, so the answer is
kept for thirty seconds: the time it takes a revocation to bite, and a bound
somebody can be told.

Each byte relayed under a grant is counted against its grantor, in memory, for
the management pages: an Emby grant is somebody spending the deployment's
bandwidth, and the person deciding whether to keep granting it should be able
to see how much. In memory, and from the start of this process, which the page
says; a figure kept across restarts would need a bucket of its own and an answer
to when it resets, and neither was worth having for a figure whose use is "who
is spending it now".

YouTube is the second thing such a deployment may relay, behind a switch of its
own (watch.youtube_relay) and nothing else: no grant, because nobody chooses to
need it. A viewer in mainland China cannot reach YouTube and every other viewer
can, so it is relayed for whoever's player falls back to it, whoever resolved
the link. Its ticket is ledgered when it is resolved, marked as YouTube's, and
relayed while the switch is on; a film's grantor is never asked about it, and
it never makes a film's grantor look as if their grant stands.

A YouTube video is not one ticket either, but its pieces are not named the way a
film's are. The gateway signs every address in a YouTube playlist rather than
filing it (sign() in the gateway), and a signed name says nothing this server
can trace to a ticket, so with the switch on every name of that shape is passed
to the gateway, and the gateway is the one that refuses a signed name that is
not YouTube's. That is the one place this server is not the only gate, and it is
bounded by what the gateway signs at all: under a deployment that relays
nothing, the only playlists it relays — and so the only addresses it signs —
are a film's, which are filed rather than signed, and a YouTube video's.

What YouTube costs is counted apart from the films. Its ticket's bytes are
counted against whoever resolved it, and its pieces, which cannot be traced to
anybody, in one figure for the whole deployment; the page shows the two added
together beside the switch.

Bilibili's bangumi, the series and films it licenses, are the third
(watch.bangumi_relay, which starts on: the owner's choice of 2026-10-14 was
every episode relayed, for everybody). Like YouTube they answer to the switch
and to no grant, and are ledgered under whoever resolved them. Unlike YouTube,
every piece of an episode can be traced to its ticket: the gateway names each
playlist and file the episode's playlists hand out after the ticket itself,
"<ticket>.p1", "<ticket>.f1" (partName), rather than signing an address. So a
piece is relayed only where the ledger holds its ticket as a bangumi episode's
and that ticket stands, it is counted against the same person as the ticket,
and this server stays the only gate it needs — the gateway's own refusal of
anything that is not an episode (RELAY_BANGUMI) is a second one, as for
everything else, rather than the one that holds.
*/

// ticketLife is how long a film's ticket is relayed after it was chosen.
const ticketLife = 12 * time.Hour

// grantKept is how long the answer to "does this grant still stand" is reused.
const grantKept = 30 * time.Second

// playlistLimit is the most of one playlist read for the names in it.
//
// A three-hour film cut into two-second segments is a few hundred kilobytes of
// playlist. A playlist is read whole before it is passed on, so that its names
// are in the ledger before the player can ask for any of them — streamed, the
// player could have the playlist and ask for its first segment while this was
// still writing it down — and this is the bound on what that holds.
const playlistLimit = 8 << 20

// childName is the only shape a name in a relayed playlist may have to be
// relayed under the playlist's grant: what the gateway makes of a media
// server's addresses. YouTube's relayed names are signed, and a bangumi
// episode's are parts of its ticket, and both carry a dot; a ticket is a
// different length. None of them is ever taken from a playlist.
var childName = regexp.MustCompile(`^c[0-9a-f]{32}$`)

// partName is a piece of a bangumi episode: the ticket it was filed under, a
// dot, and which of its playlists or files it is. A ticket has no dot, a film's
// child none either, and a signed name's second half is its twenty-four
// characters of MAC, where a part's is a few lowercase letters and digits, so
// no name is ever two of these.
var partName = regexp.MustCompile(`^([\w-]{16,64})\.([a-z0-9]{1,8})$`)

// playlistName is a relayed address in a playlist: relative to the playlist,
// which is itself at /api/watch/media, as the gateway writes them.
var playlistName = regexp.MustCompile(`media\?t=([\w-]+)`)

// errGrantWithdrawn stops a relayed answer partway, where its grant was taken
// away while it was being sent.
var errGrantWithdrawn = errors.New("the grant this film was relayed under was withdrawn")

// errPlaylistTooLong is a playlist larger than this server will read for names.
var errPlaylistTooLong = errors.New("a relayed playlist was longer than this server reads")

// watchLedger is what the relay remembers between requests: the recent answers
// about each grantor, and what has been carried for each.
//
// Its zero value is ready, because the application is assembled as a literal
// in more places than New.
type watchLedger struct {
	mu       sync.Mutex
	verdicts map[string]verdict
	spent    map[string]uint64

	// tube is what YouTube tickets have cost, by whoever resolved each, and
	// tubeLoose what was relayed under the signed names a YouTube playlist
	// hands out, which cannot be traced to a ticket.
	tube      map[string]uint64
	tubeLoose uint64

	// bangumi is what Bilibili's bangumi episodes have cost, by whoever
	// resolved each: every piece of one is traced to its ticket, so there is
	// no loose figure.
	bangumi map[string]uint64
}

// verdict is whether a grantor's grant stood, and when that was asked.
type verdict struct {
	stands bool
	at     time.Time
}

// EmbySpent is what has been relayed under each grantor's signature since this
// process started. A copy, for the management pages; see admin.Spent.
func (l *watchLedger) EmbySpent() map[string]uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make(map[string]uint64, len(l.spent))
	for trip, bytes := range l.spent {
		out[trip] = bytes
	}

	return out
}

// MoveSpent carries what was relayed under one signature across to another,
// where somebody's passphrase changed.
//
// The figure is shown beside a person, and a person's signature is what their
// passphrase makes, so a reset — by an administrator or by the person — put
// their figure back to nought on the page while the bytes stayed counted
// against a signature nobody now has. Worse, the old passphrase is free again
// once nobody holds it, and whoever was given it next would have worn the
// first person's figure. Their films picked before the change stop when it is
// made (the grant is asked for by signature), so nothing more is counted under
// the old one.
func (l *watchLedger) MoveSpent(from, to string) {
	if from == to {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if bytes, ok := l.spent[from]; ok {
		l.spent[to] += bytes
		delete(l.spent, from)
	}

	// The YouTube figure by person goes with them for the same reason, and
	// would otherwise be left under a signature that may be given to somebody
	// else.
	if bytes, ok := l.tube[from]; ok {
		l.tube[to] += bytes
		delete(l.tube, from)
	}

	if bytes, ok := l.bangumi[from]; ok {
		l.bangumi[to] += bytes
		delete(l.bangumi, from)
	}
}

// YouTubeSpent is what has been relayed of YouTube since this process started:
// every resolver's figure and the untraceable pieces, together. For the
// management pages; see admin.Spent.
func (l *watchLedger) YouTubeSpent() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	total := l.tubeLoose
	for _, bytes := range l.tube {
		total += bytes
	}

	return total
}

// BangumiSpent is what has been relayed of bangumi episodes since this process
// started, everybody's together. For the management pages; see admin.Spent.
func (l *watchLedger) BangumiSpent() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	var total uint64
	for _, bytes := range l.bangumi {
		total += bytes
	}

	return total
}

// bangumiBy is what bangumi episodes have cost, by whoever resolved each. A
// copy.
func (l *watchLedger) bangumiBy() map[string]uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make(map[string]uint64, len(l.bangumi))
	for trip, bytes := range l.bangumi {
		out[trip] = bytes
	}

	return out
}

// spendBangumi counts an episode's bytes against whoever resolved it.
func (l *watchLedger) spendBangumi(trip string, bytes int) {
	if bytes <= 0 {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.bangumi == nil {
		l.bangumi = make(map[string]uint64)
	}

	l.bangumi[trip] += uint64(bytes)
}

// youtubeBy is what YouTube tickets have cost, by whoever resolved each. A
// copy.
func (l *watchLedger) youtubeBy() map[string]uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make(map[string]uint64, len(l.tube))
	for trip, bytes := range l.tube {
		out[trip] = bytes
	}

	return out
}

// spendTube counts YouTube's bytes: against a resolver, or, with no signature,
// against nobody in particular.
func (l *watchLedger) spendTube(trip string, bytes int) {
	if bytes <= 0 {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if trip == "" {
		l.tubeLoose += uint64(bytes)
		return
	}

	if l.tube == nil {
		l.tube = make(map[string]uint64)
	}

	l.tube[trip] += uint64(bytes)
}

func (l *watchLedger) spend(trip string, bytes int) {
	if bytes <= 0 {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.spent == nil {
		l.spent = make(map[string]uint64)
	}

	l.spent[trip] += uint64(bytes)
}

// remembered is the kept answer for a grantor, if it is recent enough.
func (l *watchLedger) remembered(trip string, now time.Time) (bool, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	found, ok := l.verdicts[trip]

	// A clock that went backwards is not a reason to trust an answer from the
	// future.
	if !ok || now.Before(found.at) || now.Sub(found.at) >= grantKept {
		return false, false
	}

	return found.stands, true
}

func (l *watchLedger) remember(trip string, stands bool, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.verdicts == nil {
		l.verdicts = make(map[string]verdict)
	}

	l.verdicts[trip] = verdict{stands: stands, at: now}
}

// embyRelayOn reads the deployment-wide switch. Off without a store.
func (a *App) embyRelayOn() bool {
	return a.store != nil && a.store.EmbyRelay()
}

// youtubeRelayOn reads the YouTube switch. Off without a store.
func (a *App) youtubeRelayOn() bool {
	return a.store != nil && a.store.YouTubeRelay()
}

// youtubeStands reports whether a ledgered YouTube ticket is relayed now: on a
// deployment that relays everything, as everything is, and on one that relays
// nothing, while the switch is on.
func (a *App) youtubeStands() bool {
	return !a.conf.Meet.Watch.DirectOnly || a.youtubeRelayOn()
}

// bangumiRelayOn reads the bangumi switch. Off without a store: the switch
// starts on in the store, and a deployment with no store has no ledger to
// relay an episode from either.
func (a *App) bangumiRelayOn() bool {
	return a.store != nil && a.store.BangumiRelay()
}

// bangumiStands reports whether a ledgered bangumi episode is relayed now, as
// youtubeStands does for a video.
func (a *App) bangumiStands() bool {
	return !a.conf.Meet.Watch.DirectOnly || a.bangumiRelayOn()
}

// ledgered is who a ticket was relayed for, if anybody.
func (a *App) ledgered(ticket string) (store.WatchGrant, bool) {
	if a.store == nil {
		return store.WatchGrant{}, false
	}

	return a.store.WatchTicket(ticket)
}

// record writes tickets into the ledger under somebody, as a film, a YouTube
// video or a bangumi episode (kind, as store.WatchGrant.Kind says it).
//
// For a film it notes that their grant stands — they were asked a moment ago,
// so a revocation that has since been undone does not go on refusing their new
// film for the rest of the half minute. Never for a YouTube video or a bangumi
// episode: nobody was asked anything, and noting it would have a grant taken
// away a moment before go on being honoured for the half minute because its
// holder resolved a YouTube or Bilibili link.
//
// The expiry is by the wall clock rather than the application's, because the
// store judges it by the wall clock.
func (a *App) record(tickets []string, account store.Account, kind string) error {
	if a.store == nil {
		return errors.New("no store to keep the ledger in")
	}

	grant := store.WatchGrant{
		Name:    account.Name,
		Trip:    account.Trip,
		Expires: time.Now().UTC().Add(ticketLife),
		Kind:    kind,
	}

	if err := a.store.PutWatchTickets(tickets, grant); err != nil {
		return err
	}

	if kind == "" {
		a.relayed.remember(account.Trip, true, a.now())
	}

	return nil
}

// stands reports whether a ticket's grant still holds: for a film, the switch
// on, where the deployment relays nothing else, and the grantor still given
// Emby; for a YouTube video, the YouTube switch, and for a bangumi episode, the
// bangumi switch, and nothing about anybody.
//
// A kind this build does not know stands for nothing. Read as a film, an entry
// some later build wrote would be relayed on whatever grant it named.
//
// The switch is read every time — one key, and turning it off is meant to be
// the thing that stops everything at once. The grantor's answer is kept for
// grantKept, for the requests a film is made of; a long answer asks past it
// (see relaying).
//
// The grantor is asked by signature, which is what the grant was recorded
// against and what survives a rename. A grantor who changes their passphrase
// partway through a film therefore stops it, as one who was removed would; the
// next film they choose is recorded under the new one. Asked by name instead,
// a name deleted and given to somebody else would carry the first person's
// films on the second person's grant.
func (a *App) stands(grant store.WatchGrant) bool {
	switch grant.Kind {
	case "":
	case store.WatchYouTube:
		return a.youtubeStands()
	case store.WatchBangumi:
		return a.bangumiStands()
	default:
		return false
	}

	if a.switchedOff() {
		return false
	}

	now := a.now()

	if stands, ok := a.relayed.remembered(grant.Trip, now); ok {
		return stands
	}

	return a.standsNow(grant)
}

// standsNow asks the store whether a grant stands, past the kept answer, and
// keeps what it hears for everybody else.
//
// For the long answer, which asks every grantKept and would otherwise be told
// an answer up to grantKept old: the two halves added up to twice the bound the
// page states, for a revocation made just after another viewer's request had
// refreshed the kept answer.
func (a *App) standsNow(grant store.WatchGrant) bool {
	if a.switchedOff() {
		return false
	}

	stands := a.holds(grant.Trip, store.PermEmby)
	a.relayed.remember(grant.Trip, stands, a.now())

	return stands
}

// switchedOff reports whether the deployment relays nothing and its switch says
// that includes films.
func (a *App) switchedOff() bool {
	return a.conf.Meet.Watch.DirectOnly && !a.embyRelayOn()
}

/*
relay is the media path: a ticket's video, playlists and segments.

Under a deployment that relays nothing, only what the ledger holds reaches the
gateway, and only while its grant stands; everything else is the 404 of a path
that is not there, decided here without the gateway being asked. That order is
the guarantee. The gateway relays whatever it holds a ticket for, YouTube
manifests and Bilibili files included, so a request that reached it would be
relayed whatever the gateway's own mode said.

With the YouTube switch on, two more things reach the gateway under such a
deployment: a YouTube ticket the ledger holds, and any name of the shape the
gateway signs (signedName), which is what a YouTube playlist's every variant and
segment is called. The second cannot be checked here against anything — a
signed name is the gateway's and carries no ticket — so the gateway refuses the
ones that are not YouTube's; see the head of this file for why that is narrow.
Both are counted as YouTube's and stop at the next piece when the switch goes
off. With the switch off neither reaches the gateway, exactly as before there
was one.

A bangumi episode reaches the gateway the same two ways, its ticket and its
pieces, but a piece is named after its ticket (partName) and is let through
only where that ticket is in the ledger as an episode's and still stands — the
bangumi switch on — and counted against whoever resolved it. A name shaped like
a piece of anything else, or of nothing the ledger holds, is the 404 of
everything else.

Under a deployment that relays everything, anything the ledger does not hold is
relayed as it always was, and a film the ledger does hold still stops when its
grant does: the grant is about media server films, and a deployment relaying
YouTube does not change who may spend its bandwidth on them.
*/
func (a *App) relay(w http.ResponseWriter, r *http.Request, g gateway) {
	ticket := r.URL.Query().Get("t")
	if ticket == "" {
		// Nothing to relay without the token naming what: as good as no path.
		http.NotFound(w, r)
		return
	}

	grant, held := a.ledgered(ticket)
	direct := a.conf.Meet.Watch.DirectOnly

	switch {
	case held && !a.stands(grant):
		http.NotFound(w, r)

	case held && grant.Kind == store.WatchYouTube:
		passOnAsking(a.tubeRelaying(w, grant.Trip), r, g, "media", ticketQuery(ticket), true)

	case held && grant.Kind == store.WatchBangumi:
		passOnAsking(a.bangumiRelaying(w, grant.Trip), r, g, "media", ticketQuery(ticket), true)

	case held:
		relaying := &relaying{ResponseWriter: w, app: a, grant: grant, asked: a.now()}
		passOnAsking(relaying, r, g, "media", ticketQuery(ticket), true)
		relaying.finish()

	case direct && signedName.MatchString(ticket) && a.youtubeRelayOn():
		passOnAsking(a.tubeRelaying(w, ""), r, g, "media", ticketQuery(ticket), true)

	case direct && partName.MatchString(ticket):
		a.relayPart(w, r, g, ticket)

	case direct:
		http.NotFound(w, r)

	default:
		passOnAsking(w, r, g, "media", ticketQuery(ticket), true)
	}
}

// relayPart relays a piece of a bangumi episode, on its ticket's terms: only
// where the ledger holds the ticket the piece is named after as an episode's,
// and it stands.
func (a *App) relayPart(w http.ResponseWriter, r *http.Request, g gateway, name string) {
	grant, held := a.ledgered(partName.FindStringSubmatch(name)[1])
	if !held || grant.Kind != store.WatchBangumi || !a.stands(grant) {
		http.NotFound(w, r)
		return
	}

	passOnAsking(a.bangumiRelaying(w, grant.Trip), r, g, "media", ticketQuery(name), true)
}

// errSwitchedOff stops a relayed answer partway, where the switch it was
// relayed under was turned off while it was being sent.
var errSwitchedOff = errors.New("the relay this answer was sent under was turned off")

// tubeRelaying is a relayed YouTube answer: counted against whoever resolved
// the video, or, for a signed piece, against nobody in particular.
func (a *App) tubeRelaying(w http.ResponseWriter, trip string) *switched {
	return &switched{ResponseWriter: w, stands: a.youtubeStands, spend: func(bytes int) { a.relayed.spendTube(trip, bytes) }}
}

// bangumiRelaying is a relayed answer of a bangumi episode: counted against
// whoever resolved it, every piece of it.
func (a *App) bangumiRelaying(w http.ResponseWriter, trip string) *switched {
	return &switched{ResponseWriter: w, stands: a.bangumiStands, spend: func(bytes int) { a.relayed.spendBangumi(trip, bytes) }}
}

/*
switched is a relayed answer under a switch rather than a grant — a YouTube
video, or a bangumi episode — on its way to the viewer: counted as that
switch's, and stopped at its next piece once the switch is off.

Simpler than relaying because there is less to ask. No grant stands behind it,
so nothing about anybody is asked again; and its playlists name signed names or
parts of its own ticket, which are relayed by their shape and their ticket, so
nothing is held back to be read for names. The switch is read before every
piece, for the reason relaying reads its own: turning it off is meant to stop
what is playing, and a file relayed as one answer is a whole video.

Only what the gateway answered as a success is counted. Its refusal of a signed
name that is not YouTube's is a few bytes of JSON, and counted, it would be a
figure for YouTube that grew with every refusal of something else.
*/
type switched struct {
	http.ResponseWriter
	stands func() bool
	spend  func(bytes int)
	status int
}

func (rw *switched) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

func (rw *switched) Write(p []byte) (int, error) {
	if !rw.stands() {
		return 0, errSwitchedOff
	}

	n, err := rw.ResponseWriter.Write(p)
	if rw.status == 0 || rw.status/100 == 2 {
		rw.spend(n)
	}

	return n, err
}

// Unwrap lets http.ResponseController reach the connection underneath.
func (rw *switched) Unwrap() http.ResponseWriter {
	return rw.ResponseWriter
}

/*
ticketQuery is the question put to the gateway about a ticket: the ticket this
server checked, and nothing else.

Built rather than passed on. The query as it came was passed on once, and the
ledger was asked about one reading of it while the gateway was asked another:
this server skips a pair holding a semicolon and keeps a '#' inside a value,
and the request to the gateway is cut at the '#'. So "t=<a YouTube
ticket>#;&t=<a ledgered film>" was checked as the film and relayed as the
YouTube ticket, under a deployment that relays nothing, and was saved only by
the gateway's own mode. A second value, or any other parameter, reached the
gateway the same way, safe only for as long as the gateway read the first value
and nothing else. The gateway reads nothing but t on either path that takes a
ticket, so nothing is lost by asking it only that.
*/
func ticketQuery(ticket string) string {
	return "t=" + url.QueryEscape(ticket)
}

/*
relaying is a relayed answer under a grant, on its way to the viewer.

It does three things passOn has no reason to know about. It counts what it
sends against the grantor. It asks again, every grantKept, whether the grant
still stands, and stops partway if it does not — a whole file relayed in one
answer is a film, and asking only at its first byte would let a revoked grant
run to the end. And it holds a playlist back until it has been read for the
names in it and those are in the ledger, for the reason given at playlistLimit.

The asking is of the store, not of the answer the relay keeps (standsNow), and
the switch is read before every piece. A piece is tens of kilobytes and the
switch one key read from a memory-mapped file, which is cheap beside sending
it; and checking the switch only every grantKept made turning it off stop a
long answer half a minute later, which is not what a switch is for.
*/
type relaying struct {
	http.ResponseWriter
	app   *App
	grant store.WatchGrant
	// asked is when the grant was last found standing.
	asked time.Time

	// A playlist, held until finish.
	playlist bool
	status   int
	held     []byte
	tooLong  bool
}

func (rw *relaying) WriteHeader(status int) {
	if status/100 == 2 && strings.Contains(strings.ToLower(rw.Header().Get("Content-Type")), "mpegurl") {
		rw.playlist, rw.status = true, status
		return
	}

	rw.ResponseWriter.WriteHeader(status)
}

func (rw *relaying) Write(p []byte) (int, error) {
	if rw.playlist {
		if len(rw.held)+len(p) > playlistLimit {
			rw.tooLong = true
			return 0, errPlaylistTooLong
		}

		rw.held = append(rw.held, p...)
		return len(p), nil
	}

	if rw.app.switchedOff() {
		return 0, errGrantWithdrawn
	}

	if now := rw.app.now(); now.Sub(rw.asked) >= grantKept || now.Before(rw.asked) {
		if !rw.app.standsNow(rw.grant) {
			return 0, errGrantWithdrawn
		}

		rw.asked = now
	}

	n, err := rw.ResponseWriter.Write(p)
	rw.app.relayed.spend(rw.grant.Trip, n)

	return n, err
}

// Unwrap lets http.ResponseController reach the connection underneath.
func (rw *relaying) Unwrap() http.ResponseWriter {
	return rw.ResponseWriter
}

// finish sends a held playlist, once what it names is in the ledger.
func (rw *relaying) finish() {
	if !rw.playlist {
		return
	}

	// Nothing has been written yet, so the refusal can still be a refusal
	// rather than a playlist cut short — but the gateway's description of the
	// playlist is already set, and its length is not this answer's.
	refuse := func() {
		for _, name := range gatewayHeaders {
			rw.Header().Del(name)
		}
		fail(rw.ResponseWriter, http.StatusBadGateway, reasonServerError)
	}

	if rw.tooLong {
		slog.Error("a relayed playlist was longer than this server reads for the names in it",
			"limit", playlistLimit)
		refuse()
		return
	}

	if names := childrenOf(rw.held); len(names) > 0 {
		if err := rw.app.store.PutWatchTickets(names, rw.grant); err != nil {
			// Refused rather than sent. Sent, every name in it would be
			// refused when the player asked for it, which is the same film
			// not playing with a less honest answer.
			slog.Error("failed to record what a relayed playlist names", "error", err)
			refuse()
			return
		}
	}

	rw.ResponseWriter.WriteHeader(rw.status)
	n, _ := rw.ResponseWriter.Write(rw.held)
	rw.app.relayed.spend(rw.grant.Trip, n)
}

// childrenOf is every child name a playlist relays, once each.
func childrenOf(playlist []byte) []string {
	seen := map[string]bool{}
	out := []string{}

	for _, match := range playlistName.FindAllSubmatch(playlist, -1) {
		name := string(match[1])
		if childName.MatchString(name) && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}

	return out
}
