// Package room turns a requested name into an authorisation to join it.
//
// There is no room object anywhere on the server and no membership table. A room
// exists because somebody named it, and stops existing when the last participant
// leaves. What this package produces is a signed statement that the bearer may
// join one particular room under one particular identity, and nothing else.
package room

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
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
	// Proof is what the client must send back with an issued identity for it
	// to be kept: see GuestProof. Empty for the other kinds.
	Proof string
}

// Request is what a caller asks to be authorised for.
type Request struct {
	// Room is the name they want to join.
	Room string
	// Identity they were given previously, if any.
	Identity string
	// IdentityProof is what they were given with it, where it was issued.
	IdentityProof string
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
// The display name is signed in rather than set by the client after connecting,
// so the name is there in the first roster update and no one is ever briefly
// labelled with a raw identity. It is not, as this comment once said, beyond
// changing mid-call: see the attributes grant below.
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
	keep := ValidIdentity(identity) && provenTrip(identity) == trip &&
		accountMark(identity) == (req.Account != "")

	// An issued identity is kept only for the tab it was issued to.
	//
	// Nothing else about it is a secret: the whole identity is on every roster
	// in the room. So anybody in the call could send a guest's identity back as
	// their own, and the media server, finding the identity already present,
	// removed the guest and seated the copy — same name, same mark, same
	// picture. The two could evict each other indefinitely, the host's
	// "remove" put the guest back for whoever rejoined next, and a pin an
	// administrator set for the guest went to whoever arrived first. A
	// passphrase or a session guards the other two kinds; this proof, handed
	// to the tab beside the identity and never shown to anybody else, guards
	// this one. Without it the identity is re-issued rather than refused, which
	// costs a reload a fresh mark and costs a copy everything.
	if keep && trip == "" {
		want := GuestProof(req.TripKey, identity)
		keep = want != "" && hmac.Equal([]byte(req.IdentityProof), []byte(want))
	}

	if !keep {
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
			//
			// What it does admit them to is their own name: the media server
			// has one permission for name, metadata and attributes together,
			// so whoever may raise a hand may also rename themselves mid-call,
			// to anything, past the forty characters the join allows. Kept
			// anyway, for now. The hand and the watching list are set this way
			// by the browser and by every app already installed, and taking
			// the grant away would silently stop both on every one of those
			// until each moved to a server endpoint that writes the attributes
			// with RoomAdmin. Filtering renames out of the signalling instead
			// would mean decoding the media server's compressed WebSocket
			// frames in the relay's proxy, on the path every call depends on.
			// What the room does about a rename meanwhile is say so: the web's
			// impersonation mark compares names as they read (live/name.ts).
			CanUpdateOwnMetadata: ptr(true),
		})

	signed, err := sign(key, secret, token.GetGrants(), req.TTL, req.TripKey)
	if err != nil {
		return Grant{}, fmt.Errorf("sign a join token: %w", err)
	}

	grant := Grant{Token: signed, Identity: identity}
	if trip == "" {
		grant.Proof = GuestProof(req.TripKey, identity)
	}

	return grant, nil
}

// GuestProof is the proof that goes with an issued identity: a MAC of it under
// a key from the tripcode key, which is this node's alone. Empty where there is
// no key, which keeps nothing.
func GuestProof(tripKey []byte, identity string) string {
	if len(tripKey) == 0 {
		return ""
	}

	mac := hmac.New(sha256.New, tripKey)
	mac.Write([]byte("tomoshibi issued identity v1\x00" + identity))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:18])
}

/*
The control node's own mark on a join token.

A join token is signed with the deployment's API key pair, and every relay holds
that pair, because every relay has to verify the tokens clients bring it. So a
relay can sign a token too, and the control node's host endpoints — close a
room, remove somebody, move a meeting, mint a standing invitation into a scoped
room — used to accept any token that verified. One relay broken into, in a
place where the machine is rented from somebody else, was therefore every
host's and every scope member's authority on every room, by writing their
identity (shown beside their name in every call) into a token of its own.

The proof is what tells this node's tokens from anybody else's: an HMAC over the
identity, the room and the expiry, keyed from the tripcode key, which never
leaves the control node. It travels as the token's `jti`, which the media
server ignores — it reads a JWT ID only where there is no subject, and a join
always has one — so clients, relays and the media server are untouched, and
tokens minted before this existed simply carry none and are refused by the host
endpoints for the five minutes they had left anyway.

Per-relay key pairs were the other way to close this, and do not: the cluster
trusts redis rather than keys between its nodes, so a relay holding only its own
pair still reaches every room through the bus. RELAY.md has the argument.
*/

// proofKey is the key proofs are made with, kept apart from the tripcode key it
// comes from so that a proof can never be mistaken for a signature.
func proofKey(tripKey []byte) []byte {
	mac := hmac.New(sha256.New, tripKey)
	mac.Write([]byte("tomoshibi join token proof v1"))

	return mac.Sum(nil)
}

func proof(tripKey []byte, identity, room string, expires int64) string {
	mac := hmac.New(sha256.New, proofKey(tripKey))
	fmt.Fprintf(mac, "%s\x00%s\x00%d", identity, room, expires)

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:18])
}

// Vouched reports whether a token's JWT ID is the proof this node would have
// written for that identity, room and expiry: whether this node minted it.
func Vouched(tripKey []byte, identity, room string, expires time.Time, id string) bool {
	if len(tripKey) == 0 || id == "" || expires.IsZero() {
		return false
	}

	return hmac.Equal([]byte(id), []byte(proof(tripKey, identity, room, expires.Unix())))
}

// joinClaims is the token's body, laid out as the media server's own library
// lays it out — the registered claims and the grants side by side — with the
// proof as its JWT ID.
type joinClaims struct {
	jwt.RegisteredClaims
	auth.ClaimGrants
}

// sign is the media server library's ToJWT, with the proof added.
//
// Rewritten rather than wrapped because the library offers no way to set a JWT
// ID. The layout is the library's, field for field, and a test decodes a token
// from here with the library's own verifier.
func sign(key, secret string, grants *auth.ClaimGrants, ttl time.Duration, tripKey []byte) (string, error) {
	if key == "" || secret == "" {
		return "", auth.ErrKeysMissing
	}

	// The library's default, for a caller that asks for nothing.
	if ttl <= 0 {
		ttl = 6 * time.Hour
	}

	now := time.Now()
	expires := jwt.NewNumericDate(now.Add(ttl))

	claims := joinClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    key,
			Subject:   grants.Identity,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: expires,
		},
		ClaimGrants: *grants,
	}

	if len(tripKey) > 0 {
		claims.ID = proof(tripKey, grants.Identity, grants.Video.Room, expires.Unix())
	}

	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
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

// Presented is what a join token says, once its signature and this node's
// proof have been checked and its expiry has not.
type Presented struct {
	Identity string
	Room     string
	Issued   time.Time
	Expires  time.Time
}

// Present reads a join token this node minted: signed with the key pair, and
// carrying the proof only this node can write. The expiry is reported rather
// than enforced, because one caller has a reason to accept a token past it (see
// the host endpoints in internal/app/host.go) and decides that for itself.
func Present(raw, key, secret string, tripKey []byte) (Presented, bool) {
	claims := &joinClaims{}

	token, err := jwt.ParseWithClaims(raw, claims,
		func(*jwt.Token) (any, error) { return []byte(secret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithoutClaimsValidation(),
	)
	if err != nil || !token.Valid || claims.Issuer != key || claims.ExpiresAt == nil || claims.Video == nil {
		return Presented{}, false
	}

	identity := claims.Subject
	if identity == "" {
		identity = claims.ClaimGrants.Identity
	}

	if !Vouched(tripKey, identity, claims.Video.Room, claims.ExpiresAt.Time, claims.ID) {
		return Presented{}, false
	}

	presented := Presented{Identity: identity, Room: claims.Video.Room, Expires: claims.ExpiresAt.Time}
	if claims.IssuedAt != nil {
		presented.Issued = claims.IssuedAt.Time
	}

	return presented, true
}
