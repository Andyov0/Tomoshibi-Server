package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
Giving somebody a way in.

An administrator makes an account by choosing a name and a first passphrase. The
passphrase is turned into a signature at the moment it is typed and is not kept:
what is stored is the signature, exactly as it is for administrators, so this
database holds nothing that can be used to sign in as anybody.

That has a consequence worth stating plainly, because it is the first question
anybody asks. An administrator cannot look up somebody's passphrase and cannot
be shown it later. What they can do is set a new one, which is the useful half
of the same request and the only half that was ever safe.

What an account may use is set here too, as a set of checkboxes (see
store/perms.go). Every box but one is the accounts capability's to tick. The
one is Emby, which relays a film through this deployment for everybody in the
room and so spends its bandwidth on that person's say-so; ticking or unticking
it, on an account being made or one being changed, asks for moderate as well.

So does setting the passphrase of an account that holds Emby. The grant goes
with the account and not with the person, and whoever sets the passphrase can
sign in with it: an administrator trusted with the accounts and refused the box
could otherwise reset a grantee's passphrase, sign in as them, and choose films
on their grant. Renaming is not the same thing and is left alone — the ledger
and every check of the grant ask by signature, which a rename does not move, so
the person who held the grant before a rename holds it after and nobody else
does.

A box sends itself and nothing about the others, and the store lays it over
what it holds. A page sends what was pressed rather than the set it last drew,
because the set it last drew is up to half a minute old: written whole, it put
every other box back as it stood then, and undid whatever another administrator
had changed in between — another administrator's Emby grant among it, taken
away by somebody who had pressed Music.
*/

// Ledger is where the accounts are kept.
type Ledger interface {
	Accounts() ([]store.Account, error)
	Account(name string) (store.Account, bool)
	AddAccount(account store.Account) error
	UpdateAccount(was string, account store.Account) error
	RemoveAccount(name string) error

	// ChangeAccountPerms changes the permissions it is given, leaves the rest
	// as stored, and touches nothing else; UpdateAccount carries the stored
	// permissions over rather than writing them, so this is the only way they
	// change.
	ChangeAccountPerms(name string, changes map[string]bool) error
}

type accountView struct {
	Name     string `json:"name"`
	Trip     string `json:"trip"`
	Avatar   bool   `json:"avatar,omitempty"`
	Created  string `json:"created,omitempty"`
	LastSeen string `json:"lastSeen,omitempty"`
	Blocked  bool   `json:"blocked,omitempty"`
	Note     string `json:"note,omitempty"`
	// Scopes are the groups this account belongs to. Sent whole, because the
	// list is short and the page edits it whole.
	Scopes []string `json:"scopes,omitempty"`

	// Perms is what is stored: only where this account differs from the
	// defaults. Effective is every permission and whether the account holds
	// it, which is what a page draws its checkboxes from — it would otherwise
	// have to know every default, and be wrong the day one changed.
	Perms     map[string]bool `json:"perms,omitempty"`
	Effective map[string]bool `json:"effective"`

	// EmbySpent is what the media server relay has carried on this account's
	// behalf since this process started. Not kept across a restart.
	EmbySpent uint64 `json:"embySpent,omitempty"`
}

func (a *API) accounts(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	list, err := a.ledger.Accounts()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	spent := a.spending()

	out := make([]accountView, 0, len(list))
	for _, account := range list {
		// The avatar is reported as present rather than sent. A list of forty
		// accounts would otherwise be a couple of megabytes of pictures nobody
		// asked to see, on a page that redraws itself.
		view := accountView{
			Name: account.Name, Trip: account.Trip,
			Avatar: account.Avatar != "", Blocked: account.Blocked, Note: account.Note,
			Scopes: account.Scopes, Perms: account.Perms, Effective: account.Effective(),
			EmbySpent: spent[account.Trip],
		}

		if !account.Created.IsZero() {
			view.Created = account.Created.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		if !account.LastSeen.IsZero() {
			view.LastSeen = account.LastSeen.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		out = append(out, view)
	}

	respond(w, out)
}

func (a *API) addAccount(session Session, w http.ResponseWriter, r *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	var body struct {
		Name       string `json:"name"`
		Passphrase string `json:"passphrase"`
		// Perms are the boxes ticked when the account was made. Absent is
		// every permission at its default.
		Perms map[string]bool `json:"perms"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if len([]rune(strings.TrimSpace(body.Passphrase))) < 8 {
		refuse(w, http.StatusBadRequest, "passphrase_too_short")
		return
	}

	account := store.Account{
		Name:  strings.TrimSpace(body.Name),
		Trip:  a.sessions.Signature(body.Passphrase),
		Perms: cleanPerms(body.Perms),
	}

	// Made with Emby is given Emby, and asks for what giving it asks for.
	if account.May(store.PermEmby) && !a.mayGrantEmby(session, "add account", account.Name, "not allowed to grant emby") {
		refuse(w, http.StatusForbidden, "emby_needs_moderate")
		return
	}

	// Never one an administrator already uses. The two lists are separate and
	// the signature is not: somebody signing in on the front page with an
	// administrator's passphrase would be that administrator to every part of
	// this deployment that recognises people, which is all of them.
	for _, admin := range a.Administrators() {
		if admin.Trip == account.Trip {
			refuse(w, http.StatusConflict, "passphrase_in_use")
			return
		}
	}

	if err := a.ledger.AddAccount(account); err != nil {
		a.log.Record(Entry{
			Action: "add account", Trip: session.Trip, Name: session.Name,
			Target: account.Name, Failed: true, Reason: err.Error(),
		})

		failAccount(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "add account", Trip: session.Trip, Name: session.Name, Target: account.Name,
		Change: "perms " + strings.Join(account.Granted(), ","),
	})

	// The signature is returned because it is the account's public identity —
	// it is what prints beside the name in every room — and whoever just made
	// the account is the person who has to hand it over.
	respond(w, map[string]any{"name": account.Name, "trip": account.Trip})
}

func (a *API) changeAccount(session Session, w http.ResponseWriter, r *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	var body struct {
		Name       *string `json:"name"`
		Passphrase *string `json:"passphrase"`
		Blocked    *bool   `json:"blocked"`
		Note       *string `json:"note"`
		// The whole list, replacing what was there. Absent leaves it alone;
		// an empty list takes somebody out of every scope.
		Scopes *[]string `json:"scopes"`
		// The permissions that were pressed, each laid over what is stored:
		// a permission not named is left as it is. Words this build does not
		// know are dropped. See the file comment for why not the whole set.
		Perms *map[string]bool `json:"perms"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	was := r.PathValue("name")

	account, ok := a.ledger.Account(was)
	if !ok {
		refuse(w, http.StatusNotFound, "no_such_account")
		return
	}

	before, trip := account.Granted(), account.Trip

	if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
		account.Name = strings.TrimSpace(*body.Name)
	}

	if body.Blocked != nil {
		account.Blocked = *body.Blocked
	}

	if body.Note != nil {
		account.Note = strings.TrimSpace(*body.Note)
	}

	// What the audit entry says changed, where a scope or a permission did.
	// Recorded because a tag is a key to every room held under it and a
	// permission can be a charge on the deployment's bandwidth, and "who gave
	// this person the acme rooms" or "who gave them Emby" is a question
	// somebody will ask after the fact.
	var changed []string

	if body.Scopes != nil {
		wanted := scopes(*body.Scopes)

		changed = append(changed,
			"scopes "+strings.Join(account.Scopes, ",")+" -> "+strings.Join(wanted, ","))
		account.Scopes = wanted
	}

	// The permissions to change, worked out before anything is written, so
	// that a refusal over Emby refuses the whole request rather than the half
	// of it that happened to come second.
	var perms map[string]bool

	if body.Perms != nil {
		perms = cleanPerms(*body.Perms)

		// Emby named is Emby set, and only a moving Emby is a decision about
		// it. Compared as held rather than as written: a page that sends Emby
		// unticked about an account that never had it is changing nothing and
		// must not need moderate to say so.
		if wanted, named := perms[store.PermEmby]; named {
			switch {
			case wanted != account.May(store.PermEmby):
				if !a.mayGrantEmby(session, "change account", was, "not allowed to grant emby") {
					refuse(w, http.StatusForbidden, "emby_needs_moderate")
					return
				}

			case !session.Allows(config.Moderate):
				// Unchanged, and not this session's to write even as itself:
				// what it read a moment ago may not be what the store holds
				// by the time this is written, and written as read it would
				// be a grant given, or taken away, by somebody without
				// moderate. Left to whoever may.
				delete(perms, store.PermEmby)
			}
		}
	}

	// Set rather than read. An administrator cannot be shown somebody's
	// passphrase — it was never stored — and this is the useful half of that
	// request: the person is told the new one out of band and changes it
	// themselves afterwards.
	if body.Passphrase != nil && strings.TrimSpace(*body.Passphrase) != "" {
		if len([]rune(strings.TrimSpace(*body.Passphrase))) < 8 {
			refuse(w, http.StatusBadRequest, "passphrase_too_short")
			return
		}

		// Choosing the passphrase of somebody who holds Emby is choosing who
		// holds it; see the file comment. Asked of the record as read above,
		// blocked or not: a block is lifted by a press of the accounts
		// capability's own, and would hand over the grant the moment it was.
		//
		// What remains is the moment between this read and the write below,
		// in which a moderator granting Emby to this same account would be
		// granting it to a passphrase somebody else has just chosen. That is
		// two administrators changing one account in the same instant, and the
		// moderator's page shows the new signature on its next read.
		if account.May(store.PermEmby) &&
			!a.mayGrantEmby(session, "change account", was, "not allowed to set the passphrase of an account holding emby") {
			refuse(w, http.StatusForbidden, "emby_needs_moderate")
			return
		}

		account.Trip = a.sessions.Signature(*body.Passphrase)

		for _, admin := range a.Administrators() {
			if admin.Trip == account.Trip {
				refuse(w, http.StatusConflict, "passphrase_in_use")
				return
			}
		}
	}

	refused := func(err error) {
		a.log.Record(Entry{
			Action: "change account", Trip: session.Trip, Name: session.Name,
			Target: was, Failed: true, Reason: err.Error(),
		})

		failAccount(w, err)
	}

	// The rest of the record is written only where some of it was sent.
	//
	// A request carrying only permissions — which is what a ticked box sends —
	// does not hand the whole record back. It would be a copy read at the top
	// of this request, and anything that changed in between, the person's own
	// new picture among it, would be put back the way it was.
	rest := body.Name != nil || body.Passphrase != nil || body.Blocked != nil ||
		body.Note != nil || body.Scopes != nil

	if rest || body.Perms == nil {
		if err := a.ledger.UpdateAccount(was, account); err != nil {
			refused(err)
			return
		}

		a.moveSpent(trip, account.Trip)
	}

	// Under the name the record now has, which a rename above may have
	// changed. Second rather than first because the rename can be refused —
	// the name taken — and the permissions would then have been changed by a
	// request that answered as though nothing had been.
	if len(perms) > 0 {
		if err := a.ledger.ChangeAccountPerms(account.Name, perms); err != nil {
			refused(err)
			return
		}
	}

	// Read back for the answer, so that a page drawing boxes from it draws
	// what was stored rather than what it sent — the other boxes as they are
	// now, which may not be as that page last drew them.
	if stored, ok := a.ledger.Account(account.Name); ok {
		account = stored
	}

	if body.Perms != nil {
		changed = append(changed,
			"perms "+strings.Join(before, ",")+" -> "+strings.Join(account.Granted(), ","))
	}

	a.log.Record(Entry{
		Action: "change account", Trip: session.Trip, Name: session.Name, Target: was,
		Change: strings.Join(changed, "; "),
	})

	respond(w, map[string]any{
		"name": account.Name, "trip": account.Trip,
		"perms": account.Perms, "effective": account.Effective(),
	})
}

// mayGrantEmby reports whether this session may give or take away somebody's
// Emby, and records it when it may not.
//
// Moderate and nothing finer. The accounts capability is trusted with who gets
// in; the Emby grant decides what the deployment spends its bandwidth on, for
// everybody in every room the grantee chooses a film in, and that is the
// owner's call or a full administrator's.
//
// why is the audit log's reason, which says which of the two it was refused:
// the box itself, or the passphrase of somebody holding it.
func (a *API) mayGrantEmby(session Session, action, target, why string) bool {
	if session.Allows(config.Moderate) {
		return true
	}

	a.log.Record(Entry{
		Action: action, Trip: session.Trip, Name: session.Name, Target: target,
		Failed: true, Reason: why,
	})

	return false
}

func (a *API) dropAccount(session Session, w http.ResponseWriter, r *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	name := r.PathValue("name")

	if err := a.ledger.RemoveAccount(name); err != nil {
		failAccount(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "remove account", Trip: session.Trip, Name: session.Name, Target: name,
	})

	respond(w, map[string]any{"removed": name})
}

// scopes tidies a list of tags as an administrator typed it.
//
// Lowercased and trimmed, because a scope is read out of a room name that has
// been through the same treatment, and a tag that differs from the name only in
// case is a membership of nothing. Duplicates are dropped and the rest sorted, so
// the record says the same thing however it was typed.
//
// Anything that still is not a scope is left in, for the store to refuse the
// whole change: a tag dropped quietly here would be a person who thinks they
// gave somebody access and did not.
func scopes(typed []string) []string {
	seen := make(map[string]bool, len(typed))
	out := make([]string, 0, len(typed))

	for _, one := range typed {
		scope := strings.ToLower(strings.TrimSpace(one))
		if scope == "" || seen[scope] {
			continue
		}

		seen[scope] = true
		out = append(out, scope)
	}

	sort.Strings(out)

	return out
}

// failAccount turns a store's refusal into a status and a code the page says.
func failAccount(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrAccountExists):
		refuse(w, http.StatusConflict, "name_taken")
	case errors.Is(err, store.ErrAccountTripTaken):
		refuse(w, http.StatusConflict, "passphrase_in_use")
	case errors.Is(err, store.ErrNoSuchAccount):
		refuse(w, http.StatusNotFound, "no_such_account")
	case errors.Is(err, store.ErrAccountNoName), errors.Is(err, store.ErrAccountBadName),
		errors.Is(err, store.ErrAccountLongName):
		refuse(w, http.StatusBadRequest, "bad_name")
	case errors.Is(err, store.ErrAvatarTooLarge):
		refuse(w, http.StatusRequestEntityTooLarge, "avatar_too_large")
	case errors.Is(err, store.ErrAccountBadScope):
		refuse(w, http.StatusBadRequest, "bad_scope")
	case errors.Is(err, store.ErrUnknownPermission):
		refuse(w, http.StatusBadRequest, "unknown_permission")
	default:
		refuse(w, http.StatusInternalServerError, "store_unavailable")
	}
}
