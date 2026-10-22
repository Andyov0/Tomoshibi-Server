package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
The door to the watch gateway.

What would go wrong unnoticed: resolving opened to anybody, so that the
deployment does the work for strangers; relaying closed to guests, so that the
people in the call who are not signed in see nothing; a relay that passes on a
request with no token, or a path the gateway was never meant to be asked; and
the gateway's verdict on a viewer's expired token reported as this server's
misconfiguration, or the other way round.
*/

const watchToken = "a-watch-token-long-enough-to-trust"

func watchApp(t *testing.T, gateway http.Handler) (http.Handler, *http.Cookie) {
	t.Helper()

	upstream := httptest.NewServer(gateway)
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken}
	return mux, cookie
}

func TestThereIsNoWatchingWhereNoneIsConfigured(t *testing.T) {
	mux, _, cookie := signedInApp(t)

	if got := musicGet(mux, "/api/watch/ready", cookie).Code; got != http.StatusNotFound {
		t.Fatalf("a deployment with no watch gateway answered %d; the client reads 404 as none", got)
	}
}

func TestOnlySomebodySignedInMayResolveALink(t *testing.T) {
	reached := false
	mux, _ := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))

	for _, path := range []string{"/api/watch/ready", "/api/watch/resolve?url=https%3A%2F%2Fexample.invalid%2Fv"} {
		if got := musicGet(mux, path, nil).Code; got != http.StatusUnauthorized {
			t.Errorf("%s answered %d to somebody not signed in", path, got)
		}
	}
	if reached {
		t.Fatal("the gateway was asked on behalf of somebody not signed in")
	}
}

func TestAGuestIsRelayedWhatTheTokenNames(t *testing.T) {
	var token, span, sentToken string
	mux, _ := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, span, sentToken = r.URL.Query().Get("t"), r.Header.Get("Range"), r.Header.Get("X-Watch-Token")
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 0-3/100")
		w.Header().Set("Cache-Control", "private, max-age=600")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "abcd")
	}))

	got := musicGet(mux, "/api/watch/media?t=signed.token", nil, "Range", "bytes=0-3")

	if got.Code != http.StatusPartialContent || got.Body.String() != "abcd" {
		t.Fatalf("a guest's relay came back %d %q", got.Code, got.Body.String())
	}
	if token != "signed.token" || span != "bytes=0-3" || sentToken != watchToken {
		t.Fatalf("the gateway was asked with token %q, range %q and server token %q", token, span, sentToken)
	}
	if got.Header().Get("Cache-Control") != "private, max-age=600" || got.Header().Get("Content-Range") != "bytes 0-3/100" {
		t.Fatalf("the relay's headers were not passed on: %v", got.Header())
	}
	if strings.Contains(got.Body.String()+strings.Join(got.Header().Values("X-Watch-Token"), ""), watchToken) {
		t.Fatal("the server's token reached the browser")
	}
}

func TestNothingIsRelayedWithoutAToken(t *testing.T) {
	reached := false
	mux, cookie := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))

	if got := musicGet(mux, "/api/watch/media", cookie).Code; got != http.StatusNotFound || reached {
		t.Fatalf("a relay with no token answered %d and reached the gateway: %v", got, reached)
	}
}

func TestOnlyTheWatchGatewaysOwnPathsArePassedOn(t *testing.T) {
	reached := false
	mux, cookie := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))

	for _, path := range []string{"/api/watch/admin", "/api/watch/sources", "/api/watch/proxy?u=x"} {
		if got := musicGet(mux, path, cookie).Code; got != http.StatusNotFound {
			t.Errorf("%s answered %d", path, got)
		}
	}
	if reached {
		t.Fatal("the gateway was asked a path it does not offer")
	}
}

func TestAnOldTicketIsTheViewersAndARefusedServerIsTheDeployments(t *testing.T) {
	status := http.StatusGone
	mux, cookie := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
	}))

	for _, path := range []string{"/api/watch/media?t=old", "/api/watch/info?t=old"} {
		if got := musicGet(mux, path, nil).Code; got != http.StatusGone {
			t.Errorf("%s with a ticket gone came back %d; the viewer needs to know it is gone", path, got)
		}
	}

	status = http.StatusForbidden
	for _, path := range []string{"/api/watch/media?t=x", "/api/watch/info?t=x"} {
		if got := musicGet(mux, path, nil).Code; got != http.StatusBadGateway {
			t.Errorf("%s with the gateway refusing this server came back %d; it is this deployment's to fix", path, got)
		}
	}
	if got := musicGet(mux, "/api/watch/resolve?url=x", cookie).Code; got != http.StatusBadGateway {
		t.Errorf("resolve with the gateway refusing this server came back %d", got)
	}
}

func TestARelayedAnswerIsMediaAndNeverAPage(t *testing.T) {
	mux, _ := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<script>alert(document.cookie)</script>")
	}))

	got := musicGet(mux, "/api/watch/media?t=a-ticket", nil)

	if kind := got.Header().Get("Content-Type"); kind != "application/octet-stream" {
		t.Errorf("a relayed page came back as %q; on this origin it would run as one", kind)
	}
	if got.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(got.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("a relayed answer was not fenced off: %v", got.Header())
	}
}

func TestAGuestMayReadWhatATicketPlays(t *testing.T) {
	var asked string
	mux, _ := watchApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Path + "?" + r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"title":"x"}`)
	}))

	if got := musicGet(mux, "/api/watch/info?t=a-ticket", nil); got.Code != http.StatusOK || asked != "/info?t=a-ticket" {
		t.Fatalf("a guest's ticket came back %d and reached the gateway as %q", got.Code, asked)
	}
	if got := musicGet(mux, "/api/watch/info", nil).Code; got != http.StatusNotFound {
		t.Fatalf("info with no ticket answered %d", got)
	}
}

func TestOnlySomebodyGrantedEmbyMayBrowseTheLibrary(t *testing.T) {
	reached := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.Header().Set("Content-Type", "image/svg+xml")
		_, _ = io.WriteString(w, "<svg/>")
	}))
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken}

	if got := musicGet(mux, "/api/watch/library?op=servers", nil).Code; got != http.StatusUnauthorized || reached {
		t.Fatalf("a guest browsing the library got %d and reached the gateway: %v", got, reached)
	}

	// Signed in is no longer enough: every item in the library plays only
	// through the relay, and the relay is the grant's.
	if got := musicGet(mux, "/api/watch/library?op=servers", cookie); got.Code != http.StatusForbidden ||
		refusal(t, got) != "not_allowed" || reached {
		t.Fatalf("somebody signed in and not granted Emby got %d %s and reached the gateway: %v",
			got.Code, got.Body.String(), reached)
	}

	if err := app.store.SetAccountPerms("listener", map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	got := musicGet(mux, "/api/watch/library?op=image&server=a&id=1", cookie)
	if got.Code != http.StatusOK {
		t.Fatalf("somebody granted Emby got %d", got.Code)
	}
	if kind := got.Header().Get("Content-Type"); kind != "application/octet-stream" {
		t.Errorf("an SVG poster came back as %q; it is a document that can carry script", kind)
	}
}

func TestADeploymentThatRelaysNothingPassesNoMediaThrough(t *testing.T) {
	var asked []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	t.Cleanup(upstream.Close)
	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken, DirectOnly: true}

	for _, path := range []string{"/api/watch/media?t=a-ticket", "/api/watch/library?op=servers"} {
		if got := musicGet(mux, path, cookie).Code; got != http.StatusNotFound {
			t.Errorf("%s answered %d on a deployment that relays nothing", path, got)
		}
	}
	if len(asked) != 0 {
		t.Fatalf("the gateway was asked %v", asked)
	}

	for _, path := range []string{"/api/watch/ready", "/api/watch/resolve?url=https%3A%2F%2Fexample.invalid%2Fv", "/api/watch/info?t=a-ticket"} {
		got := musicGet(mux, path, cookie)
		if got.Code != http.StatusOK {
			t.Errorf("%s answered %d; reading a link is still done", path, got.Code)
		}
		if got.Header().Get("X-Watch-Relay") != "off" {
			t.Errorf("%s did not say there is no relay, so a viewer's player would try one", path)
		}
	}
}
