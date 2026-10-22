package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Bilibili's bangumi relayed for everybody, on a deployment that relays nothing
else.

The switch (watch.bangumi_relay) opens the media path to an episode's ticket and
to the pieces its playlists name, which the gateway calls after the ticket
("<ticket>.p1", "<ticket>.f1"). Unlike YouTube's signed names, every piece can
be traced to a ticket, so what these tests hold is that it is: a piece is
relayed only where the ledger holds its ticket as a bangumi episode's and the
switch is on, and a name shaped like a piece of anything else — a YouTube
video, a Bilibili video, a ticket nobody resolved — is a 404 the gateway never
hears. Those are the ones that would go through the CDN silently and be paid
for.

The switch starts on, the owner's choice, so the test that a deployment nobody
configured relays an episode is the one that would catch it reading off — every
series at 360p and its members' episodes refused, with nothing to say why. The
counter is held to what was sent, against whoever resolved the episode, and
apart from YouTube's and the films'.
*/

var (
	bangumiPlaylist = bangumiTicket + ".p1"
	bangumiFile     = bangumiTicket + ".f1"
)

// bangumiDeployment is a deployment that relays nothing, with the Emby and
// YouTube switches off, the bangumi switch as asked or as it starts, and
// nobody granted anything.
func bangumiDeployment(t *testing.T, on *bool) *embyRig {
	t.Helper()

	rig := embyDeployment(t, true)

	if err := rig.st.SetEmbyRelay(false); err != nil {
		t.Fatal(err)
	}

	if on != nil {
		if err := rig.st.SetBangumiRelay(*on); err != nil {
			t.Fatal(err)
		}
	}

	// The episode's master playlist, naming its pieces after its ticket, as the
	// gateway writes one.
	rig.gateway.instead = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/media" || r.URL.Query().Get("t") != bangumiTicket {
			return false
		}

		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = io.WriteString(w, "#EXTM3U\n"+
			`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio",URI="media?t=`+bangumiTicket+`.p0"`+"\n"+
			"#EXT-X-STREAM-INF:BANDWIDTH=2192000,AUDIO=\"a\"\nmedia?t="+bangumiPlaylist+"\n")

		return true
	}

	return rig
}

func turned(on bool) *bool { return &on }

func TestTheBangumiSwitchStartsOn(t *testing.T) {
	// Nobody has touched the switch.
	rig := bangumiDeployment(t, nil)

	resolved := rig.resolve("https://www.bilibili.com/bangumi/play/ep508405")
	if resolved.Code != http.StatusOK || resolved.Header().Get("X-Watch-Relay") != "" {
		t.Fatalf("an episode on a deployment nobody configured resolved %d with relay %q; "+
			"the owner's choice is every episode relayed", resolved.Code, resolved.Header().Get("X-Watch-Relay"))
	}

	if grant, ok := rig.st.WatchTicket(bangumiTicket); !ok || grant.Kind != store.WatchBangumi ||
		grant.Trip != "eeeeefffff" || grant.Name != "listener" {
		t.Fatalf("the episode was ledgered as %+v (%v), want a bangumi episode under whoever resolved it", grant, ok)
	}

	for _, name := range []string{bangumiTicket, bangumiPlaylist, bangumiFile} {
		if got := rig.media(name); got.Code != http.StatusOK || !rig.gateway.heard(name) {
			t.Errorf("%s came back %d, gateway asked: %v", name, got.Code, rig.gateway.heard(name))
		}
	}
}

func TestWithTheBangumiSwitchOffNoEpisodeIsRelayed(t *testing.T) {
	rig := bangumiDeployment(t, turned(false))

	// Played only through the relay, so said to have none: every page reads
	// that as a video that cannot be played here.
	resolved := rig.resolve("bangumi")
	if resolved.Code != http.StatusOK || resolved.Header().Get("X-Watch-Relay") != "off" {
		t.Fatalf("an episode with the switch off resolved %d with relay %q", resolved.Code, resolved.Header().Get("X-Watch-Relay"))
	}

	if _, ok := rig.st.WatchTicket(bangumiTicket); ok {
		t.Error("an episode was ledgered with the switch off")
	}

	if got := rig.get("/api/watch/info?t="+bangumiTicket, nil); got.Header().Get("X-Watch-Relay") != "off" {
		t.Error("an episode was described as relayed with the switch off")
	}

	for _, name := range []string{bangumiTicket, bangumiPlaylist, bangumiFile} {
		refusedUnheard(t, rig, name, "with the switch off")
	}

	// On, an episode resolved, then off again: what the ledger holds stops with
	// the switch, at once and for everybody, pieces and all.
	if err := rig.st.SetBangumiRelay(true); err != nil {
		t.Fatal(err)
	}

	if got := rig.resolve("bangumi"); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Fatalf("an episode with the switch on resolved %d with relay %q", got.Code, got.Header().Get("X-Watch-Relay"))
	}

	if got := rig.media(bangumiFile); got.Code != http.StatusOK {
		t.Fatalf("a piece of the ledgered episode came back %d with the switch on", got.Code)
	}

	if err := rig.st.SetBangumiRelay(false); err != nil {
		t.Fatal(err)
	}

	before := len(rig.gateway.all())

	for _, name := range []string{bangumiTicket, bangumiPlaylist, bangumiFile} {
		if got := rig.media(name); got.Code != http.StatusNotFound {
			t.Errorf("%s was answered %d once the switch was turned off", name, got.Code)
		}
	}

	if after := len(rig.gateway.all()); after != before {
		t.Errorf("with the switch turned off the gateway was asked %d more times", after-before)
	}

	if got := rig.get("/api/watch/info?t="+bangumiTicket, nil); got.Header().Get("X-Watch-Relay") != "off" {
		t.Error("a ledgered episode was still described as relayed once the switch was turned off")
	}
}

func TestABangumiEpisodeIsRelayedForEverybodyByItsParts(t *testing.T) {
	rig := bangumiDeployment(t, turned(true))

	// listener holds no grant at all: none is asked for.
	if got := rig.resolve("bangumi"); got.Code != http.StatusOK {
		t.Fatalf("an episode resolved %d", got.Code)
	}

	if got := rig.get("/api/watch/info?t="+bangumiTicket, nil); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Errorf("a guest asking about the episode was told %d with relay %q; their player would not play it",
			got.Code, got.Header().Get("X-Watch-Relay"))
	}

	// A guest, with no session, through the playlist to a byte range of a file.
	master := rig.media(bangumiTicket)
	if master.Code != http.StatusOK || !strings.Contains(master.Body.String(), "media?t="+bangumiPlaylist) {
		t.Fatalf("the episode's playlist came back %d %q", master.Code, master.Body.String())
	}

	for _, name := range []string{bangumiTicket + ".p0", bangumiPlaylist, bangumiFile} {
		if got := rig.media(name); got.Code != http.StatusOK || !rig.gateway.heard(name) {
			t.Errorf("%s came back %d, gateway asked: %v", name, got.Code, rig.gateway.heard(name))
		}
	}

	// Resolved by a host for somebody else: no grant is spent, so nothing is
	// refused, and it is ledgered just the same.
	if got := rig.resolve("bangumi", "for=other"); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Errorf("a host resolving somebody else's episode got %d with relay %q", got.Code, got.Header().Get("X-Watch-Relay"))
	}

	if got := rig.get("/api/watch/info?t="+bangumiTicket, nil).Header().Get("X-Watch-Grantor"); got != "" {
		t.Errorf("an episode was described as relayed under %q; the holder would refuse it from anybody else", got)
	}
}

// The invariant the switch must not move: everything that is not a bangumi
// episode is as unrelayed with it on as with it off, and a piece is a piece of
// an episode only where the ledger says its ticket is one.
func TestTheBangumiSwitchRelaysNothingElse(t *testing.T) {
	rig := bangumiDeployment(t, turned(true))

	for _, link := range []string{"bilibili", "youtube", "https://example.invalid/v.mp4"} {
		got := rig.resolve(link)
		if got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s resolved %d with relay %q under the bangumi switch", link, got.Code, got.Header().Get("X-Watch-Relay"))
		}
	}

	if _, ok := rig.st.WatchTicket(tubeTicket); ok {
		t.Error("a YouTube video was ledgered under the bangumi switch")
	}

	for _, name := range []string{
		biliTicket, plainTicket, tubeTicket,
		// Shaped like pieces, of tickets the ledger does not hold as an
		// episode's — or does not hold at all.
		biliTicket + ".f1", plainTicket + ".p0", tubeTicket + ".p1", filmTicket + ".f0",
		"nobody-resolved-this-1.f1",
		// And YouTube's signed pieces, whose own switch is off.
		tubeVariant, tubeSegment,
	} {
		refusedUnheard(t, rig, name, "under the bangumi switch")
	}

	// A YouTube video ledgered under its own switch is still not an episode:
	// a name shaped like a piece of its ticket is not relayed on either switch.
	if err := rig.st.SetYouTubeRelay(true); err != nil {
		t.Fatal(err)
	}

	if got := rig.resolve("youtube"); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Fatalf("a YouTube link with its switch on resolved %d", got.Code)
	}

	refusedUnheard(t, rig, tubeTicket+".p1", "a piece-shaped name of a YouTube ticket")

	// Nor a film's, ledgered under a grant.
	if err := rig.st.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	rig.grant(t, true)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("a granted film resolved %d", got.Code)
	}

	refusedUnheard(t, rig, filmTicket+".f0", "a piece-shaped name of a film's ticket")

	// Near the shape and not in it: an uppercase piece, two dots, a ticket too
	// short to be one.
	rig.resolve("bangumi")

	for _, name := range []string{
		bangumiTicket + ".P1", bangumiTicket + ".f1.f1", bangumiTicket + ".", "short.f1",
		bangumiTicket + "." + strings.Repeat("a", 9),
	} {
		refusedUnheard(t, rig, name, "near the shape of a piece")
	}
}

/*
What bangumi costs is counted apart from YouTube and the films, against whoever
resolved the episode, and only what was sent.

Every piece is traced to its ticket, so all of an episode's bytes are its
resolver's; the settings page shows the total beside the switch. The gateway's
refusal of a piece is not an episode being relayed, and counted, it would be a
figure that grew with every refusal.
*/
func TestBangumiIsCountedAgainstWhoeverResolvedIt(t *testing.T) {
	rig := bangumiDeployment(t, turned(true))

	refused := bangumiTicket + ".f9"
	inner := rig.gateway.instead
	rig.gateway.instead = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/media" && r.URL.Query().Get("t") == refused {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":"not_found"}`)
			return true
		}

		return inner(w, r)
	}

	trip := room.Trip(tripKey, "the owner's passphrase")
	if err := rig.st.AddAdmin(store.Admin{Trip: trip, Name: "owner", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	rig.mux = rig.app.Handler()

	rig.resolve("bangumi")

	sent := rig.media(bangumiTicket).Body.Len() + rig.media(bangumiPlaylist).Body.Len() + rig.media(bangumiFile).Body.Len()

	if got := rig.media(refused); got.Code != http.StatusNotFound || !rig.gateway.heard(refused) {
		t.Fatalf("the stub's refusal of a piece came back %d", got.Code)
	}

	if sent == 0 {
		t.Fatal("nothing was relayed; the count proves nothing")
	}

	if by := rig.app.relayed.bangumiBy(); by["eeeeefffff"] != uint64(sent) || len(by) != 1 {
		t.Errorf("bangumi was counted by resolver as %v; all %d bytes are listener's", by, sent)
	}

	if got := rig.app.relayed.BangumiSpent(); got != uint64(sent) {
		t.Errorf("the bangumi figure is %d; %d bytes were relayed, and the refusal was none of it", got, sent)
	}

	if got := rig.app.relayed.YouTubeSpent(); got != 0 {
		t.Errorf("bangumi was counted as YouTube's: %d", got)
	}

	if spent := rig.app.relayed.EmbySpent(); len(spent) != 0 {
		t.Errorf("bangumi was counted against the films as %v", spent)
	}

	// And the page says the same, beside the switch.
	signed := ask(rig.mux, asking(http.MethodPost, "/api/admin/session", "",
		`{"name":"owner","passphrase":"the owner's passphrase"}`))
	if signed.Code != http.StatusOK {
		t.Fatalf("signing in to the management pages answered %d", signed.Code)
	}

	reading := httptest.NewRequest(http.MethodGet, "/api/admin/settings", nil)
	for _, cookie := range signed.Result().Cookies() {
		reading.AddCookie(cookie)
	}

	var settings struct {
		BangumiRelay bool   `json:"bangumiRelay"`
		BangumiSpent uint64 `json:"bangumiSpent"`
	}

	read := ask(rig.mux, reading)
	if err := json.Unmarshal(read.Body.Bytes(), &settings); err != nil {
		t.Fatalf("the settings did not read: %v (%s)", err, read.Body.String())
	}

	if !settings.BangumiRelay || settings.BangumiSpent != uint64(sent) {
		t.Errorf("the settings page says the switch is %v and %d bytes were relayed; it is on and %d were",
			settings.BangumiRelay, settings.BangumiSpent, sent)
	}

	// A passphrase changed takes the figure with it.
	rig.app.relayed.MoveSpent("eeeeefffff", "tnewtrip00")

	if by := rig.app.relayed.bangumiBy(); by["tnewtrip00"] != uint64(sent) || by["eeeeefffff"] != 0 {
		t.Errorf("after a passphrase change the bangumi figure by resolver is %v", by)
	}
}

/*
The gateway is told while the switch is off, on every resolve, so that it does
not have an episode read for the relay — the PC player asked with the
deployment's Bilibili account, every quality's index read from the CDN — only
for this server to answer that it will not relay it. It was, for every episode
pasted while the switch was off, and the answer said nothing of it.

Told by this server and by nobody else: a client's own bangumi= never reaches
the gateway, whichever way the switch is, and a deployment that relays
everything never says it, since there the switch is not consulted at all.
*/
func TestTheGatewayIsToldWhileTheBangumiSwitchIsOff(t *testing.T) {
	lastResolve := func(rig *embyRig) string {
		t.Helper()

		all := rig.gateway.all()
		if len(all) == 0 {
			t.Fatal("the gateway was asked nothing")
		}

		return all[len(all)-1]
	}

	rig := bangumiDeployment(t, turned(false))

	for _, extra := range [][]string{nil, {"bangumi=on"}, {"for=other", "bangumi=on"}} {
		rig.resolve("bangumi", extra...)

		if got := lastResolve(rig); got != "/resolve?url=bangumi&bangumi=off" {
			t.Errorf("with the switch off and %v from the client, the gateway was asked %q", extra, got)
		}
	}

	if err := rig.st.SetBangumiRelay(true); err != nil {
		t.Fatal(err)
	}

	for _, extra := range [][]string{nil, {"bangumi=off"}, {"bangumi=off", "for=other"}} {
		rig.resolve("bangumi", extra...)

		if got := lastResolve(rig); got != "/resolve?url=bangumi" {
			t.Errorf("with the switch on and %v from the client, the gateway was asked %q", extra, got)
		}
	}

	everything := bangumiDeployment(t, turned(false))
	everything.app.conf.Meet.Watch.DirectOnly = false

	everything.resolve("bangumi", "bangumi=off")

	if got := lastResolve(everything); got != "/resolve?url=bangumi" {
		t.Errorf("a deployment that relays everything asked the gateway %q", got)
	}
}

// A deployment that relays everything relays an episode as it does everything,
// whatever the switch says, and ledgers nothing for it.
func TestADeploymentThatRelaysEverythingIgnoresTheBangumiSwitch(t *testing.T) {
	for _, on := range []bool{false, true} {
		rig := bangumiDeployment(t, turned(on))
		rig.app.conf.Meet.Watch.DirectOnly = false

		if got := rig.resolve("bangumi"); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
			t.Errorf("switch %v: an episode resolved %d with relay %q", on, got.Code, got.Header().Get("X-Watch-Relay"))
		}

		if _, ok := rig.st.WatchTicket(bangumiTicket); ok {
			t.Errorf("switch %v: a deployment that relays everything ledgered an episode", on)
		}

		for _, name := range []string{bangumiTicket, bangumiPlaylist, bangumiFile} {
			if got := rig.media(name); got.Code != http.StatusOK {
				t.Errorf("switch %v: a deployment that relays everything answered %s with %d", on, name, got.Code)
			}
		}
	}
}

// Turning the switch off stops a piece already being sent at its next write: a
// file relayed as one answer is minutes of an episode.
func TestTheBangumiSwitchStopsALongAnswerAtOnce(t *testing.T) {
	release := make(chan struct{})
	sentFirst := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/resolve":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, resolvedAs("bangumi"))
		case "/media":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = io.WriteString(w, "FIRST-PART")
			w.(http.Flusher).Flush()
			close(sentFirst)
			<-release
			_, _ = io.WriteString(w, "SECOND-PART")
		}
	}))
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken, DirectOnly: true}

	if got := musicGet(mux, "/api/watch/resolve?url=bangumi", cookie); got.Code != http.StatusOK {
		t.Fatalf("an episode resolved %d", got.Code)
	}

	var once sync.Once
	defer once.Do(func() { close(release) })

	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- musicGet(mux, "/api/watch/media?t="+bangumiFile, nil) }()

	<-sentFirst

	if err := app.store.SetBangumiRelay(false); err != nil {
		t.Fatal(err)
	}

	once.Do(func() { close(release) })
	got := <-done

	if !strings.Contains(got.Body.String(), "FIRST-PART") {
		t.Fatalf("the piece was not relayed at all: %q", got.Body.String())
	}

	if strings.Contains(got.Body.String(), "SECOND-PART") {
		t.Errorf("a piece went on being relayed after the switch was turned off: %q", got.Body.String())
	}
}
