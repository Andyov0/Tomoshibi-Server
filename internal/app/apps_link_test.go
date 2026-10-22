package app

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
The apps for somebody holding a link into a meeting rather than an account,
through the router.

What would go wrong silently:

  - A link the join would turn away handing over the app anyway. Revoked, run
    out, not open yet, made by somebody no longer in the scope, ignored at a
    door that asks for an account, a meeting ended or cancelled: from outside,
    every one of those is a download that works, and nothing says a dead link
    is being honoured. So each is refused on all four of the endpoints a link
    may reach, and the build is checked not to have been sent.
  - A link that is good refused, which is the page offering an app it then
    cannot hand over. Both kinds, and a meeting's before it begins, which is
    when somebody opens it.
  - The link reaching what an account is for. Invitations by address are how
    this deployment knows who is testing the iOS app; somebody holding a link
    is offered the public link instead and cannot ask Apple to mail anybody.
  - A session going on working only by accident, or a stray link beside it
    turning a signed-in account into a guest.
  - A download by link logged as if an account had made it, or logged with
    the token, which is a way into the meeting for as long as it lasts.
*/

const publicLink = "https://testflight.apple.com/join/AbCd1234"

// linkFixture is the scoped control node — ada in acme, bob in nothing — with
// a Mac, an Android and a Windows build, invitations by address, the public
// link, and a door that asks for an invitation, which is where a link means
// something.
func linkFixture(t *testing.T) (http.Handler, *store.Store, *App, *fakeTester) {
	t.Helper()

	_, st, app := scoped(t)
	fake := &fakeTester{inGroup: map[string]bool{}}

	app.apps = desk(t, fake, appsDirectory(t, map[string][]build{
		"mac":     {{version: "2.0.0", file: "Tomoshibi-2.0.0.dmg", contents: dmg}},
		"android": {{version: "2.0.0", file: "Tomoshibi-2.0.0.apk", contents: apk}},
		"windows": {{version: "2.0.0", file: "Tomoshibi-Setup-2.0.0.exe", contents: exe}},
	}))
	app.apps.publicLink = publicLink

	byInvitation(t, st)

	return app.Handler(), st, app, fake
}

// arrangeIn writes a meeting straight into the store and gives back its link's
// token, as the host's own page would have been given it.
func arrangeIn(t *testing.T, st *store.Store, meeting store.Meeting) string {
	t.Helper()

	id, err := store.NewMeetingID()
	if err != nil {
		t.Fatal(err)
	}

	meeting.ID = id
	if meeting.Made.IsZero() {
		meeting.Made = time.Now().UTC()
	}

	token := store.MeetingToken(tripKey, id)
	if err := st.Arrange(token, meeting, time.Now().UTC()); err != nil {
		t.Fatalf("Arrange: %v", err)
	}

	return token
}

// keptInvite writes an invitation straight into the store, on the wall clock
// the application reads in these tests.
func keptInvite(t *testing.T, st *store.Store, invite store.Invite) string {
	t.Helper()

	token, err := store.NewInviteToken()
	if err != nil {
		t.Fatal(err)
	}

	if invite.Created.IsZero() {
		invite.Created = time.Now().UTC()
	}

	if err := st.KeepInvite(token, invite); err != nil {
		t.Fatalf("KeepInvite: %v", err)
	}

	return token
}

// withLink is a path with a link's token in its query, as the page sends it.
func withLink(path, kind, token string) string {
	return path + "?" + kind + "=" + url.QueryEscape(token)
}

// The four paths a link may reach, and what each hands over when it does.
var linkPaths = []struct {
	path string
	sent []byte
}{
	{"/api/apps", nil},
	{"/api/apps/mac", dmg},
	{"/api/apps/android", apk},
	{"/api/apps/windows", exe},
}

func TestAGoodLinkHandsOverTheAppsWithoutAnAccount(t *testing.T) {
	mux, st, _, fake := linkFixture(t)

	now := time.Now().UTC()
	ada := room.Trip(tripKey, adaPassphrase)

	begun := arrangeIn(t, st, store.Meeting{Room: "retro", At: now.Add(10 * time.Minute), Host: ada})
	if _, err := st.Begin("retro", ada, "minted-for-retro", now); err != nil {
		t.Fatalf("Begin: %v", err)
	}

	for _, tc := range []struct {
		name, kind, token, room string
	}{
		{"an invitation made in a call", "invite",
			keptInvite(t, st, store.Invite{Room: "standup", Expires: now.Add(time.Hour)}), "standup"},
		{"a standing invitation into a scope, by a member", "invite",
			keptInvite(t, st, store.Invite{Room: "board@acme", By: ada, Standing: true}), "board@acme"},
		{"a meeting link before the meeting begins", "meeting",
			arrangeIn(t, st, store.Meeting{Room: "planning", At: now.Add(48 * time.Hour), Host: ada}), "planning"},
		{"a meeting link while it is held", "meeting", begun, "retro"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logged bytes.Buffer
			was := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
			t.Cleanup(func() { slog.SetDefault(was) })

			view := offered(t, appsGet(mux, withLink("/api/apps", tc.kind, tc.token), nil))

			if !view.Mac.Available || !view.Android.Available || !view.Windows.Available {
				t.Errorf("a good link was told %+v, want every build", view)
			}

			// The public link, and no invitations by address: there is no
			// account to count them against.
			if view.IOS.Invites || view.IOS.Link != publicLink {
				t.Errorf("a good link was offered iOS as %+v, want the public link and no invitations", view.IOS)
			}

			for _, one := range linkPaths[1:] {
				got := appsGet(mux, withLink(one.path, tc.kind, tc.token), nil)

				if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), one.sent) {
					t.Errorf("%s on a good link answered %d with %d bytes, want the build", one.path,
						got.Code, got.Body.Len())
				}

				if saved := got.Header().Get("Content-Disposition"); !strings.HasPrefix(saved, `attachment; filename="Tomoshibi-2.0.0.`) {
					t.Errorf("%s on a good link is saved as %q", one.path, saved)
				}
			}

			said := logged.String()
			if strings.Count(said, "on a link into a meeting") != len(linkPaths)-1 || !strings.Contains(said, "room="+tc.room) {
				t.Errorf("the downloads were not logged as made on a link, with the room:\n%s", said)
			}

			kind := linkInvitation
			if tc.kind == "meeting" {
				kind = linkMeeting
			}

			if !strings.Contains(said, "link="+kind) {
				t.Errorf("the log does not say which kind of link it was (%s):\n%s", kind, said)
			}

			if strings.Contains(said, "account=") {
				t.Errorf("a download on a link was logged as an account's:\n%s", said)
			}

			if strings.Contains(said, tc.token) {
				t.Errorf("the log carries the link's token, which is a way into the meeting:\n%s", said)
			}
		})
	}

	if fake.times() != 0 {
		t.Errorf("App Store Connect was asked %d times on behalf of a link", fake.times())
	}
}

func TestALinkTheJoinWouldTurnAwayHandsOverNothing(t *testing.T) {
	mux, st, _, _ := linkFixture(t)

	now := time.Now().UTC()
	ada := room.Trip(tripKey, adaPassphrase)
	bob := room.Trip(tripKey, bobPassphrase)

	revoked := keptInvite(t, st, store.Invite{Room: "revoked", Expires: now.Add(time.Hour)})
	if _, err := st.DropInvites("revoked", true); err != nil {
		t.Fatal(err)
	}

	ended := arrangeIn(t, st, store.Meeting{Room: "ended", At: now.Add(10 * time.Minute), Host: ada})
	if _, err := st.Begin("ended", ada, "minted-for-ended", now); err != nil {
		t.Fatal(err)
	}
	if err := st.End("ended", now); err != nil {
		t.Fatal(err)
	}

	cancelled := arrangeIn(t, st, store.Meeting{Room: "cancelled", At: now.Add(time.Hour), Host: ada})
	if gone, err := st.Arranged(cancelled); err != nil {
		t.Fatal(err)
	} else if _, err := st.Cancel(gone.ID, ada); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, kind, token, reason string
		// shut is a door that asks for an account, set for this case alone.
		shut bool
	}{
		{"an invitation nobody made", "invite", "no-such-invitation", reasonNoSuchInvite, false},
		{"a revoked invitation", "invite", revoked, reasonNoSuchInvite, false},
		{"an invitation past its day", "invite",
			keptInvite(t, st, store.Invite{Room: "late", Created: now.Add(-25 * time.Hour), Expires: now.Add(-time.Hour)}),
			reasonNoSuchInvite, false},
		{"an invitation whose window has not opened", "invite",
			keptInvite(t, st, store.Invite{Room: "early@acme", By: ada, Standing: true, From: now.Add(24 * time.Hour)}),
			reasonNoSuchInvite, false},
		{"an invitation into a scope by somebody not in it", "invite",
			keptInvite(t, st, store.Invite{Room: "board@acme", By: bob, Standing: true}),
			reasonNoSuchInvite, false},
		{"an invitation where the door asks for an account", "invite",
			keptInvite(t, st, store.Invite{Room: "standup", Expires: now.Add(time.Hour)}),
			reasonNoSuchInvite, true},
		{"a meeting nobody arranged", "meeting", "no-such-meeting", reasonNoSuchMeeting, false},
		{"a meeting that has ended", "meeting", ended, reasonNoSuchMeeting, false},
		{"a meeting that was cancelled", "meeting", cancelled, reasonNoSuchMeeting, false},
		{"a meeting nobody can still be waiting for", "meeting",
			arrangeIn(t, st, store.Meeting{Room: "forgotten", At: now.Add(-50 * time.Hour), Host: ada}),
			reasonNoSuchMeeting, false},
		{"a meeting where the door asks for an account", "meeting",
			arrangeIn(t, st, store.Meeting{Room: "weekly", At: now.Add(time.Hour), Host: ada}),
			reasonNoSuchMeeting, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.shut {
				if err := st.SetJoining(room.ByAccount); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { byInvitation(t, st) })
			}

			for _, one := range linkPaths {
				got := appsGet(mux, withLink(one.path, tc.kind, tc.token), nil)

				if got.Code != http.StatusForbidden || refusalOf(t, got) != tc.reason {
					t.Errorf("%s answered %d %q, want 403 %q", one.path, got.Code, refusalOf(t, got), tc.reason)
				}

				if one.sent != nil && bytes.Contains(got.Body.Bytes(), one.sent[:64]) {
					t.Errorf("%s handed the build over on a link the join would turn away", one.path)
				}
			}
		})
	}
}

// Nothing in the address and nobody signed in is the refusal it always was,
// and so is a link parameter with nothing in it, and so is the cookie a join
// leaves, which is the join's and not a link anybody was sent.
func TestNoLinkAndNoSessionIsSignedOut(t *testing.T) {
	mux, st, _, _ := linkFixture(t)

	spent := &http.Cookie{Name: inviteCookie,
		Value: keptInvite(t, st, store.Invite{Room: "standup", Expires: time.Now().UTC().Add(time.Hour)})}

	for _, path := range []string{"/api/apps", "/api/apps/mac", "/api/apps/android", "/api/apps/windows",
		"/api/apps?invite=", "/api/apps/mac?meeting=%20", "/api/apps/android?invite=", "/api/apps/windows?meeting="} {
		for _, cookie := range []*http.Cookie{nil, spent} {
			got := appsGet(mux, path, cookie)

			if got.Code != http.StatusUnauthorized || refusalOf(t, got) != reasonSignedOut {
				t.Errorf("%s (cookie %v) answered %d %q, want 401 %q", path, cookie != nil,
					got.Code, refusalOf(t, got), reasonSignedOut)
			}
		}
	}
}

// A link reaches the downloads and what is offered, and not the invitation by
// address, which is for accounts.
func TestALinkCannotInviteAnAddress(t *testing.T) {
	mux, st, _, fake := linkFixture(t)

	token := keptInvite(t, st, store.Invite{Room: "standup", Expires: time.Now().UTC().Add(time.Hour)})

	request := httptest.NewRequest(http.MethodPost, withLink("/api/apps/ios/invite", "invite", token),
		strings.NewReader(`{"email":"guest@example.com"}`))
	request.Header.Set("Content-Type", "application/json")

	got := ask(mux, request)
	if got.Code != http.StatusUnauthorized {
		t.Errorf("an invitation by address on a link answered %d, want 401", got.Code)
	}

	if fake.times() != 0 {
		t.Errorf("App Store Connect was asked to mail somebody on behalf of a link: %v", fake.asked)
	}
}

// A session is what it was, whatever link is beside it: invited by address,
// and not told the public link while that is offered.
func TestASessionIsAnAccountWhateverLinkIsBesideIt(t *testing.T) {
	mux, st, app, _ := linkFixture(t)
	cookie := signedInAs(t, st, "tess", room.Trip(tripKey, "tess's own passphrase"))

	for _, path := range []string{"/api/apps", "/api/apps?invite=no-such-invitation", "/api/apps?meeting=nothing"} {
		view := offered(t, appsGet(mux, path, cookie))

		if !view.IOS.Invites || view.IOS.Left != testersPerAccount || view.IOS.Link != "" {
			t.Errorf("%s signed in was offered iOS as %+v, want invitations by address and no public link",
				path, view.IOS)
		}
	}

	if got := appsGet(mux, "/api/apps/mac?invite=no-such-invitation", cookie); got.Code != http.StatusOK {
		t.Errorf("a signed-in download beside a dead link answered %d", got.Code)
	}

	// Where nobody can be invited by address, an account is offered the public
	// link rather than nothing.
	app.apps.tester = nil

	if view := offered(t, appsGet(mux, "/api/apps", cookie)); view.IOS.Invites || view.IOS.Link != publicLink {
		t.Errorf("an account on a deployment with no key was offered iOS as %+v, want the public link", view.IOS)
	}
}

// And without a public link configured, nobody holding a link is offered iOS.
func TestNoPublicLinkOffersALinkNoIOSApp(t *testing.T) {
	mux, st, app, _ := linkFixture(t)
	app.apps.publicLink = ""

	token := keptInvite(t, st, store.Invite{Room: "standup", Expires: time.Now().UTC().Add(time.Hour)})

	if view := offered(t, appsGet(mux, withLink("/api/apps", "invite", token), nil)); view.IOS.Invites || view.IOS.Link != "" {
		t.Errorf("a link on a deployment with no public link was offered iOS as %+v", view.IOS)
	}
}

// A token is the whole of the check, so asking about one is charged to the
// join's budget, as the door it opens is.
func TestALinkIsChargedToTheJoinsBudget(t *testing.T) {
	mux, st, app, _ := linkFixture(t)
	app.limit = limit.New(1.0/3600, 1, 0)

	token := keptInvite(t, st, store.Invite{Room: "standup", Expires: time.Now().UTC().Add(time.Hour)})

	if got := appsGet(mux, withLink("/api/apps", "invite", token), nil); got.Code != http.StatusOK {
		t.Fatalf("the first ask answered %d", got.Code)
	}

	got := appsGet(mux, withLink("/api/apps", "invite", "a-guess"), nil)
	if got.Code != http.StatusTooManyRequests || refusalOf(t, got) != reasonRateLimited {
		t.Errorf("a guess past the budget answered %d %q, want 429", got.Code, refusalOf(t, got))
	}
}
