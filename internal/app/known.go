package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"time"
)

/*
A passphrase this browser has joined with before.

The join charges a wrong passphrase to a budget with a ceiling, because the join
answers whether a passphrase is an administrator's or an account's. But most
passphrases at the join are not guesses: the field is filled from local storage
on every visit, so the same person brings the same passphrase every time, and
counting each of those as a failure is what let a busy hour lock the door.

So a join that succeeded with a passphrase leaves a cookie holding a MAC of its
signature, and a later join from the same browser with the same passphrase is
not asked about. That is safe because of what the cookie can be used for: it
skips the budget only for the passphrase it was made from, and only a browser
that already joined with that passphrase has it. Nothing is learnt by skipping
the budget for an answer one already holds.

HttpOnly, SameSite=Strict, and scoped to the join's own path, so no script and
no other site's request carries it. Keyed from the tripcode key, which no relay
holds, and kept apart from it by a label so it is never a signature.
*/

const (
	knownCookie = "meet-live.known"
	knownFor    = 365 * 24 * time.Hour
)

func (a *App) knownMark(trip string) string {
	mac := hmac.New(sha256.New, a.tripKey)
	mac.Write([]byte("tomoshibi known passphrase v1\x00" + trip))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:18])
}

// knownHere reports whether this browser has joined with the passphrase whose
// signature this is.
func (a *App) knownHere(r *http.Request, trip string) bool {
	if len(a.tripKey) == 0 || trip == "" {
		return false
	}

	cookie, err := r.Cookie(knownCookie)
	if err != nil {
		return false
	}

	return hmac.Equal([]byte(cookie.Value), []byte(a.knownMark(trip)))
}

// rememberHere leaves the cookie after a join with a passphrase.
func (a *App) rememberHere(w http.ResponseWriter, r *http.Request, trip string) {
	if len(a.tripKey) == 0 || trip == "" {
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     knownCookie,
		Value:    a.knownMark(trip),
		Path:     "/api/rooms/",
		HttpOnly: true,
		Secure:   r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https",
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(knownFor.Seconds()),
	})
}
