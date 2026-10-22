package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
Managing who else may open these pages.

Somebody is recognised here by the signature their passphrase produces, never by
the passphrase itself — this server is never told one and could not store one if
it wanted to. The signature is already public: it prints beside its owner's name
in every room they join, which is also how somebody being added finds out what to
hand over. So adding an administrator is adding a name and a signature, and the
person being added does not have to trust anybody with anything.

Adding requires moderate, because being able to grant an ability is the same
ability. An observer who could appoint a moderator would be a moderator with an
extra step. The finer capabilities do not change that: somebody trusted with the
accounts is not thereby trusted to decide who else is, and the roster stays
behind moderate and nothing less.

An administrator's own Emby grant is edited here as well, and for the same
reason is moderate's alone. It is the one permission an administrator does not
hold by being one, because it spends the deployment's bandwidth. Nobody else can
set an administrator's passphrase — an administrator is their signature, and
changes it only themselves — so the rule that guards a grantee's passphrase on
the accounts page has nothing to guard here.

A custom role's four boxes send what was pressed, as an account's boxes do, and
the store lays it over the list it holds. The role control above them is the
one thing that writes the list whole, because choosing "can watch" or "can
manage everything" is a choice about the whole of it.
*/

// rosterEntry is one administrator as a page sees them.
type rosterEntry struct {
	Trip string `json:"trip"`
	Name string `json:"name"`
	// Can is every capability they hold, including those moderate carries;
	// Granted is what is written against them, which is what a page that
	// edits the role has to start from — a moderator's Can lists all four
	// finer capabilities and was given none of them by name.
	Can     []string `json:"can"`
	Granted []string `json:"granted"`
	Added   string   `json:"added,omitempty"`
	// Self marks the entry belonging to whoever is reading, so a page can say
	// so and can refuse to let somebody quietly remove their own way back in.
	Self bool `json:"self,omitempty"`

	// Perms is what is stored against them and Effective every permission and
	// whether they hold it, as for an account; for an administrator only the
	// Emby grant can differ.
	Perms     map[string]bool `json:"perms,omitempty"`
	Effective map[string]bool `json:"effective"`

	// EmbySpent is what the media server relay has carried on their behalf
	// since this process started.
	EmbySpent uint64 `json:"embySpent,omitempty"`
}

func (a *API) roles(session Session, w http.ResponseWriter, _ *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	list, err := a.roster.Admins()
	if err != nil {
		fail(w, err)
		return
	}

	// Falling back to the file rather than answering empty. A deployment that
	// has not adopted yet has administrators — somebody is signed in reading
	// this — and a page that showed none would invite adding one that is
	// already there.
	if len(list) == 0 {
		for _, one := range a.conf.Meet.Admins {
			list = append(list, store.Admin{Trip: one.Trip, Name: one.Name, Can: one.Can})
		}
	}

	spent := a.spending()

	out := make([]rosterEntry, 0, len(list))
	for _, one := range list {
		entry := rosterEntry{
			Trip:      one.Trip,
			Name:      one.Name,
			Can:       capabilitiesOf(one.Configured()),
			Granted:   clean(one.Can),
			Self:      one.Trip == session.Trip,
			Perms:     one.Perms,
			Effective: one.Effective(),
			EmbySpent: spent[one.Trip],
		}

		if !one.Added.IsZero() {
			entry.Added = one.Added.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		out = append(out, entry)
	}

	respond(w, out)
}

// roleRequest is what a page sends to add somebody.
type roleRequest struct {
	Trip string   `json:"trip"`
	Name string   `json:"name"`
	Can  []string `json:"can"`
	// Perms is the grants to start with; in practice whether they have Emby.
	Perms map[string]bool `json:"perms"`
}

func (a *API) addRole(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	var body roleRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	admin := store.Admin{
		Trip:  strings.ToLower(strings.TrimSpace(body.Trip)),
		Name:  strings.TrimSpace(body.Name),
		Can:   clean(body.Can),
		Perms: cleanPerms(body.Perms),
	}

	if err := a.roster.AddAdmin(admin); err != nil {
		a.log.Record(Entry{
			Action: "add administrator", Trip: session.Trip, Name: session.Name,
			Target: admin.Trip, Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "add administrator", Trip: session.Trip, Name: session.Name,
		Target: admin.Trip, Change: "can " + strings.Join(admin.Can, ",") +
			"; perms " + strings.Join(admin.Granted(), ","),
	})

	respond(w, map[string]any{"added": admin.Trip})
}

// changeRole renames somebody, changes what they may do, or changes their
// grants — whichever of the three the page sent.
//
// Each is optional and an absent one is left alone. This used to build a fresh
// administrator from the request, so a request that carried a role and no name
// emptied the name, and every change of role took the person's picture away:
// the record written was the request, and the request had no picture in it. It
// now starts from the stored record and changes only what was asked.
func (a *API) changeRole(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	var body struct {
		Name *string   `json:"name"`
		Can  *[]string `json:"can"`
		// Caps is boxes of a custom role, each given or taken away and laid
		// over the list as stored: the four finer capabilities, and nothing
		// else. A page that sent the whole list as it last drew it undid
		// whatever another administrator had pressed since.
		Caps  *map[string]bool `json:"caps"`
		Perms *map[string]bool `json:"perms"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	trip := r.PathValue("trip")

	refused := func(err error) {
		a.log.Record(Entry{
			Action: "change administrator", Trip: session.Trip, Name: session.Name,
			Target: trip, Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
	}

	list, err := a.roster.Admins()
	if err != nil {
		refused(err)
		return
	}

	var admin store.Admin
	found := false

	for _, one := range list {
		if one.Trip == trip {
			admin, found = one, true
		}
	}

	if !found {
		refused(store.ErrNoSuchAdmin)
		return
	}

	var changed []string

	if body.Name != nil || body.Can != nil {
		before := admin

		if body.Name != nil {
			admin.Name = strings.TrimSpace(*body.Name)
		}

		if body.Can != nil {
			admin.Can = clean(*body.Can)
			changed = append(changed,
				"can "+strings.Join(clean(before.Can), ",")+" -> "+strings.Join(admin.Can, ","))
		}

		if err := a.roster.UpdateAdmin(admin); err != nil {
			refused(err)
			return
		}
	}

	if body.Caps != nil {
		before := clean(admin.Can)

		after, err := a.roster.ChangeAdminCan(trip, *body.Caps)
		if err != nil {
			refused(err)
			return
		}

		changed = append(changed,
			"can "+strings.Join(before, ",")+" -> "+strings.Join(clean(after), ","))
	}

	if body.Perms != nil {
		wanted := cleanPerms(*body.Perms)

		if err := a.roster.ChangeAdminPerms(trip, wanted); err != nil {
			refused(err)
			return
		}

		after := admin
		if stored, ok := a.adminBySignature(trip); ok {
			after = stored
		}

		changed = append(changed,
			"perms "+strings.Join(admin.Granted(), ",")+" -> "+strings.Join(after.Granted(), ","))
	}

	a.log.Record(Entry{
		Action: "change administrator", Trip: session.Trip, Name: session.Name, Target: trip,
		Change: strings.Join(changed, "; "),
	})

	respond(w, map[string]any{"changed": trip})
}

// adminBySignature reads one administrator back from the roster, for an audit
// entry that says what a change left behind.
func (a *API) adminBySignature(trip string) (store.Admin, bool) {
	list, err := a.roster.Admins()
	if err != nil {
		return store.Admin{}, false
	}

	for _, one := range list {
		if one.Trip == trip {
			return one, true
		}
	}

	return store.Admin{}, false
}

func (a *API) dropRole(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	trip := r.PathValue("trip")

	if err := a.roster.RemoveAdmin(trip); err != nil {
		a.log.Record(Entry{
			Action: "remove administrator", Trip: session.Trip, Name: session.Name,
			Target: trip, Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "remove administrator", Trip: session.Trip, Name: session.Name, Target: trip,
	})

	respond(w, map[string]any{"removed": trip})
}

// clean keeps only capabilities this deployment has, and drops the rest.
//
// Silently, because the alternative is refusing a request over a word nobody
// typed: these arrive from checkboxes, and a name that is not one this build
// knows is a page and a server that disagree rather than an administrator
// making a mistake. What matters is that nothing unrecognised is stored, since a
// later version that gave that word a meaning would be granting an ability
// nobody chose. Duplicates go too, and the rest are put in the page's order, so
// the record says the same thing however the boxes were ticked.
//
// Beside moderate, the four it holds are dropped. The roster spells every
// capability out, implied ones included, and a page that renames somebody sends
// that list straight back — so without this, renaming a moderator wrote the four
// finer words into their record. That means nothing different today and is a
// record an older build refuses to rewrite, which on a rollback is every
// moderator unable to change their own picture.
func clean(can []string) []string {
	wanted := make(map[string]bool, len(can))
	for _, one := range can {
		wanted[one] = true
	}

	out := make([]string, 0, len(wanted))

	for _, one := range config.Capabilities() {
		if !wanted[one] {
			continue
		}

		if wanted[config.Moderate] && one != config.Observe && one != config.Moderate {
			continue
		}

		out = append(out, one)
	}

	return out
}

// cleanPerms keeps only permissions this deployment has, and drops the rest,
// for the reason clean does.
func cleanPerms(perms map[string]bool) map[string]bool {
	out := make(map[string]bool, len(perms))

	for name, held := range perms {
		if _, known := store.Permission(name); known {
			out[name] = held
		}
	}

	return out
}

// capabilitiesOf spells out what somebody may do, including what they hold by
// default rather than by being granted it, and what moderate carries with it.
func capabilitiesOf(admin config.Admin) []string {
	out := []string{}

	for _, one := range config.Capabilities() {
		if admin.Allows(one) {
			out = append(out, one)
		}
	}

	return out
}

// fail turns a store's refusal into a status and a code the page can say.
//
// Codes rather than sentences, as everywhere else here: the page owns the
// wording and says it in the reader's own language, and an English string
// returned from the server arrives on screen untranslated.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrAdminExists):
		refuse(w, http.StatusConflict, "already_an_administrator")
	case errors.Is(err, store.ErrNoSuchAdmin):
		refuse(w, http.StatusNotFound, "no_such_administrator")
	case errors.Is(err, store.ErrLastModerator):
		refuse(w, http.StatusConflict, "last_moderator")
	case errors.Is(err, store.ErrAdminNoTrip), errors.Is(err, store.ErrAdminBadTrip):
		refuse(w, http.StatusBadRequest, "not_a_signature")
	case errors.Is(err, store.ErrAdminLongName):
		refuse(w, http.StatusBadRequest, "name_too_long")
	case errors.Is(err, store.ErrAdminBadCan):
		refuse(w, http.StatusBadRequest, "unknown_capability")
	default:
		refuse(w, http.StatusInternalServerError, "store_unavailable")
	}
}

// reasonFor is the same set, for the audit log, which is read by people rather
// than by a page and so keeps the sentence.
func reasonFor(err error) string {
	if err == nil {
		return ""
	}

	return err.Error()
}

// changeOwnPassphrase moves whoever is signed in to a new signature.
//
// There is no password on this server to change. The passphrase is never sent
// here in a form anything keeps and never written down — what is stored is the
// signature it produces — so rotating one means being recognised by a new
// signature from now on, and that is what this does.
//
// The old passphrase is required even though the session already proves who
// this is. What a session proves is that somebody was signed in; what this asks
// is whether the person at the keyboard now is the one who signed in then. An
// unattended laptop is exactly the case where those differ, and it is exactly
// the case where a silent change of credentials is worth something to whoever
// walked past.
func (a *API) changeOwnPassphrase(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	var body struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if strings.TrimSpace(body.Next) == "" {
		refuse(w, http.StatusBadRequest, "no_passphrase")
		return
	}

	// Long enough to be worth having. This is the only credential on the
	// deployment and it is checked by an endpoint anybody can reach, so a short
	// one is a short one whichever way it is stored.
	if len([]rune(strings.TrimSpace(body.Next))) < 8 {
		refuse(w, http.StatusBadRequest, "passphrase_too_short")
		return
	}

	if a.sessions.Signature(body.Current) != session.Trip {
		a.log.Record(Entry{
			Action: "change passphrase", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: "the current passphrase did not match",
		})

		refuse(w, http.StatusForbidden, "wrong_passphrase")
		return
	}

	next := a.sessions.Signature(body.Next)

	if next == session.Trip {
		// The same passphrase. Refused rather than quietly succeeding, because
		// somebody who thought they had changed it would go on believing so.
		refuse(w, http.StatusBadRequest, "passphrase_unchanged")
		return
	}

	if err := a.roster.ReplaceAdminTrip(session.Trip, next); err != nil {
		a.log.Record(Entry{
			Action: "change passphrase", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	// Carried across, or they would be signed out by their own success: the
	// cookie in their browser names a signature this deployment no longer has.
	a.sessions.Moved(session.Trip, next)
	a.moveSpent(session.Trip, next)

	a.log.Record(Entry{
		Action: "change passphrase", Trip: next, Name: session.Name,
	})

	// The new signature is returned because it is what prints beside their name
	// in every room from now on, and somebody who has just changed it is the one
	// person who needs to know it changed.
	respond(w, map[string]any{"trip": next})
}
