package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
The failure this guards is a deployment that believes it is encrypted and is
not.

Half a configuration — a certificate with no key, or a key with no certificate —
is the shape a hurried edit leaves behind, and the obvious handling of it is to
carry on without TLS. That produces a relay serving plaintext at the address a
control node hands out as wss, so every browser refuses the connection and the
fault surfaces as "calls do not work", a long way from the line that caused it.

So half is refused at startup, and the pair is loaded rather than merely
stat'd: a certificate that does not match its key fails the same way, and
finding that out when the listener starts is finding it out too late.
*/

// writePair puts a working certificate and key on disk and returns their paths.
func writePair(t *testing.T) (string, string) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate a key: %v", err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "relay.example.invalid"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{"relay.example.invalid"},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create a certificate: %v", err)
	}

	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		t.Fatal(err)
	}

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled})
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}

	return certPath, keyPath
}

func TestAWorkingPairIsAccepted(t *testing.T) {
	cert, key := writePair(t)

	meet := Meet{TLSCert: cert, TLSKey: key}
	if err := checkTLS(&meet); err != nil {
		t.Fatalf("a valid pair was refused: %v", err)
	}
}

func TestNoTLSIsFine(t *testing.T) {
	meet := Meet{}
	if err := checkTLS(&meet); err != nil {
		t.Fatalf("a deployment with no certificate was refused: %v", err)
	}
}

// Half a configuration must not start. Carrying on without TLS would leave a
// relay serving plaintext at an address handed out as wss, and the symptom
// arrives in somebody's browser rather than in the log of the machine that is
// wrong.
func TestHalfAConfigurationIsRefused(t *testing.T) {
	cert, key := writePair(t)

	for _, tc := range []struct {
		name string
		meet Meet
		says string
	}{
		{"certificate with no key", Meet{TLSCert: cert}, "tls_key"},
		{"key with no certificate", Meet{TLSKey: key}, "tls_cert"},
	} {
		err := checkTLS(&tc.meet)
		if err == nil {
			t.Errorf("%s was accepted; the listener would come up plaintext", tc.name)
			continue
		}

		if !strings.Contains(err.Error(), tc.says) {
			t.Errorf("%s said %q, which does not name the missing half", tc.name, err)
		}
	}
}

func TestAMissingFileIsRefused(t *testing.T) {
	cert, key := writePair(t)

	meet := Meet{TLSCert: filepath.Join(t.TempDir(), "absent.pem"), TLSKey: key}
	if err := checkTLS(&meet); err == nil {
		t.Error("a certificate path that does not exist was accepted")
	}

	meet = Meet{TLSCert: cert, TLSKey: filepath.Join(t.TempDir(), "absent.pem")}
	if err := checkTLS(&meet); err == nil {
		t.Error("a key path that does not exist was accepted")
	}
}

// A certificate and a key that are each valid and are not a pair. Stat'ing both
// would accept this; loading them is what catches it, and catching it here is
// the difference between a message and a listener that fails at start.
func TestAMismatchedPairIsRefused(t *testing.T) {
	cert, _ := writePair(t)
	_, otherKey := writePair(t)

	meet := Meet{TLSCert: cert, TLSKey: otherKey}
	if err := checkTLS(&meet); err == nil {
		t.Error("a certificate was accepted alongside a key from a different one")
	}
}

func TestSomethingThatIsNotACertificateIsRefused(t *testing.T) {
	_, key := writePair(t)

	notACert := filepath.Join(t.TempDir(), "notes.pem")
	if err := os.WriteFile(notACert, []byte("this is where I meant to put the certificate\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	meet := Meet{TLSCert: notACert, TLSKey: key}
	if err := checkTLS(&meet); err == nil {
		t.Error("a file holding prose was accepted as a certificate")
	}
}
