// A stand-in for App Store Connect, for trying the TestFlight invitation on a
// laptop.
//
// The invitation cannot be tried against Apple without a real key, a real app
// and a real person's inbox, and every attempt is a tester counted against the
// app and a mail sent in its name. This answers the four requests an invitation
// makes, the way Apple's documentation says Apple does, and checks every token
// it is handed against the public half of the key — header, claims, and an
// ES256 signature in the r||s form JWS asks for — so that a run against it says
// whether the token would be accepted as well as whether the page reads the
// answers.
//
// The address decides what Apple "says", so that each of the page's sentences
// can be reached by typing:
//
//	…+known@…     Apple already has this tester in the group (409, then found)
//	…+elsewhere@… Apple has the tester, in another group (409, then added)
//	…+refuse@…    Apple refuses (403)
//	anything else a new tester (201); typed a second time, the first case
//
// Run it, and a server built with the ascstub tag pointed at it:
//
//	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
//	  -pkeyopt ec_param_enc:named_curve -out /tmp/asc.p8
//	go run ./dev/ascstub /tmp/asc.p8 127.0.0.1:18990
//	go build -tags ascstub -o /tmp/tomoshibi-stub . &&
//	  TOMOSHIBI_ASC_STUB=http://127.0.0.1:18990 /tmp/tomoshibi-stub serve <config>
//
// The second -pkeyopt is not optional on a Mac. The openssl macOS ships is
// LibreSSL, which writes the curve out as explicit parameters unless told to
// name it; Apple's keys name it, Go refuses the other kind as an unknown curve,
// and the startup check then refuses the throwaway key exactly as it would a
// real one that was damaged. Found the first time this was run.
//
// Never point it at anything but a server built for it. A release build cannot
// be pointed at it at all; see internal/testflight/stub.go.
package main

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/testflight"
)

type stand struct {
	key *ecdsa.PublicKey

	mu      sync.Mutex
	testers map[string]string
	inGroup map[string]bool
	next    int
}

func main() {
	if len(os.Args) != 3 {
		fmt.Println("usage: ascstub <key.p8> <listen address>")
		os.Exit(2)
	}

	key, err := testflight.ReadKey(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}

	s := &stand{key: &key.PublicKey, testers: map[string]string{}, inGroup: map[string]bool{}}

	log.Printf("playing App Store Connect on http://%s", os.Args[2])
	log.Fatal(http.ListenAndServe(os.Args[2], s))
}

func (s *stand) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if problem := s.verify(r.Header.Get("Authorization")); problem != "" {
		log.Printf("%s %s refused: %s", r.Method, r.URL.Path, problem)
		answer(w, http.StatusUnauthorized, `{"errors":[{"code":"NOT_AUTHORIZED"}]}`)
		return
	}

	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/betaTesters":
		var body struct {
			Data struct {
				Attributes struct {
					Email string `json:"email"`
				} `json:"attributes"`
				Relationships struct {
					BetaGroups struct {
						Data []struct {
							ID string `json:"id"`
						} `json:"data"`
					} `json:"betaGroups"`
				} `json:"relationships"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		email := body.Data.Attributes.Email
		groups := body.Data.Relationships.BetaGroups.Data
		log.Printf("POST /v1/betaTesters  token ok, group %v, address %s", groups, testflight.Masked(email))

		switch {
		case strings.Contains(email, "+refuse@"):
			answer(w, http.StatusForbidden, `{"errors":[{"code":"FORBIDDEN_ERROR"}]}`)
			return

		case strings.Contains(email, "+known@"):
			s.remember(email, true)
		case strings.Contains(email, "+elsewhere@"):
			s.remember(email, false)
		}

		if _, known := s.testers[email]; known {
			answer(w, http.StatusConflict, `{"errors":[{"code":"ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE"}]}`)
			return
		}

		s.remember(email, true)
		answer(w, http.StatusCreated, `{"data":{"type":"betaTesters","id":"`+s.testers[email]+`"}}`)

	case r.Method == http.MethodGet && r.URL.Path == "/v1/betaTesters":
		email := r.URL.Query().Get("filter[email]")
		inGroup := r.URL.Query().Get("filter[betaGroups]") != ""
		log.Printf("GET /v1/betaTesters  token ok, in group asked %v, address %s", inGroup, testflight.Masked(email))

		id, known := s.testers[email]
		if !known || (inGroup && !s.inGroup[email]) {
			answer(w, http.StatusOK, `{"data":[]}`)
			return
		}

		answer(w, http.StatusOK, `{"data":[{"type":"betaTesters","id":"`+id+`"}]}`)

	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/betaGroups/") &&
		strings.HasSuffix(r.URL.Path, "/relationships/betaTesters"):
		var body struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		log.Printf("POST %s  token ok, testers %v", r.URL.Path, body.Data)

		for email, id := range s.testers {
			for _, added := range body.Data {
				if added.ID == id {
					s.inGroup[email] = true
				}
			}
		}

		w.WriteHeader(http.StatusNoContent)

	default:
		log.Printf("%s %s is not something an invitation asks for", r.Method, r.URL.Path)
		answer(w, http.StatusNotFound, `{"errors":[{"code":"NOT_FOUND"}]}`)
	}
}

func (s *stand) remember(email string, inGroup bool) {
	if _, known := s.testers[email]; known {
		return
	}

	s.next++
	s.testers[email] = fmt.Sprintf("tester-%d", s.next)
	s.inGroup[email] = inGroup
}

// verify checks a bearer token as App Store Connect would, and says what is
// wrong with it, or nothing.
func (s *stand) verify(authorization string) string {
	token, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok {
		return "no bearer token"
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Sprintf("%d parts, not three", len(parts))
	}

	var header map[string]string
	if raw, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil || json.Unmarshal(raw, &header) != nil {
		return "the header is not base64url JSON"
	}
	if header["alg"] != "ES256" || header["typ"] != "JWT" || header["kid"] == "" {
		return fmt.Sprintf("the header is %v", header)
	}

	var claims struct {
		Iss string `json:"iss"`
		Iat int64  `json:"iat"`
		Exp int64  `json:"exp"`
		Aud string `json:"aud"`
	}
	if raw, err := base64.RawURLEncoding.DecodeString(parts[1]); err != nil || json.Unmarshal(raw, &claims) != nil {
		return "the claims are not base64url JSON"
	}

	now := time.Now().Unix()
	switch {
	case claims.Aud != "appstoreconnect-v1":
		return fmt.Sprintf("the audience is %q", claims.Aud)
	case claims.Iss == "":
		return "no issuer"
	case claims.Exp <= now:
		return "expired"
	case claims.Exp-claims.Iat > 20*60:
		return "lives longer than twenty minutes"
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != 64 {
		return fmt.Sprintf("the signature is %d bytes, not r and s at 32 each", len(signature))
	}

	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(s.key, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		return "the signature does not verify"
	}

	return ""
}

func answer(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
