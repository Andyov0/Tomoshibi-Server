package admin

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/lockout"
	"tomoshibi/internal/logring"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * The lockout at the management sign-in, and the page that lifts it.
 *
 * What the package's own tests cannot see is where the door asks: a lockout
 * checked after the guessing budget answers with the budget's refusal once
 * the budget is empty, and one checked after the passphrase is judged has
 * judged it and charged it, which is the work it exists to refuse. So these
 * go through the router, and hold both — the budget by emptying it first and
 * reading which refusal comes back, and the judging by how often the list of
 * administrators is read, which is the first thing judging a passphrase does,
 * and by whether the budget still has room afterwards.
 */

// lockable is a management side with a lockout, a budget roomy enough that
// eleven failures fit inside it, and a count of how often a passphrase was
// judged.
func lockable(t *testing.T, admins []config.Admin) (*API, http.Handler, *kept, *atomic.Int64) {
	t.Helper()

	api, _, written := mountAudited(t, admins)

	judged := &atomic.Int64{}
	api.sessions = NewSessions(func() []config.Admin {
		judged.Add(1)
		return admins
	}, key)
	// Twelve: the eleven failures the lockout needs and one more, which is
	// what the test reads afterwards to see whether anything else was spent.
	api.sessions.limit = guess.NewWith(lockout.Failures+2, 1000)

	api.lockout = lockout.New(nil)
	api.lockout.OnLock(api.lockedOut)

	mux := http.NewServeMux()
	api.Mount(mux)

	return api, mux, written, judged
}

func answered(mux http.Handler, r *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, r)
	return recorder
}

// until is the end of the lockout an answer names, or empty for an answer
// that names none.
func until(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()

	var body struct {
		Error string `json:"error"`
		Until string `json:"until"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)

	return body.Until
}

// reasonIn is the code an answer refused with.
func reasonIn(recorder *httptest.ResponseRecorder) string {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)

	return body.Error
}

func shutOut(t *testing.T, mux http.Handler) {
	t.Helper()

	for i := 1; i <= lockout.Failures; i++ {
		if code := answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`)).Code; code != http.StatusUnauthorized {
			t.Fatalf("failure %d answered %d, want 401", i, code)
		}
	}

	eleventh := answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`))
	if eleventh.Code != http.StatusTooManyRequests || until(t, eleventh) == "" {
		t.Fatalf("the eleventh failure answered %d %s, want 429 with the lockout's end",
			eleventh.Code, eleventh.Body.String())
	}
}

func TestAShutOutCallerIsRefusedBeforeTheirPassphraseIsJudged(t *testing.T) {
	api, mux, _, judged := lockable(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	shutOut(t, mux)

	before := judged.Load()

	// The right passphrase, and wrong ones, are refused alike and judged not
	// at all.
	for _, said := range []string{"correct", "wrong", "correct", "another"} {
		for i := 0; i < 5; i++ {
			recorder := answered(mux, sign(`{"name":"adam","passphrase":"`+said+`"}`))

			if recorder.Code != http.StatusTooManyRequests || until(t, recorder) == "" {
				t.Fatalf("%q while shut out answered %d %s, want 429 with the lockout's end",
					said, recorder.Code, recorder.Body.String())
			}
			if recorder.Header().Get("Retry-After") == "" {
				t.Error("no Retry-After on a lockout")
			}
			if len(recorder.Result().Cookies()) != 0 {
				t.Fatal("a session was given to a caller who is shut out")
			}
		}
	}

	if after := judged.Load(); after != before {
		t.Errorf("passphrases were judged %d times while the caller was shut out, want none", after-before)
	}

	if _, _, err := api.lockout.Lift(api.lockout.Lockouts()[0].Key); err != nil {
		t.Fatalf("Lift: %v", err)
	}

	// The budget had one attempt left when the lockout began. Twenty wrong
	// passphrases judged and charged would have spent it and had the rest
	// refused; refused before they were judged, they spent nothing, so a
	// wrong passphrase now is judged and refused as wrong rather than turned
	// away. Whether the lockout is asked before the budget as well is
	// TestTheLockoutIsAskedBeforeTheBudget: a guess the budget lets through
	// and the lockout then refuses is settled, and spends nothing either.
	if code := answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`)).Code; code != http.StatusUnauthorized {
		t.Errorf("a wrong passphrase after the lift answered %d, want 401: the lockout spent from the budget", code)
	}
}

// The lockout is asked before the budget, and that is not visible in what
// a refused guess spends: one the budget lets through and the lockout then
// refuses is settled, spending nothing either way. What shows it is a budget
// already empty. Asked first, the lockout answers with its end; asked after,
// the budget answers "too many attempts" with no end, which is the sentence
// that sends somebody shut out for half an hour back in a minute.
func TestTheLockoutIsAskedBeforeTheBudget(t *testing.T) {
	_, mux, _, _ := lockable(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	shutOut(t, mux)

	// Twelve in the budget and eleven spent shutting the caller out; another
	// device at the address spends the last.
	other := sign(`{"name":"adam","passphrase":"wrong"}`)
	other.Header.Set("User-Agent", "another device")
	if code := answered(mux, other).Code; code != http.StatusUnauthorized {
		t.Fatalf("another device's failure answered %d, want 401", code)
	}

	recorder := answered(mux, sign(`{"name":"adam","passphrase":"correct"}`))
	if recorder.Code != http.StatusTooManyRequests || until(t, recorder) == "" || recorder.Header().Get("Retry-After") == "" {
		t.Errorf("the caller shut out, at an empty budget, answered %d %s: the budget was asked first",
			recorder.Code, recorder.Body.String())
	}
}

// Signing in here clears nothing: ten failures, a success, and one more
// failure inside the window is the eleventh. A success that cleared the count
// let anybody who could sign in as somebody go on guessing at somebody else
// from the same address and device, ten at a time.
func TestSigningInHereClearsNothing(t *testing.T) {
	_, mux, _, _ := lockable(t, []config.Admin{
		{Trip: room.Trip(key, "correct"), Name: "adam"},
		{Trip: room.Trip(key, "eve's own"), Name: "eve"},
	})

	for i := 1; i <= lockout.Failures; i++ {
		answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`))
	}

	if code := answered(mux, sign(`{"name":"eve","passphrase":"eve's own"}`)).Code; code != http.StatusOK {
		t.Fatalf("signing in answered %d", code)
	}

	recorder := answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`))
	if recorder.Code != http.StatusTooManyRequests || until(t, recorder) == "" {
		t.Errorf("the eleventh failure, after a success, answered %d %s, want the lockout",
			recorder.Code, recorder.Body.String())
	}
}

// Somebody else at the same address, on another device, is not shut out
// with them.
func TestAnotherDeviceAtTheSameAddressMaySignIn(t *testing.T) {
	_, mux, _, _ := lockable(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	shutOut(t, mux)

	other := sign(`{"name":"adam","passphrase":"correct"}`)
	other.Header.Set("User-Agent", "Tomoshibi/0.1.0.8 (Mac; macOS 26.6; Mac16,1)")

	if code := answered(mux, other).Code; code != http.StatusOK {
		t.Errorf("another device at the same address answered %d, want 200", code)
	}
}

// A body that offered no passphrase is not a guess at one, and one that could
// not be read whole is refused before anything in it is looked at, though a
// field of the wrong type leaves the others filled.
func TestAMalformedSignInIsNotCounted(t *testing.T) {
	api, mux, _, judged := lockable(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})
	api.sessions.limit = guess.NewWith(1000, 1000)

	for _, body := range []string{`{"name":"adam"}`, `{"name":"adam","passphrase":""}`} {
		for i := 0; i <= lockout.Failures; i++ {
			recorder := answered(mux, sign(body))
			if until(t, recorder) != "" {
				t.Fatalf("%q was counted towards a lockout", body)
			}
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%q answered %d, want 401", body, recorder.Code)
			}
		}
	}

	before := judged.Load()

	for _, body := range []string{
		`{`, `not json`, `{"name":5,"passphrase":"wrong"}`, `{"name":"adam","passphrase":"wrong","turnstile":7}`,
		`{"name":"adam","passphrase":"correct","turnstile":7}`, `{"name":"adam","passphrase":"correct","name":5}`,
	} {
		for i := 0; i <= lockout.Failures; i++ {
			recorder := answered(mux, sign(body))
			if recorder.Code != http.StatusBadRequest || reasonIn(recorder) != "unreadable" {
				t.Fatalf("%q answered %d %s, want 400 unreadable", body, recorder.Code, recorder.Body.String())
			}
			if len(recorder.Result().Cookies()) != 0 {
				t.Fatalf("%q was handed a session", body)
			}
		}
	}

	if judged.Load() != before {
		t.Errorf("a passphrase in a body that could not be read was judged %d times", judged.Load()-before)
	}

	if len(api.lockout.Lockouts()) != 0 {
		t.Error("malformed sign-ins shut the caller out")
	}
}

// A lockout is a warning of its own in the log, in parts the page can say in
// the reader's language: never an administrator's action, which nobody took,
// and never anything that was typed.
func TestALockoutIsWrittenToTheLog(t *testing.T) {
	api, mux, written, _ := lockable(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	shutOut(t, mux)

	listed := api.lockout.Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	var found []keptLine
	for _, line := range written.written() {
		if line.message == LockedOut {
			found = append(found, line)
		}
		for _, value := range line.attrs {
			if strings.Contains(value, "wrong") {
				t.Errorf("the log holds what was typed: %+v", line)
			}
		}
	}

	if len(found) != 1 {
		t.Fatalf("%d lines say a caller was shut out, want 1", len(found))
	}

	line := found[0]
	want := map[string]string{
		"address":  "192.0.2.1",
		"device":   "no user agent",
		"failures": "11",
		"doors":    "management",
		"until":    listed[0].Until.UTC().Format(time.RFC3339),
	}
	if line.level != slog.LevelWarn {
		t.Errorf("the lockout was written at %v, want a warning", line.level)
	}
	for key, value := range want {
		if line.attrs[key] != value {
			t.Errorf("the lockout's %s is %q, want %q", key, line.attrs[key], value)
		}
	}
	for _, key := range []string{"action", "trip", "name"} {
		if _, ok := line.attrs[key]; ok {
			t.Errorf("the lockout is written as an administrator's action: %+v", line)
		}
	}
}

// The log page names a lockout's device as the accounts page does, from the
// parts it is written with, where it used to show deviceWords' lower-case
// English ("iphone app 0.1.7.1, iOS 27.0.1, iPhone17,1") a page away from
// the same device named "iPhone app 0.1.7.1" in the reader's language. The
// page reads the parts by the keys the ring flattens the group to, so this
// reads what the ring kept rather than what was handed to slog; a group the
// ring did not flatten, or a key renamed on one side, leaves the page with the
// English words again and nothing else would notice.
func TestALockoutsDeviceReachesTheLogPageInParts(t *testing.T) {
	ring := logring.New(8)
	api := &API{log: &Log{to: slog.New(ring.Handler(slog.NewTextHandler(io.Discard, nil)))}}

	api.lockedOut(store.Lockout{
		Address: "192.0.2.7", Failures: 11, Doors: []string{"account"}, Until: time.Now().Add(30 * time.Minute),
		Client: &store.Client{
			Kind: "iphone", App: "0.1.7.1", System: "iOS 27.0.1", Device: "iPhone17,1",
			Agent: "Tomoshibi/0.1.7.1 (iPhone; iOS 27.0.1; iPhone17,1)",
		},
	})
	api.lockedOut(store.Lockout{Address: "192.0.2.8", Failures: 11, Doors: []string{"account"}, Until: time.Now().Add(30 * time.Minute)})

	lines, _ := ring.After(0, 0)
	if len(lines) != 2 {
		t.Fatalf("the ring kept %d lines, want 2", len(lines))
	}

	attrs := func(line logring.Line) map[string]string {
		held := map[string]string{}
		for _, attr := range line.Attrs {
			held[attr.Key] = attr.Value
		}
		return held
	}

	phone := attrs(lines[0])
	for key, value := range map[string]string{
		"client.kind": "iphone", "client.app": "0.1.7.1", "client.system": "iOS 27.0.1", "client.device": "iPhone17,1",
		"device": "iphone app 0.1.7.1, iOS 27.0.1, iPhone17,1",
	} {
		if phone[key] != value {
			t.Errorf("the lockout's %s reached the page as %q, want %q", key, phone[key], value)
		}
	}
	for _, key := range []string{"client.browser", "client.agent"} {
		if _, ok := phone[key]; ok {
			t.Errorf("the lockout carries %s, which the device never sent or the page is not shown: %v", key, phone)
		}
	}

	for key := range attrs(lines[1]) {
		if strings.HasPrefix(key, "client.") {
			t.Errorf("a lockout with no device recorded carries %s", key)
		}
	}
}

// A moderator sees the lockout, lifts it, and is written down for it; the
// caller is then let in.
func TestAModeratorLiftsALockout(t *testing.T) {
	moderator := room.Trip(key, "moderator")
	_, mux, written, _ := lockable(t, []config.Admin{
		{Trip: room.Trip(key, "correct"), Name: "adam"},
		{Trip: moderator, Name: "mo", Can: []string{config.Moderate}},
	})

	shutOut(t, mux)

	// Signed in from another device, since this address and the default
	// device are the ones shut out.
	in := sign(`{"name":"mo","passphrase":"moderator"}`)
	in.Header.Set("User-Agent", "another browser")
	signedIn := answered(mux, in)
	if signedIn.Code != http.StatusOK {
		t.Fatalf("the moderator's sign-in answered %d", signedIn.Code)
	}
	cookie := signedIn.Result().Cookies()[0]

	as := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.AddCookie(cookie)
		return answered(mux, r)
	}

	listing := as(http.MethodGet, "/api/admin/lockouts")
	var listed struct {
		Lockouts []lockoutView `json:"lockouts"`
		Failures int           `json:"failures"`
		Window   int           `json:"windowSeconds"`
		For      int           `json:"forSeconds"`
	}
	if err := json.Unmarshal(listing.Body.Bytes(), &listed); err != nil || len(listed.Lockouts) != 1 {
		t.Fatalf("the listing answered %d %s", listing.Code, listing.Body.String())
	}

	one := listed.Lockouts[0]
	if one.Address != "192.0.2.1" || one.Failures != lockout.Failures+1 || len(one.Doors) != 1 || one.Doors[0] != lockout.Management {
		t.Errorf("listed %+v", one)
	}
	if one.First == "" || one.Last == "" || one.Since == "" || one.Until == "" || one.Client == nil {
		t.Errorf("the listing leaves out when or what: %+v", one)
	}
	if listed.Failures != 10 || listed.Window != 300 || listed.For != 1800 {
		t.Errorf("the rule was said as %d in %ds for %ds", listed.Failures, listed.Window, listed.For)
	}

	if code := as(http.MethodDelete, "/api/admin/lockouts/"+one.Key).Code; code != http.StatusOK {
		t.Fatalf("lifting answered %d", code)
	}
	if code := as(http.MethodDelete, "/api/admin/lockouts/"+one.Key).Code; code != http.StatusNotFound {
		t.Errorf("lifting it again answered %d, want 404", code)
	}

	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "lift lockout" && !entry.Failed && entry.Target == "192.0.2.1" {
			found = true
			if entry.Trip != moderator || entry.Name != "mo" {
				t.Errorf("the lift was written against %q %q, want the moderator", entry.Trip, entry.Name)
			}
		}
	}
	if !found {
		t.Error("the lift was not written to the management log")
	}

	if code := answered(mux, sign(`{"name":"adam","passphrase":"correct"}`)).Code; code != http.StatusOK {
		t.Errorf("signing in after the lift answered %d, want 200", code)
	}
}

func TestLiftingEveryLockoutIsWrittenDownOneByOne(t *testing.T) {
	moderator := room.Trip(key, "moderator")
	api, mux, written, _ := lockable(t, []config.Admin{
		{Trip: room.Trip(key, "correct"), Name: "adam"},
		{Trip: moderator, Name: "mo", Can: []string{config.Moderate}},
	})

	// Two devices at one address, which the budget would hold to eleven
	// failures between them; it is the lockouts being tested, not the budget.
	api.sessions.limit = guess.NewWith(1000, 1000)

	for _, device := range []string{"one", "two"} {
		for i := 0; i <= lockout.Failures; i++ {
			r := sign(`{"name":"adam","passphrase":"wrong"}`)
			r.Header.Set("User-Agent", device)
			r.RemoteAddr = "198.51.100.7:4000"
			answered(mux, r)
		}
	}

	if len(api.lockout.Lockouts()) != 2 {
		t.Fatalf("%d lockouts, want 2", len(api.lockout.Lockouts()))
	}

	_, token, _ := api.sessions.Open("mo", "moderator")
	r := httptest.NewRequest(http.MethodDelete, "/api/admin/lockouts", nil)
	r.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	recorder := answered(mux, r)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"lifted":2`) {
		t.Fatalf("lifting every lockout answered %d %s", recorder.Code, recorder.Body.String())
	}

	lifts := 0
	for _, entry := range written.recorded() {
		if entry.Action == "lift lockout" && entry.Trip == moderator {
			lifts++
		}
	}
	if lifts != 2 {
		t.Errorf("%d lifts written down, want one for each", lifts)
	}
}

// Every one of the finer capabilities together is not moderate, and does not
// lift a lockout.
func TestOnlyAModeratorLiftsALockout(t *testing.T) {
	steward := room.Trip(key, "steward")
	api, mux, _, _ := lockable(t, []config.Admin{
		{Trip: room.Trip(key, "correct"), Name: "adam"},
		{Trip: steward, Name: "stu", Can: []string{config.ManageRooms, config.ManageAccounts, config.ManageRelays, config.ManageSettings}},
	})

	shutOut(t, mux)

	_, token, _ := api.sessions.Open("stu", "steward")

	for _, path := range []string{"/api/admin/lockouts/" + api.lockout.Lockouts()[0].Key, "/api/admin/lockouts"} {
		r := httptest.NewRequest(http.MethodDelete, path, nil)
		r.AddCookie(&http.Cookie{Name: cookieName, Value: token})

		if code := answered(mux, r).Code; code != http.StatusForbidden {
			t.Errorf("DELETE %s answered %d for every capability but moderate, want 403", path, code)
		}
	}

	if len(api.lockout.Lockouts()) != 1 {
		t.Error("a lockout was lifted by somebody who may not lift one")
	}
}

// The API as startup builds it, rather than as the tests above assemble one:
// a lockout there has to reach the log without anybody wiring it by hand.
func TestTheAssembledAPIWritesItsLockoutsDown(t *testing.T) {
	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:   config.RoleControl,
			Admins: []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}},
		},
	}

	api := New(conf, nil, nil, key)
	t.Cleanup(api.Close)

	audit, written := auditing()
	api.log = audit
	api.sessions.limit = guess.NewWith(lockout.Failures+2, 1000)

	mux := http.NewServeMux()
	api.Mount(mux)

	shutOut(t, mux)

	for _, line := range written.written() {
		if line.message == LockedOut && line.attrs["address"] == "192.0.2.1" {
			return
		}
	}

	t.Error("a lockout on the assembled API was not written to the management log")
}

// A refusal by the guessing budget is not a failed sign-in, and is not
// counted: the budget refused before any passphrase was judged. With a budget
// of ten, ten failures spend it, and the eleventh request is the budget's
// refusal, with no end, rather than the lockout.
func TestABudgetRefusalIsNotCounted(t *testing.T) {
	api, mux, _, _ := lockable(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})
	api.sessions.limit = guess.NewWith(lockout.Failures, 1000)

	for i := 1; i <= lockout.Failures; i++ {
		if code := answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`)).Code; code != http.StatusUnauthorized {
			t.Fatalf("failure %d answered %d, want 401", i, code)
		}
	}

	for range 3 {
		recorder := answered(mux, sign(`{"name":"adam","passphrase":"wrong"}`))
		if recorder.Code != http.StatusTooManyRequests || reasonIn(recorder) != "too_many_attempts" || until(t, recorder) != "" {
			t.Fatalf("past the budget the door answered %d %s, want the budget's 429 with no end",
				recorder.Code, recorder.Body.String())
		}
	}

	if len(api.lockout.Lockouts()) != 0 {
		t.Error("the budget's refusals shut the caller out")
	}
}

// The log page says a lockout in the reader's words by matching its message
// exactly (web/src/manage/LogPanel.tsx). A change to one that is not made to
// the other leaves every lockout on that page as a bare line of English, which
// nothing else would notice.
func TestTheLogPageKnowsTheLockoutsMessage(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "web", "src", "manage", "LogPanel.tsx"))
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(page), strconv.Quote(LockedOut)) {
		t.Errorf("the log page does not match %q", LockedOut)
	}
}
