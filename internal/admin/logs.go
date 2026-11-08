package admin

import (
	"net/http"
	"strconv"

	"tomoshibi/internal/logring"
)

/*
The log, on a page, and what the apps are offered.

The log is read from the ring the process log is copied into
(internal/logring) and from nothing else: not the store, not the media server,
not a relay. That is the whole of the design. The page exists for the moment
one of those is failing, and the owner's complaint about the pages it replaces
was that at exactly that moment they would not open; a handler that asked the
store for anything would be one more page that went down with the thing it was
meant to report on. Behind the same session as the rest, and observe's, since
every administrator may see everything.
*/

// logShown is the most lines one request returns. A page polls for what came
// after the last line it has, so this bounds the first answer and the one after
// a long absence, not the steady state.
const logShown = 500

func (a *API) readLog(_ Session, w http.ResponseWriter, r *http.Request) {
	ring := a.ring
	if ring == nil {
		ring = logring.Recent
	}

	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)

	lines, missed := ring.After(after, logShown)
	if lines == nil {
		lines = []logring.Line{}
	}

	answer := map[string]any{"lines": lines, "started": Started.UTC()}
	if missed {
		answer["missed"] = true
	}

	respond(w, answer)
}

// Offered is one platform's newest app, as the apps and the download page are
// told of it.
type Offered struct {
	Platform  string `json:"platform"`
	Version   string `json:"version,omitempty"`
	Available bool   `json:"available"`
	Size      int64  `json:"size,omitempty"`
}

// Shelf says which version of each app this deployment hands out. It is the
// application's (internal/app/apps.go), which reads the manifest beside the
// builds; the pages are only shown it.
type Shelf interface {
	// Offered is each platform in a fixed order, and whether a directory is
	// configured at all.
	Offered() ([]Offered, bool)
}

// UseShelf lets the pages say which app versions are being handed out.
func (a *API) UseShelf(shelf Shelf) {
	if a == nil {
		return
	}

	a.shelf = shelf
}

func (a *API) readApps(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.shelf == nil {
		respond(w, map[string]any{"configured": false, "platforms": []Offered{}})
		return
	}

	platforms, configured := a.shelf.Offered()
	if platforms == nil {
		platforms = []Offered{}
	}

	respond(w, map[string]any{"configured": configured, "platforms": platforms})
}
