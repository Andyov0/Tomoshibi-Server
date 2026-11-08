package admin

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"tomoshibi/internal/lockout"
	"tomoshibi/internal/store"
)

/*
Who is shut out of signing in, and letting them back in.

The rule itself is in internal/lockout and is applied at the two sign-ins; this
is the management side of it. An administrator sees each caller shut out — the
address, the device as the joins describe one, the user agent as sent for
whatever the description did not catch, when the failures began and ended,
how many there were and at which sign-in, and when the lockout ends — and can
end one early, or all of them.

Every lockout and every lift goes into the management log. A lockout is the
one sign that somebody is working through passphrases, so it is written at
Warn with the refused sign-ins; a lift is an administrator reopening a door,
and is written against whoever did it, because "who let them back in" is the
question somebody will have afterwards.
*/

// lockoutView is one lockout as the page is told it.
type lockoutView struct {
	Key     string `json:"key"`
	Address string `json:"address"`
	Seen    string `json:"seen,omitempty"`
	// Client is the device, read as the joins read one; its Agent is the
	// user agent as sent, cut short, for whatever the reading missed.
	Client   *store.Client `json:"client,omitempty"`
	First    string        `json:"first"`
	Last     string        `json:"last"`
	Since    string        `json:"since"`
	Until    string        `json:"until"`
	Failures int           `json:"failures"`
	Doors    []string      `json:"doors"`
}

func lockoutOf(one store.Lockout) lockoutView {
	return lockoutView{
		Key:      one.Key,
		Address:  one.Address,
		Seen:     one.Seen,
		Client:   one.Client,
		First:    one.First.UTC().Format(time.RFC3339),
		Last:     one.Last.UTC().Format(time.RFC3339),
		Since:    one.Since.UTC().Format(time.RFC3339),
		Until:    one.Until.UTC().Format(time.RFC3339),
		Failures: one.Failures,
		Doors:    one.Doors,
	}
}

// lockouts lists the lockouts in force, and the rule they were made by, so
// the page can say the rule in its own words rather than repeating numbers it
// would otherwise have to be kept in step with.
func (a *API) lockouts(_ Session, w http.ResponseWriter, _ *http.Request) {
	held := a.lockout.Lockouts()

	list := make([]lockoutView, 0, len(held))
	for _, one := range held {
		list = append(list, lockoutOf(one))
	}

	respond(w, map[string]any{
		"lockouts":      list,
		"failures":      lockout.Failures,
		"windowSeconds": int(lockout.Window.Seconds()),
		"forSeconds":    int(lockout.For.Seconds()),
	})
}

// liftLockout lets one caller back in.
func (a *API) liftLockout(session Session, w http.ResponseWriter, r *http.Request) {
	lifted, found, err := a.lockout.Lift(r.PathValue("key"))
	if err != nil {
		a.log.Record(Entry{
			Action: "lift lockout", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: "the store would not let go of it",
		})
		refuse(w, http.StatusServiceUnavailable, "store_unwritable")
		return
	}

	// One that ended by itself between the page drawing it and the press is
	// answered the same as one that never was: there is nothing to lift, and
	// the page drops the row either way.
	if !found {
		refuse(w, http.StatusNotFound, "no_such_lockout")
		return
	}

	a.lifted(session, lifted)

	respond(w, map[string]any{"lifted": lockoutOf(lifted)})
}

// liftLockouts lets everybody shut out back in, for the afternoon a
// deployment's own users have locked themselves out in numbers.
func (a *API) liftLockouts(session Session, w http.ResponseWriter, _ *http.Request) {
	lifted, err := a.lockout.LiftAll()

	// Each one written down, including those lifted before the store failed:
	// those are lifted, and the log says what is true.
	for _, one := range lifted {
		a.lifted(session, one)
	}

	if err != nil {
		a.log.Record(Entry{
			Action: "lift every lockout", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: "the store would not let go of one",
		})
		refuse(w, http.StatusServiceUnavailable, "store_unwritable")
		return
	}

	respond(w, map[string]any{"lifted": len(lifted)})
}

func (a *API) lifted(session Session, one store.Lockout) {
	a.log.Record(Entry{
		Action: "lift lockout", Trip: session.Trip, Name: session.Name,
		Target: one.Address, Change: deviceWords(one.Client),
	})
}

// LockedOut is the message a lockout is written to the log under, as it
// begins. The log page matches it exactly, as it matches the administrators'
// actions, and says the line in the reader's language from its parts.
const LockedOut = "a caller was shut out of signing in"

// lockedOut writes a lockout into the log as it begins.
//
// A line of its own, at Warn, so that the log page's problems and any
// standing query for anything above Info find it beside the refused sign-ins
// before it. It used to be written as an administrator's action, a refused
// "sign in" by "-", and the page showed it so: under the "Administrator" tag
// although nobody did anything, as "- sign in 198.51.100.54 refused" and a
// sentence of English with a UTC timestamp beside lines whose times are the
// reader's own. Now the parts are separate and the page says them: the
// address, the device in a few words, how many failures at which sign-in,
// and the end, which the page gives in local time. Nothing derived from what
// was typed, for the reason the failures carry none: one of these logs will be
// read by somebody it does not belong to.
func (a *API) lockedOut(one store.Lockout) {
	attrs := []any{
		"address", one.Address,
		"device", deviceWords(one.Client),
		"failures", one.Failures,
		"doors", strings.Join(one.Doors, ","),
		"until", one.Until.UTC().Format(time.RFC3339),
	}
	if one.Seen != "" && one.Seen != one.Address {
		attrs = append(attrs, "seen", one.Seen)
	}
	if parts := clientParts(one.Client); len(parts) > 0 {
		attrs = append(attrs, slog.Group("client", parts...))
	}

	a.log.logger().Warn(LockedOut, attrs...)
}

// clientParts is the device as the accounts page's list of lockouts is given
// it, for the log page to say in the same words: "iPhone app 0.1.7.1" in the
// reader's language rather than deviceWords' "iphone app 0.1.7.1", which a
// review found beside the very same device named properly a page away. The
// words stay as well, for whoever reads the process log on the machine, where
// nothing translates them. Empty parts are left out so that the page can tell
// a part nobody sent from one that was blank.
func clientParts(client *store.Client) []any {
	if client == nil || client.Kind == "" {
		return nil
	}

	parts := []any{"kind", client.Kind}
	for _, one := range []struct{ key, value string }{
		{"app", client.App}, {"browser", client.Browser}, {"system", client.System}, {"device", client.Device},
	} {
		if one.value != "" {
			parts = append(parts, one.key, one.value)
		}
	}

	return parts
}

// deviceWords is a device in a few words for the log: what it is and the
// system under it, or the user agent where nothing was read from it.
func deviceWords(client *store.Client) string {
	if client == nil {
		return "no device"
	}

	var parts []string

	switch {
	case client.Browser != "":
		parts = append(parts, client.Browser)
	case client.App != "":
		parts = append(parts, client.Kind+" app "+client.App)
	case client.Kind == "app":
		parts = append(parts, "an app that did not say which")
	}

	for _, one := range []string{client.System, client.Device} {
		if one != "" {
			parts = append(parts, one)
		}
	}

	if len(parts) == 0 {
		if client.Agent == "" {
			return "no user agent"
		}

		return client.Agent
	}

	return strings.Join(parts, ", ")
}
