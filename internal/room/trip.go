package room

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TripLength is how many characters of the digest a signature shows.
//
// Ten base32 characters is fifty bits, which is far past what an online guess
// can reach through a rate limiter. It is also short enough to read out loud,
// which is the point of showing it at all.
const TripLength = 10

// Every identity carries a signature. What differs is where it came from, and
// the prefix is what says which — read without parsing and, more importantly,
// impossible for its bearer to choose, since the whole identity is signed into
// the token.
//
// A signature nobody can tell apart from a proven one is worth nothing: an
// impostor would simply point at their own and claim it. So the two are
// different kinds rather than the same field with different provenance.
const (
	// proven: derived from a passphrase, so it is the same on every visit and
	// only its holder can produce it.
	proven = "t"

	// issued: derived from nothing, fresh each time. It tells two people with
	// one name apart for the length of a call and claims nothing beyond that.
	issued = "g"

	// held: the same signature, reached by signing in to an account rather than
	// by typing a passphrase at the door.
	//
	// The two are the same person and the same mark — signing in derives the
	// signature the same way — so this is not a stronger claim about who
	// somebody is. What it is is a claim about how they arrived, and the one
	// thing that turns on it is whether the picture they chose is shown: an
	// account's picture belongs to the account, and showing it for anybody who
	// happened to type the right passphrase into a join form would make the
	// picture a second, weaker credential.
	held = "a"
)

// tripAlphabet is lowercase base32 without padding.
//
// Lowercase because the identity travels in a room path and is read aloud;
// base32 rather than base64 because it has no characters that need escaping and
// none that look like each other in most typefaces.
var tripAlphabet = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// Trip derives the signature for a passphrase.
//
// Keyed rather than a bare hash, which is the whole difference between this and
// the tripcodes it borrows from: without the key a signature cannot be attacked
// offline at all, so the only way to find a passphrase is to guess it through
// the join endpoint, where the rate limiter is waiting. A bare hash would be a
// dictionary attack somebody could run on their own hardware.
func Trip(key []byte, passphrase string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(passphrase))

	return tripAlphabet.EncodeToString(mac.Sum(nil))[:TripLength]
}

// IssueTrip returns a mark for somebody who gave no passphrase.
//
// Drawn from the same alphabet and the same length as an earned one, so a
// roster reads as one column rather than two, and so nobody has to know which
// kind they are looking at to read it aloud. What separates them is the prefix
// on the identity, which its bearer cannot choose.
func IssueTrip() string {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// predictable mark is worse than not starting.
		panic(fmt.Sprintf("read random bytes: %v", err))
	}

	return tripAlphabet.EncodeToString(raw)[:TripLength]
}

// NewPassphrase makes one nobody will guess.
//
// Generated rather than chosen, and that distinction is the whole of the
// difference between a signature worth trusting and one that is not. A
// signature cannot be attacked offline without this deployment's key, so the
// only way at it is through the join endpoint — where the rate limiter stands.
// But the limiter counts per address, and an attacker with a thousand of them
// has a thousand budgets. Against fifty bits that is still nothing; against a
// passphrase somebody thought of, it is about a quarter of an hour.
//
// Ten words from the alphabet below is fifty bits, matched to the signature they
// produce: making the passphrase stronger than its own output would be effort
// spent past the point where anything improves.
func NewPassphrase() string {
	// Seven bytes encode to twelve characters; the first ten are the fifty bits
	// wanted, and the remainder is discarded rather than rounded into.
	raw := make([]byte, 7)
	if _, err := rand.Read(raw); err != nil {
		panic(fmt.Sprintf("read random bytes: %v", err))
	}

	letters := tripAlphabet.EncodeToString(raw)[:TripLength]

	// Grouped, because this is read off one screen and typed into another, and
	// an unbroken run of ten characters is where a person loses their place.
	var out strings.Builder
	for i := 0; i < len(letters); i += 5 {
		if i > 0 {
			out.WriteByte('-')
		}
		out.WriteString(letters[i : i+5])
	}

	return out.String()
}

// Signature is the mark an identity carries.
type Signature struct {
	// Trip is the mark itself.
	Trip string
	// Proven says it came from a passphrase rather than from nothing, which is
	// the difference between "this is the same person as last time" and "these
	// two people in this room are not the same person".
	Proven bool

	// Account says they were signed in to one when they joined.
	//
	// Implies Proven and is not a stronger statement of identity: the signature
	// is derived the same way either way. It records how they arrived, which is
	// what decides whether the picture on their account is theirs to wear here.
	Account bool
}

// SignatureOf reads the mark out of an identity.
//
// Read from the identity rather than sent alongside it, because the identity is
// signed into the token and the media server enforces it. Anything travelling
// beside it would be a claim, and a claim is exactly what a signature exists to
// replace.
func SignatureOf(identity string) (Signature, bool) {
	if len(identity) < 1+TripLength+1 || identity[1+TripLength] != '-' {
		return Signature{}, false
	}

	kind := identity[:1]
	if kind != proven && kind != issued && kind != held {
		return Signature{}, false
	}

	return Signature{
		Trip:    identity[1 : 1+TripLength],
		Proven:  kind == proven || kind == held,
		Account: kind == held,
	}, true
}

// LoadTripKey reads the signing key for tripcodes, creating one if absent.
//
// Its own file rather than sharing the API credentials, because the two have
// opposite lifetimes: API credentials should be rotated, and rotating this one
// silently changes everybody's signature, which is the one thing a signature
// must never do. Keeping them apart means neither rotation can take the other
// with it.
//
// Created exclusively, so several processes starting at once settle on one file
// rather than racing to overwrite each other, and read-only to its owner where
// the platform has an opinion.
func LoadTripKey(path string) ([]byte, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	switch {
	case err == nil:
		defer file.Close()

		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("read random bytes: %w", err)
		}

		if _, err := file.Write([]byte(tripAlphabet.EncodeToString(key))); err != nil {
			return nil, fmt.Errorf("write %s: %w", path, err)
		}

		return key, nil

	case os.IsExist(err):
		stored, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}

		key, err := tripAlphabet.DecodeString(strings.TrimSpace(string(stored)))
		if err != nil {
			return nil, fmt.Errorf(
				"%s does not hold a key this build can read. Delete it to start over, "+
					"accepting that every existing signature changes", path)
		}

		return key, nil

	default:
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
}

// Passphrase is a secret whose value must never be written down.
//
// A named type with its own String and formatting, so that logging a request
// that carries one cannot leak it: the redaction lives on the value rather than
// depending on every call site remembering.
type Passphrase string

// String hides the value.
func (p Passphrase) String() string {
	if p == "" {
		return ""
	}
	return "[redacted]"
}

// GoString hides the value from %#v as well as %v.
func (p Passphrase) GoString() string {
	return p.String()
}

// Empty reports whether there is no passphrase, without revealing one.
func (p Passphrase) Empty() bool {
	return strings.TrimSpace(string(p)) == ""
}
