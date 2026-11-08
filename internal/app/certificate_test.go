package app

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"sort"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

/*
Who is handed the wildcard's private key.

The hourly push went to every relay in the store: one dialled over ws:// got
the key in the clear, ones out of service got it, ones dialled by address got
it in order to refuse it, and a record whose address had been typed as some
other machine's sent the key there. These hold that the key goes only to a
relay in service, over wss://, at a name the certificate answers for under the
enrolment domain — and that a relay dialled by address is still watched, by
reading what it serves, without being sent anything.
*/

type certifier struct {
	mu   sync.Mutex
	sent []string
	read []string
}

func (c *certifier) SendCertificate(_ context.Context, relay string, _ rtc.Certificate) (time.Time, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, relay)
	return time.Time{}, nil
}

func (c *certifier) Serving(_ context.Context, relay string) (time.Time, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.read = append(c.read, relay)
	return time.Now().Add(time.Hour), nil
}

func wildcardFor(t *testing.T, name string) (rtc.Certificate, *x509.Certificate) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour),
		DNSNames: []string{name},
	}, &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour),
		DNSNames: []string{name},
	}, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	marshalled, _ := x509.MarshalECPrivateKey(key)
	carried := rtc.Certificate{
		Cert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		Key:  string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled})),
	}

	leaf, err := carried.Leaf()
	if err != nil {
		t.Fatal(err)
	}

	return carried, leaf
}

func TestTheWildcardsKeyGoesOnlyToRelaysItIsFor(t *testing.T) {
	app := &App{conf: &config.Config{Meet: config.Meet{Enrol: config.Enrol{Domain: "relay.example.invalid"}}}}
	carried, leaf := wildcardFor(t, "*.relay.example.invalid")

	relays := []store.Relay{
		{Name: "tokyo", URL: "wss://tokyo.relay.example.invalid:13377", Enabled: true},
		{Name: "plain", URL: "ws://plain.relay.example.invalid:13377", Enabled: true},
		{Name: "resting", URL: "wss://resting.relay.example.invalid:13377", Enabled: false},
		{Name: "elsewhere", URL: "wss://mail.example.invalid:13377", Enabled: true},
		{Name: "deeper", URL: "wss://a.b.relay.example.invalid:13377", Enabled: true},
		{Name: "bare", URL: "wss://198.51.100.9:13377", Enabled: true},
		{Name: "bare-plain", URL: "ws://198.51.100.10:13377", Enabled: true},
	}

	via := &certifier{}
	taken, _, own := app.handOut(context.Background(), via, relays, carried, leaf, leaf.NotAfter)

	sort.Strings(via.sent)

	if len(via.sent) != 1 || via.sent[0] != "wss://tokyo.relay.example.invalid:13377" {
		t.Errorf("the key was sent to %v; only tokyo is in service, over wss, at a name it answers for", via.sent)
	}

	if len(via.read) != 1 || via.read[0] != "wss://198.51.100.9:13377" {
		t.Errorf("what a relay dialled by address serves was read from %v, want only the bare wss one", via.read)
	}

	if taken != 2 {
		t.Errorf("answered %d, want 2", taken)
	}

	if _, watched := own["bare"]; !watched {
		t.Error("the relay dialled by address is no longer watched: its own certificate is not reported")
	}
}
