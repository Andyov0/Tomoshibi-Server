package admin

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
)

/*
What a relay brought up by the install script is configured to do with media.

The script writes relay.yaml with printf, one line at a time, and nothing reads
what it wrote until the service starts on a machine minutes old. Two settings
went into it after measurement — the sender-side estimate and a 4000-packet
resend window, which together are the difference between a viewer on a narrow
line settling on the 1080p layer and seeing no frame for a minute — and both
are easy to lose silently: a line dropped from the template still installs a
relay that starts, joins the cluster and carries calls, just on the defaults
that froze.

Indentation is the other way to lose them. A key printed two spaces short lands
beside `congestion_control` rather than inside it, and four spaces short lands
outside `rtc`. The loader refuses both, which is a relay that does not start.

So this runs the part of the script that writes the file, with /bin/sh, and
loads what it wrote with the loader the service uses. Reading the template for
the right strings would pass for a line at the wrong depth; this does not.
*/

func TestTheInstalledRelayChoosesFromTheSendersEstimate(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh to run the script with")
	}

	api, _, _, _ := enrolling(t)

	recorder := httptest.NewRecorder()
	api.PublicInstall(recorder, httptest.NewRequest(http.MethodGet, "/install", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("the install script answered %d: %s", recorder.Code, recorder.Body)
	}

	block := writingTheConfiguration(t, recorder.Body.String())

	// With and without the interface list, which the script prints after the
	// media settings and indents one level deeper. A setting printed after it
	// at the wrong depth would be read as part of that list.
	for name, iface := range map[string]string{"no interface named": "", "an interface named": "eth0"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			pairAt(t, filepath.Join(dir, "certs"))

			// Everything the script would have learnt from the control node by
			// this point, and the machine's own paths moved somewhere writable.
			program := strings.Join([]string{
				"set -eu",
				"say() { :; }",
				"LISTEN_PORT=13377 UDP_PORT=13378 TCP_PORT=13379 PROBE_PORT=39218 SILENT=1",
				"iface='" + iface + "'",
				"api_key=APIkey api_secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"redis_addr=redis.invalid:6379 redis_pass='redis password'",
				"node= selector=",
				strings.ReplaceAll(block, "/etc/tomoshibi/", dir+"/"),
			}, "\n")

			command := exec.Command(shell, "-c", program)
			if out, err := command.CombinedOutput(); err != nil {
				t.Fatalf("the configuration step of the install script failed: %v\n%s", err, out)
			}

			written := filepath.Join(dir, "relay.yaml")

			conf, err := config.Load(written)
			if err != nil {
				body, _ := os.ReadFile(written)
				t.Fatalf("the relay.yaml the script writes does not load, so the relay it "+
					"installs would not start: %v\n%s", err, body)
			}

			if conf.Meet.Role != config.RoleRelay {
				t.Fatalf("the script wrote a %q", conf.Meet.Role)
			}

			cc := conf.LiveKit.RTC.CongestionControl
			if !cc.Enabled || !cc.UseSendSideBWE {
				t.Errorf("a freshly installed relay has congestion control %v and the sender-side "+
					"estimate %v; without both, a viewer on a narrow line is sent the whole of a "+
					"screen share and freezes", cc.Enabled, cc.UseSendSideBWE)
			}

			if got := conf.LiveKit.RTC.PacketBufferSizeVideo; got != 4000 {
				t.Errorf("a freshly installed relay keeps %d packets of video for resending, "+
					"want 4000", got)
			}
		})
	}
}

// writingTheConfiguration cuts out the step of the script that writes
// relay.yaml, from the line announcing it to the redirect that ends it.
//
// Found by those two lines rather than by line numbers, and refused loudly when
// either is missing, so that a rewritten script fails here instead of handing
// this test nothing to run and passing.
func writingTheConfiguration(t *testing.T, script string) string {
	t.Helper()

	const (
		opening = `say "Writing the configuration"`
		closing = "} > /etc/tomoshibi/relay.yaml"
	)

	start := strings.Index(script, opening)
	if start < 0 {
		t.Fatalf("the install script no longer announces %q; this test cannot find the step "+
			"that writes relay.yaml", opening)
	}

	end := strings.Index(script[start:], closing)
	if end < 0 {
		t.Fatalf("the install script no longer ends its configuration with %q", closing)
	}

	return script[start : start+end+len(closing)]
}

// pairAt puts a working certificate and key where the script's relay.yaml names
// them, since the loader refuses a pair it cannot load.
func pairAt(t *testing.T, dir string) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "relay.example.invalid"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"relay.example.invalid"},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(dir, "relay.fullchain.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(dir, "relay.key"),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled}), 0o600); err != nil {
		t.Fatal(err)
	}
}
