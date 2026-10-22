package app

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
YouTube relayed for whoever cannot reach it, on a deployment that relays nothing
else.

The switch (watch.youtube_relay) opens two doors in the media path at once: a
YouTube ticket the ledger holds, and every name of the shape the gateway signs,
which is what a YouTube playlist's variants and segments are called. Both doors
are wide — the second takes a name this server cannot trace to anything — so
what these tests hold is that they are shut while the switch is off, without
the gateway hearing the question, and that opening them opens nothing else:
Bilibili, a pasted address, a film's child nobody named, a name that only looks
signed. Those are the ones that would go through the CDN silently and be paid
for.

The gateway stub relays whatever it is asked for, as in watchledger_test.go, so
a refusal is a refusal only if the stub never heard it. The counters are held
to what was actually sent, and the gateway's refusal of a signed name — which
under the switch is how a non-YouTube name is turned away — is held to count
for nothing.
*/

// signedLike is a name in the shape the gateway's sign() makes: URL-safe
// base64 of what the address is, a dot, and eighteen bytes of MAC in the same
// alphabet. The MAC is not a real one; checking it is the gateway's.
func signedLike(address string) string {
	body := base64.RawURLEncoding.EncodeToString([]byte(
		`{"u":"` + address + `","h":{},"e":` + strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + `}`))
	mac := base64.RawURLEncoding.EncodeToString([]byte("eighteen-bytes-mac"))

	return body + "." + mac
}

var (
	tubeVariant = signedLike("https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/96/index.m3u8")
	tubeSegment = signedLike("https://rr1---sn-x.googlevideo.com/videoplayback/sq/1/file/seg.ts")
)

// tubeDeployment is a deployment that relays nothing, with the Emby switch off
// and the YouTube switch as asked, and nobody granted anything.
func tubeDeployment(t *testing.T, on bool) *embyRig {
	t.Helper()

	rig := embyDeployment(t, true)

	if err := rig.st.SetEmbyRelay(false); err != nil {
		t.Fatal(err)
	}

	if err := rig.st.SetYouTubeRelay(on); err != nil {
		t.Fatal(err)
	}

	// The YouTube ticket's master playlist, naming its two pieces by signed
	// names, as the gateway rewrites YouTube's.
	rig.gateway.instead = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/media" || r.URL.Query().Get("t") != tubeTicket {
			return false
		}

		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia?t="+tubeVariant+"\n")

		return true
	}

	return rig
}

// refusedUnheard holds a name to a 404 the gateway never heard about.
func refusedUnheard(t *testing.T, rig *embyRig, name, why string) {
	t.Helper()

	if got := rig.media(name); got.Code != http.StatusNotFound {
		t.Errorf("%s: %s was answered %d", why, short(name), got.Code)
	}

	if rig.gateway.heard(name) {
		t.Errorf("%s: the gateway was asked to relay %s, and would have", why, short(name))
	}
}

func short(name string) string {
	if len(name) > 40 {
		return name[:20] + "…" + name[len(name)-12:]
	}

	return name
}

func TestWithTheYouTubeSwitchOffNoYouTubeIsRelayed(t *testing.T) {
	rig := tubeDeployment(t, false)

	resolved := rig.resolve("youtube")
	if resolved.Code != http.StatusOK || resolved.Header().Get("X-Watch-Relay") != "off" {
		t.Fatalf("a YouTube link with the switch off resolved %d with relay %q; it plays from where it is, and only so",
			resolved.Code, resolved.Header().Get("X-Watch-Relay"))
	}

	if _, ok := rig.st.WatchTicket(tubeTicket); ok {
		t.Error("a YouTube video was ledgered with the switch off")
	}

	if got := rig.get("/api/watch/info?t="+tubeTicket, nil); got.Header().Get("X-Watch-Relay") != "off" {
		t.Error("a YouTube video was described as relayed with the switch off")
	}

	for _, name := range []string{tubeTicket, tubeVariant, tubeSegment} {
		refusedUnheard(t, rig, name, "with the switch off")
	}

	// Turned on, a video resolved, then turned off again: what the ledger holds
	// stops with the switch, at once and for everybody.
	if err := rig.st.SetYouTubeRelay(true); err != nil {
		t.Fatal(err)
	}

	if got := rig.resolve("youtube"); got.Code != http.StatusOK {
		t.Fatalf("a YouTube link with the switch on resolved %d", got.Code)
	}

	if got := rig.media(tubeTicket); got.Code != http.StatusOK {
		t.Fatalf("the ledgered video came back %d with the switch on", got.Code)
	}

	if err := rig.st.SetYouTubeRelay(false); err != nil {
		t.Fatal(err)
	}

	before := len(rig.gateway.all())

	for _, name := range []string{tubeTicket, tubeVariant, tubeSegment} {
		if got := rig.media(name); got.Code != http.StatusNotFound {
			t.Errorf("%s was answered %d once the switch was turned off", short(name), got.Code)
		}
	}

	if after := len(rig.gateway.all()); after != before {
		t.Errorf("with the switch turned off the gateway was asked %d more times", after-before)
	}

	if got := rig.get("/api/watch/info?t="+tubeTicket, nil); got.Header().Get("X-Watch-Relay") != "off" {
		t.Error("a ledgered video was still described as relayed once the switch was turned off")
	}
}

func TestWithTheYouTubeSwitchOnAVideoIsRelayedForEverybody(t *testing.T) {
	rig := tubeDeployment(t, true)

	// listener holds no grant at all: none is asked for.
	resolved := rig.resolve("youtube")
	if resolved.Code != http.StatusOK {
		t.Fatalf("a YouTube link resolved %d", resolved.Code)
	}

	if got := resolved.Header().Get("X-Watch-Relay"); got != "" {
		t.Errorf("a YouTube video the deployment will relay was resolved with relay %q; "+
			"the resolver's own player would never try it", got)
	}

	grant, ok := rig.st.WatchTicket(tubeTicket)
	if !ok || grant.Kind != store.WatchYouTube || grant.Trip != "eeeeefffff" || grant.Name != "listener" {
		t.Fatalf("the video was ledgered as %+v (%v), want a YouTube video under whoever resolved it", grant, ok)
	}

	if got := rig.get("/api/watch/info?t="+tubeTicket, nil); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Errorf("a guest asking about the video was told %d with relay %q; their player would not try the relay",
			got.Code, got.Header().Get("X-Watch-Relay"))
	}

	// A guest, with no session, through the playlist to a segment.
	master := rig.media(tubeTicket)
	if master.Code != http.StatusOK || !strings.Contains(master.Body.String(), "media?t="+tubeVariant) {
		t.Fatalf("the video's playlist came back %d %q", master.Code, master.Body.String())
	}

	for _, name := range []string{tubeVariant, tubeSegment} {
		if got := rig.media(name); got.Code != http.StatusOK || !rig.gateway.heard(name) {
			t.Errorf("a signed piece of the video came back %d, gateway asked: %v", got.Code, rig.gateway.heard(name))
		}
	}

	// Resolved by a host for somebody else: no grant is spent, so nothing is
	// refused, and it is ledgered just the same.
	if got := rig.resolve("youtube", "for=other"); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Errorf("a host resolving somebody else's YouTube link got %d with relay %q",
			got.Code, got.Header().Get("X-Watch-Relay"))
	}
}

// The invariant the switch must not move: everything that is not YouTube's is
// as unrelayed with it on as with it off.
func TestTheYouTubeSwitchRelaysNothingElse(t *testing.T) {
	rig := tubeDeployment(t, true)

	for _, link := range []string{"bilibili", "https://example.invalid/v.mp4"} {
		got := rig.resolve(link)
		if got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s resolved %d with relay %q under the YouTube switch", link, got.Code, got.Header().Get("X-Watch-Relay"))
		}
	}

	for _, ticket := range []string{biliTicket, plainTicket} {
		if got := rig.get("/api/watch/info?t="+ticket, nil); got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s was described without saying there is no relay for it", ticket)
		}
	}

	// A film from a media server is still the Emby switch's, which is off.
	if got := rig.resolve("emby"); got.Code != http.StatusUnprocessableEntity {
		t.Errorf("a film resolved %d with only the YouTube switch on", got.Code)
	}

	for _, name := range []string{
		biliTicket, plainTicket, filmTicket, posterTicket,
		variantName, strayName,
		"anything-at-all-of-ticket-length",
		// Near the signed shape and not in it: the dot in the wrong place, a
		// MAC a character short or long, two dots, a body too short to be one.
		"abc.def.signed-name-the-gateway-made",
		tubeSegment[:len(tubeSegment)-1],
		tubeSegment + "A",
		strings.Replace(tubeSegment, ".", "", 1),
		"tiny." + strings.Repeat("A", 24),
		"eyJ1Ijoi" + strings.Repeat("A", 20) + "." + strings.Repeat("A", 23) + "/",
	} {
		refusedUnheard(t, rig, name, "under the YouTube switch")
	}
}

// The holder of a show refuses a film handed over by anybody but its grantor,
// and learns who that is from X-Watch-Grantor. A YouTube video named with one
// would be refused from everybody but whoever resolved it.
func TestAYouTubeVideoNamesNoGrantor(t *testing.T) {
	rig := tubeDeployment(t, true)

	if got := rig.resolve("youtube").Header().Get("X-Watch-Grantor"); got != "" {
		t.Errorf("a YouTube video was resolved as relayed under %q", got)
	}

	if got := rig.get("/api/watch/info?t="+tubeTicket, nil).Header().Get("X-Watch-Grantor"); got != "" {
		t.Errorf("a ledgered YouTube video was described as relayed under %q", got)
	}
}

/*
Resolving a YouTube link does not make somebody's Emby grant look as if it
stands.

Recording a film notes that its grantor's grant stands, so that a grant given
back is honoured at once (TestAFilmChosenRightAfterTheGrantIsGivenBackPlays).
The same note made for a YouTube video, which asks nothing of anybody, would
have a grant taken away a moment before honoured again for the half minute
because its holder pasted a YouTube link.
*/
func TestResolvingYouTubeDoesNotRenewAnEmbyGrant(t *testing.T) {
	rig := tubeDeployment(t, true)

	if err := rig.st.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	rig.grant(t, true)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	rig.grant(t, false)
	rig.at = rig.at.Add(grantKept)

	if got := rig.media(filmTicket); got.Code != http.StatusNotFound {
		t.Fatalf("a film whose grant was taken away came back %d", got.Code)
	}

	if got := rig.resolve("youtube"); got.Code != http.StatusOK {
		t.Fatalf("a YouTube link resolved %d", got.Code)
	}

	if got := rig.media(filmTicket); got.Code != http.StatusNotFound {
		t.Errorf("a film whose grant was taken away was relayed again after its holder resolved a YouTube link: %d", got.Code)
	}
}

// An entry of a kind this build does not know is relayed on nobody's terms:
// read as a film it would ride on its grantor's Emby, and as a video on the
// switch.
func TestALedgerEntryOfAnUnknownKindIsNotRelayed(t *testing.T) {
	rig := tubeDeployment(t, true)

	if err := rig.st.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	rig.grant(t, true)

	const later = "a-later-builds-ticket01"
	if err := rig.st.PutWatchTickets([]string{later}, store.WatchGrant{
		Name: "listener", Trip: "eeeeefffff", Expires: time.Now().Add(time.Hour), Kind: "something-later",
	}); err != nil {
		t.Fatal(err)
	}

	refusedUnheard(t, rig, later, "an entry of an unknown kind")

	if got := rig.get("/api/watch/info?t="+later, nil); got.Header().Get("X-Watch-Relay") != "off" {
		t.Error("an entry of an unknown kind was described as relayed")
	}
}

/*
What YouTube costs is counted apart from the films, and only what was sent.

The ticket's own bytes against whoever resolved it; the signed pieces, which
nothing ties to a ticket, in the figure for everybody; the two together on the
settings page beside the switch. The gateway's refusal of a signed name is not
YouTube being relayed — under the switch, it is how anything else is turned away
— and counted, it would be a figure that grew with every refusal.
*/
func TestYouTubeIsCountedApartFromTheFilms(t *testing.T) {
	rig := tubeDeployment(t, true)

	refused := signedLike("https://upos.example.invalid/bilibili.m4s")
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

	rig.resolve("youtube")

	ticketBytes := rig.media(tubeTicket).Body.Len()
	pieceBytes := rig.media(tubeVariant).Body.Len() + rig.media(tubeSegment).Body.Len()

	if got := rig.media(refused); got.Code != http.StatusNotFound || !rig.gateway.heard(refused) {
		t.Fatalf("the stub's refusal of a signed name came back %d", got.Code)
	}

	if ticketBytes == 0 || pieceBytes == 0 {
		t.Fatalf("%d and %d bytes were relayed; neither proves anything", ticketBytes, pieceBytes)
	}

	if by := rig.app.relayed.youtubeBy(); by["eeeeefffff"] != uint64(ticketBytes) || len(by) != 1 {
		t.Errorf("YouTube was counted by resolver as %v; the ticket's %d bytes are listener's", by, ticketBytes)
	}

	total := uint64(ticketBytes + pieceBytes)
	if got := rig.app.relayed.YouTubeSpent(); got != total {
		t.Errorf("YouTube's figure is %d; %d bytes of it were relayed, and the refusal was none of it", got, total)
	}

	if spent := rig.app.relayed.EmbySpent(); len(spent) != 0 {
		t.Errorf("YouTube was counted against the films as %v", spent)
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
		YouTubeRelay bool   `json:"youtubeRelay"`
		YouTubeSpent uint64 `json:"youtubeSpent"`
	}

	read := ask(rig.mux, reading)
	if err := json.Unmarshal(read.Body.Bytes(), &settings); err != nil {
		t.Fatalf("the settings did not read: %v (%s)", err, read.Body.String())
	}

	if !settings.YouTubeRelay || settings.YouTubeSpent != total {
		t.Errorf("the settings page says the switch is %v and %d bytes were relayed; it is on and %d were",
			settings.YouTubeRelay, settings.YouTubeSpent, total)
	}

	// A passphrase changed takes the figure with it.
	rig.app.relayed.MoveSpent("eeeeefffff", "tnewtrip00")

	if by := rig.app.relayed.youtubeBy(); by["tnewtrip00"] != uint64(ticketBytes) || by["eeeeefffff"] != 0 {
		t.Errorf("after a passphrase change the YouTube figure by resolver is %v", by)
	}
}

// A deployment that relays everything relays YouTube as it always did, whatever
// the switch says, and ledgers nothing for it.
func TestADeploymentThatRelaysEverythingIgnoresTheYouTubeSwitch(t *testing.T) {
	for _, on := range []bool{false, true} {
		rig := tubeDeployment(t, on)
		rig.app.conf.Meet.Watch.DirectOnly = false

		if got := rig.resolve("youtube"); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
			t.Errorf("switch %v: a YouTube link resolved %d with relay %q", on, got.Code, got.Header().Get("X-Watch-Relay"))
		}

		if _, ok := rig.st.WatchTicket(tubeTicket); ok {
			t.Errorf("switch %v: a deployment that relays everything ledgered a YouTube video", on)
		}

		for _, name := range []string{tubeTicket, tubeVariant, biliTicket} {
			if got := rig.media(name); got.Code != http.StatusOK {
				t.Errorf("switch %v: a deployment that relays everything answered %s with %d", on, short(name), got.Code)
			}
		}
	}
}

// Turning the switch off stops a video already playing at its next piece: a
// file relayed as one answer is a whole video, and a switch that waited for
// the end of it would not be one.
func TestTheYouTubeSwitchStopsALongAnswerAtOnce(t *testing.T) {
	release := make(chan struct{})
	sentFirst := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/resolve":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, resolvedAs("youtube"))
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

	if err := app.store.SetYouTubeRelay(true); err != nil {
		t.Fatal(err)
	}

	if got := musicGet(mux, "/api/watch/resolve?url=youtube", cookie); got.Code != http.StatusOK {
		t.Fatalf("a YouTube link resolved %d", got.Code)
	}

	var once sync.Once
	defer once.Do(func() { close(release) })

	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- musicGet(mux, "/api/watch/media?t="+tubeTicket, nil) }()

	<-sentFirst

	if err := app.store.SetYouTubeRelay(false); err != nil {
		t.Fatal(err)
	}

	once.Do(func() { close(release) })
	got := <-done

	if strings.Contains(got.Body.String(), "SECOND-PART") {
		t.Errorf("a video went on being relayed after the switch was turned off: %q", got.Body.String())
	}
}
