package store

import (
	"testing"
	"time"

	"tomoshibi/internal/room"
)

/*
What somebody joins from, read back per person.

Read from the joins, which are kept per room, so the faults here are all quiet
ones. A phone that updated its app between two calls counted as two phones
would make a list of one person's devices read as a household's; the oldest
use of a device winning over the newest would put last month's room beside a
phone used this morning; and a guest counted at all would give a stranger's
browser to whoever happened to share nothing with them but the empty mark.
*/

func TestDevicesAreReadPerPersonNewestFirstAndOnceEach(t *testing.T) {
	st := open(t)

	trip := room.Trip([]byte("0123456789abcdef0123456789abcdef"), "ada's passphrase")
	ada := "a" + trip + "-0123456789abcdef"
	guest := "g" + trip[:9] + "x-0123456789abcdef"

	base := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	phone := func(version string) *Client {
		return &Client{Kind: "iphone", App: version, System: "iOS 27.0.1", Device: "iPhone17,1"}
	}
	laptop := &Client{Kind: "web", Browser: "Chrome 141", System: "macOS"}

	joins := []struct {
		room     string
		identity string
		client   *Client
		at       time.Time
	}{
		{"standup", ada, phone("0.1.2.3"), base},
		{"standup", ada, laptop, base.Add(time.Hour)},
		// The same phone a day later, after the app updated itself.
		{"retro", ada, phone("0.1.2.4"), base.Add(24 * time.Hour)},
		// A join from before devices were kept, which says nothing.
		{"retro", ada, nil, base.Add(25 * time.Hour)},
		{"retro", guest, &Client{Kind: "web", Browser: "Firefox 140", System: "Windows"}, base.Add(26 * time.Hour)},
	}
	for _, one := range joins {
		if err := st.Arrived(one.room, one.identity, Arrival{Client: one.client, At: one.at}); err != nil {
			t.Fatal(err)
		}
	}

	seen := st.Devices(5)

	got := seen[trip]
	if len(got) != 2 {
		t.Fatalf("ada has %d devices, want the phone and the laptop: %+v", len(got), got)
	}
	if got[0].Client.Kind != "iphone" || got[0].Client.App != "0.1.2.4" || got[0].Room != "retro" {
		t.Errorf("the newest is %+v, want the phone as it was used last, in retro", got[0])
	}
	if got[1].Client.Browser != "Chrome 141" || !got[1].At.Equal(base.Add(time.Hour)) {
		t.Errorf("the second is %+v, want the laptop", got[1])
	}

	for mark, devices := range seen {
		if mark != trip {
			t.Errorf("%d devices were kept against %q, which is a guest's mark", len(devices), mark)
		}
	}

	if one := st.Devices(1)[trip]; len(one) != 1 || one[0].Client.Kind != "iphone" {
		t.Errorf("asked for one, got %+v", one)
	}
}
