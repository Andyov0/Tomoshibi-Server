package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"tomoshibi/internal/remote"
)

/*
The lobby's notice and the apps' feature switches, from the management pages.

Two of the four sections of the apps' remote.json (internal/remote), and the two
that are decisions somebody makes in a hurry: a notice is published the moment
something is wrong, and a feature is turned off on one platform the moment it
is found to be broken there. The other two, the phrases and the numbers, are
edited in the file by whoever looks after it, and are never touched from here.

	GET /api/admin/remote/notice     the notice in the file, and whether the apps are shown it
	PUT /api/admin/remote/notice     publish one; an empty body or null takes it down
	GET /api/admin/remote/switches   every switch in the file
	PUT /api/admin/remote/switches   replace every switch with the list sent

Reading needs observe and writing the settings capability, beside who may open
a room and what is relayed of watching together: each goes on deciding after
whoever set it has signed out, and each decides for everybody.

The switches are written as a whole list rather than one rule at a time,
because the list's order is its meaning. A later rule overrides an earlier one
for the same feature, so a rule added in the wrong place is a different
decision, and a page that saved rules one by one would be choosing the order
nobody looked at.

A deployment with no apps directory has nowhere to keep the file, and says so
rather than pretending to have written something.
*/

// Remote is the file the apps are told the notice and the switches from.
//
// A narrow interface, for the reason the package names one for everything it
// needs: the gates in front of these endpoints are tested by handing over
// something that remembers what it was given.
type Remote interface {
	Read() remote.Settings
	SetNotice(notice *remote.Notice) error
	SetSwitches(switches []remote.Switch) error
}

// noticeReading is what the page is told of the notice: the one in the file,
// and whether the apps are being shown it now, which a notice whose end has
// passed is not.
type noticeReading struct {
	Notice  *remote.Notice `json:"notice"`
	Showing bool           `json:"showing"`
}

// switchesReading is every switch the file holds that could be read, and how
// many it holds that could not. The page replaces the whole list, so a save
// from it would take those away, and it says so before anybody presses it.
type switchesReading struct {
	Switches []remote.Switch `json:"switches"`
	Unread   int             `json:"unread"`
}

// The refusals of these endpoints that are not a rule's or a notice's own.
const (
	// reasonNoAppsDirectory is a deployment with no apps directory.
	reasonNoAppsDirectory = "no_apps_directory"

	// reasonRemoteUnreadable is a file somebody has left as something other
	// than a JSON object, which nothing is written over.
	reasonRemoteUnreadable = "remote_unreadable"

	// reasonRemoteUnwritable is a file that could not be written.
	reasonRemoteUnwritable = "remote_unwritable"
)

func (a *API) noticeNow() noticeReading {
	notice := a.remote.Read().Notice

	return noticeReading{Notice: notice, Showing: notice.Showing(time.Now())}
}

func (a *API) switchesNow() switchesReading {
	settings := a.remote.Read()

	switches := settings.Switches
	if switches == nil {
		switches = []remote.Switch{}
	}

	return switchesReading{Switches: switches, Unread: settings.UnreadSwitches}
}

func (a *API) readNotice(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.remote == nil {
		refuse(w, http.StatusServiceUnavailable, reasonNoAppsDirectory)
		return
	}

	respond(w, a.noticeNow())
}

func (a *API) readSwitches(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.remote == nil {
		refuse(w, http.StatusServiceUnavailable, reasonNoAppsDirectory)
		return
	}

	respond(w, a.switchesNow())
}

// setNotice publishes the notice, or takes it down.
//
// Taking it down is a body of nothing, or null, rather than an endpoint of its
// own, so that the notice has one address and one verb whatever is done to
// it. What the apps are told is the file afterwards, so a notice taken down
// stops being sent at the next check of every app.
func (a *API) setNotice(session Session, w http.ResponseWriter, r *http.Request) {
	if a.remote == nil {
		refuse(w, http.StatusServiceUnavailable, reasonNoAppsDirectory)
		return
	}

	// Four languages of five hundred characters, of up to four bytes each,
	// and the rest of a notice: well inside this.
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		refuse(w, http.StatusBadRequest, "unreadable_request")
		return
	}

	raw = bytes.TrimSpace(raw)

	if len(raw) == 0 || string(raw) == "null" {
		target := ""
		if before := a.remote.Read().Notice; before != nil {
			target = before.ID
		}

		err := a.remote.SetNotice(nil)
		a.record(session, "take down the apps' notice", "", target, err)

		if err != nil {
			a.unwritten(w, err)
			return
		}

		respond(w, a.noticeNow())
		return
	}

	var sent remote.Notice
	if err := json.Unmarshal(raw, &sent); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable_request")
		return
	}

	notice, err := remote.CheckNotice(sent, time.Now())
	if err != nil {
		refuse(w, http.StatusBadRequest, err.Error())
		return
	}

	err = a.remote.SetNotice(&notice)
	a.recordChange(session, "publish the apps' notice", notice.ID, describeNotice(notice), err)

	if err != nil {
		a.unwritten(w, err)
		return
	}

	respond(w, a.noticeNow())
}

// setSwitches replaces every switch.
//
// Each rule is held to what the file may hold before any of them is written,
// so that a list with one bad rule writes nothing rather than every rule but
// that one: a list is a decision in an order, and part of it is a different
// decision. A field the server does not know is refused too, for the reason
// the file refuses one (internal/remote): every field of a rule narrows it, and
// one this server would ignore is a rule wider than the page that sent it
// meant.
func (a *API) setSwitches(session Session, w http.ResponseWriter, r *http.Request) {
	if a.remote == nil {
		refuse(w, http.StatusServiceUnavailable, reasonNoAppsDirectory)
		return
	}

	var body struct {
		Switches *[]remote.Switch `json:"switches"`
	}

	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&body); err != nil || body.Switches == nil {
		refuse(w, http.StatusBadRequest, "unreadable_request")
		return
	}

	sent := *body.Switches
	if len(sent) > remote.MaxSwitches {
		refuse(w, http.StatusBadRequest, string(remote.TooManySwitches))
		return
	}

	switches := make([]remote.Switch, 0, len(sent))
	for _, one := range sent {
		one = one.Tidied()

		if err := one.Check(); err != nil {
			refuse(w, http.StatusBadRequest, err.Error())
			return
		}

		switches = append(switches, one)
	}

	err := a.remote.SetSwitches(switches)
	a.recordChange(session, "set the apps' feature switches", "", describeSwitches(switches), err)

	if err != nil {
		a.unwritten(w, err)
		return
	}

	respond(w, a.switchesNow())
}

// unwritten answers a write the file did not take.
//
// A file left as something other than JSON is the operator's to mend, and is
// said apart from a disk that would not take the write, because the page says
// different things about them: one is "fix the file", and the other is
// "nothing was changed, try again".
func (a *API) unwritten(w http.ResponseWriter, err error) {
	if errors.Is(err, remote.ErrUnreadable) {
		refuse(w, http.StatusConflict, reasonRemoteUnreadable)
		return
	}

	slog.Error("failed to write the apps' remote settings", "error", err)
	refuse(w, http.StatusInternalServerError, reasonRemoteUnwritable)
}

// recordChange is record with what was changed, which neither of these
// actions says by itself: "set the apps' feature switches" is no answer to
// "who turned screen sharing off on Android".
func (a *API) recordChange(session Session, action, target, change string, err error) {
	entry := Entry{
		Action: action, Trip: session.Trip, Name: session.Name,
		Target: target, Change: change,
	}

	if err != nil {
		entry.Failed = true
		entry.Reason = err.Error()
	}

	a.log.Record(entry)
}

// describeNotice is a notice as the log says it: its level, its end, and which
// languages it is in. Not its words, which are in the file and can be long.
func describeNotice(notice remote.Notice) string {
	languages := make([]string, 0, len(notice.Text))
	for tag := range notice.Text {
		languages = append(languages, tag)
	}

	sort.Strings(languages)

	said := notice.Level + " in " + strings.Join(languages, ",")
	if notice.Until != "" {
		said += " until " + notice.Until
	}

	return said
}

// describeSwitches is the list as the log says it, a rule to a clause, in its
// order: "screen-share off android 0.1.4..0.1.5; music on".
func describeSwitches(switches []remote.Switch) string {
	if len(switches) == 0 {
		return "none"
	}

	clauses := make([]string, 0, len(switches))

	for _, one := range switches {
		clause := one.Feature + " on"
		if one.Off {
			clause = one.Feature + " off"
		}

		if len(one.Platforms) > 0 {
			clause += " " + strings.Join(one.Platforms, ",")
		}

		if one.From != "" || one.Below != "" {
			clause += " " + one.From + ".." + one.Below
		}

		clauses = append(clauses, clause)
	}

	return strings.Join(clauses, "; ")
}
