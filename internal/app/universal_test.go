package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/config"
)

/*
The Apple apps' statement at /.well-known/apple-app-site-association, through
the router.

The same class of fault as the Android statement's, on other people's devices
and just as quietly: a statement Apple's CDN cannot read, served as another
type, behind a session, or naming the apps or the links wrongly, is every
invitation opening in Safari with nothing saying why. So the text is held
exactly, keys and patterns and all, and not as a parse a differently shaped
answer could also satisfy — "/" and "?" are the keys Apple reads, and a field
marshalled under its Go name would parse here and match nothing there.

And the other direction: no identifiers is a 404 nothing keeps, whatever the
client's fallback would answer for the address, and a relay answers none of
it.
*/

const (
	iosAppID = "ABCDE12345.app.example.ios"
	macAppID = "ABCDE12345.app.example.mac"
)

func appleApps() config.Apps {
	return config.Apps{AppleAppIDs: []string{iosAppID, macAppID}}
}

// Asked as Apple's CDN asks: no cookie, no session, nobody.
func askAppleSiteAssociation(mux http.Handler) *httptest.ResponseRecorder {
	return ask(mux, httptest.NewRequest(http.MethodGet, appleSiteAssociationPath, nil))
}

func TestTheAppleStatementIsServedExactlyAndWithoutASession(t *testing.T) {
	// Written out rather than built by the code under test: a change in the
	// shape the handler marshals has to be a failure here.
	want := `{"applinks":{"details":[{"appIDs":["` + iosAppID + `","` + macAppID + `"],` +
		`"components":[{"/":"/","?":{"invite":"?*"}},{"/":"/","?":{"meeting":"?*"}}]}]}}`

	for _, role := range []config.Role{config.RoleControl, config.RoleFull} {
		got := askAppleSiteAssociation(pagesFor(t, role, appleApps()))

		if got.Code != http.StatusOK {
			t.Fatalf("on a %s node the statement answered %d without a session; Apple's CDN has "+
				"none, so anything but 200 leaves every invitation in Safari", role, got.Code)
		}

		if body := got.Body.String(); body != want {
			t.Errorf("on a %s node the statement is\n  %s\nwant\n  %s", role, body, want)
		}

		if kind := got.Header().Get("Content-Type"); kind != "application/json" {
			t.Errorf("on a %s node the statement is served as %q; Apple reads it only as "+
				"application/json", role, kind)
		}

		if caching := got.Header().Get("Cache-Control"); caching != "public, max-age=300" {
			t.Errorf("on a %s node the statement may be cached %q", role, caching)
		}

		if where := got.Header().Get("Location"); where != "" {
			t.Errorf("on a %s node the statement redirects to %q; Apple follows no redirect for it", role, where)
		}
	}
}

// The Android claim and the Apple one are separate settings, and either alone
// is served alone.
func TestTheTwoStatementsAreClaimedApart(t *testing.T) {
	androidOnly := pagesFor(t, config.RoleControl, linkedApps())
	if got := askAppleSiteAssociation(androidOnly); got.Code != http.StatusNotFound {
		t.Errorf("a deployment claiming only the Android app answered the Apple statement with %d: %s",
			got.Code, got.Body)
	}

	appleOnly := pagesFor(t, config.RoleControl, appleApps())
	if got := askAssetLinks(appleOnly); got.Code != http.StatusNotFound {
		t.Errorf("a deployment claiming only the Apple apps answered the Android statement with %d: %s",
			got.Code, got.Body)
	}
}

func TestADeploymentWithoutAnAppleAppClaimsNone(t *testing.T) {
	for _, role := range []config.Role{config.RoleControl, config.RoleFull} {
		got := askAppleSiteAssociation(pagesFor(t, role, config.Apps{MacDir: t.TempDir()}))

		if got.Code != http.StatusNotFound {
			t.Errorf("on a %s node with no Apple app the statement's address answered %d; it must be "+
				"a 404, and left to the client's fallback it is a page", role, got.Code)
		}

		if strings.Contains(got.Body.String(), "applinks") {
			t.Errorf("on a %s node with no Apple app the address claimed one: %s", role, got.Body)
		}

		if caching := got.Header().Get("Cache-Control"); caching != "no-store" {
			t.Errorf("on a %s node the 404 may be cached %q", role, caching)
		}
	}
}

func TestARelayDoesNotServeTheAppleStatement(t *testing.T) {
	for _, silent := range []bool{false, true} {
		got := askAppleSiteAssociation(relayFor(t, silent))
		if got.Code == http.StatusOK || strings.Contains(got.Body.String(), "applinks") {
			t.Errorf("a relay (silent %v) answered the Apple statement's address with %d: %s",
				silent, got.Code, got.Body)
		}
	}
}
