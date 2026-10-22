package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
The one film a deployment that relays nothing will relay.

Under meet.watch.direct_only the server carries nothing for anybody, except a
media server's film chosen by somebody granted Emby, on a deployment whose
switch is on. Everything that can go wrong with that goes wrong silently and
costs money: the gateway relays whatever it holds a ticket for, so a single
ticket that reached it which should not have is a YouTube film, or a Bilibili
file, carried at the deployment's expense for every viewer in the room, with
nothing on any screen to say so.

So these tests hold the media path to its ledger from the outside, through the
router, against a gateway stub that relays anything it is asked for and writes
down that it was asked. Each refusal is checked twice: that the answer was 404,
and that the gateway never heard the question — a 404 the gateway produced
would mean the server had passed the request on and been saved by the gateway's
own mode, which is the second line of defence and not the one under test.

The grant is checked from both ends: that it is needed to have a film relayed at
all, and that taking it away stops a film already playing within the half minute
the server keeps its answer for. The clock is the application's, moved by hand,
so that half minute is a fact of the test rather than of how long it took.
*/

const (
	filmTicket   = "embyfilm000000000000001"
	posterTicket = "embyposter0000000000001"
	tubeTicket   = "youtube0000000000000001"
	biliTicket   = "bilibili000000000000001"
	plainTicket  = "directfile0000000000001"
	// bangumiTicket is a Bilibili bangumi episode, which the gateway names the
	// pieces of after it; see bangumi_test.go.
	bangumiTicket = "bangumi0000000000000001"
)

var (
	variantName = "c" + strings.Repeat("a", 32)
	audioName   = "c" + strings.Repeat("b", 32)
	segmentName = "c" + strings.Repeat("d", 32)
	// strayName has the shape of a child and is named by no relayed playlist.
	strayName = "c" + strings.Repeat("e", 32)
)

// fakeWatch is a watch gateway that answers everything and remembers what it
// was asked. It relays any ticket at all, as the real one does, so that the only
// thing keeping a ticket from being relayed is the server.
type fakeWatch struct {
	mu    sync.Mutex
	asked []string

	// instead answers in place of the stub, where it says it has: for a test
	// that needs the gateway to say something the real one would not.
	instead func(w http.ResponseWriter, r *http.Request) bool
}

func (f *fakeWatch) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.asked = append(f.asked, r.URL.Path+"?"+r.URL.RawQuery)
	instead := f.instead
	f.mu.Unlock()

	if instead != nil && instead(w, r) {
		return
	}

	query := r.URL.Query()

	switch r.URL.Path {
	case "/ready":
		w.WriteHeader(http.StatusNoContent)

	case "/resolve":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, resolvedAs(query.Get("url")))

	case "/info":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket":"`+query.Get("t")+`","title":"x","play":{"kind":"relay"},"proxy":{"kind":"hls","url":"media?t=`+query.Get("t")+`"}}`)

	case "/library":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"servers":[{"key":"home","name":"Home"}]}`)

	case "/media":
		switch query.Get("t") {
		case filmTicket:
			// The master playlist: an audio rendition in an attribute, a
			// variant on a line of its own, and two names that are not
			// children — a ticket the gateway would relay, and a name one
			// character too long — which must not be taken for them.
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = io.WriteString(w, "#EXTM3U\n"+
				`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio",URI="media?t=`+audioName+`"`+"\n"+
				"#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO=\"a\"\n"+
				"media?t="+variantName+"\n"+
				"media?t="+tubeTicket+"\n"+
				"media?t="+strayName+"0\n")
		case variantName:
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = io.WriteString(w, "#EXTM3U\n#EXTINF:6.0,\nmedia?t="+segmentName+"\n#EXT-X-ENDLIST\n")
		case posterTicket:
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = io.WriteString(w, "JPEG")
		default:
			w.Header().Set("Content-Type", "video/mp2t")
			w.Header().Set("Cache-Control", "private, max-age=600")
			_, _ = io.WriteString(w, "SEGMENT-BYTES")
		}

	default:
		http.NotFound(w, r)
	}
}

// resolvedAs is what the gateway says a link plays, by a word in the link.
func resolvedAs(link string) string {
	answer := func(ticket, play, cover string) string {
		return `{"ticket":"` + ticket + `","title":"t","duration":60,"cover":"` + cover + `","link":"x","live":false,` +
			`"relay":false,"play":` + play + `,"proxy":{"kind":"hls","url":"media?t=` + ticket + `"}}`
	}

	switch {
	case strings.Contains(link, "emby") || strings.HasPrefix(link, "library:"):
		return answer(filmTicket, `{"kind":"relay"}`, "media?t="+posterTicket)
	case strings.Contains(link, "youtube"):
		return answer(tubeTicket, `{"kind":"youtube","id":"dQw4w9WgXcQ"}`, "https://i.ytimg.com/vi/x.jpg")
	case strings.Contains(link, "bangumi"):
		return answer(bangumiTicket, `{"kind":"bangumi"}`, "https://i0.hdslb.com/bfs/bangumi/x.jpg")
	case strings.Contains(link, "bilibili"):
		return answer(biliTicket, `{"kind":"file","url":"https://upos.example.invalid/v.mp4"}`, "")
	default:
		return answer(plainTicket, `{"kind":"file","url":"https://example.invalid/v.mp4"}`, "")
	}
}

// heard reports whether the gateway was asked anything about a ticket's media.
func (f *fakeWatch) heard(ticket string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, one := range f.asked {
		if one == "/media?t="+ticket {
			return true
		}
	}

	return false
}

func (f *fakeWatch) all() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.asked...)
}

// embyRig is a deployment with a watch gateway, one account signed in, and a
// clock the test moves.
type embyRig struct {
	mux     http.Handler
	app     *App
	st      *store.Store
	cookie  *http.Cookie
	gateway *fakeWatch
	at      time.Time
}

// embyDeployment is a deployment that relays nothing (or everything), with the
// switch on and nobody granted.
func embyDeployment(t *testing.T, directOnly bool) *embyRig {
	t.Helper()

	gateway := &fakeWatch{}
	upstream := httptest.NewServer(gateway)
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken, DirectOnly: directOnly}

	if err := app.store.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	rig := &embyRig{mux: mux, app: app, st: app.store, cookie: cookie, gateway: gateway, at: time.Now().UTC()}
	app.clock = func() time.Time { return rig.at }

	return rig
}

func (rig *embyRig) grant(t *testing.T, held bool) {
	t.Helper()

	if err := rig.st.SetAccountPerms("listener", map[string]bool{store.PermEmby: held}); err != nil {
		t.Fatal(err)
	}
}

func (rig *embyRig) get(path string, cookie *http.Cookie) *httptest.ResponseRecorder {
	return musicGet(rig.mux, path, cookie)
}

func (rig *embyRig) resolve(link string, extra ...string) *httptest.ResponseRecorder {
	path := "/api/watch/resolve?url=" + url.QueryEscape(link)
	for _, one := range extra {
		path += "&" + one
	}

	return rig.get(path, rig.cookie)
}

// media asks for a ticket's media as a guest would: with no session at all.
func (rig *embyRig) media(ticket string) *httptest.ResponseRecorder {
	return rig.get("/api/watch/media?t="+ticket, nil)
}

func TestAFilmIsRelayedOnlyForSomebodyGrantedEmby(t *testing.T) {
	rig := embyDeployment(t, true)

	refused := rig.resolve("https://emby.example.invalid/web/#!/item?id=1")
	if refused.Code != http.StatusForbidden || refusal(t, refused) != "emby_not_allowed" {
		t.Fatalf("somebody not granted Emby resolved a film: %d %s", refused.Code, refused.Body.String())
	}

	if strings.Contains(refused.Body.String(), filmTicket) {
		t.Error("the refusal carried the ticket, which is the film to anybody who reads it")
	}

	if got := rig.media(filmTicket); got.Code != http.StatusNotFound || rig.gateway.heard(filmTicket) {
		t.Fatalf("a film refused at resolve was relayed anyway: %d, gateway asked: %v", got.Code, rig.gateway.heard(filmTicket))
	}

	rig.grant(t, true)

	allowed := rig.resolve("library:home/1")
	if allowed.Code != http.StatusOK || !strings.Contains(allowed.Body.String(), filmTicket) {
		t.Fatalf("somebody granted Emby resolved a film and got %d %s", allowed.Code, allowed.Body.String())
	}

	if allowed.Header().Get("X-Watch-Relay") != "" {
		t.Error("a film the deployment agreed to relay was said to have no relay; nobody's player would try it")
	}

	if grant, ok := rig.st.WatchTicket(filmTicket); !ok || grant.Trip != "eeeeefffff" || grant.Name != "listener" {
		t.Errorf("the film's ticket was ledgered as %+v (%v), want under the person who chose it", grant, ok)
	} else if life := time.Until(grant.Expires); life < 11*time.Hour || life > 13*time.Hour {
		t.Errorf("the film is relayed for %v; it should be about twelve hours", life)
	}

	if _, ok := rig.st.WatchTicket(posterTicket); !ok {
		t.Error("the film's poster was not ledgered, so nobody in the room would see it")
	}

	if got := rig.media(filmTicket); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "#EXTM3U") {
		t.Errorf("a guest asking for the granted film got %d %q", got.Code, got.Body.String())
	}

	if got := rig.media(posterTicket); got.Code != http.StatusOK || got.Body.String() != "JPEG" {
		t.Errorf("a guest asking for the granted film's poster got %d %q", got.Code, got.Body.String())
	}
}

func TestAnAdministratorNeedsTheEmbyGrantLikeAnybodyElse(t *testing.T) {
	rig := embyDeployment(t, true)

	trip := room.Trip(tripKey, "the owner's passphrase")
	if err := rig.st.AddAdmin(store.Admin{Trip: trip, Name: "owner", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	owner := sessionFor(t, rig.st, "owner", trip)

	// Watching together is theirs without asking: every permission that
	// defaults to yes is.
	if got := rig.get("/api/watch/ready", owner).Code; got != http.StatusNoContent {
		t.Fatalf("an administrator asking whether they may watch together got %d", got)
	}

	if got := rig.get("/api/watch/resolve?url=emby", owner); got.Code != http.StatusForbidden || refusal(t, got) != "emby_not_allowed" {
		t.Fatalf("an administrator nobody granted Emby resolved a film: %d %s", got.Code, got.Body.String())
	}

	if got := rig.get("/api/watch/library?op=servers", owner).Code; got != http.StatusForbidden {
		t.Errorf("an administrator nobody granted Emby browsed the library: %d", got)
	}

	if err := rig.st.SetAdminPerms(trip, map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	if got := rig.get("/api/watch/resolve?url=emby", owner).Code; got != http.StatusOK {
		t.Errorf("an administrator granted Emby was refused a film: %d", got)
	}

	if got := rig.get("/api/watch/library?op=servers", owner).Code; got != http.StatusOK {
		t.Errorf("an administrator granted Emby was refused the library: %d", got)
	}
}

func TestAFilmResolvedOnSomebodyElsesBehalfIsRefused(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	got := rig.resolve("emby", "for=other")
	if got.Code != http.StatusForbidden || refusal(t, got) != "emby_not_allowed" {
		t.Fatalf("a granted host resolving a film somebody else added got %d %s; "+
			"a guest would be spending the host's grant", got.Code, got.Body.String())
	}

	if _, ok := rig.st.WatchTicket(filmTicket); ok {
		t.Error("a refused film was written into the ledger")
	}

	// Anything else resolved for somebody else is as it was.
	if other := rig.resolve("youtube", "for=other"); other.Code != http.StatusOK {
		t.Errorf("a host resolving somebody else's YouTube link got %d", other.Code)
	}

	for _, asked := range rig.gateway.all() {
		if strings.Contains(asked, "for=") {
			t.Errorf("the gateway was asked %q; the parameter is this server's", asked)
		}
	}
}

// The invariant the whole of watchledger.go exists for.
func TestNothingButAGrantedFilmIsEverRelayed(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	// The film's own playlist, which names a YouTube ticket and a name one
	// character too long beside its real children.
	if got := rig.media(filmTicket); got.Code != http.StatusOK {
		t.Fatalf("the granted film's playlist came back %d", got.Code)
	}

	for _, link := range []string{"youtube", "bilibili", "https://example.invalid/v.mp4"} {
		got := rig.resolve(link)
		if got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s resolved with %d and relay %q; it plays from where it is, and only so",
				link, got.Code, got.Header().Get("X-Watch-Relay"))
		}
	}

	for _, ticket := range []string{
		tubeTicket, biliTicket, plainTicket,
		strayName, strayName + "0",
		"abc.def.signed-name-the-gateway-made",
		"anything-at-all-of-ticket-length",
	} {
		if got := rig.media(ticket); got.Code != http.StatusNotFound {
			t.Errorf("%s was answered %d by a deployment that relays nothing", ticket, got.Code)
		}

		if rig.gateway.heard(ticket) {
			t.Errorf("the gateway was asked to relay %s; it would have", ticket)
		}
	}
}

func TestAPieceOfAFilmIsRelayedOnlyUnderTheFilm(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	// Before the film's playlist has been relayed, nothing has named its
	// children, and a name of the right shape is only a shape.
	if got := rig.media(variantName); got.Code != http.StatusNotFound || rig.gateway.heard(variantName) {
		t.Fatalf("a child nobody's playlist named was answered %d", got.Code)
	}

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	master := rig.media(filmTicket)
	if master.Code != http.StatusOK || !strings.Contains(master.Body.String(), "media?t="+variantName) {
		t.Fatalf("the film's playlist came back %d %q", master.Code, master.Body.String())
	}

	for _, name := range []string{variantName, audioName} {
		if grant, ok := rig.st.WatchTicket(name); !ok || grant.Trip != "eeeeefffff" {
			t.Errorf("%s, named by the film's playlist, was not ledgered under the film's grant", name)
		}
	}

	variant := rig.media(variantName)
	if variant.Code != http.StatusOK || !strings.Contains(variant.Body.String(), segmentName) {
		t.Fatalf("the variant playlist came back %d %q", variant.Code, variant.Body.String())
	}

	segment := rig.media(segmentName)
	if segment.Code != http.StatusOK || segment.Body.String() != "SEGMENT-BYTES" {
		t.Fatalf("a segment of the granted film came back %d %q", segment.Code, segment.Body.String())
	}

	if segment.Header().Get("Cache-Control") != "private, max-age=600" {
		t.Errorf("the gateway's word on caching a segment was lost: %q", segment.Header().Get("Cache-Control"))
	}
}

func TestTakingTheGrantAwayStopsAFilmAlreadyPlaying(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	rig.resolve("emby")
	rig.media(filmTicket)
	rig.media(variantName)

	if got := rig.media(segmentName); got.Code != http.StatusOK {
		t.Fatalf("a segment of the granted film came back %d", got.Code)
	}

	rig.grant(t, false)

	// Within the half minute the answer is kept, the film plays on. Not a
	// promise anybody needs, but the bound the page states, checked from the
	// side that would notice it being exceeded below.
	rig.at = rig.at.Add(10 * time.Second)
	if got := rig.media(segmentName); got.Code != http.StatusOK {
		t.Logf("the revocation bit inside the half minute (%d), which is allowed", got.Code)
	}

	rig.at = rig.at.Add(grantKept)

	before := len(rig.gateway.all())

	for _, name := range []string{segmentName, variantName, filmTicket, posterTicket} {
		if got := rig.media(name); got.Code != http.StatusNotFound {
			t.Errorf("%s was relayed %v after the grant was taken away: %d", name, 10*time.Second+grantKept, got.Code)
		}
	}

	if after := len(rig.gateway.all()); after != before {
		t.Errorf("the gateway was asked %v after the grant was taken away", rig.gateway.all()[before:])
	}

	if got := rig.get("/api/watch/info?t="+filmTicket, nil); got.Header().Get("X-Watch-Relay") != "off" {
		t.Error("a film whose grant was taken away was still described as relayed")
	}

	// Given back, it plays again — the ledger is not emptied by a revocation,
	// only not honoured while it lasts.
	rig.grant(t, true)
	rig.at = rig.at.Add(grantKept)

	if got := rig.media(segmentName); got.Code != http.StatusOK {
		t.Errorf("a segment of a film whose grant was given back came back %d", got.Code)
	}

	// And blocking the grantor is taking it away.
	blocked, _ := rig.st.Account("listener")
	blocked.Blocked = true
	if err := rig.st.UpdateAccount("listener", blocked); err != nil {
		t.Fatal(err)
	}
	rig.at = rig.at.Add(grantKept)

	if got := rig.media(segmentName); got.Code != http.StatusNotFound {
		t.Errorf("a segment of a film chosen by somebody since blocked came back %d", got.Code)
	}
}

func TestWithTheSwitchOffNothingIsRelayed(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	rig.resolve("emby")

	if err := rig.st.SetEmbyRelay(false); err != nil {
		t.Fatal(err)
	}

	before := len(rig.gateway.all())

	for _, path := range []string{
		"/api/watch/media?t=" + filmTicket,
		"/api/watch/media?t=" + posterTicket,
		"/api/watch/library?op=servers",
	} {
		if got := rig.get(path, rig.cookie).Code; got != http.StatusNotFound {
			t.Errorf("%s answered %d with the switch off", path, got)
		}
	}

	if after := len(rig.gateway.all()); after != before {
		t.Errorf("with the switch off the gateway was asked %v", rig.gateway.all()[before:])
	}

	// Unavailable, as the gateway said it before there was a switch, and not
	// the person's refusal: listener holds the grant, and being told the media
	// servers were not opened to them would be untrue.
	if got := rig.resolve("emby"); got.Code != http.StatusUnprocessableEntity || refusal(t, got) != "unavailable" {
		t.Errorf("a film resolved by somebody granted Emby with the switch off answered %d %s",
			got.Code, got.Body.String())
	}

	// And the same to somebody without the grant: with the switch off nobody
	// is refused anything particular to them.
	rig.grant(t, false)

	if got := rig.resolve("emby"); got.Code != http.StatusUnprocessableEntity || refusal(t, got) != "unavailable" {
		t.Errorf("a film resolved by somebody not granted Emby with the switch off answered %d %s",
			got.Code, got.Body.String())
	}

	rig.grant(t, true)

	for _, path := range []string{"/api/watch/ready", "/api/watch/resolve?url=youtube", "/api/watch/info?t=" + filmTicket} {
		got := rig.get(path, rig.cookie)
		if got.Code/100 != 2 || got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s answered %d with relay %q; with the switch off the deployment relays nothing and says so",
				path, got.Code, got.Header().Get("X-Watch-Relay"))
		}
	}
}

func TestEveryTicketIsToldWhetherItIsRelayed(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	rig.resolve("emby")
	rig.resolve("youtube")

	if got := rig.get("/api/watch/info?t="+filmTicket, nil); got.Code != http.StatusOK || got.Header().Get("X-Watch-Relay") != "" {
		t.Errorf("the granted film was described with %d and relay %q; the room's players would not try the relay",
			got.Code, got.Header().Get("X-Watch-Relay"))
	}

	for _, ticket := range []string{tubeTicket, "a-ticket-nobody-ledgered"} {
		if got := rig.get("/api/watch/info?t="+ticket, nil); got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s was described without saying there is no relay for it", ticket)
		}
	}

	// A deployment that relays everything says nothing about either, as it
	// never did.
	rig.app.conf.Meet.Watch.DirectOnly = false

	for _, ticket := range []string{filmTicket, tubeTicket} {
		if got := rig.get("/api/watch/info?t="+ticket, nil); got.Header().Get("X-Watch-Relay") != "" {
			t.Errorf("a deployment that relays everything said %q about %s", got.Header().Get("X-Watch-Relay"), ticket)
		}
	}
}

func TestADeploymentThatRelaysEverythingStillNeedsTheGrantForAFilm(t *testing.T) {
	rig := embyDeployment(t, false)

	// The switch is the guard on a deployment that relays nothing else; one
	// that relays everything has already decided to spend.
	if err := rig.st.SetEmbyRelay(false); err != nil {
		t.Fatal(err)
	}

	if got := rig.resolve("emby"); got.Code != http.StatusForbidden || refusal(t, got) != "emby_not_allowed" {
		t.Fatalf("somebody not granted Emby resolved a film on a deployment that relays everything: %d", got.Code)
	}

	if got := rig.media(tubeTicket); got.Code != http.StatusOK || !rig.gateway.heard(tubeTicket) {
		t.Fatalf("a deployment that relays everything did not relay a YouTube ticket: %d", got.Code)
	}

	rig.grant(t, true)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("somebody granted Emby was refused a film: %d", got.Code)
	}

	if got := rig.media(filmTicket); got.Code != http.StatusOK {
		t.Fatalf("the granted film came back %d", got.Code)
	}

	rig.grant(t, false)
	rig.at = rig.at.Add(grantKept)

	if got := rig.media(filmTicket); got.Code != http.StatusNotFound {
		t.Errorf("a film whose grant was taken away was still relayed on a deployment that relays everything: %d", got.Code)
	}
}

func TestWhatIsRelayedIsCountedAgainstWhoeverChoseIt(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	trip := room.Trip(tripKey, "the owner's passphrase")
	if err := rig.st.AddAdmin(store.Admin{Trip: trip, Name: "owner", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	// Built again now there is somebody to sign in to the management pages.
	rig.mux = rig.app.Handler()

	rig.resolve("emby")
	sent := len(rig.media(filmTicket).Body.String())
	sent += len(rig.media(variantName).Body.String())
	sent += len(rig.media(segmentName).Body.String())

	// What is not relayed under a grant is nobody's to be charged.
	rig.app.conf.Meet.Watch.DirectOnly = false
	rig.media(tubeTicket)

	signed := ask(rig.mux, asking(http.MethodPost, "/api/admin/session", "",
		`{"name":"owner","passphrase":"the owner's passphrase"}`))
	if signed.Code != http.StatusOK {
		t.Fatalf("signing in to the management pages answered %d", signed.Code)
	}

	listing := httptest.NewRequest(http.MethodGet, "/api/admin/accounts", nil)
	for _, cookie := range signed.Result().Cookies() {
		listing.AddCookie(cookie)
	}

	listed := ask(rig.mux, listing)

	var accounts []struct {
		Name      string `json:"name"`
		EmbySpent uint64 `json:"embySpent"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &accounts); err != nil {
		t.Fatalf("the accounts list did not read: %v (%s)", err, listed.Body.String())
	}

	found := false

	for _, account := range accounts {
		if account.Name == "listener" {
			found = true

			if account.EmbySpent != uint64(sent) {
				t.Errorf("the accounts page says %d bytes were relayed for listener; %d were", account.EmbySpent, sent)
			}
		}
	}

	if !found || sent == 0 {
		t.Fatalf("the accounts page listed %s and %d bytes were relayed; neither proves anything",
			listed.Body.String(), sent)
	}
}

func TestADescriptionThatCannotBeReadIsNotPassedOn(t *testing.T) {
	// The long one is a refusal, because a long description that succeeded
	// would fail to read as JSON whatever the bound said; it is the answer
	// that would otherwise be passed on cut short that the bound is for.
	for name, answer := range map[string]struct {
		status int
		body   string
	}{
		"not json": {http.StatusOK, `<html>a film</html>`},
		"too long": {http.StatusNotFound, `{"error":"` + strings.Repeat("x", resolveLimit) + `"}`},
	} {
		t.Run(name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(answer.status)
				_, _ = io.WriteString(w, answer.body)
			}))
			t.Cleanup(upstream.Close)

			mux, app, cookie := signedInApp(t)
			app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken}

			if got := musicGet(mux, "/api/watch/resolve?url=x", cookie); got.Code != http.StatusBadGateway {
				t.Errorf("a description that could not be read whole came back %d; "+
					"it cannot be told apart from a film that plays only through the relay", got.Code)
			}
		})
	}
}

// A film relayed as one long answer — a file rather than a playlist of
// segments — is one request for its whole length, and a grant asked about only
// at its first byte would run to the end of it.
func TestTakingTheGrantAwayStopsALongAnswerPartway(t *testing.T) {
	sentFirst := make(chan struct{})
	release := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/resolve":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, resolvedAs("emby"))
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

	if err := app.store.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	if err := app.store.SetAccountPerms("listener", map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	// Read from the request's goroutine and moved from this one.
	var clock sync.Mutex
	at := time.Now().UTC()
	app.clock = func() time.Time {
		clock.Lock()
		defer clock.Unlock()
		return at
	}

	if got := musicGet(mux, "/api/watch/resolve?url=emby", cookie); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- musicGet(mux, "/api/watch/media?t="+filmTicket, nil) }()

	<-sentFirst

	if err := app.store.SetAccountPerms("listener", nil); err != nil {
		t.Fatal(err)
	}

	clock.Lock()
	at = at.Add(grantKept)
	clock.Unlock()

	close(release)
	got := <-done

	if strings.Contains(got.Body.String(), "SECOND-PART") {
		t.Errorf("a film went on being relayed %v after its grant was taken away: %q", grantKept, got.Body.String())
	}
}

// mentioned reports whether the gateway was asked anything at all that names a
// ticket, on any path and in any position of the query: a name it never sees is
// one it cannot relay, whatever its own parser makes of the rest.
func (f *fakeWatch) mentioned(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, one := range f.asked {
		if strings.Contains(one, name) {
			return true
		}
	}

	return false
}

/*
The ledger is consulted about one reading of the query and the gateway is asked
another, unless what the gateway is asked is built from the reading that was
checked.

This server reads a query with url.ParseQuery, which skips a pair holding a
semicolon and leaves a '#' inside the value; the request to the gateway is
built with url.Parse, which cuts the query at '#'; the gateway reads the first
of several values and this server reads the first too, but only by agreement.
Each shape below puts a ledgered film where this server looks and a YouTube
ticket where the gateway would, and the YouTube ticket must never reach the
gateway at all, on either path that takes a ticket.
*/
func TestTheGatewayIsAskedOnlyForTheTicketThatWasChecked(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	for _, query := range []string{
		// Cut at the fragment on the way out, skipped for the semicolon here.
		"t=" + tubeTicket + "#;&t=" + filmTicket,
		// The ledgered one first, for this server; the other for a gateway that
		// reads the last.
		"t=" + filmTicket + "&t=" + tubeTicket,
		"t=" + posterTicket + "&t=" + tubeTicket + "&u=https://x.invalid/",
		// A pair with a semicolon in it, which this server skips and a gateway
		// may not.
		"t=" + tubeTicket + ";x&t=" + filmTicket,
	} {
		for _, path := range []string{"/api/watch/media?", "/api/watch/info?"} {
			got := rig.get(path+query, nil)

			if rig.gateway.mentioned(tubeTicket) {
				t.Fatalf("%s%s reached the gateway naming the YouTube ticket (answered %d): %v",
					path, query, got.Code, rig.gateway.all())
			}

			// Not asked of media: the film's own playlist in the stub names
			// the YouTube ticket on purpose (see fakeWatch).
			if path == "/api/watch/info?" && strings.Contains(got.Body.String(), tubeTicket) {
				t.Errorf("%s%s answered with the YouTube ticket's description", path, query)
			}
		}
	}

	for _, asked := range rig.gateway.all() {
		if strings.Contains(asked, "u=") {
			t.Errorf("the gateway was asked %q; only the ticket is the gateway's to read", asked)
		}
	}
}

// A deployment that relays everything still refuses a film whose grant was
// taken away (TestADeploymentThatRelaysEverythingStillNeedsTheGrantForAFilm),
// so its info has to say so too, or every viewer's player tries a relay that
// answers 404 instead of reading the film as unplayable here.
func TestInfoSaysOffWhereverMediaWouldRefuse(t *testing.T) {
	rig := embyDeployment(t, false)
	rig.grant(t, true)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	info := func(ticket string) *httptest.ResponseRecorder {
		return rig.get("/api/watch/info?t="+ticket, nil)
	}

	if got := info(filmTicket); got.Header().Get("X-Watch-Relay") != "" {
		t.Fatalf("a film whose grant stands was said to have no relay: %q", got.Header().Get("X-Watch-Relay"))
	}

	rig.grant(t, false)
	rig.at = rig.at.Add(grantKept)

	if got := rig.media(filmTicket); got.Code != http.StatusNotFound {
		t.Fatalf("a film whose grant was taken away was relayed: %d", got.Code)
	}

	if got := info(filmTicket); got.Header().Get("X-Watch-Relay") != "off" {
		t.Errorf("a film whose grant was taken away was described as relayed on a deployment that relays everything")
	}

	// Anything else on such a deployment is relayed, and is said nothing.
	if got := info(tubeTicket); got.Header().Get("X-Watch-Relay") != "" {
		t.Errorf("a deployment that relays everything said %q about a YouTube ticket", got.Header().Get("X-Watch-Relay"))
	}
}

// The holder of a show queues a relayed film only from whoever's grant it is,
// and learns whose it is from these.
func TestAFilmSaysWhoseGrantItIsRelayedUnder(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	resolved := rig.resolve("emby")
	if got := resolved.Header().Get("X-Watch-Grantor"); got != "eeeeefffff" {
		t.Errorf("the resolve that recorded a film named its grantor %q", got)
	}

	if got := rig.get("/api/watch/info?t="+filmTicket, nil).Header().Get("X-Watch-Grantor"); got != "eeeeefffff" {
		t.Errorf("the film's info named its grantor %q", got)
	}

	if got := rig.resolve("youtube").Header().Get("X-Watch-Grantor"); got != "" {
		t.Errorf("a YouTube link was said to be relayed under %q", got)
	}

	if got := rig.get("/api/watch/info?t="+tubeTicket, nil).Header().Get("X-Watch-Grantor"); got != "" {
		t.Errorf("a ticket nobody's grant covers was said to be under %q", got)
	}
}

// chunks is an answer that says each piece as it is written, so a test can move
// the clock between two of them knowing the first has been through the relay.
type chunks struct {
	*httptest.ResponseRecorder
	wrote chan string
}

func (c *chunks) Write(p []byte) (int, error) {
	n, err := c.ResponseRecorder.Write(p)
	c.wrote <- string(p)
	return n, err
}

// longFilm is a deployment relaying nothing but granted films, whose gateway
// answers a film's media as one long answer in three parts, each sent when the
// test says.
type longFilm struct {
	mux     http.Handler
	app     *App
	cookie  *http.Cookie
	release chan struct{}

	clock sync.Mutex
	at    time.Time
}

func longFilmDeployment(t *testing.T) *longFilm {
	t.Helper()

	rig := &longFilm{release: make(chan struct{}), at: time.Now().UTC()}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/resolve":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, resolvedAs("emby"))
		case "/media":
			if r.URL.Query().Get("t") != filmTicket {
				w.Header().Set("Content-Type", "image/jpeg")
				_, _ = io.WriteString(w, "JPEG")
				return
			}

			w.Header().Set("Content-Type", "video/mp4")
			for _, part := range []string{"PART1", "PART2", "PART3"} {
				_, _ = io.WriteString(w, part)
				w.(http.Flusher).Flush()
				if part != "PART3" {
					<-rig.release
				}
			}
		}
	}))
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken, DirectOnly: true}

	if err := app.store.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	if err := app.store.SetAccountPerms("listener", map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	// Read from the request's goroutine and moved from the test's.
	app.clock = func() time.Time {
		rig.clock.Lock()
		defer rig.clock.Unlock()
		return rig.at
	}

	rig.mux, rig.app, rig.cookie = mux, app, cookie

	return rig
}

func (rig *longFilm) move(by time.Duration) {
	rig.clock.Lock()
	defer rig.clock.Unlock()
	rig.at = rig.at.Add(by)
}

// play starts the film's long answer and hands back what it writes, piece by
// piece, and the whole answer once it is over.
func (rig *longFilm) play() (*chunks, chan struct{}) {
	answer := &chunks{ResponseRecorder: httptest.NewRecorder(), wrote: make(chan string, 8)}
	done := make(chan struct{})

	go func() {
		rig.mux.ServeHTTP(answer, httptest.NewRequest(http.MethodGet, "/api/watch/media?t="+filmTicket, nil))
		close(done)
	}()

	return answer, done
}

/*
A revocation bites within grantKept of being made, even when somebody else's
request has just refreshed the answer the relay keeps.

The long answer asked only every grantKept, and asked the kept answer, which can
itself be grantKept old: so an answer that began just before the kept answer
ran out, beside a request that refreshed it just before the grant was taken
away, went on for twice grantKept after the revocation.
*/
func TestARevocationStopsALongAnswerWithinTheHalfMinute(t *testing.T) {
	rig := longFilmDeployment(t)

	if got := musicGet(rig.mux, "/api/watch/resolve?url=emby", rig.cookie); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	// Just inside the answer kept at resolve.
	rig.move(grantKept - 100*time.Millisecond)
	answer, done := rig.play()

	if first := <-answer.wrote; first != "PART1" {
		t.Fatalf("the film began with %q", first)
	}

	// Another viewer's request finds the kept answer out of date and asks
	// again: the grant stands, and that is kept for another grantKept.
	rig.move(100 * time.Millisecond)
	if got := musicGet(rig.mux, "/api/watch/media?t="+posterTicket, nil); got.Code != http.StatusOK {
		t.Fatalf("the poster came back %d", got.Code)
	}

	rig.move(10 * time.Millisecond)
	if err := rig.app.store.SetAccountPerms("listener", nil); err != nil {
		t.Fatal(err)
	}

	// The long answer's own half minute is up, a moment short of the kept
	// answer's.
	rig.move(grantKept - 110*time.Millisecond)
	rig.release <- struct{}{}

	close(rig.release)
	<-done

	if body := answer.Body.String(); strings.Contains(body, "PART2") {
		t.Errorf("the film went on %v after its grant was taken away, on a kept answer: %q",
			grantKept-110*time.Millisecond, body)
	}
}

// Turning the switch off stops a long answer at its next piece, not at its
// next half minute: the switch is the thing that stops everything at once.
func TestTheSwitchStopsALongAnswerAtOnce(t *testing.T) {
	rig := longFilmDeployment(t)

	if got := musicGet(rig.mux, "/api/watch/resolve?url=emby", rig.cookie); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	answer, done := rig.play()

	if first := <-answer.wrote; first != "PART1" {
		t.Fatalf("the film began with %q", first)
	}

	if err := rig.app.store.SetEmbyRelay(false); err != nil {
		t.Fatal(err)
	}

	rig.move(time.Second)
	rig.release <- struct{}{}

	close(rig.release)
	<-done

	if body := answer.Body.String(); strings.Contains(body, "PART2") {
		t.Errorf("the film went on after the switch was turned off: %q", body)
	}
}

// Browsing the library is relayed through this server as well — every poster
// in it, fetched again on every visit — and is spent on the same person's
// grant, so the figure beside their Emby badge counts it.
func TestBrowsingTheLibraryIsCountedAgainstWhoeverBrowses(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	sent := 0

	for _, path := range []string{"/api/watch/library?op=servers", "/api/watch/library?op=image&server=home&id=1&tag=x"} {
		got := rig.get(path, rig.cookie)
		if got.Code != http.StatusOK {
			t.Fatalf("%s came back %d", path, got.Code)
		}

		sent += got.Body.Len()
	}

	if spent := rig.app.relayed.EmbySpent()["eeeeefffff"]; sent == 0 || spent != uint64(sent) {
		t.Errorf("browsing the library relayed %d bytes and %d were counted against the person browsing", sent, spent)
	}
}

// Recording a film notes that its grant stands. Without that, a grant taken
// away and given back within the half minute the relay keeps its answer would
// go on refusing the new film for the rest of it: the player gives up on a
// playlist that answers 404, and the film plays for nobody.
func TestAFilmChosenRightAfterTheGrantIsGivenBackPlays(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, false)

	// The relay is asked about listener while they hold nothing, and keeps
	// "no" for the half minute.
	if err := rig.st.PutWatchTickets([]string{posterTicket}, store.WatchGrant{
		Name: "listener", Trip: "eeeeefffff", Expires: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	if got := rig.media(posterTicket); got.Code != http.StatusNotFound {
		t.Fatalf("a ticket under a grant that does not stand came back %d", got.Code)
	}

	rig.grant(t, true)
	rig.at = rig.at.Add(time.Second)

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the film did not resolve once the grant was given back: %d", got.Code)
	}

	if got := rig.media(filmTicket); got.Code != http.StatusOK {
		t.Errorf("a film chosen a second after the grant was given back came back %d", got.Code)
	}
}

// A playlist longer than this server reads for names is refused, and nothing it
// named is ledgered: sent, it would be a film whose every segment answered 404.
func TestAPlaylistTooLongToReadIsRefused(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	rig.gateway.instead = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/media" || r.URL.Query().Get("t") != filmTicket {
			return false
		}

		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = io.WriteString(w, "#EXTM3U\nmedia?t="+variantName+"\n")
		// Nine megabytes, written out rather than taken from playlistLimit: a
		// playlist sized by the constant under test would grow with it and pass
		// whatever the bound said.
		_, _ = io.WriteString(w, "#"+strings.Repeat("x", 9<<20)+"\n")

		return true
	}

	if got := rig.resolve("emby"); got.Code != http.StatusOK {
		t.Fatalf("the granted film did not resolve: %d", got.Code)
	}

	if got := rig.media(filmTicket); got.Code != http.StatusBadGateway {
		t.Errorf("a playlist of nine megabytes came back %d", got.Code)
	}

	if _, ok := rig.st.WatchTicket(variantName); ok {
		t.Error("a name in a playlist that was refused was ledgered")
	}
}

// A film the gateway files under something that is not a ticket is refused at
// resolve and never ledgered: the ledger would otherwise hold a name of any
// shape the gateway made, a signed YouTube name among them.
func TestAFilmFiledUnderSomethingThatIsNotATicketIsRefused(t *testing.T) {
	rig := embyDeployment(t, true)
	rig.grant(t, true)

	const signed = "abc.def.signed-name-the-gateway-made"

	rig.gateway.instead = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/resolve" {
			return false
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ticket":"`+signed+`","title":"t","play":{"kind":"relay"},`+
			`"proxy":{"kind":"hls","url":"media?t=`+signed+`"}}`)

		return true
	}

	if got := rig.resolve("emby"); got.Code != http.StatusBadGateway {
		t.Errorf("a film filed under %q resolved with %d", signed, got.Code)
	}

	if _, ok := rig.st.WatchTicket(signed); ok {
		t.Error("a film filed under something that is not a ticket was ledgered")
	}
}
