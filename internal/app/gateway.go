package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// gateway is a service this deployment runs somewhere else, reached with a
// token only this server holds: the music library and the watch gateway.
type gateway struct {
	name   string
	url    string
	header string
	token  string
	// The configuration key the token comes from, named when it is refused.
	key string
	// The types an answer may carry, by prefix. Set, anything else is sent as
	// bytes, unsniffed and sandboxed; see watch.go.
	contains []string
}

// The headers that describe a response, and the only ones passed back. Anything
// else the gateway says is between it and this server.
var gatewayHeaders = []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"}

// gatewayClient has no overall timeout because a streamed response is as long
// as what it carries: a four-minute song arrives over four minutes when the
// listener's browser reads it at the pace it plays. Only the wait for the
// gateway to begin answering is bounded.
var gatewayClient = &http.Client{
	Transport: &http.Transport{
		Proxy: nil,
		// Long enough for a video link to be read: yt-dlp alone was measured
		// at most of a minute for some, and the request's own deadline below
		// is the bound that means something.
		ResponseHeaderTimeout: 100 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   16,
	},
}

// passOn asks the gateway the same question at path `what`, with the query as it
// came, and copies the answer back. A streamed path passes Range on, is not cut
// short, and keeps the gateway's own word on caching: a relayed segment of
// video is the same bytes every time it is asked for, and a viewer seeking back
// should not fetch it again.
//
// The query is passed on unread. The gateway is the party that knows what its
// parameters mean, and it refuses what it does not; reading them here as well
// would be two lists of the same thing kept in step by hand.
//
// Except where this server has decided something about the query: then the
// question asked is built from what it decided about, by passOnAsking. See
// ticketQuery for the paths that do.
func passOn(w http.ResponseWriter, r *http.Request, g gateway, what string, streamed bool) {
	passOnAsking(w, r, g, what, r.URL.RawQuery, streamed)
}

// passOnAsking is passOn with the query this server chose to ask, rather than
// the one that came.
func passOnAsking(w http.ResponseWriter, r *http.Request, g gateway, what, query string, streamed bool) {
	response, done := consult(w, r, g, what, query, streamed)
	if response == nil {
		return
	}
	defer done()

	describeAnswer(w, g, response, streamed)
	w.WriteHeader(response.StatusCode)

	// Copied as it arrives rather than read whole: a track or a video is tens
	// of megabytes, and the browser plays it while it comes.
	_, _ = io.Copy(w, response.Body)
}

// consult puts a question to the gateway and hands back its answer, unread.
//
// Split from passOn for the one answer this server has to read before passing
// it on — what a resolved link plays, which decides whether this deployment
// will relay it; see watch.go. Everything about reaching the gateway is the
// same for both, and two copies of it would be two places for the token
// handling to drift apart.
//
// Where it returns nil it has already written the failure. Otherwise the caller
// runs done when it has finished with the body.
func consult(w http.ResponseWriter, r *http.Request, g gateway, what, query string, streamed bool) (*http.Response, func()) {
	target := strings.TrimRight(g.url, "/") + "/" + what
	if query != "" {
		target += "?" + query
	}

	ctx := r.Context()
	cancel := context.CancelFunc(func() {})
	if !streamed {
		ctx, cancel = context.WithTimeout(ctx, 100*time.Second)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		cancel()
		fail(w, http.StatusInternalServerError, reasonServerError)
		return nil, nil
	}

	request.Header.Set(g.header, g.token)
	if streamed {
		if span := r.Header.Get("Range"); span != "" {
			request.Header.Set("Range", span)
		}
	}

	response, err := gatewayClient.Do(request)
	if err != nil {
		if ctx.Err() == nil {
			// The cause without the address: the query holds a pasted link or
			// a ticket, and neither belongs in a log.
			var failed *url.Error
			if errors.As(err, &failed) {
				err = failed.Err
			}
			slog.Warn("a gateway did not answer", "gateway", g.name, "path", what, "error", err)
		}
		cancel()
		fail(w, http.StatusBadGateway, reasonServerError)
		return nil, nil
	}

	// The gateway refusing this server is a configuration that does not match,
	// not a thing the person pressing play did or can do anything about. A
	// ticket that has run out is the gateway's 410, which passes through: it
	// is the viewer's to hear. One status for both, keyed on the path asked,
	// reported a stale ticket in somebody's queue as this deployment's
	// misconfiguration, at error level.
	if response.StatusCode == http.StatusForbidden {
		response.Body.Close()
		cancel()
		slog.Error("a gateway refused this server's token: " + g.key + " does not match the gateway's")
		fail(w, http.StatusBadGateway, reasonServerError)
		return nil, nil
	}

	return response, func() {
		response.Body.Close()
		cancel()
	}
}

// describeAnswer sets what the browser is told about a gateway's answer: the
// few headers that describe it, what it may be taken for, and how long it may
// be kept.
func describeAnswer(w http.ResponseWriter, g gateway, response *http.Response, streamed bool) {
	for _, name := range gatewayHeaders {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	if g.contains != nil {
		if !hasPrefix(strings.ToLower(w.Header().Get("Content-Type")), g.contains) {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	}
	cache := "no-store"
	if streamed && response.Header.Get("Cache-Control") != "" {
		cache = response.Header.Get("Cache-Control")
	}
	w.Header().Set("Cache-Control", cache)
}

func hasPrefix(value string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}
