package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

/*
Which files a browser may keep, and for how long.

The rule is simple and was applied to one file instead of three. Assets are
named after their contents, so a changed asset is a changed URL and the old one
can be kept forever. A document's name never changes, so it must be revalidated
or a deployment reaches nobody who has visited before.

This deployment serves three documents. Only the client was named, so the
management and account pages went out as immutable for a year — and immutable is
not a cache that goes stale and recovers, it is a promise a browser takes at its
word and a CDN repeats per edge. The symptom is a fix that reaches some people
and not others, indefinitely, and looks exactly like a build that never
deployed.
*/
func TestEveryDocumentIsRevalidatedAndEveryAssetIsNot(t *testing.T) {
	documents := []string{"index.html", "admin.html", "account.html"}

	for _, name := range documents {
		if got := caching(name); got != "no-cache" {
			t.Errorf("%s is served %q. A document keeps its name across every build, so one "+
				"a browser is told it may keep is one that never gets the next deployment",
				name, got)
		}
	}

	// And the other half, which is what makes the first half affordable.
	for _, name := range []string{
		"assets/index-CUiA9y28.js",
		"assets/loader-circle-DystNjoV.css",
		"flags/cn.svg",
	} {
		if got := caching(name); got == "no-cache" {
			t.Errorf("%s is served %q; a file named after its contents can be kept forever, "+
				"and revalidating every one of them is a request per asset per visit",
				name, got)
		}
	}
}

// Framed under a lure, a signed-in administrator's click can be made to land on
// a button that closes somebody's meeting. The meeting itself stays framable,
// since embedding one in a site of one's own is a use and not an attack.
func TestOnlyTheSignedInPagesRefuseToBeFramed(t *testing.T) {
	web := Web(fstest.MapFS{
		"index.html":   {Data: []byte("<!doctype html>")},
		"admin.html":   {Data: []byte("<!doctype html>")},
		"account.html": {Data: []byte("<!doctype html>")},
	})

	ask := func(path string) http.Header {
		recorder := httptest.NewRecorder()
		web.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Header()
	}

	for _, path := range []string{"/admin.html", "/account.html"} {
		if got := ask(path).Get("Content-Security-Policy"); got != "frame-ancestors 'none'" {
			t.Errorf("%s may be framed: Content-Security-Policy is %q", path, got)
		}
		if got := ask(path).Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("%s may be framed by older browsers: X-Frame-Options is %q", path, got)
		}
	}
	for _, path := range []string{"/", "/some/room"} {
		if got := ask(path).Get("Content-Security-Policy"); got != "" {
			t.Errorf("the meeting page at %s refuses to be framed: Content-Security-Policy is %q", path, got)
		}
	}
}

/*
Serving the copy that was compressed at build time.

One file needs this: MediaPipe's vision runtime, which background blur cannot
work without and which is nine megabytes uncompressed. The published copies are
on jsdelivr and Google's storage and neither answers from mainland China, so it
has to come from here, and here is a binary copied to every relay.

Only the compressed copy is stored. That makes two things load-bearing that
would otherwise be cosmetic, and both are asserted below.

The Content-Type has to come from the name that was asked for. Served under the
stored name a wasm file goes out as application/x-brotli or as nothing at all,
and WebAssembly.instantiateStreaming refuses it — as a corrupt module, which
says nothing about the cause.

And Vary has to be set, because a cache in front of this would otherwise hand
the compressed bytes to a client that did not ask for them.
*/
func TestTheCompressedCopyIsServedUnderTheRealName(t *testing.T) {
	files := fstest.MapFS{
		"index.html":  &fstest.MapFile{Data: []byte("<html></html>")},
		"big.wasm.br": &fstest.MapFile{Data: []byte("squashed")},
	}

	request := httptest.NewRequest(http.MethodGet, "/big.wasm", nil)
	request.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")

	answer := httptest.NewRecorder()
	Web(files).ServeHTTP(answer, request)

	if answer.Code != http.StatusOK {
		t.Fatalf("asked for big.wasm and got %d. Only the compressed copy is stored, so a "+
			"handler that does not look for it serves nothing at all", answer.Code)
	}

	if got := answer.Body.String(); got != "squashed" {
		t.Errorf("body = %q, want the compressed bytes", got)
	}

	if got := answer.Header().Get("Content-Encoding"); got != "br" {
		t.Errorf("Content-Encoding = %q, want br. Without it the browser takes compressed "+
			"bytes for the file itself", got)
	}

	if got := answer.Header().Get("Content-Type"); !strings.Contains(got, "wasm") {
		t.Errorf("Content-Type = %q. It has to come from the name that was asked for, or "+
			"instantiateStreaming refuses the module and blames the module", got)
	}

	if got := answer.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("Vary = %q, want Accept-Encoding. A cache in front of this would otherwise "+
			"hand compressed bytes to somebody who did not ask for them", got)
	}
}

/*
And that a browser refusing brotli is not handed it anyway.

The header is read whole rather than searched for "br", which is a substring of
plenty of things that are not brotli, and an explicit q=0 is a refusal.
*/
func TestBrotliIsOnlySentWhereItIsWanted(t *testing.T) {
	for _, one := range []struct {
		header string
		want   bool
	}{
		{"gzip, deflate, br", true},
		{"br;q=1.0, gzip;q=0.8", true},
		{" BR ", true},
		{"gzip, deflate", false},
		{"", false},
		{"br;q=0", false},
		// Not brotli, and the reason the header is split rather than searched.
		{"brotli-ng", false},
		{"gzip;q=0.8, identity", false},
	} {
		if got := acceptsBrotli(one.header); got != one.want {
			t.Errorf("acceptsBrotli(%q) = %v, want %v", one.header, got, one.want)
		}
	}
}
