package app

import (
	"encoding/json"
	"net/http"

	"tomoshibi/internal/config"
)

/*
The statement that lets the Android app open this deployment's links.

An invitation is a link to this deployment, https://<deployment>/?invite=…, and
on a phone with the Android app it should open in the app. Android lets an app
take an https link without asking only once the site has said the app may: at
install, the phone's verifier fetches /.well-known/assetlinks.json from each host
the app's intent filter names, and looks there for a statement naming the app's
package and the fingerprint of a key it is signed with. Without one the link
opens in the browser, or behind a question about which app to use, and nothing
on the phone or here says why.

	GET /.well-known/assetlinks.json

	[{"relation":["delegate_permission/common.handle_all_urls"],
	  "target":{"namespace":"android_app","package_name":"<package>",
	            "sha256_cert_fingerprints":["<fingerprint>", …]}}]

No session, because the verifier has none and is not anybody: the statement is
public by design, and says no more than the app itself does to whoever unpacks
it. The package and fingerprints come from meet.apps (android_package and
android_certificates), checked at startup in internal/config.

Where neither is set the address is a 404, and is still claimed by this router
rather than left to the client's fallback. A deployment without an Android app
must not claim one, and what the fallback answers is not this file's to decide:
the placeholder served when no client was built answers every path with a page,
and a web_root on disk serves whatever somebody put in it.

Not served by a relay, which returns from the router before this is mounted.
The links Android is asked to open are the deployment's own address, the one
the page was loaded from (web/src/live/host.ts builds an invitation from the
address bar), and no link anybody is given names a relay. A relay serves no
pages, and one in mainland China must answer nothing that would make it a
website; see silent.go.
*/

// assetLinksPath is where every verifier asks. Fixed by the Digital Asset
// Links protocol, so it is not a setting.
const assetLinksPath = "/.well-known/assetlinks.json"

// assetLinksCaching is how long a browser, or the CDN in front of the real
// deployment, may go on answering with a statement it was given.
//
// Five minutes, chosen against the two things the number trades. Caching saves
// this server next to nothing: the file is asked for once when the app is
// installed or updated, so the busiest it gets is the burst after a release is
// announced, and five minutes is enough for the CDN to absorb that burst rather
// than pass every one of it here. Holding it longer costs something real. The
// statement changes when a signing key is added or replaced, and a phone that
// installs while an edge still holds the old one fails to verify and goes on
// opening invitations in the browser until something makes it verify again,
// which is ordinarily the app's next update. Five minutes is a corrected
// fingerprint reaching every phone by the time somebody has finished deploying
// it and picked the phone up.
//
// Public, because the answer is the same for everybody and behind no session,
// so a shared cache may keep it. The download endpoints beside this are
// private for the opposite reason.
const assetLinksCaching = "public, max-age=300"

// assetStatement is one statement of the Digital Asset Links protocol. Fields
// in the order the protocol's own examples write them, which is the order they
// are marshalled in.
type assetStatement struct {
	Relation []string    `json:"relation"`
	Target   assetTarget `json:"target"`
}

type assetTarget struct {
	Namespace    string   `json:"namespace"`
	PackageName  string   `json:"package_name"`
	Fingerprints []string `json:"sha256_cert_fingerprints"`
}

// assetLinks is the file for a configuration, or nil where it claims no
// Android app.
//
// Made once, when the router is built: the configuration does not change
// while the process runs, and a statement assembled per request is one more
// place for two requests to disagree.
func assetLinks(apps config.Apps) []byte {
	if !apps.AndroidLinked() {
		return nil
	}

	statement, err := json.Marshal([]assetStatement{{
		// handle_all_urls is the relation that lets the app open this site's
		// links. Nothing else is granted: the other relation Android reads
		// here, get_login_creds, would share the password manager's entries
		// for this site with the app, which is a decision about the passphrase
		// nobody has made.
		Relation: []string{"delegate_permission/common.handle_all_urls"},
		Target: assetTarget{
			Namespace:    "android_app",
			PackageName:  apps.AndroidPackage,
			Fingerprints: apps.AndroidCertificates,
		},
	}})
	if err != nil {
		// Strings and slices of strings cannot fail to marshal.
		panic(err)
	}

	return statement
}

func (a *App) mountAssetLinks(mux *http.ServeMux) {
	statement := assetLinks(a.conf.Meet.Apps)

	mux.HandleFunc("GET "+assetLinksPath, func(w http.ResponseWriter, r *http.Request) {
		if statement == nil {
			// An absence is not kept anywhere. The day the Android app ships is
			// the day these keys are added and the server restarted, and the
			// first phones to install it ask at once; an edge still holding
			// yesterday's 404 would fail every one of them, each until that
			// phone next has a reason to verify.
			w.Header().Set("Cache-Control", "no-store")
			http.NotFound(w, r)

			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", assetLinksCaching)
		_, _ = w.Write(statement)
	})
}
