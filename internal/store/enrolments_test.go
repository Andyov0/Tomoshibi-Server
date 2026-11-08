package store

import (
	"errors"
	"testing"
	"time"
)

// An enrolment token is the deployment for half an hour, so the store's part
// is that it is used once, not at all after it expires, kept by digest, and
// gone when withdrawn.
func TestAnEnrolmentTokenIsSpentOnce(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	token, err := NewEnrolToken()
	if err != nil {
		t.Fatal(err)
	}

	if _, err := st.KeepEnrolGrant(token, EnrolGrant{Prefix: "tokyo", Expires: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}

	if _, ok := st.EnrolGrant(token, now); !ok {
		t.Fatal("a token just kept cannot be read back")
	}

	grant, err := st.SpendEnrolGrant(token, now)
	if err != nil || grant.Prefix != "tokyo" {
		t.Fatalf("spending answered %+v, %v", grant, err)
	}

	if _, err := st.SpendEnrolGrant(token, now); !errors.Is(err, ErrNoSuchEnrolment) {
		t.Errorf("a token spent once was spent again: %v", err)
	}

	if _, ok := st.EnrolGrant(token, now); ok {
		t.Error("a spent token is still readable")
	}
}

func TestAnExpiredEnrolmentTokenIsNotSpentAndIsCleared(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	stale, _ := NewEnrolToken()
	live, _ := NewEnrolToken()

	if _, err := st.KeepEnrolGrant(stale, EnrolGrant{Prefix: "old", Expires: now.Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.KeepEnrolGrant(live, EnrolGrant{Prefix: "new", Expires: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}

	if _, ok := st.EnrolGrant(stale, now); ok {
		t.Error("an expired token reads as waiting")
	}

	waiting, err := st.EnrolGrants(now)
	if err != nil || len(waiting) != 1 || waiting[0].Prefix != "new" {
		t.Fatalf("the list is %+v, %v", waiting, err)
	}

	if _, err := st.SpendEnrolGrant(stale, now); !errors.Is(err, ErrNoSuchEnrolment) {
		t.Errorf("an expired token was spent: %v", err)
	}

	found, err := st.WithdrawEnrolGrant(waiting[0].ID)
	if err != nil || !found {
		t.Fatalf("withdrawing answered %v, %v", found, err)
	}

	if _, err := st.SpendEnrolGrant(live, now); !errors.Is(err, ErrNoSuchEnrolment) {
		t.Errorf("a withdrawn token was spent: %v", err)
	}
}
