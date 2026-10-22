package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
The door to a music library.

What would go wrong silently: a library anybody could play from, a token that
reached the browser, a Range that did not get through (and a track that can
only be played from the start, after downloading all of it), and a gateway
refusing this server's token being shown to somebody as their own failure.
*/

const musicToken = "a-token-long-enough-for-the-gateway"

// musicApp is a control node with a library at a fake gateway, and a session
// for somebody signed in.
func musicApp(t *testing.T, gateway http.Handler) (http.Handler, *http.Cookie) {
	t.Helper()

	upstream := httptest.NewServer(gateway)
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Music = config.Music{URL: upstream.URL, Token: musicToken}
	return mux, cookie
}

// signedInApp is a control node with one account signed in, and its cookie.
func signedInApp(t *testing.T) (http.Handler, *App, *http.Cookie) {
	t.Helper()

	mux, st, app := controlWithStore(t, config.PickProbe)

	account := store.Account{Name: "listener", Trip: "eeeeefffff"}
	if err := st.AddAccount(account); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	if err := st.KeepSession("a-music-session", store.Session{
		Trip: account.Trip, Name: account.Name, Kind: "account", Opened: now, Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	return mux, app, &http.Cookie{Name: "meet-live.account", Value: "a-music-session"}
}

func musicGet(mux http.Handler, path string, cookie *http.Cookie, header ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}
	return ask(mux, request)
}

func TestThereIsNoLibraryWhereNoneIsConfigured(t *testing.T) {
	mux, _, _ := controlWithStore(t, config.PickProbe)

	if got := musicGet(mux, "/api/music/sources", nil).Code; got != http.StatusNotFound {
		t.Fatalf("a deployment with no library answered %d; the client reads 404 as none", got)
	}
}

func TestOnlySomebodySignedInMayUseTheLibrary(t *testing.T) {
	reached := false
	mux, _ := musicApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
	}))

	got := musicGet(mux, "/api/music/search?source=a&q=b", nil)
	if got.Code != http.StatusUnauthorized {
		t.Fatalf("somebody not signed in got %d from the library; it is somebody's subscription", got.Code)
	}
	if reached {
		t.Fatal("the gateway was asked on behalf of somebody not signed in")
	}
}

func TestTheLibraryIsAskedWithTheTokenWhichNeverReachesTheBrowser(t *testing.T) {
	var path, query, token string
	mux, cookie := musicApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, query, token = r.URL.Path, r.URL.RawQuery, r.Header.Get("X-Music-Token")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Gateway-Detail", "not for the browser")
		_, _ = io.WriteString(w, `{"tracks":[]}`)
	}))

	got := musicGet(mux, "/api/music/search?source=a&q=sunny+day", cookie)

	if got.Code != http.StatusOK || got.Body.String() != `{"tracks":[]}` {
		t.Fatalf("the search came back %d %q", got.Code, got.Body)
	}
	if path != "/search" || query != "source=a&q=sunny+day" {
		t.Fatalf("the gateway was asked %q ? %q", path, query)
	}
	if token != musicToken {
		t.Fatalf("the gateway was sent token %q", token)
	}
	if strings.Contains(got.Body.String(), musicToken) || got.Header().Get("X-Gateway-Detail") != "" {
		t.Fatal("something only the gateway should see reached the browser")
	}
}

func TestAudioIsStreamedWithItsRange(t *testing.T) {
	var span string
	mux, cookie := musicApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		span = r.Header.Get("Range")
		w.Header().Set("Content-Type", "audio/flac")
		w.Header().Set("Content-Range", "bytes 4-7/100")
		w.Header().Set("Content-Length", "4")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "fLaC")
	}))

	got := musicGet(mux, "/api/music/audio?source=a&id=b", cookie, "Range", "bytes=4-7")

	if span != "bytes=4-7" {
		t.Fatalf("the gateway was asked for range %q; a track could only be played from its start", span)
	}
	if got.Code != http.StatusPartialContent || got.Header().Get("Content-Range") != "bytes 4-7/100" ||
		got.Header().Get("Content-Type") != "audio/flac" || got.Body.String() != "fLaC" {
		t.Fatalf("the audio came back %d %v %q", got.Code, got.Header(), got.Body)
	}
}

func TestALinkIsPassedOnForTheGatewayToRead(t *testing.T) {
	var query string
	mux, cookie := musicApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.Query().Get("text")
		_, _ = io.WriteString(w, `{"tracks":[]}`)
	}))

	if got := musicGet(mux, "/api/music/link?text=a+shared+link", cookie).Code; got != http.StatusOK || query != "a shared link" {
		t.Fatalf("a pasted link came back %d and reached the gateway as %q", got, query)
	}
}

func TestOnlyTheLibrarysOwnPathsArePassedOn(t *testing.T) {
	reached := false
	mux, cookie := musicApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
	}))

	if got := musicGet(mux, "/api/music/login?x=1", cookie).Code; got != http.StatusNotFound || reached {
		t.Fatalf("a path the library does not have was passed on (%d, reached=%v)", got, reached)
	}
}

func TestAGatewayRefusingThisServerIsNotSaidToBeTheListenersFault(t *testing.T) {
	mux, cookie := musicApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":"refused"}`)
	}))

	if got := musicGet(mux, "/api/music/sources", cookie).Code; got != http.StatusBadGateway {
		t.Fatalf("a token mismatch reached the listener as %d", got)
	}
}
