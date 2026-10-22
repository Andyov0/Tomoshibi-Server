package rtc

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
)

/*
The one path by which a relay's certificate is ever replaced.

Everything about this is quiet when it goes wrong. A push that is refused leaves
the relay serving a certificate that still works, for a while; a push that is
accepted when it should not have been leaves it serving one somebody else chose.
Neither shows up until a date that is months away, which is the whole reason the
fleet had no distribution at all until now: nothing about the missing one was
visible either.
*/

const (
	testKey    = "APItest"
	testSecret = "a secret long enough for the token library to accept it"
)

// issued writes a certificate and key expiring at the given time.
func issued(t *testing.T, dir string, expires time.Time) (string, string, Certificate) {
	t.Helper()

	return issuedFor(t, dir, expires, "relay.example.invalid", nil)
}

// issuedFor writes a certificate for a name, an address, or both.
func issuedFor(t *testing.T, dir string, expires time.Time, host string, ip net.IP) (string, string, Certificate) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(expires.UnixNano()),
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     expires,
	}

	if host != "" {
		template.DNSNames = []string{host}
	}
	if ip != nil {
		template.IPAddresses = []net.IP{ip}
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	pkey := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled})

	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if err := os.WriteFile(certPath, cert, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pkey, 0o600); err != nil {
		t.Fatal(err)
	}

	return certPath, keyPath, Certificate{Cert: string(cert), Key: string(pkey)}
}

// pushing sends one certificate at the handler, signed or not.
func pushing(t *testing.T, handler http.Handler, cert Certificate, signed bool) *httptest.ResponseRecorder {
	t.Helper()

	body, err := json.Marshal(cert)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPut, CertificatePath, bytes.NewReader(body))

	if signed {
		token, err := auth.NewAccessToken(testKey, testSecret).
			SetIdentity("tomoshibi").
			SetVideoGrant(&auth.VideoGrant{RoomList: true}).
			SetValidFor(time.Minute).
			ToJWT()
		if err != nil {
			t.Fatal(err)
		}

		request.Header.Set("Authorization", "Bearer "+token)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	return recorder
}

func TestARenewedCertificateReplacesTheOneOnDisk(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := issued(t, dir, time.Now().Add(30*24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, renewed := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	if code := pushing(t, handler, renewed, true).Code; code != http.StatusOK {
		t.Fatalf("the relay answered %d", code)
	}

	on, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(on) != renewed.Cert {
		t.Error("the certificate on disk is not the one that was sent, so the fleet would " +
			"expire on schedule with the renewal sitting on the control node")
	}
}

// The check that stops a certificate going backwards.
//
// Without it, anybody who could reach this endpoint could put back a
// certificate about to expire and choose the hour a relay stops answering. It
// is also what makes the hourly push safe to be dull: the control node sends to
// everybody and keeps no record of who has what, so most pushes are of a
// certificate the relay already holds.
func TestAnOlderCertificateIsNotTaken(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, current := issued(t, dir, time.Now().Add(60*24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, older := issued(t, t.TempDir(), time.Now().Add(2*24*time.Hour))

	if code := pushing(t, handler, older, true).Code; code != http.StatusOK {
		t.Fatalf("answered %d; being sent something already held is the ordinary case and "+
			"not an error", code)
	}

	on, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(on) != current.Cert {
		t.Error("an older certificate replaced a newer one: whoever can reach this can now " +
			"choose the hour this relay stops answering")
	}
}

func TestAnUnsignedPushIsRefused(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, current := issued(t, dir, time.Now().Add(24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, renewed := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	if code := pushing(t, handler, renewed, false).Code; code != http.StatusUnauthorized {
		t.Errorf("an unsigned push answered %d: anybody who found the port could replace "+
			"what this relay serves", code)
	}

	if on, _ := os.ReadFile(certPath); string(on) != current.Cert {
		t.Error("and it was written anyway")
	}
}

func TestSomethingThatIsNotAKeypairIsRefused(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, current := issued(t, dir, time.Now().Add(24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	// A certificate with somebody else's key, which is the shape a mistake
	// takes: two files copied from two different renewals.
	_, _, one := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))
	_, _, two := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	mismatched := Certificate{Cert: one.Cert, Key: two.Key}

	if code := pushing(t, handler, mismatched, true).Code; code != http.StatusBadRequest {
		t.Errorf("answered %d, want 400", code)
	}

	if on, _ := os.ReadFile(certPath); string(on) != current.Cert {
		t.Error("a certificate that does not match its key was written, which is a relay that " +
			"comes back from its next restart refusing every handshake")
	}
}

/*
The certificate two relays hold for their own bare address, and the wildcard
that ate it.

Those two are dialled by address rather than by name, because the name they used
to answer to is filtered on this path and the address is not. So each of them
issues its own certificate for that address — short-lived, six days, renewed
four times a day by its own cron — and that is the certificate they must serve.

The rule here used to be "a later expiry is a renewal", which is true of every
relay but those two and catastrophic for them: a ninety-day wildcard expires
later than a six-day address certificate by definition, so the fleet-wide push
replaced it. Both machines went on answering, and every client that checks the
name it dialled against the certificate it was given stopped being able to reach
them — which does not look like a certificate problem from the outside. It looks
like two relays that went quiet.
*/
func TestAWildcardDoesNotReplaceACertificateForTheAddress(t *testing.T) {
	dir := t.TempDir()

	// What one of those relays serves: its own address, expiring in six days.
	certPath, keyPath, _ := issuedFor(t, dir, time.Now().Add(6*24*time.Hour), "", net.ParseIP("198.51.100.9"))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	// What the control node has, and pushes to everybody: a wildcard for a
	// domain, expiring in ninety days.
	_, _, wildcard := issuedFor(t, t.TempDir(), time.Now().Add(90*24*time.Hour), "relay.example.invalid", nil)

	if code := pushing(t, handler, wildcard, true).Code; code != http.StatusOK {
		t.Fatalf("answered %d; being offered something it will not take is not an error", code)
	}

	on, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}

	leaf, err := leafOf(on)
	if err != nil {
		t.Fatal(err)
	}

	if len(leaf.IPAddresses) == 0 {
		t.Fatal("the certificate for this relay's own address was replaced by one that does " +
			"not name it. The relay still answers, and nothing that checks the address it " +
			"dialled can reach it")
	}

	if leaf.VerifyHostname("198.51.100.9") != nil {
		t.Error("what is served no longer answers to the address it is dialled by")
	}
}

// And the ordinary case still works: same names, later date, taken.
func TestARenewalOfTheSameCertificateIsStillTaken(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := issued(t, dir, time.Now().Add(30*24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, renewed := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	if code := pushing(t, handler, renewed, true).Code; code != http.StatusOK {
		t.Fatalf("answered %d", code)
	}

	if on, _ := os.ReadFile(certPath); string(on) != renewed.Cert {
		t.Error("a plain renewal was refused, which would leave the fleet expiring on schedule")
	}
}

// What a relay says it is serving, which is how the one certificate this
// deployment cannot renew gets watched at all.
//
// Two relays hold a six-day certificate for their own bare address, issued and
// renewed by a cron job on the machine itself. Nothing here can renew it and
// nothing was watching it: the job could stop and the relay would answer
// perfectly until the morning it did not. The push already reaches every relay
// every hour, so the date comes back in the answer.
func TestTheRelaySaysWhatItIsServing(t *testing.T) {
	dir := t.TempDir()
	expires := time.Now().Add(6 * 24 * time.Hour).Truncate(time.Second)
	certPath, keyPath, _ := issuedFor(t, dir, expires, "", net.ParseIP("198.51.100.9"))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	// Offered a wildcard it will not take, which is the ordinary case for these
	// two and the one where the date matters most.
	_, _, wildcard := issuedFor(t, t.TempDir(), time.Now().Add(90*24*time.Hour), "relay.example.invalid", nil)

	recorder := pushing(t, handler, wildcard, true)
	if recorder.Code != http.StatusOK {
		t.Fatalf("answered %d", recorder.Code)
	}

	var said struct {
		Kept    bool      `json:"kept"`
		Expires time.Time `json:"expires"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatal(err)
	}

	if !said.Kept {
		t.Error("it took the wildcard over its own address certificate")
	}

	if !said.Expires.Equal(expires) {
		t.Errorf("it says %s and is serving something that expires %s: a date nobody can read "+
			"back is a certificate nobody is watching", said.Expires, expires)
	}
}

/*
 * The way back from a certificate pushed by mistake.
 *
 * The refusal rules only go one way, deliberately: a relay never narrows what
 * it answers to and never takes something that expires no later than what it
 * holds. Both were written after real faults — a wildcard pushed over the
 * certificates of two relays dialled by bare address took them off the air.
 *
 * The cost is that a certificate pushed by mistake with a distant expiry cannot
 * be pushed over. Every correct push afterwards is refused, and the refusal
 * answers 200 and looks exactly like the ordinary case of a relay already
 * having what was sent.
 *
 * There is no override for this and there should not be: one reachable over the
 * network is a way for whoever can reach the relay to narrow its certificate,
 * which is what the rule prevents. The way out is on the machine — take the
 * file away, and the next push has nothing to be refused in favour of. This
 * test is that claim, and RELAY.md is where somebody looks for it.
 */
func TestTakingTheFileAwayLetsTheNextPushLand(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := issued(t, dir, time.Now().Add(3650*24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	// The real one, which expires long before the mistake and is therefore
	// refused while the mistake is in place.
	_, _, right := issued(t, t.TempDir(), time.Now().Add(60*24*time.Hour))

	if code := pushing(t, handler, right, true).Code; code != http.StatusOK {
		t.Fatalf("answered %d, want 200", code)
	}

	on, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(on) == right.Cert {
		t.Fatal("a certificate expiring sooner replaced one expiring later, which is the rule " +
			"that stops somebody choosing the hour this relay goes off the air")
	}

	// The way out, taken on the machine itself.
	if err := os.Remove(certPath); err != nil {
		t.Fatal(err)
	}

	if code := pushing(t, handler, right, true).Code; code != http.StatusOK {
		t.Fatalf("answered %d after the file was taken away, want 200", code)
	}

	on, err = os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("nothing was written after the file was taken away: %v", err)
	}

	if string(on) != right.Cert {
		t.Error("taking the file away did not let the next push land, so a certificate pushed " +
			"by mistake has no way back at all")
	}
}

/*
 * Which certificate refusals are worth waking somebody for.
 *
 * A relay that keeps what it has answers 200 either way, so the reason is the
 * only thing that separates "this is every round of every hour" from "this
 * machine is stuck behind a certificate nothing here can replace".
 *
 * Both routine cases were warned about when this was first written, and the
 * first run against the real fleet produced six of them in one round — one per
 * relay, every hour, for ever. A warning that fires on the ordinary case is a
 * warning somebody learns to scroll past, which costs the line the one time it
 * means something.
 *
 * The strings are this repository's own, from keeping() in certificate.go, and
 * the cases below are taken from that function rather than invented.
 */
func TestWhichRefusalsAreRoutine(t *testing.T) {
	for _, why := range []string{
		"the offer expires no later than what is held",
		"the offer does not answer to 203.0.113.25",
		"the offer does not answer to hk.relays.example",
	} {
		if !routineRefusal(why) {
			t.Errorf("warned about the ordinary case: %q", why)
		}
	}

	for _, why := range []string{
		"the offer could not be read",
		"",
		"something nobody has written yet",
	} {
		if routineRefusal(why) && why != "" {
			t.Errorf("stayed quiet about a refusal that is not ordinary: %q", why)
		}
	}
}
