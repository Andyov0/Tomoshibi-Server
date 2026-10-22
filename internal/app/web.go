package app

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// index is the document every unclaimed path falls back to, so that reloading a
// nested route reaches the client rather than a 404.
const index = "index.html"

// unframed are the documents whose buttons act as whoever is signed in.
var unframed = map[string]bool{"admin.html": true, "account.html": true}

// Web serves the client out of files.
//
// Takes an fs.FS rather than a directory so the same handler covers both the
// copy built into the binary and one read off disk during development. The
// caller decides which; nothing below can tell the difference.
func Web(files fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = index
		}

		// A copy compressed once at build time, where there is one and the
		// browser will take it.
		//
		// This exists for one file. Background blur needs MediaPipe's vision
		// runtime, which is nine megabytes of WebAssembly, and every way of
		// getting it is worse than this one: the published copies live on
		// jsdelivr and on Google's storage, and neither is reachable from
		// mainland China, which is where most of the people using this are. So
		// it is served from here, and nine megabytes in the binary is nine
		// megabytes copied to every relay on every deployment.
		//
		// Compressed it is under two. Only the compressed copy is kept, because
		// keeping both would be four megabytes to save a request from a browser
		// that predates 2016 — and a browser that old cannot run the blur it
		// would be downloading. Where one is not accepted the file is simply not
		// there, which the client already handles: it offers blur only where it
		// works and says so once when it does not.
		//
		// Content-Type comes from the real name rather than the stored one, or
		// WebAssembly.instantiateStreaming refuses a wasm file served as
		// application/x-brotli and the failure reads as a corrupt module.
		if encoded, kind := precompressed(files, name, r.Header.Get("Accept-Encoding")); encoded != nil {
			w.Header().Set("Content-Encoding", kind)
			w.Header().Set("Vary", "Accept-Encoding")
			w.Header().Set("Cache-Control", caching(name))
			http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(encoded))

			return
		}

		content, err := fs.ReadFile(files, name)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				http.Error(w, "the client could not be read", http.StatusInternalServerError)
				return
			}

			// An unknown path is a client-side route; an unknown asset is
			// genuinely missing. Answering the document for a missing asset
			// would turn a 404 into a syntax error in the console, which says
			// far less about what went wrong.
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}

			name = index
			if content, err = fs.ReadFile(files, name); err != nil {
				http.Error(w, "the client is not built", http.StatusNotFound)
				return
			}
		}

		w.Header().Set("Cache-Control", caching(name))

		// The management and account pages may not be drawn inside anybody
		// else's page. Framed invisibly under a lure, a signed-in
		// administrator's click on something innocent lands on "Close this
		// room" instead, and the session cookie goes with it because the
		// request is to this origin. Only those two: a meeting embedded in
		// somebody's own site is a reasonable thing to build, and nothing a
		// participant can press does harm to anybody else.
		if unframed[name] {
			w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
			w.Header().Set("X-Frame-Options", "DENY")
		}

		// The zero time leaves Last-Modified off, which is right for both
		// sources: files built into the binary have no meaningful timestamp, and
		// files on disk are named after their contents anyway.
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
	})
}

// precompressed finds a copy of name that was compressed at build time.
//
// Brotli only. gzip would be a second stored copy of everything this covers for
// the sake of browsers that take gzip and not brotli, and that set is empty
// among browsers that can hold a video call.
func precompressed(files fs.FS, name, accepts string) (content []byte, kind string) {
	if !acceptsBrotli(accepts) {
		return nil, ""
	}

	content, err := fs.ReadFile(files, name+".br")
	if err != nil {
		return nil, ""
	}

	return content, "br"
}

// acceptsBrotli reads an Accept-Encoding header for brotli.
//
// Split on the comma and compared whole, rather than searched for "br" — every
// header that mentions "brotli" contains it, and so does every one that
// mentions a "br"-prefixed anything. A quality of zero is a refusal and is the
// one q value worth reading: "br;q=0" means the browser is telling us not to,
// and honouring it costs nothing.
func acceptsBrotli(accepts string) bool {
	for _, one := range strings.Split(accepts, ",") {
		name, rest, _ := strings.Cut(strings.TrimSpace(one), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "br") {
			continue
		}

		for _, parameter := range strings.Split(rest, ";") {
			key, value, found := strings.Cut(parameter, "=")
			if found && strings.EqualFold(strings.TrimSpace(key), "q") && strings.TrimSpace(value) == "0" {
				return false
			}
		}

		return true
	}

	return false
}

// caching decides how long a file may be kept.
//
// The build names assets after their contents, so a changed file is a changed
// URL and the old one can be kept forever. A document's name never changes, so
// it has to be revalidated every time or a deployment would reach nobody who
// has visited before.
//
// Every document, which this used to read as one. There are three — the client,
// the management pages, the account page — and only the client was named here,
// so the other two were served as immutable for a year. That is not a cache
// that goes stale and recovers: an immutable response is one a browser will not
// revalidate, and a content delivery network in front of it holds the same
// answer per edge. A deployment then reaches some people and not others, for a
// year, with nothing to distinguish it from a build that did not go out —
// which is exactly how it presented, and it cost an hour of comparing bytes
// that were identical the whole time.
func caching(name string) string {
	if strings.HasSuffix(name, ".html") {
		return "no-cache"
	}

	return "public, max-age=31536000, immutable"
}

// Dir opens a directory for serving, checking that it holds a built client.
//
// Checked here rather than on the first request, so a wrong path is a startup
// error naming the directory rather than a 404 somebody has to go looking for.
func Dir(root string) (fs.FS, error) {
	files := os.DirFS(root)

	if _, err := fs.Stat(files, index); err != nil {
		return nil, err
	}

	return files, nil
}

// Placeholder serves one document for every path.
//
// Used when nothing was built into the binary. Answering 404 everywhere would be
// technically accurate and completely unhelpful; a page that says which command
// to run is the one thing this situation needs.
func Placeholder(document []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, index, time.Time{}, bytes.NewReader(document))
	})
}
