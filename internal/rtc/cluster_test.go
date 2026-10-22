package rtc

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

/*
 * Whether an error came back from a relay or came back instead of one.
 *
 * The whole of what this decides is whether the next relay is asked. An answer
 * is final — the same question put to another machine returns the same answer,
 * because rooms are the cluster's rather than any one machine's — so anything
 * read as an answer stops the walk and is handed to the caller.
 *
 * The cost of being wrong is therefore lopsided. A refusal misread as a failure
 * to reach costs one extra request. A failure to reach misread as a refusal
 * stops the walk at the first broken machine, so one relay takes the whole
 * cluster's management surface with it and the error shown is about a machine
 * nobody asked about.
 *
 * The cases that were missing are the ones this deployment produces. Two of its
 * relays hold six-day certificates renewed by a cron job on the machine itself,
 * so an expired one is not hypothetical — and an expired certificate is refused
 * during the handshake, before anything at the far end has read the request.
 */

func TestATransportFailureIsNotAnAnswer(t *testing.T) {
	for _, err := range []error{
		errors.New("dial tcp 10.0.0.1:443: connect: connection refused"),
		errors.New(`Get "https://relay.example": dial tcp: lookup relay.example: no such host`),
		errors.New("context deadline exceeded"),
		errors.New("read tcp 10.0.0.1:443: connection reset by peer"),
		errors.New("unexpected EOF"),
		errors.New("dial tcp 10.0.0.1:443: connect: network is unreachable"),

		// The ones that were missing.
		errors.New(`tls: failed to verify certificate: x509: certificate has expired or is not yet valid`),
		errors.New("x509: certificate signed by unknown authority"),
		errors.New(`tls: first record does not look like a TLS handshake`),
		errors.New("remote error: tls: handshake failure"),
	} {
		if !unreachable(err) {
			t.Errorf("read as an answer from a relay: %v", err)
		}
	}
}

func TestARefusalIsAnAnswer(t *testing.T) {
	for _, err := range []error{
		errors.New("twirp error not_found: no such room"),
		errors.New("twirp error permission_denied: invalid token"),
		errors.New("twirp error invalid_argument: identity is required"),
		errors.New("500 Internal Server Error"),
	} {
		if unreachable(err) {
			t.Errorf("read as a failure to reach: %v", err)
		}
	}
}

// The classification against a real expired certificate rather than against a
// string somebody thought Go produces. What crypto/tls actually says is the
// thing under test, and it is the standard library's to change.
func TestARealExpiredCertificateReadsAsUnreached(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// The server's certificate, verified against a pool that trusts it, at a
	// time long after it expires. Standing up a genuinely expired certificate
	// would mean minting one, and this asks the same question of the same code.
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs: pool,
				Time:    func() time.Time { return server.Certificate().NotAfter.Add(24 * time.Hour) },
			},
		},
		Timeout: 5 * time.Second,
	}

	_, err := client.Get(server.URL)
	if err == nil {
		t.Fatal("an expired certificate was accepted")
	}

	if !unreachable(err) {
		t.Errorf("an expired certificate reads as a relay answering: %v", err)
	}
}

// And a machine that is simply not there, over a port nothing holds.
func TestNothingListeningReadsAsUnreached(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	address := listener.Addr().String()
	listener.Close()

	client := &http.Client{Timeout: 3 * time.Second}

	_, err = client.Get(fmt.Sprintf("http://%s/", address))
	if err == nil {
		t.Fatal("a port nothing is listening on answered")
	}

	if !unreachable(err) {
		t.Errorf("a closed port reads as a relay answering: %v", err)
	}
}
