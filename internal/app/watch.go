package app

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"tomoshibi/internal/store"
)

/*
Watching a video together.

Somebody signed in pastes a link; everybody in the call watches it, each in
their own browser, kept at the same moment by the one who started it (see
web/src/live/watch.ts). This file is the door to the gateway that makes that
possible, in the same shape as the music library's, with five paths:

	ready     whether there is a gateway: asked by the client to offer this
	resolve   what a pasted link plays, filed under a ticket
	library   the media servers the deployment has an account on, to browse
	          and search, and their posters
	info      what a ticket plays: the title, the length, and where it is
	media     a ticket's video, or its playlists and segments, relayed for a
	          viewer who cannot fetch it from where it is

The first three are for somebody signed in who was given watching together,
because resolving is the deployment's work done on somebody's behalf; the
library asks for the Emby grant as well. The last two are for anybody in the
call, guests included, since they watch too -- and neither is a proxy anybody
can point anywhere: they take only a ticket the gateway issued when somebody
signed in resolved a link, which stands for that one video and stops working
after six hours. A call passes tickets around and nothing else, so nobody in it
can make everybody else's browser fetch an address of their choosing.

A deployment may relay nothing (meet.watch.direct_only), and then every video
plays from where each viewer is, or not at all — with one exception it has to
agree to twice. A film from a media server plays only through the relay: the
media server's every address carries the deployment's account, which no viewer
is given. So such a film is relayed when the switch in the store says the
deployment will relay them (watch.emby_relay) and the person who chose it was
given the Emby permission, and nothing else is relayed at all. How the server
tells that film's ticket from every other ticket the gateway ever minted is the
ledger in watchledger.go; what follows from it here is that media answers 404,
without asking the gateway, for every ticket the ledger does not hold.

The second exception is YouTube, which a deployment that relays nothing relays
for whoever cannot reach it while its own switch says so (watch.youtube_relay):
for everybody, with no grant, since the people it is for are simply the ones in
mainland China, and nobody else's player ever asks for the relay. A YouTube
link resolved with the switch on is ledgered as one, and its pieces — names the
gateway signed — pass to the gateway by their shape; watchledger.go has the
argument.

The third is Bilibili's bangumi — the series and films it licenses — which such
a deployment relays for everybody while their switch says so
(watch.bangumi_relay, on unless somebody turned it off: the owner's choice of
2026-10-14). An episode for members plays whole, and anything above 720p plays
at all, only through the relay, so a bangumi episode is played through it by
every viewer rather than as a fallback; the gateway says one is by play.kind
"bangumi", and its pieces are named after its ticket, so each is traced to the
ledger rather than passed by shape. Bilibili's videos, pasted addresses and
everything else stay unrelayed whatever any switch says.

A deployment that relays everything relays everything, as it always did, except
that a media server's film still needs the grant: the grant is about who may
spend the deployment's bandwidth on a film, and relaying everything else does
not answer that.

What comes back from media is said to be media, here as well as at the
gateway: a type that is not video, audio or a playlist is sent as bytes, never
sniffed, under a sandbox. These answers come from this server's own origin,
and a page relayed as a page would run with the rights of whoever opened it.
*/

var watchPaths = map[string]bool{"ready": true, "resolve": true, "library": true, "info": true, "media": true}

// Said on an answer whose video this deployment will not relay, so a viewer's
// player does not try a relay that is not there and is not answered: on ready,
// resolve and info, where a deployment relays nothing, except about a film it
// agreed to relay; and on info about a film whose grant has been taken away,
// wherever it is. The library and media paths answer with what they carry or
// with the 404 of a path that is not there, and say nothing.
const relayHeader = "X-Watch-Relay"

// grantorHeader names whose grant a film is relayed under, on info and on the
// resolve that recorded it: the signature, which is what prints beside their
// name in every room.
//
// For the holder of a show. A film's ticket travels in the show to everybody in
// the call, and a ticket is all a film needs to be queued; without this, a
// ticket copied out of one room and handed to the holder of another would be
// queued there and relayed on the first person's grant, for a room they are
// not in. The holder queues a relayed film only from the person whose grant it
// is (Theatre.addTicket in web/src/live/watch.ts). That holds an honest holder
// to it, which is the same footing for=other stands on; somebody holding a
// show of their own and a copied ticket is a person with a ticket, which the
// ledger's twelve hours and the grant's withdrawal bound.
const grantorHeader = "X-Watch-Grantor"

// What a relayed answer may say it is. Anything else is sent as bytes.
var mediaTypes = []string{
	"video/", "audio/", "application/vnd.apple.mpegurl", "application/x-mpegurl",
	"application/mp4", "application/octet-stream", "application/json", "text/vtt",
	// Posters and covers. Not image/svg+xml, which is a document that can
	// carry script, and is sent as bytes like anything else not listed.
	"image/jpeg", "image/png", "image/webp", "image/gif",
}

// resolveLimit is as much of a resolved link's description as is read.
//
// A title, a length, a cover and two addresses: a few hundred bytes. The bound
// is there because this one answer is read whole rather than streamed, and a
// gateway gone wrong should not be able to make this server hold whatever it
// sends.
const resolveLimit = 64 << 10

// ticketShape is what a gateway's ticket looks like, as the client reads one
// (TICKET in web/src/live/watch-api.ts).
var ticketShape = regexp.MustCompile(`^[\w-]{16,64}$`)

// relayedCover is a poster that comes only through the relay, by its ticket.
var relayedCover = regexp.MustCompile(`^media\?t=([\w-]{16,64})$`)

// signedName is the shape of a name the gateway signs rather than files: every
// address in a playlist it relays for YouTube (sign() in the gateway). Its
// body is URL-safe base64 of what the address is, a dot, and eighteen bytes of
// HMAC in the same alphabet, which is twenty-four characters. Neither a ticket
// nor a film's child name has a dot, and a bangumi piece (partName) has a few
// characters where this has twenty-four, so the shapes cannot be mistaken for
// one another. The shape is all this server can check; whether the signature
// is good, and whether the address is YouTube's, is the gateway's to say.
var signedName = regexp.MustCompile(`^[\w-]{16,}\.[\w-]{24}$`)

func (a *App) watch(w http.ResponseWriter, r *http.Request) {
	conf := a.conf.Meet.Watch
	what := r.PathValue("what")

	if conf.URL == "" || !watchPaths[what] {
		http.NotFound(w, r)
		return
	}

	g := gateway{
		name:     "watch",
		url:      conf.URL,
		header:   "X-Watch-Token",
		token:    conf.Token,
		key:      "meet.watch.token",
		contains: mediaTypes,
	}

	switch what {
	case "ready":
		if conf.DirectOnly {
			w.Header().Set(relayHeader, "off")
		}

		if _, ok := a.may(w, r, store.PermWatch); !ok {
			return
		}

		passOn(w, r, g, what, false)

	case "resolve":
		a.resolve(w, r, g)

	case "library":
		a.library(w, r, g)

	case "info":
		ticket := r.URL.Query().Get("t")
		if ticket == "" {
			// Nothing to describe without the token naming what: as good as
			// no path.
			http.NotFound(w, r)
			return
		}

		// Everybody in the call asks this of every ticket, and the answer is
		// how each of their players decides whether to try the relay. So it
		// says "off" about anything the media path below would refuse — a
		// film whose grant no longer stands, in either kind of deployment, a
		// YouTube video or a bangumi episode once its switch is off, and
		// anything the ledger does not hold in one that relays nothing — and
		// nothing about what it would carry.
		grant, held := a.ledgered(ticket)

		if held && !a.stands(grant) || !held && conf.DirectOnly {
			w.Header().Set(relayHeader, "off")
		}

		// Whose choice a ledgered film was, for the holder of a show deciding
		// whether to queue it; see grantorHeader. Never a YouTube video's or a
		// bangumi episode's resolver: those are relayed on nobody's grant, and
		// named, the holder would refuse them from anybody else in the call
		// who handed one over.
		if held && grant.Kind == "" {
			w.Header().Set(grantorHeader, grant.Trip)
		}

		// The ticket the answer above is about, and not the query as it came;
		// see ticketQuery.
		passOnAsking(w, r, g, what, ticketQuery(ticket), false)

	case "media":
		a.relay(w, r, g)
	}
}

// library is a media server's catalogue, for somebody given the Emby grant.
//
// Every item in it plays only through the relay, so it is offered to nobody
// who could not have one relayed: on a deployment that relays nothing, not at
// all until the switch is on — the same 404 as a path that is not there, which
// is what the client reads as "no library" — and to nobody who was not given
// the grant.
func (a *App) library(w http.ResponseWriter, r *http.Request, g gateway) {
	if a.conf.Meet.Watch.DirectOnly && !a.embyRelayOn() {
		http.NotFound(w, r)
		return
	}

	account, ok := a.may(w, r, store.PermWatch)
	if !ok {
		return
	}

	if !a.holds(account.Trip, store.PermEmby) {
		fail(w, http.StatusForbidden, reasonNotAllowed)
		return
	}

	// Counted against whoever is browsing, beside the films they chose: every
	// poster in a page of the library comes through here, again on every
	// visit, and a figure that counted only films would say a person browsing
	// for an evening had spent nothing.
	passOn(&counted{ResponseWriter: w, ledger: &a.relayed, trip: account.Trip}, r, g, "library", false)
}

// counted is an answer whose bytes are spent against somebody, and nothing
// else: none of the relay's asking again, which a page of the library is too
// short to need.
type counted struct {
	http.ResponseWriter
	ledger *watchLedger
	trip   string
}

func (c *counted) Write(p []byte) (int, error) {
	n, err := c.ResponseWriter.Write(p)
	c.ledger.spend(c.trip, n)

	return n, err
}

// Unwrap lets http.ResponseController reach the connection underneath.
func (c *counted) Unwrap() http.ResponseWriter {
	return c.ResponseWriter
}

/*
resolve asks the gateway what a pasted link plays, and reads the answer before
passing it on.

The one gateway answer this server reads. Every other is passed on unread, and
on purpose (see passOn); this one decides whether the deployment will spend its
bandwidth, and the gateway cannot decide that because it does not know who is
asking. So the answer is read whole, bounded, as JSON, and a film that plays
only through the relay — play.kind "relay", which only a media server's film
is — is let through only for somebody given the Emby grant, on a deployment
whose switch is on where it relays nothing else, and only when they asked for
themselves.

"For themselves" is the for=other the client sends when the host of a showing
resolves a link somebody else added. A showing is resolved in its host's
browser, with the host's session, whoever pasted the link; without this, a
guest pasting a media server's address into a granted host's showing would be
spending the host's grant. A granted person who is not the host resolves their
choice in their own browser and hands the host the ticket instead.

Let through, the ticket and its poster are written into the ledger under the
person who asked, which is what the info and media paths consult. Refused, the
answer is emby_not_allowed and the ticket is never seen by the browser.

A YouTube video — play.kind "youtube" — is ledgered as one where the deployment
relays nothing and the YouTube switch is on, under whoever asked, for its bytes
to be counted against; asking for somebody else changes nothing, because no
grant is spent. It is never refused here. Where it cannot be ledgered it is
passed on as it would be with the switch off, saying there is no relay, which
leaves everybody who can reach YouTube watching it and nobody worse off than
before there was a switch.

A bangumi episode — play.kind "bangumi" — is ledgered the same way under its own
switch and mark. It plays only through the relay, so where it cannot be
ledgered, or the switch is off, it passes saying there is no relay, which every
page reads as a video that cannot be played here: what an episode for members
was answered before there was a relay for it. While the switch is off the
gateway is told so as well (resolveQuery), and answers an episode as
unavailable itself, without having it read for the relay.

Any other answer passes as it always did, saying where the deployment relays
nothing that it relays nothing.

The gateway's own refusal of this server stays what it was everywhere else —
the deployment's misconfiguration, a 502 — and is never read as the person not
being allowed: that would tell somebody they lack a permission when what is
wrong is a token in a file.
*/
func (a *App) resolve(w http.ResponseWriter, r *http.Request, g gateway) {
	direct := a.conf.Meet.Watch.DirectOnly
	if direct {
		w.Header().Set(relayHeader, "off")
	}

	account, ok := a.may(w, r, store.PermWatch)
	if !ok {
		return
	}

	// The client's word to this server, and none of the gateway's business.
	query := r.URL.Query()
	forOther := query.Get("for") != ""

	response, done := consult(w, r, g, "resolve", resolveQuery(r.URL.RawQuery, !a.bangumiStands()), false)
	if response == nil {
		return
	}
	defer done()

	body, err := io.ReadAll(io.LimitReader(response.Body, resolveLimit+1))
	if err != nil || len(body) > resolveLimit {
		slog.Error("the watch gateway's description of a link could not be read whole",
			"bytes", len(body), "error", err)
		fail(w, http.StatusBadGateway, reasonServerError)
		return
	}

	relayed, tube, bangumi := false, false, false

	if response.StatusCode/100 == 2 {
		var said struct {
			Ticket string `json:"ticket"`
			Cover  string `json:"cover"`
			Play   struct {
				Kind string `json:"kind"`
			} `json:"play"`
		}

		// An answer that will not read is refused rather than passed on. It
		// cannot be told apart from a film that plays only through the relay,
		// and passing it on would be relaying that film for somebody this
		// could not ask about.
		if err := json.Unmarshal(body, &said); err != nil {
			slog.Error("the watch gateway described a link in something that is not JSON", "error", err)
			fail(w, http.StatusBadGateway, reasonServerError)
			return
		}

		if said.Play.Kind == "relay" {
			// The deployment's refusal before the person's. With the switch
			// off, a deployment that relays nothing relays no film for
			// anybody, and says so as it did before there was a switch: the
			// gateway's own 422 then, which every page reads as a video that
			// cannot be played here. Refused as the person's, it told somebody
			// whose account page lists the grant that the media servers had not
			// been opened to them.
			if direct && !a.embyRelayOn() {
				fail(w, http.StatusUnprocessableEntity, reasonUnavailable)
				return
			}

			if forOther || !a.holds(account.Trip, store.PermEmby) {
				fail(w, http.StatusForbidden, reasonEmbyNotAllowed)
				return
			}

			if !ticketShape.MatchString(said.Ticket) {
				slog.Error("the watch gateway filed a film under something that is not a ticket")
				fail(w, http.StatusBadGateway, reasonServerError)
				return
			}

			tickets := []string{said.Ticket}
			if cover := relayedCover.FindStringSubmatch(said.Cover); cover != nil {
				tickets = append(tickets, cover[1])
			}

			if err := a.record(tickets, account, ""); err != nil {
				// Not handed out. A ticket the ledger does not hold is one the
				// media path refuses, so the film would be queued for the room
				// and play for nobody, with nothing to say why.
				slog.Error("failed to record a film in the relay's ledger", "error", err)
				fail(w, http.StatusInternalServerError, reasonServerError)
				return
			}

			relayed = true
		}

		if said.Play.Kind == "youtube" && direct && a.youtubeRelayOn() {
			tube = a.ledgerSwitched(said.Ticket, said.Cover, account, store.WatchYouTube)
		}

		if said.Play.Kind == "bangumi" && direct && a.bangumiRelayOn() {
			bangumi = a.ledgerSwitched(said.Ticket, said.Cover, account, store.WatchBangumi)
		}
	}

	if relayed {
		w.Header().Del(relayHeader)
		w.Header().Set(grantorHeader, account.Trip)
	}

	if tube || bangumi {
		w.Header().Del(relayHeader)
	}

	describeAnswer(w, g, response, false)
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(body)
}

// ledgerSwitched writes a resolved YouTube video or bangumi episode into the
// ledger under whoever resolved it, as the kind it is, and reports whether it
// did.
//
// A ticket of the wrong shape is left out rather than refused: the media path
// could not carry it anyway, and refusing a YouTube link would take it from
// every viewer who can reach YouTube as well; an episode left out is said to
// everybody as a video that cannot be played here. The same for a store that
// would not write, which is said in the log, since what follows is a video
// that the people it was switched on for cannot watch.
func (a *App) ledgerSwitched(ticket, cover string, account store.Account, kind string) bool {
	if !ticketShape.MatchString(ticket) {
		slog.Error("the watch gateway filed a relayed video under something that is not a ticket", "kind", kind)
		return false
	}

	tickets := []string{ticket}
	if poster := relayedCover.FindStringSubmatch(cover); poster != nil {
		tickets = append(tickets, poster[1])
	}

	if err := a.record(tickets, account, kind); err != nil {
		slog.Error("failed to record a relayed video in the relay's ledger; "+
			"it plays only for viewers who can reach where it is, if anybody", "kind", kind, "error", err)
		return false
	}

	return true
}

/*
resolveQuery is what the gateway is asked to resolve: the client's query
without for=, which is the client's word to this server, and with bangumi=off
where this server will relay no bangumi episode — on a deployment that relays
nothing, while the switch is off.

Said to the gateway because reading an episode to be relayed is not free: the
gateway has the mainland one ask Bilibili's PC player for it with the
deployment's Bilibili account, and reads every quality's index from the CDN.
With the switch off all of that was done for each episode pasted, and the answer
then passed on here saying there is no relay — a video that cannot be played
here, which is what the gateway, told, now answers without asking for any of
it. Any bangumi= the client sent is taken out first: whether the switch is off
is this server's to say, and the gateway hears it from nobody else.
*/
func resolveQuery(raw string, bangumiOff bool) string {
	kept := withoutParameter(withoutParameter(raw, "for"), "bangumi")
	if !bangumiOff {
		return kept
	}

	if kept == "" {
		return "bangumi=off"
	}

	return kept + "&bangumi=off"
}

// withoutParameter is a query with every value of one parameter taken out, and
// the rest exactly as it came.
//
// Cut out of the raw string rather than parsed and encoded again, so that what
// the gateway is asked is byte for byte what the client sent — a pasted link is
// a value in this query, and reordering or re-escaping it is changing it.
func withoutParameter(raw, name string) string {
	if raw == "" {
		return ""
	}

	kept := make([]string, 0, strings.Count(raw, "&")+1)

	for _, part := range strings.Split(raw, "&") {
		key, _, _ := strings.Cut(part, "=")
		if key == name {
			continue
		}

		kept = append(kept, part)
	}

	return strings.Join(kept, "&")
}
