package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
The apps section, read the way a deployment's file is read.

Two things would go wrong silently. A key file that is not a key starts the
server cleanly and turns every TestFlight invitation into "App Store Connect
refused", which is a sentence about Apple pointing away from a mistyped path —
so it is refused, by a sentence naming the file. And a section only partly set
must not be a startup failure: the download page is beside a meeting server,
and a missing group id is not a reason for nobody to be able to hold a call.
*/

func keyFile(t *testing.T, contents []byte) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "asc.p8")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	return path
}

func p256(t *testing.T) []byte {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func appsDocument(role, keyPath string) string {
	return `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  role: ` + role + `
  relays:
    - {name: one, url: "wss://one.example.invalid"}
  apps:
    mac_dir: /nonexistent/apps
    testflight:
      key_id: "ABCDEFGHIJ"
      issuer: "00000000-0000-0000-0000-000000000000"
      key_file: ` + keyPath + `
      group: "11111111-1111-1111-1111-111111111111"
`
}

func TestTheAppsSectionIsReadUnderItsOwnNames(t *testing.T) {
	path := keyFile(t, p256(t))

	conf, err := Load(write(t, appsDocument("control", path)))
	if err != nil {
		t.Fatalf("a whole apps section was refused: %v", err)
	}

	got := conf.Meet.Apps
	if got.MacDir != "/nonexistent/apps" || got.TestFlight.KeyFile != path ||
		got.TestFlight.KeyID != "ABCDEFGHIJ" || got.TestFlight.Group == "" || got.TestFlight.Issuer == "" {
		t.Fatalf("the section was not read as written: %+v", got)
	}

	if !got.TestFlight.Configured() {
		t.Error("a key with all four parts does not count as configured")
	}
}

// A missing directory is the page saying "not yet", not a startup failure:
// the directory is often made after the server, when the first build exists.
func TestAMissingMacDirectoryIsNotRefused(t *testing.T) {
	if _, err := Load(write(t, appsDocument("full", keyFile(t, p256(t))))); err != nil {
		t.Fatalf("a mac_dir that does not exist yet was refused: %v", err)
	}
}

func TestAKeyFileThatIsNotAKeyIsRefusedByName(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaDER, err := x509.MarshalPKCS8PrivateKey(rsaKey)
	if err != nil {
		t.Fatal(err)
	}

	for name, path := range map[string]string{
		"a file that is not there": filepath.Join(t.TempDir(), "gone.p8"),
		"a file that is not PEM":   keyFile(t, []byte("not a key at all")),
		"a PEM block that is not a key": keyFile(t, pem.EncodeToMemory(
			&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("garbage")})),
		"a key that is not P-256": keyFile(t, pem.EncodeToMemory(
			&pem.Block{Type: "PRIVATE KEY", Bytes: rsaDER})),
	} {
		_, err := Load(write(t, appsDocument("full", path)))
		if err == nil {
			t.Errorf("%s was accepted as an App Store Connect key", name)
			continue
		}

		if !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "meet.apps.testflight.key_file") {
			t.Errorf("%s was refused without naming the setting and the file: %v", name, err)
		}
	}
}

// Every part optional, and any of them missing simply leaves invitations off.
func TestAPartlySetKeyStartsAndOffersNoInvitations(t *testing.T) {
	conf, err := Load(write(t, `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  apps:
    testflight:
      key_id: "ABCDEFGHIJ"
`))
	if err != nil {
		t.Fatalf("a partly set key stopped the server starting: %v", err)
	}

	if conf.Meet.Apps.TestFlight.Configured() {
		t.Error("a key with one part of four counts as configured")
	}
}

// A relay serves no pages, so nothing in the section is read there — not even
// a key file that would be refused anywhere else.
func TestARelayIgnoresTheAppsSection(t *testing.T) {
	document := strings.Replace(appsDocument("relay", keyFile(t, []byte("not a key"))),
		"  relays:\n    - {name: one, url: \"wss://one.example.invalid\"}\n", "", 1)

	if _, err := Load(write(t, document)); err != nil {
		t.Fatalf("a relay refused to start over a section it never reads: %v", err)
	}
}

func TestATypoInTheAppsSectionIsRefused(t *testing.T) {
	_, err := Load(write(t, `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  apps:
    macdir: /var/lib/tomoshibi/apps
`))
	if err == nil {
		t.Fatal("a misspelled key under meet.apps was accepted and would have done nothing")
	}
}
