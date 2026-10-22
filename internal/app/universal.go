package app

import (
	"encoding/json"
	"net/http"

	"tomoshibi/internal/config"
)

/*
The statement that lets the iOS and Mac apps open this deployment's links.

assetlinks.go is the same thing for Android, and carries most of the argument;
what differs is Apple's.

An invitation is https://<deployment>/?invite=…#/room and a meeting link is the
same with ?meeting=, and on an iPhone, an iPad or a Mac with the app installed
either should open in the app. Apple calls that a universal link, and lets an
app have one only once the site agrees: when the app is installed, and from
time to time after, the device asks Apple's CDN for
/.well-known/apple-app-site-association on each domain the app's Associated
Domains entitlement names, the CDN fetches it from here, and the device looks
in it for the app's identifier and for a pattern the link matches. Without a
statement, or with one that names the app wrongly, the link opens in Safari,
and nothing on the device says why.

	GET /.well-known/apple-app-site-association

	{"applinks":{"details":[{
	  "appIDs":["<team>.<bundle>", …],
	  "components":[{"/":"/","?":{"invite":"?*"}},
	                {"/":"/","?":{"meeting":"?*"}}]}]}}

The components are the current form, which Apple's devices have read since
iOS 13 and macOS 10.15; the older "paths" list is not written, because no
version of the apps runs on anything that old. Each component is a pattern
matched against one part of the link: "/" the path, which is the root exactly,
since every link the deployment hands out is at its root; "?" the query, given
as a dictionary so that only the named item is matched and anything else in
the query is left alone, and "?*" — one character, then any number — so that
an empty invite= is not a link the app is asked to open. The fragment, where
the room is, is not matched: a component that leaves a part out matches it
whatever it is.

Only those two. A bare address, or a room's own address #/room, is the web
client and stays in Safari: the app has nothing for it to do that the page
does not, and a pattern for the root alone would take every visit to the site
into the app, the lobby and the management pages included. Nothing else is
claimed either — no webcredentials, which would hand the password manager's
entries for this site to the app, for the reason assetlinks.go gives for not
asking Android for get_login_creds.

No session and no redirect: Apple's CDN has neither, and follows no redirect
for this file. The identifiers come from meet.apps.apple_app_ids, checked at
startup in internal/config. Where none is set the address is a 404 claimed by
this router, for the reason the Android statement's is.

Not served by a relay, which returns from the router before this is mounted;
see assetlinks.go.
*/

// appleSiteAssociationPath is where every Apple device asks, through Apple's
// CDN. Fixed by Apple, so it is not a setting.
const appleSiteAssociationPath = "/.well-known/apple-app-site-association"

// The statement's shape, in the order Apple's own examples write it, which is
// the order it is marshalled in.
type appleSiteAssociation struct {
	AppLinks appleAppLinks `json:"applinks"`
}

type appleAppLinks struct {
	Details []appleLinkDetail `json:"details"`
}

type appleLinkDetail struct {
	AppIDs     []string         `json:"appIDs"`
	Components []appleComponent `json:"components"`
}

// appleComponent is one pattern a link is matched against. Path and Query are
// written under the keys Apple reads, which are "/" and "?".
type appleComponent struct {
	Path  string            `json:"/"`
	Query map[string]string `json:"?"`
}

// appleSiteAssociationFor is the file for a configuration, or nil where it
// claims no Apple app. Made once, when the router is built, as the Android
// statement is.
func appleSiteAssociationFor(apps config.Apps) []byte {
	if !apps.AppleLinked() {
		return nil
	}

	statement, err := json.Marshal(appleSiteAssociation{AppLinks: appleAppLinks{Details: []appleLinkDetail{{
		AppIDs: apps.AppleAppIDs,
		Components: []appleComponent{
			{Path: "/", Query: map[string]string{"invite": "?*"}},
			{Path: "/", Query: map[string]string{"meeting": "?*"}},
		},
	}}}})
	if err != nil {
		// Strings, slices and maps of strings cannot fail to marshal.
		panic(err)
	}

	return statement
}

func (a *App) mountAppleSiteAssociation(mux *http.ServeMux) {
	statement := appleSiteAssociationFor(a.conf.Meet.Apps)

	mux.HandleFunc("GET "+appleSiteAssociationPath, func(w http.ResponseWriter, r *http.Request) {
		if statement == nil {
			// Not kept by anything in front, for the reason the Android
			// statement's absence is not: the day the identifiers are added
			// is the day the first devices ask.
			w.Header().Set("Cache-Control", "no-store")
			http.NotFound(w, r)

			return
		}

		w.Header().Set("Content-Type", "application/json")

		// The Android statement's five minutes, for the same reasons. Apple's
		// CDN keeps the file on a schedule of its own whatever this says, so
		// what the number decides is how long the deployment's own CDN may go
		// on handing that one the old statement after an identifier changes.
		w.Header().Set("Cache-Control", assetLinksCaching)
		_, _ = w.Write(statement)
	})
}
