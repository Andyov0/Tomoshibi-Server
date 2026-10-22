// Package admin is the management surface: who may open it, what they may do,
// and a record of what they did.
//
// It exists only where somebody configured it. With no administrators listed
// there is no sign-in page, no endpoint, and nothing to guess at — a door that
// opens for nobody is still a door, and this deployment does not fit one.
package admin

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"
	"tomoshibi/internal/guess"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

// How long a session lasts without being used.
//
// Renewed on every request that carries it, which it was not before: the half
// hour used to run from signing in, so somebody in the middle of working was
// signed out mid-action and read it as the page breaking. What a timeout should
// measure is time away from it, not time spent in it.
//
// Twelve hours of that, which covers a working day with an interruption in it.
const sessionIdle = 12 * time.Hour

// And how long one may last however busy it is kept.
//
// Renewal without a ceiling is not a timeout — the management pages poll while
// they are open, so a tab left open would hold a session for as long as the
// browser ran, which is the laptop-in-a-meeting-room case the original half
// hour existed to prevent. A week is the compromise: long enough never to
// interrupt anybody working, short enough that a forgotten tab is not a
// standing grant.
const sessionMax = 7 * 24 * time.Hour

// The cookie carrying a session.
//
// HttpOnly so no script can read it, Secure so it never crosses plain HTTP, and
// SameSite strict so another site cannot cause a request that carries it. The
// last of those is what stands in for a cross-site request token here: with
// strict, a form posted from anywhere else arrives with no cookie at all.
const cookieName = "meet-live.admin"

// Signed in, and what they may do.
type Session struct {
	Trip string
	Name string
	Can  []string
	// Expires moves forward each time the session is used.
	Expires time.Time
	// Opened does not, and is what the ceiling is measured from.
	Opened time.Time
	// Written is when the renewal was last written down, so that a page polling
	// every five seconds does not write to disk every five seconds.
	Written time.Time
	// Checked is when Can and Name were last read from the roster rather than
	// from the moment of signing in. Zero for a session brought back from the
	// store, so the first request after a restart asks at once.
	Checked time.Time
}

// Allows reports whether this session holds a capability.
func (s Session) Allows(capability string) bool {
	return config.Admin{Trip: s.Trip, Can: s.Can}.Allows(capability)
}

// Kept is where sessions survive a restart.
//
// An interface of three methods rather than the store, so that the sign-in can
// be tested without one — and nil, on a deployment that has no store, which
// falls back to memory alone exactly as this always worked.
type Kept interface {
	KeepSession(token string, session store.Session) error
	Session(token string) (store.Session, bool)
	DropSession(token string) error
}

// Sessions is everybody currently signed in, held in memory and, where there is
// a store, written down there too so that a restart does not sign anybody out.
type Sessions struct {
	// admins is asked each time rather than captured once.
	//
	// Because the list changes while the deployment runs: somebody added on a
	// page can sign in without a restart, and somebody removed or demoted loses
	// what they held within a minute — an open session asks this same question
	// again once a minute; see Of. A captured slice would have made both of
	// those a restart, which ends every call in progress.
	admins  func() []config.Admin
	tripKey []byte

	// kept is where they are written down, so that restarting the process does
	// not sign everybody out. Nil where there is nowhere to write.
	kept Kept

	mu    sync.Mutex
	open  map[string]Session
	limit *guess.Attempts
}

// Remember gives the sessions somewhere to survive a restart.
func (s *Sessions) Remember(kept Kept) { s.kept = kept }

// NewSessions prepares the sign-in for a set of administrators.
func NewSessions(admins func() []config.Admin, tripKey []byte) *Sessions {
	return &Sessions{
		admins:  admins,
		tripKey: tripKey,
		open:    make(map[string]Session),
		limit:   guess.New(),
	}
}

// Configured reports whether this deployment has any administrators at all.
func (s *Sessions) Configured() bool {
	return len(s.admins()) > 0
}

// Open signs somebody in, or refuses them.
//
// Recognising an administrator is [config.Administrator]'s job and not this
// one's, because the join endpoint asks the same question of the same list with
// the same key — it has to, to know who may open a room — and two answers to one
// question is one of them waiting to drift.
func (s *Sessions) Open(name string, passphrase room.Passphrase) (Session, string, bool) {
	found, matched := config.NamedAdministrator(s.admins(), name, passphrase, s.tripKey)
	if !matched {
		return Session{}, "", false
	}

	now := time.Now()

	session := Session{
		Trip:    found.Trip,
		Name:    found.Name,
		Can:     found.Can,
		Opened:  now,
		Expires: now.Add(sessionIdle),
		Checked: now,
	}

	token := secret()

	s.mu.Lock()
	s.sweep()
	s.open[token] = session
	s.mu.Unlock()

	// Written down as well as held. A failure here is not a failure to sign in
	// — the session works for as long as this process runs — so it is not
	// reported to somebody who has just typed their passphrase correctly.
	if s.kept != nil {
		_ = s.kept.KeepSession(token, session.stored())
	}

	return session, token, true
}

// Of returns the session a request carries, if it carries a live one.
func (s *Sessions) Of(r *http.Request) (Session, bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return Session{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	session, held := s.open[cookie.Value]

	// Not in memory, which after a restart is every session there is. Read from
	// where they were written down instead, and put back in memory so the next
	// request does not read it again.
	if !held && s.kept != nil {
		if stored, ok := s.kept.Session(cookie.Value); ok && stored.Kind == managementKind {
			// The kind is the whole of the separation, and it was checked in one
			// of the two places that read this bucket.
			//
			// Both kinds are kept here, keyed by the hash of their token. The
			// account door checked; this one did not, and did not write the field
			// either — so anybody holding an account session could copy their own
			// cookie under the management name and be admitted. Not a forged
			// credential: their own, read through a door that never asked what it
			// was for.
			session = fromStored(stored)
			s.open[cookie.Value] = session
			held = true
		}
	}

	if !held {
		return Session{}, false
	}

	now := time.Now()

	// Idle for too long, or open for too long however busy. Both are checked
	// here rather than only at sign-in, because this is the only place a
	// session is ever looked at.
	if now.After(session.Expires) || now.Sub(session.Opened) > sessionMax {
		delete(s.open, cookie.Value)

		if s.kept != nil {
			_ = s.kept.DropSession(cookie.Value)
		}

		return Session{}, false
	}

	// What the roster says about them now, rather than what it said when they
	// signed in.
	//
	// The session used to carry the capabilities it was opened with for as long
	// as it lasted, which is up to a week of renewals. The comments beside the
	// roster said removing somebody took effect on the next request, and the
	// code never asked: an administrator removed or demoted kept every power
	// they had in the tab they already had open, and one given a capability
	// could not use it until they signed out and in again. With capabilities
	// cut finer and ticked from a page, the second half is a checkbox that
	// visibly does nothing, and the first half is the one that matters.
	//
	// Once a minute rather than on every request, because the pages poll every
	// five seconds per open tab and the roster is a read of the store. A minute
	// is what the store's RemoveAdmin says it takes, and the tests hold it.
	//
	// Gone from the roster is gone. Where the store will not answer, the roster
	// falls back to the configuration file and somebody added from a page is
	// not on that — so an outage of the store signs them out. That is the
	// direction to be wrong in for a list that decides who may act, and every
	// page they could have reached would be failing to read the store anyway.
	if now.Sub(session.Checked) > rosterRecheck {
		current, listed := s.listed(session.Trip)
		if !listed {
			delete(s.open, cookie.Value)

			if s.kept != nil {
				_ = s.kept.DropSession(cookie.Value)
			}

			return Session{}, false
		}

		session.Can = current.Can
		session.Name = current.Name
		session.Checked = now
	}

	// Pushed forward by being used. Written back rather than only returned, or
	// the renewal would last exactly as long as this request.
	session.Expires = now.Add(sessionIdle)
	s.open[cookie.Value] = session

	// Written back so the renewal survives a restart too. Once a minute at
	// most: this runs on every request the management pages make, which is one
	// every five seconds per open tab, and a disk write on each of those would
	// be a write per tab per five seconds for a field nobody reads until the
	// process comes back up.
	if s.kept != nil && now.Sub(session.Written) > time.Minute {
		session.Written = now
		s.open[cookie.Value] = session
		_ = s.kept.KeepSession(cookie.Value, session.stored())
	}

	return session, true
}

// rosterRecheck is how long a session's capabilities are trusted before the
// roster is asked again. See Of.
const rosterRecheck = time.Minute

// listed finds a signature on the roster as it stands now.
func (s *Sessions) listed(trip string) (config.Admin, bool) {
	for _, one := range s.admins() {
		if one.Trip == trip {
			return one, true
		}
	}

	return config.Admin{}, false
}

// What a management session is written down as.
//
// Named on the record rather than inferred from which bucket it is in, because
// there is one bucket: an account's session and this one are the same shape with
// the same expiry and the same sweeping, and the only thing that must never
// happen is one being accepted by the other's door.
const managementKind = "admin"

func (s Session) stored() store.Session {
	return store.Session{
		Trip: s.Trip, Name: s.Name, Can: s.Can, Kind: managementKind,
		Opened: s.Opened, Expires: s.Expires,
	}
}

func fromStored(kept store.Session) Session {
	return Session{
		Trip: kept.Trip, Name: kept.Name, Can: kept.Can,
		Opened: kept.Opened, Expires: kept.Expires,
	}
}

// Close signs somebody out.
func (s *Sessions) Close(r *http.Request) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return
	}

	s.mu.Lock()
	delete(s.open, cookie.Value)
	s.mu.Unlock()

	// And from where it was written down, or signing out would last only until
	// the next restart brought it back.
	if s.kept != nil {
		_ = s.kept.DropSession(cookie.Value)
	}
}

// Grant writes the cookie that carries a session.
func Grant(w http.ResponseWriter, token string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(sessionIdle.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// Revoke clears it.
func Revoke(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// sweep drops what has expired. Called while opening a session, which is often
// enough for a map that holds one entry per administrator.
func (s *Sessions) sweep() {
	now := time.Now()
	for token, session := range s.open {
		if now.After(session.Expires) {
			delete(s.open, token)
		}
	}
}

func secret() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		// A predictable session token is worse than refusing to make one.
		panic("read random bytes: " + err.Error())
	}

	return base64.RawURLEncoding.EncodeToString(raw)
}

// Signature is what a passphrase produces on this deployment.
//
// Exposed so that changing one can be checked against the signature already
// held, without the passphrase leaving this package or being written anywhere.
func (s *Sessions) Signature(passphrase string) string {
	return room.Trip(s.tripKey, strings.TrimSpace(passphrase))
}

// Moved carries every open session from one signature to another.
//
// Called when somebody changes their passphrase. Without it they would be
// signed out by their own success: the cookie in their browser names a
// signature the deployment no longer has, and the next request would be refused
// with nothing to explain it.
func (s *Sessions) Moved(from, to string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for token, session := range s.open {
		if session.Trip == from {
			session.Trip = to
			s.open[token] = session
		}
	}
}
