// Package testflight asks App Store Connect to invite somebody to test the iOS
// app.
//
// The app is not in the App Store, and TestFlight is the only other way an
// iPhone installs it. TestFlight offers two doors: a public link anybody may
// open, and an invitation sent to one address. The public link was rejected
// for the same reason the client is behind an account: a link posted once
// anywhere is a link everybody has, and every tester counts against a ceiling
// Apple sets per app. An invitation is sent only to an address somebody signed
// in typed, and the server that sends it can count them.
//
// So this is the one call a signed-in account's page makes on their behalf: add
// an address to the app's external beta group, which is what makes Apple mail
// the invitation. Everything about who may ask and how often is decided by the
// caller; this only knows how to ask Apple and how to read what Apple said.
//
// The credential is an App Store Connect API key — a P-256 private key, a key
// id and an issuer id — and every request carries a token signed with it that
// lives ten minutes. The token is made here with the standard library alone,
// because it is three base64 strings and a signature, and a dependency for that
// would be a dependency whose every release has to be read for what it does
// with a key that can change the app's testers.
package testflight

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Production is where App Store Connect answers.
const Production = "https://api.appstoreconnect.apple.com"

// base is where this build sends its requests.
//
// Not a setting. A deployment that could be pointed somewhere else would sign a
// token with its App Store Connect key and hand it to whatever answered there,
// and a token is ten minutes of being able to change the app's testers. The one
// way to move it is to build the binary with the `ascstub` tag (see stub.go),
// which is how a local run reaches a stand-in rather than Apple; a release build
// cannot be told to send its key anywhere but here.
var base = Production

// tokenLife is how long a signed token is good for.
//
// Apple refuses one that claims more than twenty minutes. Every token here is
// made for one invitation and spent within seconds, so the ceiling is never
// approached and ten leaves room for a clock that runs a little fast.
const tokenLife = 10 * time.Minute

// Outcome is what an invitation came to, where it came to something.
type Outcome string

const (
	// Sent means Apple accepted the address into the group, which is when it
	// mails the invitation.
	Sent Outcome = "sent"

	// AlreadyInvited means the address was in the group before this asked. Apple
	// sent its invitation then and sends nothing now; the person should look
	// for that one.
	AlreadyInvited Outcome = "already_invited"
)

// Refused is Apple answering, and answering no.
//
// Status and the first error code Apple gave, and nothing of the detail beside
// them: Apple's sentences can quote the address back, and this error is written
// to a log, where an address must not appear.
type Refused struct {
	Status int
	Code   string
}

func (r *Refused) Error() string {
	if r.Code == "" {
		return fmt.Sprintf("App Store Connect answered %d", r.Status)
	}

	return fmt.Sprintf("App Store Connect answered %d (%s)", r.Status, r.Code)
}

// Client invites testers into one beta group of one team's app.
type Client struct {
	keyID  string
	issuer string
	group  string
	key    *ecdsa.PrivateKey

	base string
	http *http.Client
	now  func() time.Time
}

// New builds a client for one beta group, signing with key.
func New(keyID, issuer, group string, key *ecdsa.PrivateKey) *Client {
	return &Client{
		keyID:  keyID,
		issuer: issuer,
		group:  group,
		key:    key,
		base:   base,
		// The whole of one request, which is the bound a page waiting on an
		// answer actually has. An invitation is at most four requests, and
		// the caller's context bounds the lot.
		http: &http.Client{Timeout: 15 * time.Second},
		now:  time.Now,
	}
}

// ReadKey loads an App Store Connect private key from the .p8 file Apple hands
// out, which is a PEM-wrapped PKCS#8 P-256 key.
//
// The errors name the file, because the one place this is read before anybody
// needs it is the startup check, and a sentence there is the difference between
// a mistyped path and an invitation form that fails for every person who uses
// it, weeks later.
func ReadKey(path string) (*ecdsa.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read the App Store Connect key %s: %w", path, err)
	}

	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s holds no PEM block. An App Store Connect key is the .p8 file "+
			"downloaded once from Users and Access, and begins -----BEGIN PRIVATE KEY-----", path)
	}

	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s is not a PKCS#8 private key: %w", path, err)
	}

	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("%s holds a private key, but not a P-256 one, and App Store "+
			"Connect signs with nothing else", path)
	}

	return key, nil
}

// Invite asks Apple to invite an address into the group.
//
// The address arrives checked and lowercased by the caller. What happens:
//
//  1. Create a tester with this address, already in the group. A 201 is the
//     ordinary case, and Apple mails the invitation.
//  2. A 409 is Apple saying it already has a tester with this address. It does
//     not say whether that tester is in this group, so that is asked next,
//     because the two are different sentences to the person waiting: one is
//     "look for the mail you were sent", the other is "a mail is on its way".
//  3. Already in it: nothing to do.
//  4. Not in it: find them by address and add them to the group, which is when
//     Apple mails them.
func (c *Client) Invite(ctx context.Context, email string) (Outcome, error) {
	token, err := c.token()
	if err != nil {
		return "", err
	}

	create := map[string]any{
		"data": map[string]any{
			"type": "betaTesters",
			"attributes": map[string]any{
				"email": email,
				// Required to be present and allowed to be empty. A name typed
				// here would be one more thing about somebody kept at Apple, and
				// the page asks for none.
				"firstName": "",
				"lastName":  "",
			},
			"relationships": map[string]any{
				"betaGroups": map[string]any{
					"data": []map[string]string{{"type": "betaGroups", "id": c.group}},
				},
			},
		},
	}

	status, reply, err := c.send(ctx, token, http.MethodPost, "/v1/betaTesters", create)
	if err != nil {
		return "", err
	}

	switch {
	case status == http.StatusCreated || status == http.StatusOK:
		return Sent, nil

	case status != http.StatusConflict:
		return "", refused(status, reply)
	}

	// In this group already, by asking for the tester with both filters. An
	// empty answer is not "no such tester" — the 409 says there is one — but
	// "not in this group".
	query := url.Values{}
	query.Set("filter[email]", email)
	query.Set("filter[betaGroups]", c.group)
	query.Set("limit", "1")

	found, err := c.find(ctx, token, query)
	if err != nil {
		return "", err
	}

	if found != "" {
		return AlreadyInvited, nil
	}

	query.Del("filter[betaGroups]")

	found, err = c.find(ctx, token, query)
	if err != nil {
		return "", err
	}

	// Apple said the tester exists and then could not find them. Not something
	// this can mend, and not something to call a success.
	if found == "" {
		return "", &Refused{Status: http.StatusConflict, Code: "TESTER_NOT_FOUND"}
	}

	add := map[string]any{
		"data": []map[string]string{{"type": "betaTesters", "id": found}},
	}

	status, reply, err = c.send(ctx, token, http.MethodPost,
		"/v1/betaGroups/"+url.PathEscape(c.group)+"/relationships/betaTesters", add)
	if err != nil {
		return "", err
	}

	if status != http.StatusNoContent && status != http.StatusOK {
		return "", refused(status, reply)
	}

	return Sent, nil
}

// find returns the id of the first tester a query matches, or nothing.
func (c *Client) find(ctx context.Context, token string, query url.Values) (string, error) {
	status, reply, err := c.send(ctx, token, http.MethodGet, "/v1/betaTesters?"+query.Encode(), nil)
	if err != nil {
		return "", err
	}

	if status != http.StatusOK {
		return "", refused(status, reply)
	}

	var listed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}

	if err := json.Unmarshal(reply, &listed); err != nil {
		return "", &Refused{Status: status, Code: "UNREADABLE"}
	}

	if len(listed.Data) == 0 {
		return "", nil
	}

	return listed.Data[0].ID, nil
}

// send makes one request and reads at most enough of the answer to understand it.
//
// A failure to reach Apple is reported without the request's address. The
// standard library's error for a request that did not arrive quotes the URL,
// and the URL of a search by address carries the address — which would put it
// in the log of every invitation that met a network fault.
func (c *Client) send(ctx context.Context, token, method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return 0, nil, fmt.Errorf("build a request to App Store Connect: %w", scrub(err))
	}

	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("reach App Store Connect: %w", scrub(err))
	}
	defer response.Body.Close()

	reply, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return 0, nil, fmt.Errorf("read App Store Connect's answer: %w", scrub(err))
	}

	return response.StatusCode, reply, nil
}

// scrub takes the URL out of an error the HTTP client made.
func scrub(err error) error {
	var wrapped *url.Error
	if errors.As(err, &wrapped) {
		return wrapped.Err
	}

	return err
}

// refused reads Apple's error code out of a refusal.
func refused(status int, reply []byte) error {
	var said struct {
		Errors []struct {
			Code string `json:"code"`
		} `json:"errors"`
	}

	_ = json.Unmarshal(reply, &said)

	code := ""
	if len(said.Errors) > 0 {
		code = said.Errors[0].Code
	}

	return &Refused{Status: status, Code: code}
}

// token signs the bearer token App Store Connect asks every request for.
//
// ES256 over the two encoded halves, and the signature written as r and s side
// by side, thirty-two bytes each. That last part is what JWS asks for and not
// what Go's ecdsa package hands out by default: SignASN1 gives the DER sequence,
// which is not a valid JWS signature, and Apple answers every token it cannot
// verify with the same 401 — so the mistake would read as a wrong key.
func (c *Client) token() (string, error) {
	now := c.now().UTC()

	header, err := json.Marshal(map[string]string{"alg": "ES256", "kid": c.keyID, "typ": "JWT"})
	if err != nil {
		return "", err
	}

	claims, err := json.Marshal(map[string]any{
		"iss": c.issuer,
		"iat": now.Unix(),
		"exp": now.Add(tokenLife).Unix(),
		"aud": "appstoreconnect-v1",
	})
	if err != nil {
		return "", err
	}

	signing := encode(header) + "." + encode(claims)
	digest := sha256.Sum256([]byte(signing))

	r, s, err := ecdsa.Sign(rand.Reader, c.key, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign an App Store Connect token: %w", err)
	}

	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])

	return signing + "." + encode(signature), nil
}

func encode(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Masked is an address as a log may show it: enough to tell two apart while
// reading a day's invitations, and not enough to write to anybody.
func Masked(email string) string {
	local, domain, found := strings.Cut(email, "@")
	if !found || local == "" {
		return "***"
	}

	return local[:1] + "***@" + domain
}
