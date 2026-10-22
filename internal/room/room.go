// Package room turns a requested name into an authorisation to join it.
//
// There is no room object anywhere on the server and no membership table. A room
// exists because somebody named it, and stops existing when the last participant
// leaves. What this package produces is a signed statement that the bearer may
// join one particular room under one particular identity, and nothing else.
package room

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
)

// MaxDisplayName is the longest display name accepted.
//
// Trimmed rather than refused, because a name is the one field where a caller's
// intent is obvious and an error would be pedantic.
const MaxDisplayName = 40

// MaxName is the longest room name accepted.
//
// Long enough for a generated name with room to spare, short enough that a name
// stays something a person can repeat over the phone.
const MaxName = 64

// random is how many hex characters of randomness every identity carries.
//
// Present even on a signed identity, so that one person joining twice is two
// participants who happen to share a signature rather than one who keeps
// evicting themselves.
const random = 32

// MaxScope is the longest scope accepted.
//
// Shorter than a room name, because it is the half people type after the one
// they chose, and because it is a label an administrator puts on accounts — a
// company or a team — rather than something generated to be hard to guess.
const MaxScope = 32

/*
A scope is a name a group of people share, written after the room.

`standup@acme` is the room `standup` as the people of `acme` hold it. It is
still only a name: there is no scope object, no membership table and nothing
created first. What the suffix changes is who may say it — the join asks, every
time, whether the person saying it carries the tag on their account — and that
question is asked of the name, which is the one thing anybody brings.

One `@` and no more. A second would make a name that splits two ways, and the
point of writing the scope into the name is that there is never a question of
which group a room belongs to.
*/

// ValidName reports whether name is one this server will authorise.
//
// Lowercase letters, digits, and inner dashes, with at most one `@` between a
// room and its scope. Narrow on purpose: the name travels in URLs, gets read
// aloud, and gets typed from memory, and every character class left out is a
// class of transcription error that cannot happen.
//
// Each half is held to the rule a plain name always was, so a scoped name is
// two plain names and nothing a plain one could not already be.
func ValidName(name string) bool {
	local, scope, scoped := strings.Cut(name, "@")
	if !scoped {
		return plain(name, MaxName)
	}

	return plain(local, MaxName) && ValidScope(scope)
}

// ValidScope reports whether scope is one an account may carry and a room may
// name.
func ValidScope(scope string) bool {
	return plain(scope, MaxScope)
}

// Split takes a name apart into the room and the scope it is held under.
//
// The scope is empty for a name without one, which is every name there was
// before scopes existed and is still the ordinary case. Callers are expected to
// have checked the name already: this does not, so that asking which scope a
// name belongs to cannot become a second, quieter definition of a valid one.
func Split(name string) (local, scope string) {
	local, scope, _ = strings.Cut(name, "@")

	return local, scope
}

// plain is the rule a room name has always been held to.
func plain(name string, longest int) bool {
	if name == "" || len(name) > longest {
		return false
	}

	if strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") {
		return false
	}

	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}

	return true
}

// ValidIdentity reports whether identity is one MintIdentity could have made.
//
// A caller returning something else is given a fresh one rather than refused:
// they get a working session instead of an error they cannot act on, and cannot
// smuggle in an identity of their own choosing.
func ValidIdentity(identity string) bool {
	mark, ok := SignatureOf(identity)
	return ok && isTrip(mark.Trip) && isRandom(identity[1+TripLength+1:])
}

// MintIdentity returns a fresh identity carrying trip, or an issued mark when
// there is no passphrase behind one.
//
// Everybody gets a mark. Without one, two people who arrive under the same name
// are indistinguishable, and the roster cannot say which of them said anything.
// What an issued mark does not do is claim to be the same person as last time,
// which is why it wears a different prefix and why the interface draws it
// differently.
//
// The mark goes into the identity rather than beside it because the identity is
// signed into the token and enforced by the media server: it is the one field
// about a participant that nobody, including that participant, can change after
// the fact. A mark sent any other way would be a claim.
func MintIdentity(trip string) string {
	return mint(trip, false)
}

// MintAccountIdentity is the same, for somebody who arrived signed in.
//
// Separate rather than a boolean on the one everybody calls, so that the ordinary
// path cannot acquire the mark by a caller passing the wrong argument. The only
// place this is reached from is the join, and only after a session has been read.
func MintAccountIdentity(trip string) string {
	return mint(trip, true)
}

func mint(trip string, account bool) string {
	var raw [random / 2]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// predictable identity is worse than not starting.
		panic(fmt.Sprintf("read random bytes: %v", err))
	}

	if trip == "" {
		return issued + IssueTrip() + "-" + hex.EncodeToString(raw[:])
	}

	if account {
		return held + trip + "-" + hex.EncodeToString(raw[:])
	}

	return proven + trip + "-" + hex.EncodeToString(raw[:])
}

func isRandom(hex string) bool {
	if len(hex) != random {
		return false
	}

	for _, r := range hex {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
		default:
			return false
		}
	}

	return true
}

func isTrip(trip string) bool {
	if len(trip) != TripLength {
		return false
	}

	for _, r := range trip {
		switch {
		case r >= 'a' && r <= 'z', r >= '2' && r <= '7':
		default:
			return false
		}
	}

	return true
}

// Grant is what a client needs to join.
type Grant struct {
	// Token authorises exactly one room and one identity.
	Token string
	// Identity is what the client will be known as, to be sent back on the next
	// join so a reload keeps the same one.
	Identity string
}

// Request is what a caller asks to be authorised for.
type Request struct {
	// Room is the name they want to join.
	Room string
	// Identity they were given previously, if any.
	Identity string
	// Display is what they would like to be called.
	Display string
	// Passphrase signs the display name, when they gave one.
	Passphrase Passphrase
	// Account is the signature of the account they are signed in to, if any.
	//
	// Read from a session cookie by the caller and never from the request body:
	// a signature a client could send would be a signature a client could
	// choose, and this one decides whose picture somebody wears.
	Account string
	// TripKey signs passphrases for this deployment.
	TripKey []byte
	// TTL is how long the token stays valid.
	TTL time.Duration
}

// Authorise signs a token for one participant in one room.
//
// The grant is scoped as tightly as the protocol allows: one room, publishing
// and subscribing within it, and nothing about any other room. Admin rights are
// deliberately absent, so a leaked token cannot be used to inspect or close
// anything.
//
// The display name is signed in rather than set by the client after connecting.
// Two things follow: nobody can rename themselves to somebody else mid-call, and
// the name is there in the first roster update, so no one is ever briefly
// labelled with a raw identity.
func Authorise(key, secret string, req Request) (Grant, error) {
	if !ValidName(req.Room) {
		return Grant{}, fmt.Errorf("invalid room name")
	}

	// A signature the caller cannot influence: it comes from their passphrase
	// and this deployment's key, and nothing else.
	trip := ""
	if !req.Passphrase.Empty() {
		trip = Trip(req.TripKey, strings.TrimSpace(string(req.Passphrase)))
	}

	// Kept only when it still matches, so changing or dropping a passphrase
	// takes effect immediately rather than being masked by the identity a client
	// happens to be holding.
	// Signed in beats typed in. Somebody with a session is the account, so the
	// signature comes from the account rather than from whatever was in the
	// passphrase field — which may be empty, because a person who has signed in
	// has no reason to type it again.
	if req.Account != "" {
		trip = req.Account
	}

	identity := req.Identity
	if !ValidIdentity(identity) || provenTrip(identity) != trip ||
		accountMark(identity) != (req.Account != "") {
		if req.Account != "" {
			identity = MintAccountIdentity(trip)
		} else {
			identity = MintIdentity(trip)
		}
	}

	token := auth.NewAccessToken(key, secret).
		SetIdentity(identity).
		SetName(display(req.Display, identity)).
		SetVideoGrant(&auth.VideoGrant{
			RoomJoin:     true,
			Room:         req.Room,
			CanPublish:   ptr(true),
			CanSubscribe: ptr(true),
			// Data messages carry the client's own signalling, which it has no
			// way to send otherwise.
			CanPublishData: ptr(true),

			// Attributes on themselves, and only on themselves.
			//
			// What this is for is the watching list: the media server tells a
			// publisher nothing about who has subscribed to their track, so the
			// only way somebody sharing their screen can be shown who is looking
			// at it is for the people looking to say so. An attribute is the
			// right shape for that — it is state rather than an event, it
			// arrives with the roster for anybody who joins late, and it
			// disappears with the participant who set it, none of which is true
			// of a data message with a heartbeat behind it.
			//
			// The grant is for their own record. It does not admit them to
			// anybody else's, and the media server enforces that rather than
			// this server hoping for it.
			CanUpdateOwnMetadata: ptr(true),
		}).
		SetValidFor(req.TTL)

	signed, err := token.ToJWT()
	if err != nil {
		return Grant{}, fmt.Errorf("sign a join token: %w", err)
	}

	return Grant{Token: signed, Identity: identity}, nil
}

// display cleans up what the caller asked to be called.
//
// Falls back to the identity rather than to an empty label, which would leave a
// tile with nothing under it and no way to tell who it belongs to.
func display(wanted, identity string) string {
	trimmed := strings.TrimSpace(wanted)

	if runes := []rune(trimmed); len(runes) > MaxDisplayName {
		trimmed = strings.TrimSpace(string(runes[:MaxDisplayName]))
	}

	if trimmed == "" {
		return identity
	}

	return trimmed
}

// accountMark says whether an identity was minted for somebody signed in.
//
// Compared at the join so that signing out, or signing in, replaces an identity
// a client is still holding. Without it somebody who signed out would go on
// wearing their account's picture for as long as the tab stayed open.
func accountMark(identity string) bool {
	mark, ok := SignatureOf(identity)

	return ok && mark.Account
}

// provenTrip is the passphrase-derived mark an identity carries, or "" when its
// mark was issued rather than earned.
//
// Used to decide whether an identity a caller sent back still matches the
// passphrase they sent with it. An issued mark never matches, which is what
// makes a fresh one appear whenever somebody arrives without a passphrase.
func provenTrip(identity string) string {
	if mark, ok := SignatureOf(identity); ok && mark.Proven {
		return mark.Trip
	}

	return ""
}

func ptr[T any](value T) *T {
	return &value
}
