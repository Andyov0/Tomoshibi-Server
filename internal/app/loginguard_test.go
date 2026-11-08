package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/lockout"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
	"tomoshibi/internal/turnstile/turnstiletest"
)

/*
 * The sign-in lockout and the human check together, at both doors, on the
 * router startup builds for a control node: nginx on the same machine in front
 * of 127.0.0.1:8080, a CDN in front of nginx, trust_proxy and two proxies.
 *
 * Each was tested on its own branch against a router of its own, and what
 * neither could see is how they meet. A lockout asked after the check would
 * spend a good token, and a Cloudflare request, on a caller who is refused
 * anyway. A check whose refusal was counted as a failed sign-in would let
 * anybody shut a caller out with rubbish tokens, which cost nothing to make. The
 * apps, which the owner decided are never asked for the check, would have no
 * protection at all if the lockout did not count them. And the tools on the
 * control node that sign in over loopback with no browser are spared the check
 * by where their connection comes from, which is also where every request
 * nginx passes on comes from; only the forwarding headers nginx always writes
 * tell the two apart, so every way of getting that wrong is a way of sparing
 * the whole internet.
 *
 * Cloudflare is a stand-in (turnstiletest): "good:" tokens are solved for the
 * account door, "admin:" for the management door, anything else is refused.
 */

// The CDN's node, which nginx sees and appends; the caller is the entry to its
// left, two in from the right.
const cdnNode = "172.70.1.1"

// nginx's own connection to the server, which is loopback like a local tool's.
const nginxPeer = "127.0.0.1:40312"

// The administrator on the control node.
const bossSaid = "the boss's own passphrase"

// What the apps' shared core sends, in the form core/protocol/src/api/agent.rs
// writes it.
const iPhoneApp = "Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)"

// What a peek tool written with Python's urllib sends.
const toolAgent = "Python-urllib/3.12"

// controlNode is a control node built as startup builds one, with the human
// check answered by a stand-in, an administrator named boss and an account
// named ada. tweak may change the configuration before anything is made from
// it.
func controlNode(t *testing.T, tweak func(*config.Meet)) (*App, http.Handler, *turnstiletest.Cloudflare) {
	t.Helper()

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	if err := st.AddAdmin(store.Admin{Trip: room.Trip(tripKey, bossSaid), Name: "boss"}); err != nil {
		t.Fatal(err)
	}
	if err := st.AddAccount(store.Account{Name: "ada", Trip: room.Trip(tripKey, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:       config.RoleControl,
			Listen:     "127.0.0.1:8080",
			TrustProxy: true,
			Proxies:    2,
			TokenTTL:   5 * time.Minute,
			JoinRate:   1000,
			JoinBurst:  1000,
			SourceURL:  source,
			Turnstile:  turnstiletest.Config(),
		},
	}
	if tweak != nil {
		tweak(&conf.Meet)
	}

	app := New(conf, st, nil, http.NotFoundHandler(), tripKey)
	t.Cleanup(app.Close)

	fake := turnstiletest.Start(t)
	app.admin.UseHumanCheck(fake.Checker(conf.Meet))

	return app, app.Handler(), fake
}

// signingInAt is a sign-in at door, carrying token where it is not empty.
func signingInAt(door, name, said, token string) *http.Request {
	body := fmt.Sprintf(`{"name":%q,"passphrase":%q}`, name, said)
	if token != "" {
		body = fmt.Sprintf(`{"name":%q,"passphrase":%q,"turnstile":%q}`, name, said, token)
	}

	request := httptest.NewRequest(http.MethodPost, door, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	return request
}

const (
	accountDoor    = "/api/account/session"
	managementDoor = "/api/admin/session"
)

// throughNginx is a sign-in from caller, with agent, as nginx passes it on
// from behind the CDN: from loopback, with the forwarded chain nginx appends
// to and the address it saw. A browser's carries the fetch metadata a page on
// this deployment sends.
func throughNginx(door, name, said, token, agent, caller string) *http.Request {
	request := signingInAt(door, name, said, token)
	request.RemoteAddr = nginxPeer
	request.Header.Set("User-Agent", agent)
	request.Header.Set("X-Forwarded-For", caller+", "+cdnNode)
	request.Header.Set("X-Real-IP", cdnNode)

	if agent == browser {
		request.Header.Set("Sec-Fetch-Site", "same-origin")
	}

	return request
}

// onThisMachine is a sign-in a tool on the control node sends straight to
// 127.0.0.1:8080.
func onThisMachine(door, name, said string) *http.Request {
	request := signingInAt(door, name, said, "")
	request.RemoteAddr = "127.0.0.1:51734"
	request.Header.Set("User-Agent", toolAgent)

	return request
}

// lockedOutAnswer reports whether recorder is the lockout's answer, with
// reason: 429, the reason, the lockout's end and a Retry-After.
func lockedOutAnswer(recorder *httptest.ResponseRecorder, reason string) bool {
	var said struct {
		Error string `json:"error"`
		Until string `json:"until"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return recorder.Code == http.StatusTooManyRequests && said.Error == reason && said.Until != "" &&
		recorder.Header().Get("Retry-After") != ""
}

// handedSession reports whether an answer set a session cookie.
func handedSession(recorder *httptest.ResponseRecorder) bool {
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Value != "" && cookie.MaxAge >= 0 {
			return true
		}
	}

	return false
}

// shutOutWithTokens fails six times at the account door and five at the
// management door from caller, each with a good token for its door, the
// eleventh shutting the caller out. Split, because each door's guessing
// budget is ten a minute from one address.
func shutOutWithTokens(t *testing.T, mux http.Handler, agent, caller string) {
	t.Helper()

	for i := range 6 {
		recorder := ask(mux, throughNginx(accountDoor, "ada", "wrong", fmt.Sprintf("good:a%d", i), agent, caller))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("account failure %d answered %d %s, want 401", i+1, recorder.Code, recorder.Body.String())
		}
	}
	for i := range 4 {
		recorder := ask(mux, throughNginx(managementDoor, "boss", "wrong", fmt.Sprintf("admin:m%d", i), agent, caller))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("management failure %d answered %d %s, want 401", i+1, recorder.Code, recorder.Body.String())
		}
	}

	eleventh := ask(mux, throughNginx(managementDoor, "boss", "wrong", "admin:m4", agent, caller))
	if !lockedOutAnswer(eleventh, "too_many_attempts") {
		t.Fatalf("the eleventh failure answered %d %s, want the lockout", eleventh.Code, eleventh.Body.String())
	}
}

// A caller shut out is answered by the lockout at both doors, with a good
// token and the right passphrase, and Cloudflare is not asked about the token:
// the lockout comes before the check, so a shut-out caller costs this server
// no request to Cloudflare and spends nothing of theirs.
func TestALockedOutBrowserWithAGoodTokenIsRefusedWithoutAskingCloudflare(t *testing.T) {
	_, mux, fake := controlNode(t, nil)

	shutOutWithTokens(t, mux, browser, "198.51.100.23")

	asked := fake.Asked()

	account := ask(mux, throughNginx(accountDoor, "ada", "ada's passphrase", "good:after", browser, "198.51.100.23"))
	if !lockedOutAnswer(account, reasonRateLimited) {
		t.Errorf("the account door answered a shut-out caller's good token %d %s, want the lockout",
			account.Code, account.Body.String())
	}
	if handedSession(account) {
		t.Error("the account door handed a shut-out caller a session")
	}

	management := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "admin:after", browser, "198.51.100.23"))
	if !lockedOutAnswer(management, "too_many_attempts") {
		t.Errorf("the management door answered a shut-out caller's good token %d %s, want the lockout",
			management.Code, management.Body.String())
	}
	if handedSession(management) {
		t.Error("the management door handed a shut-out caller a session")
	}

	if fake.Asked() != asked {
		t.Errorf("Cloudflare was asked %d times about a shut-out caller's tokens, want none", fake.Asked()-asked)
	}
}

// A human check that did not pass is not a failed sign-in, at either door.
// Counted, it would let anybody shut a caller out with tokens that cost
// nothing to make up, and with them the address's other people.
func TestAHumanCheckRefusalNeverCountsTowardTheLockout(t *testing.T) {
	app, mux, _ := controlNode(t, nil)

	for i := range 12 {
		account := ask(mux, throughNginx(accountDoor, "ada", "wrong", fmt.Sprintf("made-up-a%d", i), browser, "198.51.100.23"))
		if account.Code != http.StatusForbidden || refusedWith(account) != "human_check_failed" {
			t.Fatalf("bad token %d at the account door answered %d %s, want 403 human_check_failed",
				i+1, account.Code, account.Body.String())
		}

		management := ask(mux, throughNginx(managementDoor, "boss", "wrong", fmt.Sprintf("made-up-m%d", i), browser, "198.51.100.23"))
		if management.Code != http.StatusForbidden || refusedWith(management) != "human_check_failed" {
			t.Fatalf("bad token %d at the management door answered %d %s, want 403 human_check_failed",
				i+1, management.Code, management.Body.String())
		}
	}

	if listed := app.admin.Lockout().Lockouts(); len(listed) != 0 {
		t.Fatalf("%d lockouts from twenty-four refused human checks, want none", len(listed))
	}

	// Nor did they spend a budget: the caller signs in at both with tokens.
	if recorder := ask(mux, throughNginx(accountDoor, "ada", "ada's passphrase", "good:in", browser, "198.51.100.23")); recorder.Code != http.StatusOK {
		t.Errorf("signing in at the account door afterwards answered %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "admin:in", browser, "198.51.100.23")); recorder.Code != http.StatusOK {
		t.Errorf("signing in at the management door afterwards answered %d %s", recorder.Code, recorder.Body.String())
	}
}

// The owner's decision: an administrator signs in to an app with their own
// name and passphrase, and no token.
func TestAnAdministratorSignsInToAnAppWithNoToken(t *testing.T) {
	_, mux, fake := controlNode(t, nil)

	recorder := ask(mux, throughNginx(accountDoor, "boss", bossSaid, "", iPhoneApp, "198.51.100.23"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("the administrator from an app answered %d %s, want 200", recorder.Code, recorder.Body.String())
	}

	var me struct {
		Name  string `json:"name"`
		Admin bool   `json:"admin"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &me)
	if me.Name != "boss" || !me.Admin {
		t.Errorf("the administrator was signed in as %s", recorder.Body.String())
	}
	if !handedSession(recorder) {
		t.Error("the administrator was handed no session")
	}

	if fake.Asked() != 0 {
		t.Errorf("Cloudflare was asked %d times about an app's sign-in", fake.Asked())
	}
}

// Every app the native repository builds signs in with no token, each by the
// user agent its core writes, the Linux app for both of its processors among
// them. The exemption was written and tested before there was a Linux app,
// against the iPhone's and Android's agents, and it reads the agent by the
// kind the join reads it as (humanExempt): an exemption rewritten as a list of
// the kinds there were then would leave the Linux app's sign-in unable to
// finish, since the app has no widget to show and no token to send, and every
// test that names a phone would still pass.
//
// And a browser on Linux is asked as any browser is: the exemption is the
// app's, not the word Linux's.
func TestEveryAppSignsInWithNoTokenTheLinuxAppAmongThem(t *testing.T) {
	_, mux, fake := controlNode(t, nil)

	agents := []string{
		iPhoneApp,
		"Tomoshibi/0.1.7 (iPad; iPadOS 27.0; iPad16,3)",
		"Tomoshibi/0.1.7 (Mac; macOS 27.0; Mac16,7)",
		"Tomoshibi/0.1.7 (Android; Android 16; samsung SM-F956B)",
		"Tomoshibi/0.1.7 (Windows; Windows 10.0.26100; x64)",
		"Tomoshibi/0.1.7 (Linux; Ubuntu 24.04.4 LTS; LENOVO 21K5 x86_64)",
		"Tomoshibi/0.1.7 (Linux; Debian GNU/Linux 13 trixie; aarch64)",
		// A core built for Linux that was never described says only this.
		"Tomoshibi/0.1.7 (Linux)",
	}

	for i, agent := range agents {
		caller := fmt.Sprintf("198.51.100.%d", 60+i)

		recorder := ask(mux, throughNginx(accountDoor, "ada", "ada's passphrase", "", agent, caller))
		if recorder.Code != http.StatusOK || !handedSession(recorder) {
			t.Errorf("%q signing in with no token answered %d %s, want 200 and a session",
				agent, recorder.Code, recorder.Body.String())
		}
	}

	if fake.Asked() != 0 {
		t.Errorf("Cloudflare was asked %d times about the apps' sign-ins", fake.Asked())
	}

	linuxBrowser := throughNginx(accountDoor, "ada", "ada's passphrase", "", browser, "198.51.100.90")
	linuxBrowser.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
	linuxBrowser.Header.Set("Sec-Fetch-Site", "same-origin")
	if recorder := ask(mux, linuxBrowser); recorder.Code != http.StatusBadRequest || refusedWith(recorder) != "human_check_missing" {
		t.Errorf("a browser on Linux with no token answered %d %s, want 400 human_check_missing",
			recorder.Code, recorder.Body.String())
	}
}

// With no human check, what stands in front of an app's sign-in is the
// lockout: more than ten failures from one address and one device, and that
// device at that address is shut out of both doors.
//
// Eleven at the account door alone, which is where the apps sign in, means
// waiting for the guessing budget to give one back: it allows ten a minute
// from an address, one every six seconds, so the eleventh in the same minute
// would be the budget's refusal and not a failure. That is the budget doing
// its own job; the lockout is what still holds once a script paces itself
// under it.
func TestElevenFailuresFromAnAppShutThatAppOut(t *testing.T) {
	t.Parallel()

	app, mux, fake := controlNode(t, nil)

	const caller = "203.0.113.45"

	for i := range lockout.Failures {
		recorder := ask(mux, throughNginx(accountDoor, "boss", fmt.Sprintf("guess %d", i), "", iPhoneApp, caller))
		if recorder.Code != http.StatusUnauthorized || refusedWith(recorder) != reasonNotYours {
			t.Fatalf("an app's failure %d answered %d %s, want 401 %s", i+1, recorder.Code, recorder.Body.String(), reasonNotYours)
		}
	}

	time.Sleep(time.Minute/guess.PerAddress + 250*time.Millisecond)

	eleventh := ask(mux, throughNginx(accountDoor, "boss", "guess 10", "", iPhoneApp, caller))
	if !lockedOutAnswer(eleventh, reasonRateLimited) {
		t.Fatalf("an app's eleventh failure answered %d %s, want 429 %s with the lockout's end",
			eleventh.Code, eleventh.Body.String(), reasonRateLimited)
	}

	// Shut out, the right passphrase is refused like a wrong one.
	right := ask(mux, throughNginx(accountDoor, "boss", bossSaid, "", iPhoneApp, caller))
	if !lockedOutAnswer(right, reasonRateLimited) || handedSession(right) {
		t.Errorf("the right passphrase from the shut-out app answered %d %s, want the lockout",
			right.Code, right.Body.String())
	}

	// At the management door too, token or not.
	management := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "admin:1", iPhoneApp, caller))
	if !lockedOutAnswer(management, "too_many_attempts") {
		t.Errorf("the management door answered the shut-out app %d %s, want the lockout",
			management.Code, management.Body.String())
	}

	listed := app.admin.Lockout().Lockouts()
	if len(listed) != 1 || listed[0].Address != caller || listed[0].Client == nil || listed[0].Client.Agent != iPhoneApp {
		t.Fatalf("lockouts %+v, want the one app at %s", listed, caller)
	}

	// The address and the device together: another device at the address is
	// not shut out. Its answer is the budget's, which the eleven spent and
	// which names no lockout.
	other := ask(mux, throughNginx(accountDoor, "boss", bossSaid, "", "Tomoshibi/0.1.0.8 (Android; Android 16; samsung SM-F956B)", caller))
	if lockedOutAnswer(other, reasonRateLimited) {
		t.Errorf("another device at the address was shut out: %d %s", other.Code, other.Body.String())
	}

	if fake.Asked() != 0 {
		t.Errorf("Cloudflare was asked %d times about an app's sign-ins", fake.Asked())
	}
}

// The management door asks everybody for a token, a caller saying it is an
// app included. The apps never call it, so the exemption that is theirs at the
// account door has no business here.
func TestTheManagementDoorAsksAnAppForAToken(t *testing.T) {
	_, mux, _ := controlNode(t, nil)

	for _, agent := range []string{iPhoneApp, "", "Tomoshibi/x (anything at all)"} {
		recorder := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "", agent, "198.51.100.23"))
		if recorder.Code != http.StatusBadRequest || refusedWith(recorder) != "human_check_missing" {
			t.Errorf("the management door answered %q with no token %d %s, want 400 human_check_missing",
				agent, recorder.Code, recorder.Body.String())
		}
	}

	if recorder := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "admin:app", iPhoneApp, "198.51.100.23")); recorder.Code != http.StatusOK {
		t.Errorf("the management door answered an app's good token %d %s, want 200", recorder.Code, recorder.Body.String())
	}
}

// A tool on the control node signs in at 127.0.0.1:8080 with no browser, at
// either door, and is spared the check: its connection is loopback and it says
// it is passing nothing on.
func TestAProgramOnThisMachineSignsInWithoutAToken(t *testing.T) {
	for _, peer := range []string{"127.0.0.1:51734", "[::1]:51734"} {
		t.Run(peer, func(t *testing.T) {
			_, mux, fake := controlNode(t, nil)

			account := onThisMachine(accountDoor, "ada", "ada's passphrase")
			account.RemoteAddr = peer
			if recorder := ask(mux, account); recorder.Code != http.StatusOK || !handedSession(recorder) {
				t.Errorf("a tool at the account door answered %d %s, want 200 and a session", recorder.Code, recorder.Body.String())
			}

			management := onThisMachine(managementDoor, "boss", bossSaid)
			management.RemoteAddr = peer
			if recorder := ask(mux, management); recorder.Code != http.StatusOK || !handedSession(recorder) {
				t.Errorf("a tool at the management door answered %d %s, want 200 and a session", recorder.Code, recorder.Body.String())
			}

			if fake.Asked() != 0 {
				t.Errorf("Cloudflare was asked %d times about a tool on this machine", fake.Asked())
			}
		})
	}
}

// Everything that passed through something is asked for a token, whatever
// the connection's peer: a loopback connection carrying any one of the
// forwarding headers, with a caller's address, with nothing in it, or with
// the loopback address somebody outside would write to pass for local; a
// peer that is not loopback, saying nothing; and loopback saying nothing once
// the switch is closed.
func TestAnythingForwardedIsAskedForAToken(t *testing.T) {
	type sending struct {
		name  string
		tweak func(*config.Meet)
		build func(door, name, said string) *http.Request
	}

	cases := []sending{
		{"as nginx passes a caller on", nil, func(door, name, said string) *http.Request {
			return throughNginx(door, name, said, "", browser, "198.51.100.23")
		}},
		{"from a peer that is not loopback", nil, func(door, name, said string) *http.Request {
			request := onThisMachine(door, name, said)
			request.RemoteAddr = "192.0.2.10:5555"
			return request
		}},
		{"from loopback with the switch closed",
			func(m *config.Meet) { closed := false; m.Turnstile.ExemptLocal = &closed },
			onThisMachine},
	}

	for _, header := range []string{"X-Forwarded-For", "X-Real-IP", "Forwarded"} {
		for _, value := range []string{"198.51.100.23", "", "127.0.0.1"} {
			cases = append(cases, sending{fmt.Sprintf("from loopback with %s %q", header, value), nil,
				func(door, name, said string) *http.Request {
					request := onThisMachine(door, name, said)
					request.Header[http.CanonicalHeaderKey(header)] = []string{value}
					return request
				}})
		}
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, mux, _ := controlNode(t, c.tweak)

			for _, door := range []struct{ path, name, said string }{
				{accountDoor, "ada", "ada's passphrase"},
				{managementDoor, "boss", bossSaid},
			} {
				recorder := ask(mux, c.build(door.path, door.name, door.said))
				if recorder.Code != http.StatusBadRequest || refusedWith(recorder) != "human_check_missing" {
					t.Errorf("%s answered %d %s, want 400 human_check_missing",
						door.path, recorder.Code, recorder.Body.String())
				}
				if handedSession(recorder) {
					t.Errorf("%s handed a session without a token", door.path)
				}
			}
		})
	}
}

// Spared the check and nothing else: a tool on this machine that keeps
// getting its passphrase wrong is shut out like anybody, at both doors.
func TestAProgramOnThisMachineStillMeetsTheLockout(t *testing.T) {
	_, mux, _ := controlNode(t, nil)

	for i := range 6 {
		if recorder := ask(mux, onThisMachine(accountDoor, "ada", "wrong")); recorder.Code != http.StatusUnauthorized {
			t.Fatalf("a tool's account failure %d answered %d %s, want 401", i+1, recorder.Code, recorder.Body.String())
		}
	}
	for i := range 4 {
		if recorder := ask(mux, onThisMachine(managementDoor, "boss", "wrong")); recorder.Code != http.StatusUnauthorized {
			t.Fatalf("a tool's management failure %d answered %d %s, want 401", i+1, recorder.Code, recorder.Body.String())
		}
	}

	if eleventh := ask(mux, onThisMachine(managementDoor, "boss", "wrong")); !lockedOutAnswer(eleventh, "too_many_attempts") {
		t.Fatalf("a tool's eleventh failure answered %d %s, want the lockout", eleventh.Code, eleventh.Body.String())
	}

	if recorder := ask(mux, onThisMachine(accountDoor, "ada", "ada's passphrase")); !lockedOutAnswer(recorder, reasonRateLimited) {
		t.Errorf("the shut-out tool's right passphrase answered %d %s, want the lockout", recorder.Code, recorder.Body.String())
	}
}

// A body that could not be read whole signs nobody in and is never a guess,
// at either door, with the right passphrase in it or a wrong one.
//
// A field of the wrong type does not stop the decoder, which fills the fields
// it can, and such a body used to be judged and to sign in with the right
// passphrase, while never being counted towards a lockout: a review added
// "turnstile":5 to every attempt at the account door, and repeated "name"
// with a number at the management door, and guessed without end at both.
// Refused unread, it neither signs in nor spends anything: the caller then
// signs in at both doors, so no budget was charged, and Cloudflare was never
// asked about the good token the browser's bodies carried at either door.
func TestABodyThatCannotBeReadIsNeverJudged(t *testing.T) {
	app, mux, fake := controlNode(t, nil)

	const caller = "198.51.100.40"

	raw := func(door, body, agent string) *http.Request {
		request := throughNginx(door, "", "", "", agent, caller)
		request.Body = io.NopCloser(strings.NewReader(body))
		request.ContentLength = int64(len(body))

		return request
	}

	for i := range 2 * (lockout.Failures + 1) {
		said := fmt.Sprintf("guess %d", i)
		if i == lockout.Failures {
			said = bossSaid
		}

		account := ask(mux, raw(accountDoor, fmt.Sprintf(`{"name":"boss","passphrase":%q,"turnstile":5}`, said), iPhoneApp))
		if account.Code != http.StatusBadRequest || refusedWith(account) != reasonUnreadable || handedSession(account) {
			t.Fatalf("the account door answered %q with a number for a token %d %s, want 400 %s and no session",
				said, account.Code, account.Body.String(), reasonUnreadable)
		}

		// The same door from a browser, with a token beside a second name that
		// is a number. The app above is never asked for a token, so it cannot
		// tell whether the body is refused before the human check or after it;
		// this can, by Cloudflare's count below. Read after the check, every
		// such body would cost a question to Cloudflare and a turn of the
		// subscriber's bound on asking it, for a body nothing was going to judge.
		web := ask(mux, raw(accountDoor,
			fmt.Sprintf(`{"name":"boss","passphrase":%q,"turnstile":"sign-in:%d","name":5}`, said, i), browser))
		if web.Code != http.StatusBadRequest || refusedWith(web) != reasonUnreadable || handedSession(web) {
			t.Fatalf("the account door answered a browser's %q with a second name that is a number %d %s, want 400 %s and no session",
				said, web.Code, web.Body.String(), reasonUnreadable)
		}

		management := ask(mux, raw(managementDoor,
			fmt.Sprintf(`{"name":"boss","passphrase":%q,"turnstile":"admin:%d","name":5}`, said, i), browser))
		if management.Code != http.StatusBadRequest || refusedWith(management) != "unreadable" || handedSession(management) {
			t.Fatalf("the management door answered %q with a second name that is a number %d %s, want 400 unreadable and no session",
				said, management.Code, management.Body.String())
		}
	}

	if fake.Asked() != 0 {
		t.Errorf("Cloudflare was asked %d times about bodies that could not be read", fake.Asked())
	}
	if listed := app.admin.Lockout().Lockouts(); len(listed) != 0 {
		t.Errorf("%d lockouts from bodies that were never judged", len(listed))
	}

	if recorder := ask(mux, throughNginx(accountDoor, "boss", bossSaid, "", iPhoneApp, caller)); recorder.Code != http.StatusOK {
		t.Errorf("signing in from the app afterwards answered %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "admin:in", browser, caller)); recorder.Code != http.StatusOK {
		t.Errorf("signing in at the management door afterwards answered %d %s", recorder.Code, recorder.Body.String())
	}
}

// How often a caller may have this server ask Cloudflare is one bound for
// both doors, charged to the subscriber: an IPv6 address by its /64. Before,
// the account door's was the join's limiter, by address alone, and a review
// had Cloudflare asked once for each of three hundred addresses in one /64.
// The apps, which are never asked for a token, are never charged to it.
func TestTheBoundOnAskingCloudflareIsOneForBothDoorsBySubscriber(t *testing.T) {
	_, mux, fake := controlNode(t, func(m *config.Meet) {
		m.JoinRate = 0.0001
		m.JoinBurst = 1
	})

	if recorder := ask(mux, throughNginx(accountDoor, "ada", "wrong", "made-up-1", browser, "2001:db8::1")); recorder.Code != http.StatusForbidden {
		t.Fatalf("the first bad token answered %d %s, want 403", recorder.Code, recorder.Body.String())
	}

	if recorder := ask(mux, throughNginx(accountDoor, "ada", "wrong", "made-up-2", browser, "2001:db8::2")); recorder.Code != http.StatusTooManyRequests || refusedWith(recorder) != reasonRateLimited {
		t.Errorf("another address in the /64 at the account door answered %d %s, want 429 %s",
			recorder.Code, recorder.Body.String(), reasonRateLimited)
	}
	if recorder := ask(mux, throughNginx(managementDoor, "boss", "wrong", "made-up-3", browser, "2001:db8::3")); recorder.Code != http.StatusTooManyRequests || refusedWith(recorder) != "too_many_attempts" {
		t.Errorf("another address in the /64 at the management door answered %d %s, want 429 too_many_attempts",
			recorder.Code, recorder.Body.String())
	}

	if recorder := ask(mux, throughNginx(accountDoor, "ada", "ada's passphrase", "", iPhoneApp, "2001:db8::4")); recorder.Code != http.StatusOK {
		t.Errorf("an app in the /64 answered %d %s, want 200: it asks Cloudflare nothing", recorder.Code, recorder.Body.String())
	}

	if recorder := ask(mux, throughNginx(accountDoor, "ada", "wrong", "made-up-5", browser, "2001:db8:0:1::5")); recorder.Code != http.StatusForbidden {
		t.Errorf("an address in another /64 answered %d %s, want 403", recorder.Code, recorder.Body.String())
	}

	if fake.Asked() != 2 {
		t.Errorf("Cloudflare was asked %d times, want 2: once for each /64", fake.Asked())
	}
}
