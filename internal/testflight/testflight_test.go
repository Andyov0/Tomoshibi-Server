package testflight

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

/*
What App Store Connect is sent, and how its answers are read.

None of this can be seen from the page. A token signed in the wrong form is
refused by Apple with the same 401 a wrong key gets, so a mistake in the
signature reads as a mistake in the configuration and sends somebody to App
Store Connect to make a new key that will be refused the same way. The 409
path is the one an ordinary deployment meets least and gets wrong most: a
tester Apple already has must be told apart from a tester already in this
group, or somebody waiting for a mail is told to look for one that was never
sent. And an address must never reach the log through an error.

A stand-in for App Store Connect answers here, playing the four requests an
invitation can make, and checks every token it is handed against the public
half of the key, as Apple does.
*/

const (
	keyID  = "ABCDEFGHIJ"
	issuer = "57246542-96fe-1a63-e053-0824d011072a"
	group  = "f4a1c6c2-0000-4000-8000-000000000001"
)

// apple is a stand-in for App Store Connect, holding testers and one group.
type apple struct {
	t   *testing.T
	key *ecdsa.PublicKey

	mu sync.Mutex
	// testers is every tester by address, with their id; inGroup is those in
	// the group.
	testers map[string]string
	inGroup map[string]bool
	// refuse, where set, is the status the creation is answered with instead.
	refuse int
	calls  []string
}

func (a *apple) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.calls = append(a.calls, r.Method+" "+r.URL.Path)
	a.checkToken(r.Header.Get("Authorization"))

	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/betaTesters":
		var body struct {
			Data struct {
				Type       string `json:"type"`
				Attributes struct {
					Email     *string `json:"email"`
					FirstName *string `json:"firstName"`
					LastName  *string `json:"lastName"`
				} `json:"attributes"`
				Relationships struct {
					BetaGroups struct {
						Data []struct {
							Type string `json:"type"`
							ID   string `json:"id"`
						} `json:"data"`
					} `json:"betaGroups"`
				} `json:"relationships"`
			} `json:"data"`
		}

		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			a.t.Errorf("the creation was not JSON: %v", err)
		}

		d := body.Data
		if d.Type != "betaTesters" || d.Attributes.Email == nil ||
			d.Attributes.FirstName == nil || d.Attributes.LastName == nil ||
			len(d.Relationships.BetaGroups.Data) != 1 ||
			d.Relationships.BetaGroups.Data[0].Type != "betaGroups" ||
			d.Relationships.BetaGroups.Data[0].ID != group {
			a.t.Errorf("the creation was not shaped as App Store Connect asks: %+v", d)
		}

		if a.refuse != 0 {
			w.WriteHeader(a.refuse)
			_, _ = io.WriteString(w, `{"errors":[{"code":"FORBIDDEN_ERROR","detail":"no, `+*d.Attributes.Email+`"}]}`)
			return
		}

		email := *d.Attributes.Email
		if _, known := a.testers[email]; known {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"errors":[{"code":"ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE"}]}`)
			return
		}

		a.testers[email] = "tester-" + email
		a.inGroup[email] = true
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"data":{"type":"betaTesters","id":"tester-x"}}`)

	case r.Method == http.MethodGet && r.URL.Path == "/v1/betaTesters":
		email := r.URL.Query().Get("filter[email]")
		inGroup := r.URL.Query().Get("filter[betaGroups]")

		id, known := a.testers[email]
		if inGroup != "" && (inGroup != group || !a.inGroup[email]) {
			known = false
		}

		if !known {
			_, _ = io.WriteString(w, `{"data":[]}`)
			return
		}

		_, _ = io.WriteString(w, `{"data":[{"type":"betaTesters","id":"`+id+`"}]}`)

	case r.Method == http.MethodPost && r.URL.Path == "/v1/betaGroups/"+group+"/relationships/betaTesters":
		var body struct {
			Data []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		if len(body.Data) != 1 || body.Data[0].Type != "betaTesters" {
			a.t.Errorf("the addition to the group was not shaped as asked: %+v", body)
		}

		for email, id := range a.testers {
			if id == body.Data[0].ID {
				a.inGroup[email] = true
			}
		}

		w.WriteHeader(http.StatusNoContent)

	default:
		a.t.Errorf("an invitation asked for %s %s, which it has no reason to", r.Method, r.URL.String())
		w.WriteHeader(http.StatusNotFound)
	}
}

// checkToken verifies a bearer token as App Store Connect would: the header,
// the claims, and an ES256 signature over the two in r||s form.
func (a *apple) checkToken(authorization string) {
	t := a.t

	token, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok {
		t.Errorf("no bearer token: %q", authorization)
		return
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Errorf("a token in %d parts, not three", len(parts))
		return
	}

	decode := func(part string) []byte {
		raw, err := base64.RawURLEncoding.DecodeString(part)
		if err != nil {
			t.Errorf("a part of the token is not unpadded base64url: %v", err)
		}
		return raw
	}

	var header map[string]string
	if err := json.Unmarshal(decode(parts[0]), &header); err != nil {
		t.Errorf("the header is not JSON: %v", err)
	}
	if header["alg"] != "ES256" || header["kid"] != keyID || header["typ"] != "JWT" {
		t.Errorf("the header is %v", header)
	}

	var claims map[string]any
	if err := json.Unmarshal(decode(parts[1]), &claims); err != nil {
		t.Errorf("the claims are not JSON: %v", err)
	}

	iat, _ := claims["iat"].(float64)
	exp, _ := claims["exp"].(float64)
	if claims["iss"] != issuer || claims["aud"] != "appstoreconnect-v1" {
		t.Errorf("the claims are %v", claims)
	}
	if exp-iat != 600 {
		t.Errorf("the token lives %v seconds, want 600", exp-iat)
	}
	if drift := time.Since(time.Unix(int64(iat), 0)); drift < -time.Minute || drift > time.Minute {
		t.Errorf("the token was issued %v from now", drift)
	}

	signature := decode(parts[2])
	if len(signature) != 64 {
		t.Errorf("the signature is %d bytes; ES256 in a JWS is r and s, 32 each", len(signature))
		return
	}

	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])

	if !ecdsa.Verify(a.key, digest[:], r, s) {
		t.Error("the signature does not verify against the key's public half")
	}
}

func stand(t *testing.T) (*apple, *Client) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	stub := &apple{t: t, key: &key.PublicKey, testers: map[string]string{}, inGroup: map[string]bool{}}
	server := httptest.NewServer(stub)
	t.Cleanup(server.Close)

	client := New(keyID, issuer, group, key)
	client.base = server.URL

	return stub, client
}

func TestANewAddressIsSent(t *testing.T) {
	stub, client := stand(t)

	outcome, err := client.Invite(context.Background(), "ada@example.com")
	if err != nil || outcome != Sent {
		t.Fatalf("a new address came to %q, %v; want sent", outcome, err)
	}

	if len(stub.calls) != 1 {
		t.Errorf("a new address took %v; one request is enough", stub.calls)
	}
}

// The 409 for somebody already in this group: Apple mailed them before.
func TestAnAddressAlreadyInTheGroupIsAlreadyInvited(t *testing.T) {
	stub, client := stand(t)
	stub.testers["ada@example.com"] = "tester-ada"
	stub.inGroup["ada@example.com"] = true

	outcome, err := client.Invite(context.Background(), "ada@example.com")
	if err != nil || outcome != AlreadyInvited {
		t.Fatalf("an address already in the group came to %q, %v; want already invited", outcome, err)
	}

	for _, call := range stub.calls {
		if strings.Contains(call, "relationships") {
			t.Errorf("somebody already in the group was added again: %v", stub.calls)
		}
	}
}

// The 409 for a tester Apple has from somewhere else: added to this group, which
// is when Apple mails them, and so a mail is on its way.
func TestATesterFromElsewhereIsAddedToTheGroup(t *testing.T) {
	stub, client := stand(t)
	stub.testers["ada@example.com"] = "tester-ada"

	outcome, err := client.Invite(context.Background(), "ada@example.com")
	if err != nil || outcome != Sent {
		t.Fatalf("a tester from another group came to %q, %v; want sent", outcome, err)
	}

	if !stub.inGroup["ada@example.com"] {
		t.Errorf("the tester was never added to the group: %v", stub.calls)
	}

	want := []string{
		"POST /v1/betaTesters",
		"GET /v1/betaTesters",
		"GET /v1/betaTesters",
		"POST /v1/betaGroups/" + group + "/relationships/betaTesters",
	}
	if strings.Join(stub.calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("the 409 path asked\n%v\nwant\n%v", stub.calls, want)
	}
}

// A refusal carries Apple's status and code, and never Apple's sentence, which
// here quotes the address back as Apple's sometimes do.
func TestARefusalSaysWhatAppleSaidWithoutTheAddress(t *testing.T) {
	stub, client := stand(t)
	stub.refuse = http.StatusForbidden

	_, err := client.Invite(context.Background(), "ada@example.com")

	var refusal *Refused
	if !errors.As(err, &refusal) || refusal.Status != http.StatusForbidden || refusal.Code != "FORBIDDEN_ERROR" {
		t.Fatalf("a 403 came back as %v", err)
	}

	if strings.Contains(err.Error(), "ada") {
		t.Errorf("the error, which is logged, carries the address: %v", err)
	}
}

// The standard library quotes the URL in a request that never arrived, and the
// URL of a search by address carries the address.
func TestAnUnreachableAppleIsReportedWithoutTheAddress(t *testing.T) {
	stub, client := stand(t)
	stub.testers["ada@example.com"] = "tester-ada"

	// Answer the creation with a 409, then close the door on the search.
	conflict := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusConflict)
			return
		}

		hijacked, _, _ := w.(http.Hijacker).Hijack()
		_ = hijacked.Close()
	}))
	t.Cleanup(conflict.Close)
	client.base = conflict.URL

	_, err := client.Invite(context.Background(), "ada@example.com")
	if err == nil {
		t.Fatal("a search that was cut off came back as a success")
	}

	if strings.Contains(err.Error(), "ada") || strings.Contains(err.Error(), "example.com") {
		t.Errorf("the error, which is logged, carries the address: %v", err)
	}
}

func TestMaskedKeepsTheAddressOutOfTheLog(t *testing.T) {
	if got := Masked("ada.lovelace@example.com"); got != "a***@example.com" {
		t.Errorf("masked to %q", got)
	}

	if got := Masked("nonsense"); strings.Contains(got, "nonsense") {
		t.Errorf("something that is not an address went through whole: %q", got)
	}
}

// The signature's two halves are padded to thirty-two bytes each. An unpadded
// one is wrong only when r or s happens to begin with a zero byte, about one
// token in a hundred and twenty-eight, so a single invitation would pass a
// broken signer nearly every time. A thousand tokens miss it about once in
// two and a half thousand runs.
func TestEveryTokenIsSignedInTheFormJWSAsksFor(t *testing.T) {
	stub, client := stand(t)

	for range 1000 {
		token, err := client.token()
		if err != nil {
			t.Fatal(err)
		}

		stub.checkToken("Bearer " + token)
		if t.Failed() {
			return
		}
	}
}
