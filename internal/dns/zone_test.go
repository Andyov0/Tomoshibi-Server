package dns

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

/*
A zone shared with other services, and the two writes that act on it.

The token reaches the whole zone, so what limits the damage is this code. These
stand a fake Cloudflare up with records somebody else made beside the ones this
deployment made, and hold that an enrolment and a removal touch only the second
kind, only under the enrolment domain, and never the control node's own name.
*/

type zone struct {
	mu      sync.Mutex
	records map[string]cfRecord
	next    int
	writes  []string
}

func (z *zone) serve(t *testing.T) *httptest.Server {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		z.mu.Lock()
		defer z.mu.Unlock()

		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]

		switch r.Method {
		case http.MethodGet:
			var found []cfRecord
			for _, record := range z.records {
				if record.Name == r.URL.Query().Get("name") && record.Type == r.URL.Query().Get("type") {
					found = append(found, record)
				}
			}
			_ = json.NewEncoder(w).Encode(cfReply{Success: true, Result: found})
			return

		case http.MethodPost:
			var record cfRecord
			_ = json.NewDecoder(r.Body).Decode(&record)
			z.next++
			record.ID = "new" + string(rune('0'+z.next))
			z.records[record.ID] = record

		case http.MethodPatch:
			var record cfRecord
			_ = json.NewDecoder(r.Body).Decode(&record)
			record.ID = id
			z.records[id] = record

		case http.MethodDelete:
			delete(z.records, id)
		}

		z.writes = append(z.writes, r.Method+" "+id)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(server.Close)

	return server
}

func zoneWith(t *testing.T, records ...cfRecord) (*Cloudflare, *zone) {
	t.Helper()

	z := &zone{records: map[string]cfRecord{}}
	for _, record := range records {
		z.records[record.ID] = record
	}

	cf := NewCloudflare("token", "zone").Within("relay.example.com", "meet.relay.example.com")
	cf.base = z.serve(t).URL

	return cf, z
}

var (
	ourTokyo   = cfRecord{ID: "a", Type: "A", Name: "tokyo.relay.example.com", Content: "198.51.100.1", Comment: Marker + " Media reaches it directly."}
	theirMail  = cfRecord{ID: "b", Type: "A", Name: "mail.relay.example.com", Content: "198.51.100.2", Comment: "mail server"}
	theirBlank = cfRecord{ID: "c", Type: "A", Name: "osaka.relay.example.com", Content: "198.51.100.3"}
)

func TestARecordSomebodyElseMadeIsNotWrittenOver(t *testing.T) {
	cf, z := zoneWith(t, ourTokyo, theirMail, theirBlank)

	for _, host := range []string{"mail.relay.example.com", "osaka.relay.example.com"} {
		if err := cf.Point(host, "203.0.113.9"); !errors.Is(err, ErrNotOurs) {
			t.Errorf("pointing %s over a record this deployment did not make answered %v", host, err)
		}
	}

	if got := z.records["b"].Content; got != "198.51.100.2" {
		t.Errorf("another service's record now points at %s", got)
	}

	// And its own record is still its own to move.
	if err := cf.Point("tokyo.relay.example.com", "203.0.113.9"); err != nil {
		t.Fatalf("moving this deployment's own record failed: %v", err)
	}

	if got := z.records["a"].Content; got != "203.0.113.9" {
		t.Errorf("this deployment's record points at %s after it was moved", got)
	}
}

func TestOnlyThisDeploymentsRecordsAreRemoved(t *testing.T) {
	cf, z := zoneWith(t, ourTokyo, theirMail,
		cfRecord{ID: "d", Type: "A", Name: "tokyo.relay.example.com", Content: "198.51.100.4", Comment: "somebody's"})

	if err := cf.Unpoint("tokyo.relay.example.com"); !errors.Is(err, ErrNotOurs) {
		t.Errorf("removing a name with somebody else's record beside ours answered %v", err)
	}

	if _, still := z.records["a"]; still {
		t.Error("this deployment's own record was not removed")
	}

	if _, still := z.records["d"]; !still {
		t.Error("somebody else's record at the same name was removed")
	}

	if err := cf.Unpoint("mail.relay.example.com"); !errors.Is(err, ErrNotOurs) {
		t.Errorf("removing another service's name answered %v", err)
	}

	if _, still := z.records["b"]; !still {
		t.Error("another service's record was removed")
	}
}

func TestNothingOutsideTheEnrolmentDomainIsWritten(t *testing.T) {
	cf, z := zoneWith(t, ourTokyo)

	for _, host := range []string{
		"example.com", "relay.example.com", "mail.example.com", "a.b.relay.example.com",
		"tokyo.relay.example.com.evil.example", "meet.relay.example.com", "",
	} {
		if err := cf.Point(host, "203.0.113.9"); !errors.Is(err, ErrOutsideDomain) {
			t.Errorf("pointing %q answered %v, want a refusal", host, err)
		}

		if err := cf.Unpoint(host); !errors.Is(err, ErrOutsideDomain) {
			t.Errorf("removing %q answered %v, want a refusal", host, err)
		}
	}

	if len(z.writes) != 0 {
		t.Errorf("refused names reached the zone: %v", z.writes)
	}
}

func TestAnEnrolmentDomainAtTheControlNodesOwnLevelClashes(t *testing.T) {
	for _, tc := range []struct {
		domain, control string
		clash           bool
	}{
		{"example.com", "meet.example.com", true},
		{"meet.example.com", "meet.example.com", true},
		{"Example.COM.", "meet.example.com", true},
		{"relay.example.com", "meet.example.com", false},
		{"example.com", "a.meet.example.com", false},
		{"example.com", "", false},
	} {
		if got := Clashes(tc.domain, tc.control); got != tc.clash {
			t.Errorf("Clashes(%q, %q) = %v, want %v", tc.domain, tc.control, got, tc.clash)
		}
	}
}
