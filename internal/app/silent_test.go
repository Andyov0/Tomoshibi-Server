package app

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

/*
The whole value of silent mode is that a prober learns nothing, and "nothing"
is a specific thing: not a 400, not a 404, not an empty 200. Any status line at
all is an HTTP server identifying itself, which is the fact being withheld.

So these tests do not use an HTTP client. A client turns a closed connection
into an error and a 400 into a response, and both look like failure from up
there — a silent mode that answered 400 to everything would pass a test written
with http.Get and be useless. They speak the protocol over a raw socket and
assert on the bytes.
*/

// silentServer runs the relay's silent handler over TLS on a loopback port.
func silentServer(t *testing.T) (addr string, stop func()) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "relay.example.invalid"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	// The thing being wrapped answers everything, so that anything getting
	// through is unmistakable.
	inner := http.NewServeMux()
	inner.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if isUpgrade(r) {
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				return
			}
			conn, buffered, err := hijacker.Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			_ = buffered.Flush()
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{
		Handler:      silence(inner),
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	go func() {
		_ = server.ServeTLS(listener, certFileFor(t, der), keyFileFor(t, key))
	}()

	return listener.Addr().String(), func() { _ = server.Close() }
}

// speak sends one raw request over TLS and returns whatever came back.
func speak(t *testing.T, addr, request string) (string, error) {
	t.Helper()

	conn, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		return "", err
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(request)); err != nil {
		return "", err
	}

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	buf := make([]byte, 512)
	n, err := conn.Read(buf)

	return string(buf[:n]), err
}

// An ordinary request is what a prober sends. It must come back with no bytes
// at all — the connection closed rather than answered.
func TestSilentSaysNothingToAnOrdinaryRequest(t *testing.T) {
	addr, stop := silentServer(t)
	defer stop()

	for _, request := range []string{
		"GET / HTTP/1.1\r\nHost: relay.example.invalid\r\n\r\n",
		// The health endpoint included. Nothing measures it any more — both the
		// control node and the client time the signalling upgrade — so under
		// silence it is one more thing a prober must not be able to read.
		"GET /api/health HTTP/1.1\r\nHost: relay.example.invalid\r\n\r\n",
		"HEAD / HTTP/1.1\r\nHost: relay.example.invalid\r\n\r\n",
		"POST /rtc HTTP/1.1\r\nHost: relay.example.invalid\r\nContent-Length: 0\r\n\r\n",
		// An upgrade to something that is not a WebSocket.
		"GET / HTTP/1.1\r\nHost: relay.example.invalid\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n",
	} {
		got, err := speak(t, addr, request)

		if got != "" {
			t.Errorf("a plain request was answered with %q; any status line identifies this "+
				"port as an HTTP server, which is the one fact being withheld", firstLine(got))
		}

		// EOF is the expected end: the connection was closed without a reply.
		if err != nil && !errors.Is(err, io.EOF) && !isClosed(err) {
			t.Logf("read ended with %v, which is fine so long as nothing was said", err)
		}
	}
}

// And the request the relay exists for still works.
func TestSilentStillAcceptsTheUpgrade(t *testing.T) {
	addr, stop := silentServer(t)
	defer stop()

	got, _ := speak(t, addr, "GET /rtc HTTP/1.1\r\nHost: relay.example.invalid\r\n"+
		"Upgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")

	if len(got) < 12 || got[:12] != "HTTP/1.1 101" {
		t.Fatalf("the upgrade was answered %q, wanted 101", firstLine(got))
	}
}

// Proxies send "keep-alive, Upgrade" rather than "Upgrade" alone, and a
// comparison instead of a search would silence every client behind one.
func TestSilentAcceptsAConnectionHeaderWithAList(t *testing.T) {
	addr, stop := silentServer(t)
	defer stop()

	got, _ := speak(t, addr, "GET /rtc HTTP/1.1\r\nHost: relay.example.invalid\r\n"+
		"Upgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\n"+
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")

	if len(got) < 12 || got[:12] != "HTTP/1.1 101" {
		t.Fatalf("an upgrade behind a proxy was answered %q; the Connection header carries a "+
			"list and has to be searched rather than compared", firstLine(got))
	}
}

// The control node's management calls are ordinary HTTPS, and silencing them
// along with everything else made the dashboard report a relay unreachable
// while calls were running on it perfectly — the one thing that could not reach
// it was the page saying so.
func TestSilentAnswersAnAuthenticatedRequest(t *testing.T) {
	addr, stop := silentServer(t)
	defer stop()

	got, _ := speak(t, addr, "GET /twirp/livekit.RoomService/ListRooms HTTP/1.1\r\n"+
		"Host: relay.example.invalid\r\n"+
		"Authorization: Bearer a.token.here\r\n\r\n")

	if got == "" {
		t.Fatal("a request carrying a bearer token got no answer; the control node cannot " +
			"list rooms or read counters, and every page about this relay says it is down")
	}
}

// A token is required, not merely an Authorization header of any shape. Basic
// auth is what a scanner tries, and it should learn no more than one that tried
// nothing.
func TestSilentIgnoresAnAuthorizationThatIsNotABearer(t *testing.T) {
	addr, stop := silentServer(t)
	defer stop()

	for _, header := range []string{
		"Authorization: Basic dXNlcjpwYXNz",
		"Authorization: token abc",
		"Authorization: ",
	} {
		got, _ := speak(t, addr, "GET / HTTP/1.1\r\nHost: relay.example.invalid\r\n"+
			header+"\r\n\r\n")

		if got != "" {
			t.Errorf("%q was answered with %q", header, firstLine(got))
		}
	}
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\r' || r == '\n' {
			return s[:i]
		}
	}
	if len(s) > 60 {
		return s[:60]
	}
	return s
}

func isClosed(err error) bool {
	return err != nil && (errors.Is(err, net.ErrClosed) ||
		err.Error() == "EOF" ||
		containsAny(err.Error(), "connection reset", "broken pipe", "closed"))
}

func containsAny(s string, parts ...string) bool {
	for _, p := range parts {
		if len(p) <= len(s) {
			for i := 0; i+len(p) <= len(s); i++ {
				if s[i:i+len(p)] == p {
					return true
				}
			}
		}
	}
	return false
}

// certFileFor and keyFileFor write a PEM to a temporary file, because ServeTLS
// takes paths rather than the parsed pair.
func certFileFor(t *testing.T, der []byte) string {
	t.Helper()
	return writePEM(t, "cert.pem", "CERTIFICATE", der)
}

func keyFileFor(t *testing.T, key *ecdsa.PrivateKey) string {
	t.Helper()

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	return writePEM(t, "key.pem", "EC PRIVATE KEY", marshalled)
}

func writePEM(t *testing.T, name, kind string, der []byte) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}

	return path
}
