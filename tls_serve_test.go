package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

/*
What this guards is the difference between a relay that works over plaintext and
the same relay refusing every call the moment it is given a certificate.

ServeTLS advertises h2 in ALPN. A browser takes it, opens an HTTP/2 connection,
asks for the signalling path — and the upgrade this server performs is the
HTTP/1.1 one, which is never reached. The router answers 404. Nothing in the
logs says "protocol"; the certificate is valid, the port is open, and calls
simply stop working.

That is exactly how it presented the first time a relay was given one, and the
whole difference between working and not was one string in a TLS handshake. So
the property is written down here: a TLS listener built the way serve builds one
must not offer h2, and must still complete a WebSocket upgrade.
*/

func certFor(t *testing.T, host string) (string, string) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{host},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")

	if err := os.WriteFile(certPath,
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(keyPath,
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled}), 0o600); err != nil {
		t.Fatal(err)
	}

	return certPath, keyPath
}

// serveTLS starts a server configured exactly as serve configures one, over a
// handler that performs an HTTP/1.1 WebSocket upgrade.
func serveTLS(t *testing.T) (addr string, stop func()) {
	t.Helper()

	certPath, keyPath := certFor(t, "relay.example.invalid")

	mux := http.NewServeMux()
	mux.HandleFunc("/rtc", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" {
			http.Error(w, "not an upgrade", http.StatusBadRequest)
			return
		}

		hijacker, ok := w.(http.Hijacker)
		if !ok {
			// Which is what an HTTP/2 request is: h2 responses cannot be
			// hijacked, so this is the failure mode being guarded against,
			// reached from the other direction.
			http.Error(w, "connection cannot be hijacked", http.StatusInternalServerError)
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
	})

	server := &http.Server{
		Handler: mux,
		// The line under test.
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	go func() { _ = server.ServeTLS(listener, certPath, keyPath) }()

	return listener.Addr().String(), func() { _ = server.Close() }
}

// The heart of it. A client offering both protocols must be answered http/1.1,
// because h2 is a connection on which the signalling upgrade cannot happen.
func TestATLSListenerDoesNotOfferHTTP2(t *testing.T) {
	addr, stop := serveTLS(t)
	defer stop()

	conn, err := tls.Dial("tcp", addr, &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{"h2", "http/1.1"},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	if got := conn.ConnectionState().NegotiatedProtocol; got == "h2" {
		t.Fatalf("the listener negotiated %q; a browser would take it, open an HTTP/2 "+
			"connection, and every WebSocket upgrade would be answered 404", got)
	}
}

// And the other half: with h2 out of the way the upgrade still completes. A
// server that refused every protocol would pass the test above and be useless.
func TestAWebSocketUpgradeSurvivesTLS(t *testing.T) {
	addr, stop := serveTLS(t)
	defer stop()

	conn, err := tls.Dial("tcp", addr, &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{"h2", "http/1.1"},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	request := "GET /rtc HTTP/1.1\r\nHost: relay.example.invalid\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"

	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	buf := make([]byte, 128)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	if got := string(buf[:n]); len(got) < 12 || got[:12] != "HTTP/1.1 101" {
		t.Fatalf("the upgrade was answered %q, wanted 101 Switching Protocols", got[:min(len(got), 40)])
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
