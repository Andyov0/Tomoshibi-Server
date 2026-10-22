package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
)

/*
The Android app's statement at /.well-known/assetlinks.json, through the router.

Everything that can go wrong with it goes wrong silently, on somebody else's
phone. A statement that is not byte for byte what the verifier expects, served
as some other type, or held by a cache past a change of key, is a phone that
opens every invitation in the browser and says nothing about why. So the tests
hold the exact text and the exact headers, and not a parse of them that a
differently shaped answer could also satisfy.

The other direction matters as much. A deployment with no Android app must not
claim one, whatever its client's fallback would answer for the address, and a
relay must not answer at all: no link names it, and an answer is what makes a
mainland relay a website.
*/

const (
	linkedPackage = "app.example.android"
	fingerprintA  = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"
	fingerprintB  = "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0"
)

// linkedApps is an apps section claiming the Android app, signed two ways.
func linkedApps() config.Apps {
	return config.Apps{AndroidPackage: linkedPackage, AndroidCertificates: []string{fingerprintA, fingerprintB}}
}

// pagesFor is the real router of a deployment that serves pages, in a role and
// with an apps section, and with a client whose fallback answers every path
// with a page: the placeholder a binary built without a client serves. A route
// left to the fallback is therefore a 200, which is what the tests below need
// to tell an address this router claims from one it merely does not.
func pagesFor(t *testing.T, role config.Role, apps config.Apps) http.Handler {
	t.Helper()

	_, _, app := controlWithStore(t, config.PickProbe)
	app.conf.Meet.Role = role
	app.conf.Meet.Apps = apps
	app.web = Placeholder([]byte("<!doctype html><title>the client</title>"))

	return app.Handler()
}

// relayFor is a relay's real router, built from a file that also claims the
// Android app and the Apple apps, as a fleet's relays often are: one file, the
// role changed.
func relayFor(t *testing.T, silent bool) http.Handler {
	t.Helper()

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:      config.RoleRelay,
			Silent:    silent,
			JoinRate:  1000,
			JoinBurst: 1000,
			SourceURL: source,
			Apps: config.Apps{
				AndroidPackage:      linkedPackage,
				AndroidCertificates: []string{fingerprintA, fingerprintB},
				AppleAppIDs:         appleApps().AppleAppIDs,
			},
		},
	}

	app := &App{
		conf:   conf,
		limit:  limit.New(1000, 1000, 0),
		admin:  admin.New(conf, nil, nil, nil),
		relays: newRelays(conf, nil),
		stop:   make(chan struct{}),
	}
	t.Cleanup(app.Close)

	return app.Handler()
}

// Asked as the verifier asks: no cookie, no session, nobody.
func askAssetLinks(mux http.Handler) *httptest.ResponseRecorder {
	return ask(mux, httptest.NewRequest(http.MethodGet, assetLinksPath, nil))
}

func TestTheAndroidStatementIsServedExactlyAndWithoutASession(t *testing.T) {
	// Written out rather than built by the code under test, so that a change
	// in the shape the handler marshals is a failure here and not a change in
	// what this compares against.
	want := `[{"relation":["delegate_permission/common.handle_all_urls"],` +
		`"target":{"namespace":"android_app","package_name":"app.example.android",` +
		`"sha256_cert_fingerprints":["` + fingerprintA + `","` + fingerprintB + `"]}}]`

	for _, role := range []config.Role{config.RoleControl, config.RoleFull} {
		got := askAssetLinks(pagesFor(t, role, linkedApps()))

		if got.Code != http.StatusOK {
			t.Fatalf("on a %s node the statement answered %d without a session; the verifier "+
				"has none, so anything but 200 leaves every invitation in the browser", role, got.Code)
		}

		if body := got.Body.String(); body != want {
			t.Errorf("on a %s node the statement is\n  %s\nwant\n  %s", role, body, want)
		}

		if kind := got.Header().Get("Content-Type"); kind != "application/json" {
			t.Errorf("on a %s node the statement is served as %q; the verifier reads it as "+
				"application/json and a page is not one", role, kind)
		}

		if caching := got.Header().Get("Cache-Control"); caching != "public, max-age=300" {
			t.Errorf("on a %s node the statement may be cached %q; a CDN keeps it as long as it "+
				"is told, and a phone verifying against a statement this server no longer makes "+
				"opens invitations in the browser", role, caching)
		}
	}
}

// With no Android app configured, the address is a 404 that nothing keeps, even
// on a deployment whose client would answer it with a page.
func TestADeploymentWithoutAnAndroidAppClaimsNone(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleFull} {
		got := askAssetLinks(pagesFor(t, role, config.Apps{MacDir: t.TempDir()}))

		if got.Code != http.StatusNotFound {
			t.Errorf("on a %s node with no Android app the statement's address answered %d; it "+
				"must be a 404, and left to the client's fallback it is a page", role, got.Code)
		}

		if strings.Contains(got.Body.String(), "android_app") {
			t.Errorf("on a %s node with no Android app the address claimed one: %s", role, got.Body)
		}

		if caching := got.Header().Get("Cache-Control"); caching != "no-store" {
			t.Errorf("on a %s node the 404 may be cached %q; an edge remembering it would fail "+
				"the first phones to install the app once it ships", role, caching)
		}
	}
}

// A relay carries the same apps section as its control node and answers none of
// it: not with the statement, and, when silent, not with anything.
func TestARelayDoesNotServeTheAndroidStatement(t *testing.T) {
	loud := askAssetLinks(relayFor(t, false))
	if loud.Code != http.StatusNotFound || strings.Contains(loud.Body.String(), "android_app") {
		t.Errorf("a relay answered the statement's address with %d: %s; no link names a relay, "+
			"and it serves no pages", loud.Code, loud.Body)
	}

	// silence() cannot hijack a recorder, so it says as little as it can
	// instead; what matters is that it is not the statement.
	quiet := askAssetLinks(relayFor(t, true))
	if quiet.Code == http.StatusOK || strings.Contains(quiet.Body.String(), "android_app") {
		t.Errorf("a silent relay answered the statement's address with %d: %s; an answer is "+
			"what identifies it as a website", quiet.Code, quiet.Body)
	}
}
