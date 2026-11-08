package app

import (
	"net/http"
	"strings"
)

/*
Some networks decide what a machine is by asking it.

A relay in mainland China is probed: something opens its TLS port, sends an
ordinary HTTPS request, and reads the answer. A 204, a 401, even a 404 — any of
them is a server saying "I am a website", and an unregistered website is closed
down. The relay never did anything wrong; it answered politely, which was
enough.

A WebSocket endpoint does not have to answer politely. The only request it
exists for carries an Upgrade header, and everything else can be met with
nothing at all: no status line, no body, the connection simply closed. A prober
learns that the port accepts TCP and completes TLS, and not one thing more.

This costs the relay its health endpoint, which is what a control node's page
and a client's measurement both use. That is the trade, and it is why this is a
setting rather than the default: a relay outside such a network should stay
readable, because being able to ask whether it is up is worth having.
*/

// silence closes any request that is not a WebSocket upgrade to the signalling
// path, or a call from the control node to the management API, without
// answering it.
//
// The path is part of the test, and was not. An upgrade to any path got an
// answer: Go's "404 page not found" for most of them, the media server's own
// errors for /twirp, a 401 for /rtc. So a prober that added an Upgrade header
// learnt that the port was an HTTP server, which of the three it was, and from
// the wording what software ran it — the comment above said a prober learnt
// only that the port completed TLS, and it learnt a good deal more.
//
// Hijacked and closed rather than answered with a status. Every status is an
// answer, and an answer is the thing being avoided: a prober that receives 400
// has still learned there is an HTTP server here. Closing mid-request is
// indistinguishable from a connection that failed, which is what a port with
// nothing to say should look like.
func silence(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (isUpgrade(r) && signalling(r.URL.Path)) || (carriesCredentials(r) && managing(r.URL.Path)) {
			next.ServeHTTP(w, r)
			return
		}

		hijacker, ok := w.(http.Hijacker)
		if !ok {
			// Cannot be hijacked, which on this server means HTTP/2 — and h2 is
			// turned off wherever TLS is served for exactly the reason that
			// WebSockets cannot travel over it. Nothing useful is left to do but
			// say as little as possible.
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		conn, _, err := hijacker.Hijack()
		if err != nil {
			return
		}

		_ = conn.Close()
	})
}

// carriesCredentials reports whether a request presented a bearer token.
//
// The control node's management calls are ordinary HTTPS — listing the rooms on
// this relay, reading its counters — and the first version of this silenced them
// along with everything else. The dashboard then reported the relay unreachable
// while calls were running on it perfectly, because the one thing that could
// not reach it was the page saying so.
//
// Only the presence of a token is checked here, never its validity: this is a
// gate deciding whether to answer at all, and the handlers behind it already
// refuse a token that does not verify. A prober sends no Authorization header,
// so it still learns nothing; somebody who sends a made-up one learns that the
// port speaks HTTP, which is worth exactly as much as guessing that a relay is
// a relay.
func carriesCredentials(r *http.Request) bool {
	return strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// signalling is the media server's signalling socket, which is the only thing
// a client opens on a relay.
func signalling(path string) bool {
	return path == "/rtc" || strings.HasPrefix(path, "/rtc/")
}

// managing is where the control node calls a relay: the media server's room
// service and this server's counters and certificate, all under /twirp/.
func managing(path string) bool {
	return strings.HasPrefix(path, "/twirp/")
}

// isUpgrade reports whether this request is asking to become a WebSocket.
//
// Both headers are checked because both are required, and Connection may carry
// a list — "keep-alive, Upgrade" is what several proxies send — so it is
// searched rather than compared.
func isUpgrade(r *http.Request) bool {
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return false
	}

	for _, part := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(part), "upgrade") {
			return true
		}
	}

	return false
}
