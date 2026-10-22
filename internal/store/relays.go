package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// relaysBucket holds the media servers this deployment hands clients to.
//
// In the store rather than in the configuration file, for the reason
// rooms.opened_by is: a relay is added when a machine is brought up and removed
// when it is taken away, and both happen while the deployment is running.
// Editing a file and restarting to add one would drop every call in progress on
// the control node, which is a strange price for an operation that changes
// nothing about the calls already being held elsewhere.
//
// The configuration file remains the starting value, adopted the first time
// this runs, exactly as the opening policy is.
var relaysBucket = []byte("relays")

// Relay is one media server, as the deployment knows it.
type Relay struct {
	// Name identifies it: to an operator reading a log, and to a client naming
	// the one it measured as fastest. Immutable once created — a rename would
	// silently orphan every client that had measured the old one.
	Name string `json:"name"`

	// URL is the WebSocket origin a browser dials. Handed to clients verbatim.
	URL string `json:"url"`

	// Region is this deployment's own label for where the machine is. Compared
	// against a client's, never interpreted.
	Region string `json:"region,omitempty"`

	// Probe is where this relay answers STUN binding requests, as host:port.
	//
	// Sent to clients so the picker can time one round trip over UDP rather
	// than three over TLS. Empty where the relay does not answer, and a client
	// that is given nothing falls back to timing the signalling socket — which
	// is what it did before this existed and is still the honest ranking.
	Probe string `json:"probe,omitempty"`

	// Turn is where this relay forwards media, as host:port.
	//
	// A meeting lives on one node — the media server binds a room to whichever
	// node opened it — so without this, picking a server decided nothing for
	// anybody but the first person in: their signalling was forwarded to the
	// holding node and their media went straight past the machine they picked,
	// which carried none of the call it was chosen for.
	//
	// With it, a client that picked this relay allocates on its TURN server and
	// the packets are forwarded on. One extra hop, paid on purpose, in exchange
	// for the call entering the country the caller is in.
	//
	// Empty where the relay does not run one, and a relay that cannot forward is
	// not broken: a client that picks it while the room is elsewhere is sent
	// straight to the node holding the room, which is what everybody got before
	// this existed.
	Turn string `json:"turn,omitempty"`

	// Forwards is whether this relay may carry a call it is not holding.
	//
	// Separate from Turn, which is where, and deliberately separate from
	// AdminOnly, which is who: a machine can be reserved and still be the right
	// place to forward through, and a machine anybody may use can be one whose
	// bandwidth is too expensive to spend twice. Relaying costs the relay two
	// bytes for every one — in and out again — so this is the switch on the
	// bill, and it belongs to whoever pays it rather than being inferred.
	Forwards bool `json:"forwards,omitempty"`

	// SignalVia names the relay this one's signalling goes through: a relay
	// carrying media only, over UDP, because no TLS handshake reaches it.
	//
	// The providers in front of the mainland machines intercept TLS to a
	// server without an ICP filing however it is addressed, by name or by
	// bare IP, while UDP and other TCP pass (the owner, 2026-10-20, after a
	// participant's handshakes to two of them were reset from his network and
	// three of them could not open 80 for a certificate). Media never needed
	// TLS: it is DTLS-SRTP over UDP, and a forwarded call's TURN is UDP too. So
	// a relay that names one here is never handed out as an address to open a
	// socket to. The join gives the named relay's address for the signalling,
	// which the cluster carries to this relay through redis as it already
	// does for a call held on another machine; puts a new room on this relay
	// first, since the machine that receives the signalling would otherwise
	// create it there; and leaves the media where it was chosen. Empty is an
	// ordinary relay, which signals for itself.
	SignalVia string `json:"signalVia,omitempty"`

	// Apart names the relays this one must not forward with.
	//
	// By name and in either direction: if either of a pair lists the other, the
	// pair does not forward, whichever end a client came in at. Symmetry is not
	// a convenience — a rule written on one side of a comparison is a rule on
	// neither, and the half that was forgotten is the half that produces the
	// outage.
	//
	// It exists because reachability between two machines is a fact about the
	// networks between them and nothing here can derive it. Two relays can both
	// be fast, both be in the same country, both answer every probe, and still
	// carry nothing usable between each other — and the only symptom of pairing
	// them is a call that stutters, which reads as the relay somebody picked
	// being bad rather than as a pair that should never have been formed.
	//
	// Deliberately not derived from the region. Region groups the picker for
	// people to read, and inferring a network rule from it means a change made
	// for legibility silently changes where media goes.
	Apart []string `json:"apart,omitempty"`

	// Bridge marks a relay that may stand in for one that cannot reach a room.
	//
	// The case it exists for: a fleet with machines on both sides of a border,
	// where nothing abroad can usefully carry media to anything inside it, but
	// one particular machine can talk to both. Somebody abroad joining a meeting
	// held inside is then sent to that machine instead of to the one they picked,
	// and their call goes in the one way it can rather than not at all.
	//
	// Standing in is not the same as being chosen. A bridge is used only where
	// the pair somebody actually landed on will not work, and it still has to be
	// a relay that pair may use — a bridge kept apart from the machine holding
	// the room is no more use than the entry was.
	Bridge bool `json:"bridge,omitempty"`

	// Lat and Lon are where the machine is, in degrees.
	//
	// For the globe on the join screen, and — since the media servers were told
	// to place rooms by distance — for the region list every one of them is
	// given. Nothing measures with them; they say where a machine is, and both
	// readers want that for their own reasons.
	//
	// A relay without them is simply not drawn, which is the honest thing to do
	// with a machine nobody has said the location of: guessing from a region
	// name would put a box in the middle of a country it is not in and look
	// exactly as authoritative as the ones that are right. It is also left out
	// of the region list, where a guess would be worse still — it would place
	// calls.
	Lat float64 `json:"lat,omitempty"`
	Lon float64 `json:"lon,omitempty"`

	// Node is what the media server on this machine calls the place it is in.
	//
	// Not Region, which is this deployment's own grouping and is shown to
	// people; this is an identifier the media servers compare against each
	// other, and the two want different things. "Oversea/Asia" groups four
	// machines usefully on a page and would collapse them into one place for
	// routing, which is the opposite of what the routing is for.
	//
	// It exists because the machines already had one and nothing here knew it.
	// Every relay was given a region and a list of regions by hand, after
	// enrolment, and the enrolment went on writing neither — so a relay brought
	// up by the script fell back to the selector that picks a node at random,
	// which is the fault that put people in rooms held on machines they could
	// not reach. Recorded here, the enrolment can write both.
	Node string `json:"node,omitempty"`

	// Label is what a person is shown instead of the name.
	//
	// The name is a key: immutable, because a client that measured it will send
	// it back at the join, and short, because it is typed at a prompt on a
	// machine being brought up. Neither of those makes it good to read. "sh" is
	// a fine key and a poor thing to offer somebody choosing where to hold a
	// call, and the fix is not to rename the key — a rename orphans every client
	// that had measured the old one.
	Label string `json:"label,omitempty"`

	// Enabled is whether clients are sent here.
	//
	// The reason this is a flag rather than a deletion: taking a relay out of
	// service should stop new calls from arriving without ending the ones it is
	// already holding, and should be reversible by somebody who did not write
	// down its address first.
	Enabled bool `json:"enabled"`

	// Added is when somebody put it here, for a page that wants to say so.
	Added time.Time `json:"added"`

	// Order is where it sits in the list, smallest first.
	//
	// Set from a page rather than derived, because the useful order is not one
	// this server can work out. Alphabetical put a reserve relay above the one
	// holding every call, and by-date put whichever machine was rebuilt most
	// recently at the bottom. Whoever runs the deployment knows which relay they
	// want to look at first.
	//
	// Zero on everything written before this existed, which sorts them together
	// and leaves the name to break the tie — exactly the order they had.
	Order int `json:"order,omitempty"`

	// AdminOnly keeps a relay off the list everybody else is offered.
	//
	// For a machine that is not for general use: an expensive line, a box being
	// tried out, one paid for by somebody in particular. Distinct from Enabled,
	// which takes it out of service, and from Fallback, which is about when to
	// reach for it — this is about who may.
	//
	// Enforced where the relay is chosen and not only where the list is drawn.
	// Hiding it from the picker stops it being picked by accident; refusing it
	// at the join is what stops it being picked on purpose by somebody who read
	// the name off a colleague's screen.
	AdminOnly bool `json:"adminOnly,omitempty"`

	// Fallback keeps a relay out of the ordinary rotation without taking it out
	// of service.
	//
	// The case it exists for: a relay abroad, kept for when the domestic ones
	// cannot be reached. It works, it should be dialled when nothing else can
	// be, and it should never be the answer to "which relay is nearest" — every
	// byte of a call held there crosses a border twice and arrives late.
	//
	// Distinct from Enabled, which means the machine should take no calls at
	// all. This one means: not unless there is nothing else.
	Fallback bool `json:"fallback"`
}

// What a relay can be wrong in.
//
// Sentinels rather than sentences, because the sentence belongs to whoever is
// showing it: these travel to a management page that says them in the reader's
// own language, and an English string returned from here would arrive on screen
// untranslated. The text on each is for a log and for whoever is reading a stack
// trace, and is never what a person is shown.
var (
	ErrRelayNoName   = errors.New("a relay needs a name")
	ErrRelayLongName = errors.New("a relay name is at most 64 characters")
	ErrRelayNoURL    = errors.New("a relay needs a url")
	ErrRelayBadURL   = errors.New("a relay url must begin ws:// or wss://")
	ErrRelayLongTag  = errors.New("a relay region is at most 64 characters")
	ErrRelayExists   = errors.New("a relay with that name is already here")
	ErrNoSuchRelay   = errors.New("no relay by that name is here")

	ErrRelayLongLabel = errors.New("a relay label is at most 64 characters")

	// ErrRelaySignalledThrough is a relay being removed that another still
	// signals through. See RemoveRelay.
	ErrRelaySignalledThrough = errors.New("another relay signals through this one")
)

// Valid reports whether a relay is one this deployment can use.
//
// Checked here rather than only at the API, because the store is what the
// running deployment reads: a relay that got in by any route at all has to be
// one a client can be handed.
func (r Relay) Valid() error {
	switch {
	case strings.TrimSpace(r.Name) == "":
		return ErrRelayNoName

	case len(r.Name) > 64:
		return ErrRelayLongName

	case strings.TrimSpace(r.URL) == "":
		return ErrRelayNoURL

	case !strings.HasPrefix(r.URL, "ws://") && !strings.HasPrefix(r.URL, "wss://"):
		return ErrRelayBadURL

	case len(r.Region) > 64:
		return ErrRelayLongTag

	case len(r.Label) > 64:
		return ErrRelayLongLabel

	}

	return nil
}

// Relays lists every relay, enabled or not, by name.
//
// Sorted so that a page redrawn after a change does not reorder itself under
// whoever is reading it, and so that two control nodes show the same list.
func (s *Store) Relays() ([]Relay, error) {
	var list []Relay

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var relay Relay
			if err := json.Unmarshal(raw, &relay); err != nil {
				// One unreadable entry should not take the list with it: the
				// page is how somebody would find out and fix it.
				return nil
			}

			list = append(list, relay)
			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the relays: %w", err)
	}

	// By the order somebody chose, then by name for anything they have not
	// ordered. Stable in both halves, so a page redrawn after a change does not
	// reorder itself under whoever is reading it, and two control nodes show the
	// same list.
	sort.Slice(list, func(i, j int) bool {
		if list[i].Order != list[j].Order {
			return list[i].Order < list[j].Order
		}

		return list[i].Name < list[j].Name
	})

	return list, nil
}

// ReorderRelays puts the list in the order given.
//
// The whole list at once rather than a move at a time. Two administrators
// pressing an arrow each would otherwise interleave into an order neither
// chose, and a swap that half applied would leave two relays claiming one
// position. This writes positions from one, so whatever arrives last is simply
// the order — and anything the caller did not mention keeps its place after the
// ones that were.
func (s *Store) ReorderRelays(names []string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return ErrNoSuchRelay
		}

		for position, name := range names {
			raw := bucket.Get([]byte(name))
			if raw == nil {
				// Skipped rather than refused. A relay removed while somebody
				// was dragging is not a reason to refuse the order they chose
				// for the others.
				continue
			}

			var relay Relay
			if err := json.Unmarshal(raw, &relay); err != nil {
				continue
			}

			relay.Order = position + 1

			encoded, err := json.Marshal(relay)
			if err != nil {
				return err
			}

			if err := bucket.Put([]byte(name), encoded); err != nil {
				return err
			}
		}

		return nil
	})
}

// AddRelay records a new one.
//
// Refuses a name already in use rather than overwriting it. The two operations
// read the same in a hurry and mean opposite things: adding a relay somebody
// else added is a mistake worth hearing about, and silently replacing its
// address would move every future call without anybody asking.
func (s *Store) AddRelay(relay Relay) error {
	if err := relay.Valid(); err != nil {
		return err
	}

	relay.Name = strings.TrimSpace(relay.Name)
	relay.URL = strings.TrimSpace(relay.URL)
	relay.Region = strings.TrimSpace(relay.Region)
	relay.Label = strings.TrimSpace(relay.Label)

	if relay.Added.IsZero() {
		relay.Added = time.Now().UTC()
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(relaysBucket)
		if err != nil {
			return err
		}

		if bucket.Get([]byte(relay.Name)) != nil {
			return ErrRelayExists
		}

		encoded, err := json.Marshal(relay)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(relay.Name), encoded)
	})
}

// UpdateRelay changes one that is already here.
//
// The name is the key and cannot be changed: a client that measured "shanghai"
// a minute ago will name it at the join, and a rename would leave that client
// falling back as though it had never measured anything.
func (s *Store) UpdateRelay(relay Relay) error {
	if err := relay.Valid(); err != nil {
		return err
	}

	relay.URL = strings.TrimSpace(relay.URL)
	relay.Region = strings.TrimSpace(relay.Region)
	relay.Label = strings.TrimSpace(relay.Label)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return ErrNoSuchRelay
		}

		raw := bucket.Get([]byte(relay.Name))
		if raw == nil {
			return ErrNoSuchRelay
		}

		// The date it was added belongs to the original entry; an edit is not
		// a re-adding and should not look like one.
		var existing Relay
		if err := json.Unmarshal(raw, &existing); err == nil {
			relay.Added = existing.Added
		}

		encoded, err := json.Marshal(relay)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(relay.Name), encoded)
	})
}

// RenameRelay moves a relay to a new name, keeping everything else.
//
// The name is the key, and it was immutable for a real reason: a client that
// measured "shanghai" a minute ago sends that name at the join, and a rename
// leaves it falling back as though it had never measured anything. That cost is
// one join with an unused measurement, which is small — and paying it is better
// than a deployment stuck with whatever prefix somebody typed at a prompt on
// the night the machine was built.
//
// One transaction, because the two halves separately are a window in which the
// relay exists twice or not at all, and not-at-all means calls being sent
// nowhere.
func (s *Store) RenameRelay(from, to string) error {
	to = strings.TrimSpace(to)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return ErrNoSuchRelay
		}

		raw := bucket.Get([]byte(from))
		if raw == nil {
			return ErrNoSuchRelay
		}

		if from == to {
			return nil
		}

		if bucket.Get([]byte(to)) != nil {
			return ErrRelayExists
		}

		var relay Relay
		if err := json.Unmarshal(raw, &relay); err != nil {
			return err
		}

		relay.Name = to

		if err := relay.Valid(); err != nil {
			return err
		}

		encoded, err := json.Marshal(relay)
		if err != nil {
			return err
		}

		if err := bucket.Put([]byte(to), encoded); err != nil {
			return err
		}

		if err := bucket.Delete([]byte(from)); err != nil {
			return err
		}

		// And everywhere else the old name is written down.
		//
		// A relay is referred to by name from other relays' Apart lists, and a
		// name that no longer matches anything is not an error — apart() asks
		// whether a list contains a name, and a list naming a machine that has
		// been renamed simply answers no. So renaming a relay used to switch off
		// every rule keeping it away from another one, silently, with the rules
		// still on the page and the calls they were written to prevent now
		// allowed. On this deployment those rules are what stop Hong Kong being
		// asked to carry for Shanghai Telecom over a path that does not exist.
		//
		// In the same transaction as the rename, so there is no moment at which
		// the relay has its new name and the rules still hold the old one.
		//
		// And the relays that signal through it, which name it the same way and
		// were left naming the old one. That reference is not quiet the way a
		// rule is: the join looked for the old name, found nothing, and sent
		// every client of the media relay to whichever other relay answered the
		// control node fastest, warning on each join; the management page sent
		// the old name back with every save of that relay and was refused it, so
		// nothing on the relay could be changed until somebody worked out which
		// field was stale; and enrolling a machine under the old name later would
		// have handed it the signalling of every relay that named it, with
		// nobody having chosen that. Matched exactly, as the join matches it.
		return eachRelay(bucket, func(other Relay) (Relay, bool) {
			var touched bool

			for i, name := range other.Apart {
				if strings.EqualFold(strings.TrimSpace(name), from) {
					other.Apart[i], touched = to, true
				}
			}

			if other.SignalVia == from {
				other.SignalVia, touched = to, true
			}

			return other, touched
		})
	})
}

// eachRelay rewrites the relays a change says to rewrite.
//
// Bolt forbids modifying a bucket while its cursor is open, so the reads are
// finished before the writes begin.
func eachRelay(bucket *bolt.Bucket, change func(Relay) (Relay, bool)) error {
	var changed []Relay

	if err := bucket.ForEach(func(_, raw []byte) error {
		var relay Relay
		if err := json.Unmarshal(raw, &relay); err != nil {
			// One unreadable record is not a reason to abandon the rest, and a
			// record nothing can read is not one this can repair.
			return nil
		}

		if updated, touched := change(relay); touched {
			changed = append(changed, updated)
		}

		return nil
	}); err != nil {
		return err
	}

	for _, relay := range changed {
		encoded, err := json.Marshal(relay)
		if err != nil {
			return err
		}

		if err := bucket.Put([]byte(relay.Name), encoded); err != nil {
			return err
		}
	}

	return nil
}

// RemoveRelay forgets one.
//
// Calls already being held on it are not ended: this server has no way to end
// them and no business doing so. What stops is being sent there — which is why
// disabling is the gentler operation and this one is for a machine that is gone.
//
// Refused while another relay signals through it, rather than clearing that
// relay's setting the way the rules below are cleared. A rule that names a
// machine that is gone keeps nothing apart and can go; a relay that signals
// through one does so because its clients' networks reset TLS to it, and
// clearing the setting would send every one of them straight back into that.
// Leaving it naming the removed machine is the trap a rename used to leave
// (see RenameRelay). So the operator is asked to say where those relays
// should signal through now, which only they know.
func (s *Store) RemoveRelay(name string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return ErrNoSuchRelay
		}

		if bucket.Get([]byte(name)) == nil {
			return ErrNoSuchRelay
		}

		signalled := false
		if err := bucket.ForEach(func(_, raw []byte) error {
			var other Relay
			if json.Unmarshal(raw, &other) == nil && other.Name != name && other.SignalVia == name {
				signalled = true
			}
			return nil
		}); err != nil {
			return err
		}
		if signalled {
			return ErrRelaySignalledThrough
		}

		if err := bucket.Delete([]byte(name)); err != nil {
			return err
		}

		// And the rules that named it, for the same reason a rename rewrites
		// them: a rule naming a machine that is not there is not an error, it
		// is a rule that quietly stops applying. Left behind it is also a
		// trap — enrol a machine under the removed name later and every one of
		// those rules comes back to life at once, against a relay nobody
		// wrote them about.
		return eachRelay(bucket, func(other Relay) (Relay, bool) {
			kept := other.Apart[:0]

			for _, named := range other.Apart {
				if !strings.EqualFold(strings.TrimSpace(named), name) {
					kept = append(kept, named)
				}
			}

			if len(kept) == len(other.Apart) {
				return other, false
			}

			other.Apart = kept

			return other, true
		})
	})
}

// AdoptRelays writes the configured relays in, the first time this runs.
//
// The same bargain rooms.opened_by strikes: the file is the starting value and
// the management pages are what change it afterwards. Adopted only when the
// bucket has never existed, rather than when it is empty — a deployment that
// deliberately removed its last relay should not have the file's put back on
// the next restart.
func (s *Store) AdoptRelays(configured []Relay) (adopted bool, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(relaysBucket) != nil {
			return nil
		}

		bucket, err := tx.CreateBucketIfNotExists(relaysBucket)
		if err != nil {
			return err
		}

		for _, relay := range configured {
			if err := relay.Valid(); err != nil {
				return fmt.Errorf("relay %q from the configuration: %w", relay.Name, err)
			}

			relay.Enabled = true
			if relay.Added.IsZero() {
				relay.Added = time.Now().UTC()
			}

			encoded, err := json.Marshal(relay)
			if err != nil {
				return err
			}

			if err := bucket.Put([]byte(relay.Name), encoded); err != nil {
				return err
			}
		}

		adopted = true
		return nil
	})

	if err != nil {
		return false, fmt.Errorf("adopt the configured relays: %w", err)
	}

	return adopted, nil
}

// Shown is what a person should see this relay called.
//
// The label where there is one and the key where there is not, so that a
// deployment which never set a label reads exactly as it did before.
func (r Relay) Shown() string {
	if r.Label != "" {
		return r.Label
	}

	return r.Name
}
