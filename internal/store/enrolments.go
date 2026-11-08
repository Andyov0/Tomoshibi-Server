package store

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
One machine's permission to join the fleet, good for one use and a short while.

What an enrolment hands over is the deployment: the key pair every token is
signed with, the redis password, and the private key of the relays' certificate.
It used to be bought with one long-lived secret, written into a configuration
file and pasted into every machine that was ever brought up — so it sat in the
shell history of twenty relays, several of them rented in places where a
provider's console or a snapshot is somebody else's to read, and whoever found
it could enrol a machine of their own, or take over an existing relay's name, at
any time afterwards. Nothing expired and nothing was used up.

So the permission is now minted for one machine. An administrator names the
prefix it will take, says whether it may take one already in use, optionally
names the address it will come from, and gets back a string that works once and
for half an hour. A copy left in a terminal's scrollback afterwards is worth
nothing, and a copy taken before it was used is worth one prefix rather than all
of them.

Kept in the store rather than in memory for two reasons. A control node
restarted between the minting and the use should not make the operator start
again, and the one-use rule has to hold across two requests that arrive at the
same moment, which is a transaction's job. Kept by a digest of the token rather
than the token, for the reason sessions are: a copy of the database is not a
copy of the permissions in it.
*/

var enrolments = []byte("enrolments")

// EnrolGrant is what one enrolment token allows.
type EnrolGrant struct {
	// ID names the grant on a page without naming the token: the start of the
	// digest it is kept under. A page that withdraws one says which by this.
	ID string `json:"id"`

	// Prefix is the only name the machine may take.
	Prefix string `json:"prefix"`

	// Replace is whether that name may already be in use, which is how a rebuilt
	// machine takes over its own name. Decided by the administrator who minted
	// it, on the page, rather than by whoever runs the script: a takeover moves
	// a live relay's name to another machine, and the machine asking is the one
	// party whose word on that is worth nothing.
	Replace bool `json:"replace,omitempty"`

	// From is the address the machine must come from, or empty for any.
	//
	// Optional because the machines that most need enrolling are often the ones
	// whose outbound traffic leaves through a proxy, and the control node then
	// sees the proxy.
	From string `json:"from,omitempty"`

	// Expires is the end of the half hour, or whatever it was minted for.
	Expires time.Time `json:"expires"`

	// Made, By and ByName are when, and by whom, for the audit and the page.
	Made   time.Time `json:"made"`
	By     string    `json:"by,omitempty"`
	ByName string    `json:"byName,omitempty"`
}

// Live reports whether a grant can still be used.
func (g EnrolGrant) Live(now time.Time) bool {
	return now.Before(g.Expires)
}

// ErrNoSuchEnrolment is a token that was never minted, was used, was
// withdrawn, or has expired. Deliberately one error for all four: a caller
// holding a string that does not work has no use for knowing which.
var ErrNoSuchEnrolment = errors.New("no enrolment token by that value is waiting")

// NewEnrolToken draws one.
//
// The same size as an invite's and for the same reason: this string is the
// whole of the check, and for the half hour it lives it buys the deployment.
func NewEnrolToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// KeepEnrolGrant writes a freshly minted grant down under its token.
func (s *Store) KeepEnrolGrant(token string, grant EnrolGrant) (EnrolGrant, error) {
	key := held(token)
	grant.ID = string(key[:12])

	encoded, err := json.Marshal(grant)
	if err != nil {
		return EnrolGrant{}, err
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(enrolments)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})

	return grant, err
}

// EnrolGrant reads one back without using it up.
//
// For the question a script asks before it starts — is this prefix free — which
// has to be answered for whoever holds a live token without spending the token
// on the asking.
func (s *Store) EnrolGrant(token string, now time.Time) (EnrolGrant, bool) {
	var grant EnrolGrant
	found := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(enrolments)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &grant); err == nil && grant.Live(now) {
			found = true
		}

		return nil
	})

	return grant, found
}

// SpendEnrolGrant uses one up and says what it allowed.
//
// Removed in the same transaction that reads it, so two machines presenting one
// token at the same moment get one enrolment between them rather than two. An
// expired grant is removed as well, and refused.
func (s *Store) SpendEnrolGrant(token string, now time.Time) (EnrolGrant, error) {
	var grant EnrolGrant

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(enrolments)
		if bucket == nil {
			return ErrNoSuchEnrolment
		}

		key := held(token)

		raw := bucket.Get(key)
		if raw == nil {
			return ErrNoSuchEnrolment
		}

		if err := bucket.Delete(key); err != nil {
			return err
		}

		if err := json.Unmarshal(raw, &grant); err != nil || !grant.Live(now) {
			return ErrNoSuchEnrolment
		}

		return nil
	})

	return grant, err
}

// EnrolGrants lists the ones still waiting, soonest to expire first, and
// clears away the ones that are not.
//
// Cleared here rather than on a timer because this is the only place anybody
// looks at them, and a token nobody used does nothing by lying in the store
// except make the next list longer.
func (s *Store) EnrolGrants(now time.Time) ([]EnrolGrant, error) {
	var live []EnrolGrant

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(enrolments)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var grant EnrolGrant
			if err := json.Unmarshal(raw, &grant); err != nil || !grant.Live(now) {
				stale = append(stale, append([]byte(nil), key...))
				return nil
			}

			live = append(live, grant)

			return nil
		}); err != nil {
			return err
		}

		for _, key := range stale {
			if err := bucket.Delete(key); err != nil {
				return err
			}
		}

		return nil
	})

	sort.Slice(live, func(i, j int) bool { return live[i].Expires.Before(live[j].Expires) })

	return live, err
}

// WithdrawEnrolGrant removes one by the ID a page was shown, reporting whether
// there was one.
func (s *Store) WithdrawEnrolGrant(id string) (bool, error) {
	found := false

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(enrolments)
		if bucket == nil || len(id) != 12 {
			return nil
		}

		cursor := bucket.Cursor()
		for key, _ := cursor.Seek([]byte(id)); key != nil && string(key[:12]) == id; key, _ = cursor.Next() {
			found = true

			return bucket.Delete(key)
		}

		return nil
	})

	return found, err
}
