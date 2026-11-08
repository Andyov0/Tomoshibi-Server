package turnstile

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

/*
 * Who is spared the check for being on this machine.
 *
 * The tools on a control node sign in at http://127.0.0.1:8080 with no
 * browser, and nginx on the same machine passes every outside request to the
 * same address. Both arrive from loopback; what tells them apart is that nginx
 * always says who it is passing a request on for. So the mistakes that matter
 * are all silent ones that spare somebody outside: a forwarding header that is
 * present but empty read as absent, a header holding 127.0.0.1 read as the
 * caller being local, a header's spelling that is not the canonical one
 * missed, or anything at all read from a header in place of the connection's
 * own peer. Each is held here, and the parsing that decides what "present"
 * means is held over a real connection, since a request built in a test is
 * not what Go's server makes of the bytes a proxy sends.
 */

// from is a sign-in whose connection came from peer, carrying headers.
func from(peer string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/admin/session", nil)
	r.RemoteAddr = peer
	for name, value := range headers {
		r.Header[http.CanonicalHeaderKey(name)] = []string{value}
	}

	return r
}

func TestOnlyALoopbackPeerSayingNothingIsFromThisMachine(t *testing.T) {
	local := []string{"127.0.0.1:51234", "127.9.8.7:443", "[::1]:51234", "[::ffff:127.0.0.1]:51234"}
	remote := []string{"192.0.2.1:1234", "10.0.0.1:51234", "[2001:db8::1]:443", "[::ffff:192.0.2.1]:1234", "", "127.0.0.1", "nonsense"}

	for _, peer := range local {
		if !FromThisMachine(from(peer, nil)) {
			t.Errorf("a connection from %q with no forwarding header was not from this machine", peer)
		}
	}

	for _, peer := range remote {
		if FromThisMachine(from(peer, nil)) {
			t.Errorf("a connection from %q was taken as from this machine", peer)
		}
	}

	// Any one of the three, with a caller's address, with none, or with the
	// loopback address a caller would write to pass for local.
	for _, name := range []string{"X-Forwarded-For", "X-Real-IP", "Forwarded", "x-forwarded-for", "x-real-ip", "forwarded"} {
		for _, value := range []string{"203.0.113.7", "", "127.0.0.1", "for=127.0.0.1"} {
			if FromThisMachine(from("127.0.0.1:51234", map[string]string{name: value})) {
				t.Errorf("loopback with %s: %q was taken as from this machine", name, value)
			}
		}
	}

	// And a header never stands in for the peer: a remote connection naming
	// loopback in every header is remote.
	if FromThisMachine(from("192.0.2.1:1234", map[string]string{"X-Forwarded-For": "127.0.0.1"})) {
		t.Error("a remote peer with a loopback forwarded address was taken as from this machine")
	}
}

func TestTheSwitchDecidesWhetherThisMachineIsSpared(t *testing.T) {
	open, _ := checker(t, meet("meet.example.com"))
	if !open.Spares(from("127.0.0.1:51234", nil)) {
		t.Error("with the switch unwritten, a program on this machine is not spared")
	}
	if open.Spares(from("127.0.0.1:51234", map[string]string{"X-Real-IP": "127.0.0.1"})) {
		t.Error("a proxied request was spared")
	}
	if open.Spares(from("192.0.2.1:1234", nil)) {
		t.Error("a remote caller was spared")
	}

	conf := meet("meet.example.com")
	closed := false
	conf.Turnstile.ExemptLocal = &closed

	shut, _ := checker(t, conf)
	if shut.Spares(from("127.0.0.1:51234", nil)) {
		t.Error("exempt_local: false still spares a program on this machine")
	}

	// Nil asks nothing of anybody, and spares nobody in particular.
	var none *Checker
	if none.Spares(from("127.0.0.1:51234", nil)) {
		t.Error("a nil checker spared a caller")
	}
}

// What Go's server makes of the headers a proxy writes, over a real
// connection from loopback. An empty X-Forwarded-For, a lower-case
// x-real-ip and a Forwarded are each kept as present, and only the request
// with none of them is from this machine.
func TestAForwardingHeaderOnTheWireIsSeen(t *testing.T) {
	seen := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- FromThisMachine(r)
	}))
	t.Cleanup(server.Close)

	address := server.Listener.Addr().String()

	cases := []struct {
		name  string
		lines string
		local bool
	}{
		{"nothing", "", true},
		{"an empty X-Forwarded-For", "X-Forwarded-For:\r\n", false},
		{"an X-Forwarded-For of spaces", "X-Forwarded-For:   \r\n", false},
		{"a lower-case x-real-ip naming loopback", "x-real-ip: 127.0.0.1\r\n", false},
		{"a Forwarded", "Forwarded: for=127.0.0.1\r\n", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", address, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

			fmt.Fprintf(conn, "POST /api/admin/session HTTP/1.1\r\nHost: %s\r\n%sContent-Length: 0\r\nConnection: close\r\n\r\n",
				address, c.lines)

			if _, err := http.ReadResponse(bufio.NewReader(conn), nil); err != nil {
				t.Fatal(err)
			}

			select {
			case local := <-seen:
				if local != c.local {
					t.Errorf("from this machine = %v, want %v", local, c.local)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the request never reached the handler")
			}
		})
	}
}
