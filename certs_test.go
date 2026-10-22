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
	"os"
	"testing"
	"time"
)

/*
Renewal without a restart.

The whole argument for reading the certificate through a callback is that this
fleet renews four times a year and a restart drops every call on the machine.
That argument is worth exactly as much as the reload actually working, and a
reload that silently keeps serving the old certificate looks identical from the
outside until the day the old one expires — at which point every relay stops
being dialable at once, which is the outage this was meant to prevent.

So: replace the files under a running holder and check that what it serves
afterwards is the new certificate, not the old one.
*/

// issue writes a certificate and key for host into dir, with a serial that
// tells one from another.
func issue(t *testing.T, dir, host string, serial int64) (string, string) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(serial),
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

	certPath, keyPath := dir+"/cert.pem", dir+"/key.pem"

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(certPath,
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath,
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled}), 0o600); err != nil {
		t.Fatal(err)
	}

	return certPath, keyPath
}

// served is the serial of the certificate the holder hands out now.
func served(t *testing.T, pair *keypair) int64 {
	t.Helper()

	got, err := pair.certificate(&tls.ClientHelloInfo{ServerName: "relay.example.invalid"})
	if err != nil {
		t.Fatal(err)
	}

	leaf, err := leafOf(got)
	if err != nil {
		t.Fatal(err)
	}

	return leaf.SerialNumber.Int64()
}

func TestARenewedCertificateIsServedWithoutARestart(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := issue(t, dir, "relay.example.invalid", 1)

	pair, err := newKeypair(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}

	if serial := served(t, pair); serial != 1 {
		t.Fatalf("serving serial %d before anything changed", serial)
	}

	// Renewal, which for acme.sh is exactly this: the same two paths, rewritten.
	//
	// A modification time a second on is not decoration. Several filesystems
	// hold it to one-second resolution, and a certificate rewritten inside the
	// same second as the last check would be indistinguishable from the one
	// already held — which is the shape of every "it works on my machine and
	// not in production" this kind of check has.
	time.Sleep(1100 * time.Millisecond)
	issue(t, dir, "relay.example.invalid", 2)

	if serial := served(t, pair); serial != 2 {
		t.Errorf("still serving serial %d after the files were replaced: renewal would need a "+
			"restart, and a restart drops every call on the machine", serial)
	}
}

func TestAHalfWrittenCertificateDoesNotStopTheCallsAlreadyUp(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := issue(t, dir, "relay.example.invalid", 7)

	pair, err := newKeypair(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}

	// A copy caught in progress, which is a real state of a file being replaced
	// and not a hypothetical one.
	time.Sleep(1100 * time.Millisecond)
	if err := os.WriteFile(certPath, []byte("-----BEGIN CERTIFICATE-----\nhalf of it"), 0o644); err != nil {
		t.Fatal(err)
	}

	if serial := served(t, pair); serial != 7 {
		t.Errorf("serving %d: a certificate that will not parse must leave the one already held "+
			"in place, because refusing handshakes costs the calls and the held one is good "+
			"for another month", serial)
	}

	// And once the copy finishes, the new one is picked up after all.
	time.Sleep(1100 * time.Millisecond)
	issue(t, dir, "relay.example.invalid", 8)

	if serial := served(t, pair); serial != 8 {
		t.Errorf("serving %d: a broken file was remembered as seen and the good one that "+
			"replaced it was never read", serial)
	}
}

func TestACertificateThatDoesNotLoadIsRefusedAtStartup(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := issue(t, dir, "relay.example.invalid", 1)

	if err := os.WriteFile(certPath, []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := newKeypair(certPath, keyPath); err == nil {
		t.Error("a certificate that cannot be loaded started the server anyway, which is a " +
			"listener that comes up and refuses every handshake for reasons nothing says")
	}
}
