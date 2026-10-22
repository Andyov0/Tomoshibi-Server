// Package remote is the file that changes what the apps say and do without a
// release of them.
package remote

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

/*
What the apps are told from here, and why it is a file.

A small change to an app used to be a release of it on four platforms: a build
through Apple's review and TestFlight, an Android package, a Windows installer
and a Mac disk image, all for a sentence worded badly or a feature that needed
turning off on one platform until its fix was out. The owner decided
(2026-10-22) that four kinds of thing are said by the server instead, and the
apps, which share one core, ask for them, keep the last answer on the device,
and use that answer when they cannot reach this server:

  - phrases: a translation the apps' own dictionaries hold, replaced. Keyed by
    the English sentence, as those dictionaries are, and the same for every app.
  - switches: features turned off, on some platforms or some versions of the
    app, and on again in a narrower case.
  - params: a handful of numbers the apps would otherwise have compiled in.
  - notice: one notice in the lobby, in the apps' four languages, until a time
    or until it is taken down.

The file is remote.json, beside the apps' manifest (internal/app/apps.go), and
read on every request in the same way and for the same reason: a change is the
file rewritten, and the server is not restarted for it.

	{"phrases":  {"<the English>": {"zh-Hans": "…", "zh-Hant": "…", "ja": "…", "en": "…"}},
	 "switches": [{"feature": "screen-share", "off": true, "platforms": ["android"],
	               "from": "0.1.4", "below": "0.1.5", "note": "why it is off"}],
	 "params":   [{"name": "screen_share_max_fps", "value": 30, "platforms": ["android"]}],
	 "notice":   {"id": "2026-10-22-1", "level": "info", "until": "2026-10-23T12:00:00Z",
	              "text": {"zh-Hans": "…", "zh-Hant": "…", "ja": "…", "en": "…"}}}

The features a switch is written for are screen-share (sharing a screen),
background-blur, watch-together, music (the jukebox) and app-updates (the apps
offering their own next version), and the numbers a param is written for are
screen_share_max_fps, screen_share_max_height (pixels), screen_share_hot_fps
(the frame rate a hot device falls back to, nought for none) and
update_check_hours. A name outside those lists is sent all the same, since an
app newer than this server may know it; the management pages offer only these.

How many times a relay is measured before one is chosen is not among them, and
is not to be added: the browser client measures by the same rule
(web/src/live/relays.ts), and a number only the apps could be told would have
the apps and the browser choosing relays differently.

A rule's platforms are the kinds the apps' user agents are read as
(internal/app/device.go): mac, iphone, ipad, android and windows, with ios for
the last two of Apple's together; none at all is every platform. Its from and
below are versions, compared as the update check compares them, and a rule
holds for an app whose version is from or later and earlier than below. Where
two rules name one feature or one number, the later one in the list wins, which
is how a feature turned off for a run of versions is turned back on for one.

The file is read in pieces, as the manifest is, and for a stronger reason. A
section written wrongly costs that section, and a rule or a phrase written
wrongly costs that rule or phrase; never the others, and never the answer. An
app that is refused keeps what it was told last, which sounds harmless, but a
missing comma in a phrase would then hold back the notice an operator had just
published beside it, and an urgent notice is the case this exists for.

Three things that would otherwise read wrongly are refused rather than guessed
at, because each would widen a rule rather than narrow it. A platform this
server does not know, "andriod", would leave a rule with no platform it could
match; read as no platforms, which is every platform, it would turn a feature
off for everybody. A field it does not know, "platfroms", is the same mistake
one level up, so a rule is read with nothing in it but what it is known to
mean. And a version that is not one takes its rule away with it, rather than
the rule holding for every version.

The management pages write two of the sections, the notice and the switches,
and leave the other two to whoever edits the file. A page replaces its own
section and keeps the rest of the file as it was written, byte for byte,
spacing included, so that publishing a notice does not reformat five thousand
phrases somebody laid out by hand. It writes a new file and renames it over the
old, so that an app asking in the middle reads the file before or after and
never half of one. And it refuses to write over a file that is not JSON at all,
since there is then no telling the sections apart, and writing a notice would
throw away whatever an operator was half way through.
*/

// Name is the file's own name, in the apps' directory.
const Name = "remote.json"

// What the file may hold, past which a piece of it is passed over and said.
const (
	// MaxPhrases is how many phrases are kept, the first so many in the file.
	// The apps' own dictionaries hold under a thousand; five times that is a
	// file somebody generated by mistake, and every app is sent all of it.
	MaxPhrases = 5000

	// PhraseLength is how long a phrase, or one language's translation of it,
	// may be, in characters.
	PhraseLength = 2000

	// NoticeLength is how long one language's notice may be, in characters:
	// a banner in a lobby, not a page.
	NoticeLength = 500

	// NoteLength is how long a rule's note may be. A note is for whoever
	// reads the file or the page, and is never sent to an app.
	NoteLength = 500

	// IDLength is how long a notice's id may be.
	IDLength = 64

	// MaxSwitches is how many switches the management pages may write. The
	// file itself is not held to it: what an operator writes there is read.
	MaxSwitches = 200
)

// The two levels a notice may have. Anything else is read as Info.
const (
	Info    = "info"
	Warning = "warning"
)

// iOS names both of Apple's phones and tablets in a rule's platforms.
const iOS = "ios"

// platforms is every name a rule's platforms may hold: the kinds clientOf
// gives the apps (internal/app/device.go) and the one alias for two of them.
var platforms = map[string]bool{"mac": true, "iphone": true, "ipad": true, "android": true, "windows": true, iOS: true}

var (
	// ruleName is a feature or a number's name: lowercase, digits, dashes and
	// underscores, as both lists above are written.
	ruleName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

	// version is what a rule's from and below may be. The same shape as a
	// manifest's version (internal/app/apps.go, releaseVersion), because it is
	// compared by the same rule.
	version = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,31}$`)

	// language is a language tag, as the apps' dictionaries and an update's
	// notes are keyed.
	language = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z]{2,4})?$`)
)

// Where is which apps a rule is for.
type Where struct {
	// Platforms the rule is for, and every platform where there are none.
	Platforms []string `json:"platforms,omitempty"`

	// From is the first version it holds for, and Below the first it does not.
	// Either may be empty, for no bound on that side.
	From  string `json:"from,omitempty"`
	Below string `json:"below,omitempty"`
}

// Matches reports whether a rule's platforms take in an app of this kind:
// none named, the kind itself, or ios for an iPhone or an iPad.
func (w Where) Matches(kind string) bool {
	if len(w.Platforms) == 0 {
		return true
	}

	for _, one := range w.Platforms {
		if one == kind || one == iOS && (kind == "iphone" || kind == "ipad") {
			return true
		}
	}

	return false
}

// Switch is one rule turning a feature off, or on again.
type Switch struct {
	Feature string `json:"feature"`
	// Off is what the rule says of the feature. A rule that leaves it out says
	// on, which is the reading that turns nothing off by mistake.
	Off bool `json:"off"`
	Where
	// Note is why, for whoever reads the file or the page.
	Note string `json:"note,omitempty"`
}

// Param is one rule setting a number.
type Param struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Where
	Note string `json:"note,omitempty"`
}

// Notice is the lobby's notice.
//
// Its fields are declared in the order of their names, and a field added
// keeps that order: the apps are sent a notice inside an answer whose revision
// is the hash of it written with every object's keys in order
// (internal/app/remote.go), and encoding/json writes a struct as declared.
type Notice struct {
	// ID is what an app remembers a notice by once somebody has closed it, so
	// that the same notice is not shown again on the next start and a new one
	// is. A notice republished with new words is given a new one.
	ID    string            `json:"id"`
	Level string            `json:"level"`
	Text  map[string]string `json:"text"`
	// Until is when the notice stops being sent, in RFC 3339, and empty for
	// until it is taken down.
	Until string `json:"until,omitempty"`
}

// Showing reports whether a notice is still sent at a moment: it has no end,
// or its end has not come.
func (n *Notice) Showing(now time.Time) bool {
	if n == nil {
		return false
	}

	if n.Until == "" {
		return true
	}

	until, err := time.Parse(time.RFC3339, n.Until)

	return err == nil && now.Before(until)
}

// Settings is what the file says, as far as it could be read.
//
// Shared with every reader of the same file until it changes, so it is read
// and never written to.
type Settings struct {
	Phrases  map[string]map[string]string
	Switches []Switch
	Params   []Param
	Notice   *Notice

	// UnreadSwitches is how many switches the file holds that are not in
	// Switches, with a section that is not a list counted as one. The
	// management pages replace the whole list, so they say when a save would
	// take away something they were never shown.
	UnreadSwitches int
}

// File is one apps directory's remote.json.
type File struct {
	dir string

	// The file as last read, by a hash of its bytes, so that an unchanged file
	// is not parsed again on every request, nor is the same mistake in it said
	// again on every request. By content rather than by modification time: a
	// number changed from 30 to 60 within a second of the last write is the
	// same size and, on a coarse clock, the same time.
	mu       sync.Mutex
	sum      [sha256.Size]byte
	held     bool
	settings Settings

	// writing holds one rewrite at a time, so that the notice and the switches
	// saved at the same moment from two pages do not each write the file as
	// it was before the other.
	writing sync.Mutex
}

// At is the file in an apps directory. An empty directory is a deployment with
// none, whose file says nothing and cannot be written.
func At(dir string) *File {
	return &File{dir: dir}
}

func (f *File) path() string {
	return filepath.Join(f.dir, Name)
}

// Read is what the file says now. A file that is not there says nothing, and
// is not mentioned: most deployments will never have one.
func (f *File) Read() Settings {
	if f == nil || f.dir == "" {
		return Settings{}
	}

	path := f.path()

	raw, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("the apps' remote settings could not be read, so the apps are told nothing from them",
				"file", path, "error", err)
		}
		return Settings{}
	}

	sum := sha256.Sum256(raw)

	f.mu.Lock()
	defer f.mu.Unlock()

	if !f.held || f.sum != sum {
		f.settings = parse(raw, path)
		f.sum = sum
		f.held = true
	}

	return f.settings
}

// parse reads each section apart from the others. A top level that is not an
// object costs everything, since then there are no sections to tell apart.
func parse(raw []byte, path string) Settings {
	var sections map[string]json.RawMessage
	if err := json.Unmarshal(raw, &sections); err != nil {
		slog.Warn("the apps' remote settings are not a JSON object, so the apps are told nothing from them",
			"file", path, "error", err)
		return Settings{}
	}

	var settings Settings

	settings.Phrases = phrasesOf(sections["phrases"], path)
	settings.Switches, settings.UnreadSwitches = switchesOf(sections["switches"], path)
	settings.Params = paramsOf(sections["params"], path)
	settings.Notice = noticeOf(sections["notice"], path)

	return settings
}

// absent is a section left out or written as null, which is one with nothing
// in it and nothing wrong with it.
func absent(raw json.RawMessage) bool {
	return len(raw) == 0 || string(bytes.TrimSpace(raw)) == "null"
}

/*
phrasesOf reads the phrases, keeping each translation that can be shown and
passing over each that cannot.

Read in the file's order rather than decoded into a map, because the ceiling
keeps the first so many: decoded into a map, which five thousand survived would
be whichever Go's map happened to visit first, and a different five thousand on
the next read. A phrase given twice is the later one, as JSON's own reading of
an object has it.

A translation is passed over, rather than cut short, when it is too long. A
sentence cut at two thousand characters is a sentence that stops in the middle
on somebody's screen; passed over, the app says its own.

And when its placeholders are not the English's. The apps fill a phrase's
{name}s from what they have at hand, the browser client the same way
(web/src/live/i18n.ts, segments), so a translation that names one the English
does not, {名前} for {name} or {versoin} for {version}, reaches the screen with
its braces showing, and one that leaves one out drops the value: "Tomoshibi is
available" with no version in it. The client's own dictionaries are held to
this by a test; a file written by hand has nothing but this. Compared as sets,
so a translation may say a value twice where its grammar wants it, and only
that language is passed over: the others, and the app's own sentence in the
language lost, are still right.
*/
func phrasesOf(raw json.RawMessage, path string) map[string]map[string]string {
	if absent(raw) {
		return nil
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	if open, err := decoder.Token(); err != nil || open != json.Delim('{') {
		slog.Warn("the apps' remote phrases are not an object of phrases, so none are sent", "file", path)
		return nil
	}

	kept := map[string]map[string]string{}

	var unreadable, tooLong, tooMany, misnamed int

	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			break
		}

		phrase, _ := token.(string)

		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			break
		}

		var said map[string]json.RawMessage
		if phrase == "" || utf8.RuneCountInString(phrase) > PhraseLength || json.Unmarshal(value, &said) != nil {
			unreadable++
			continue
		}

		if _, again := kept[phrase]; !again && len(kept) >= MaxPhrases {
			tooMany++
			continue
		}

		translations := make(map[string]string, len(said))
		wanted := placeholders(phrase)

		for tag, one := range said {
			var text string
			if !language.MatchString(tag) || json.Unmarshal(one, &text) != nil {
				unreadable++
				continue
			}

			// Left empty, which is somebody's placeholder, is the app's own
			// sentence and nothing worth saying.
			if text == "" {
				continue
			}

			if utf8.RuneCountInString(text) > PhraseLength {
				tooLong++
				continue
			}

			if got := placeholders(text); !sameNames(got, wanted) {
				misnamed++

				// Said one by one, for the first few, because a count alone
				// leaves somebody searching five thousand phrases for the one
				// with a brace out of place. The file is read once for each
				// time it changes, so a file generated wrongly throughout says
				// this ten times and the count says the rest.
				if misnamed <= saidOneByOne {
					slog.Warn("a translation in the apps' remote phrases names other placeholders than its English, "+
						"so that language is passed over",
						"file", path, "phrase", clipped(phrase), "language", tag,
						"english", names(wanted), "translation", names(got))
				}

				continue
			}

			translations[tag] = text
		}

		if len(translations) > 0 {
			kept[phrase] = translations
		}
	}

	if unreadable > 0 || tooLong > 0 || tooMany > 0 || misnamed > 0 {
		slog.Warn("some of the apps' remote phrases cannot be sent and are passed over",
			"file", path, "unreadable", unreadable, "too_long", tooLong, "past_the_limit", tooMany,
			"placeholders", misnamed, "limit", MaxPhrases, "length", PhraseLength)
	}

	return kept
}

// saidOneByOne is how many translations with the wrong placeholders are named
// in the log before the rest are only counted.
const saidOneByOne = 10

// placeholder is one of a phrase's {name}s, as the clients cut a phrase at them:
// a word in braces, of letters, digits and underscores. Anything else in
// braces is text.
var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// placeholders is the set of names a phrase's placeholders give.
func placeholders(text string) map[string]bool {
	found := map[string]bool{}
	for _, match := range placeholder.FindAllStringSubmatch(text, -1) {
		found[match[1]] = true
	}

	return found
}

func sameNames(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}

	for name := range a {
		if !b[name] {
			return false
		}
	}

	return true
}

// names is a set of placeholders as the log writes it, in order.
func names(set map[string]bool) string {
	list := make([]string, 0, len(set))
	for name := range set {
		list = append(list, "{"+name+"}")
	}

	sort.Strings(list)

	return strings.Join(list, " ")
}

// clipped is a phrase short enough for a line of the log.
func clipped(phrase string) string {
	const most = 80

	if utf8.RuneCountInString(phrase) <= most {
		return phrase
	}

	return string([]rune(phrase)[:most]) + "…"
}

// switchesOf reads the switches, each apart from the others, and says how many
// it passed over.
func switchesOf(raw json.RawMessage, path string) ([]Switch, int) {
	if absent(raw) {
		return nil, 0
	}

	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		slog.Warn("the apps' remote switches are not a list, so no feature is switched", "file", path, "error", err)
		return nil, 1
	}

	var (
		kept   []Switch
		unread int
	)

	for at, entry := range entries {
		var one Switch
		if err := strictly(entry, &one); err != nil {
			slog.Warn("a switch in the apps' remote settings cannot be read and is passed over",
				"file", path, "at", at, "error", err)
			unread++
			continue
		}

		one = one.Tidied()

		if err := one.Check(); err != nil {
			slog.Warn("a switch in the apps' remote settings cannot be used and is passed over",
				"file", path, "at", at, "feature", one.Feature, "reason", err.Error())
			unread++
			continue
		}

		kept = append(kept, one)
	}

	return kept, unread
}

// paramsOf reads the numbers, each apart from the others.
func paramsOf(raw json.RawMessage, path string) []Param {
	if absent(raw) {
		return nil
	}

	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		slog.Warn("the apps' remote params are not a list, so none are sent", "file", path, "error", err)
		return nil
	}

	var kept []Param

	for at, entry := range entries {
		// The value read apart, so that a number written in quotes is refused
		// rather than the rule decoding to nought: nought is a value most of
		// these numbers can hold, and one that would stop a screen share dead.
		var line struct {
			Name  string          `json:"name"`
			Value json.RawMessage `json:"value"`
			Where
			Note string `json:"note,omitempty"`
		}

		if err := strictly(entry, &line); err != nil {
			slog.Warn("a param in the apps' remote settings cannot be read and is passed over",
				"file", path, "at", at, "error", err)
			continue
		}

		value, isNumber := numberOf(line.Value)

		one := Param{Name: line.Name, Value: value, Where: line.Where, Note: line.Note}
		one.Name = strings.TrimSpace(one.Name)
		one.Where = one.Where.tidied()

		reason := one.Where.check()
		switch {
		case !ruleName.MatchString(one.Name):
			reason = BadName
		case !isNumber:
			reason = NotANumber
		}

		if reason != nil {
			slog.Warn("a param in the apps' remote settings cannot be used and is passed over",
				"file", path, "at", at, "name", one.Name, "reason", reason.Error())
			continue
		}

		kept = append(kept, one)
	}

	return kept
}

// numberOf reads a JSON number, and only a number: not a string holding one,
// and not a boolean, and not nothing.
func numberOf(raw json.RawMessage) (float64, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '-' && (raw[0] < '0' || raw[0] > '9') {
		return 0, false
	}

	var value float64

	return value, json.Unmarshal(raw, &value) == nil
}

// strictly decodes one rule refusing any field it does not know, for the
// reason the file's header gives: every field a rule has narrows it, so one
// misspelled is a rule wider than it was written.
func strictly(raw json.RawMessage, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()

	return decoder.Decode(into)
}

// noticeOf reads the notice, keeping the languages that can be shown.
//
// Not shown at all without an id, which is what an app remembers it by once
// somebody has closed it: without one it would come back on every start, or
// never, depending on what each app made of nothing. Nor with an end that is
// not a time, which nobody could say had passed.
func noticeOf(raw json.RawMessage, path string) *Notice {
	if absent(raw) {
		return nil
	}

	var said struct {
		ID    string                     `json:"id"`
		Level string                     `json:"level"`
		Text  map[string]json.RawMessage `json:"text"`
		Until string                     `json:"until"`
	}

	if err := json.Unmarshal(raw, &said); err != nil {
		slog.Warn("the apps' remote notice cannot be read, so none is shown", "file", path, "error", err)
		return nil
	}

	id := strings.TrimSpace(said.ID)
	if id == "" || utf8.RuneCountInString(id) > IDLength {
		slog.Warn("the apps' remote notice has no id it can be remembered by, so it is not shown",
			"file", path, "id", id)
		return nil
	}

	if until := strings.TrimSpace(said.Until); until != "" {
		if _, err := time.Parse(time.RFC3339, until); err != nil {
			slog.Warn("the apps' remote notice ends at something that is not a time, so it is not shown",
				"file", path, "id", id, "until", said.Until)
			return nil
		}
	}

	text := make(map[string]string, len(said.Text))
	var tooLong, unreadable int

	for tag, value := range said.Text {
		var one string
		if !language.MatchString(tag) || json.Unmarshal(value, &one) != nil {
			unreadable++
			continue
		}

		one = strings.TrimSpace(one)
		if one == "" {
			continue
		}

		// Passed over rather than cut, as a phrase is: a notice that stops
		// half way is worse than the same notice in another of the languages.
		if utf8.RuneCountInString(one) > NoticeLength {
			tooLong++
			continue
		}

		text[tag] = one
	}

	if tooLong > 0 || unreadable > 0 {
		slog.Warn("some of the apps' remote notice cannot be shown and is passed over",
			"file", path, "id", id, "too_long", tooLong, "unreadable", unreadable, "length", NoticeLength)
	}

	if len(text) == 0 {
		slog.Warn("the apps' remote notice has nothing in any language that can be shown, so it is not",
			"file", path, "id", id)
		return nil
	}

	level := Info
	if strings.TrimSpace(said.Level) == Warning {
		level = Warning
	}

	return &Notice{ID: id, Level: level, Text: text, Until: strings.TrimSpace(said.Until)}
}

// Refusal is why a rule or a notice cannot be used, as a code: the page that
// sent it owns the sentence.
type Refusal string

func (r Refusal) Error() string { return string(r) }

// The refusals. Their spellings are what the management pages were written
// against.
const (
	BadFeature      Refusal = "bad_feature"
	BadName         Refusal = "bad_name"
	NotANumber      Refusal = "not_a_number"
	NoSuchPlatform  Refusal = "no_such_platform"
	NotAVersion     Refusal = "not_a_version"
	NoteTooLong     Refusal = "note_too_long"
	TooManySwitches Refusal = "too_many_switches"
	BadNoticeID     Refusal = "bad_notice_id"
	NoNoticeText    Refusal = "no_notice_text"
	NoticeTooLong   Refusal = "notice_too_long"
	NotALanguage    Refusal = "not_a_language"
	NoSuchLevel     Refusal = "no_such_level"
	NotATime        Refusal = "not_a_time"
	NoticeOver      Refusal = "notice_over"
)

// Tidied is a switch as it is kept: its words trimmed and its platforms
// lowercased, once each. Neither widens anything.
func (s Switch) Tidied() Switch {
	s.Feature = strings.TrimSpace(s.Feature)
	s.Note = strings.TrimSpace(s.Note)
	s.Where = s.Where.tidied()

	return s
}

func (w Where) tidied() Where {
	w.From = strings.TrimSpace(w.From)
	w.Below = strings.TrimSpace(w.Below)

	if len(w.Platforms) == 0 {
		w.Platforms = nil
		return w
	}

	seen := make(map[string]bool, len(w.Platforms))
	kept := make([]string, 0, len(w.Platforms))

	for _, one := range w.Platforms {
		one = strings.ToLower(strings.TrimSpace(one))
		if !seen[one] {
			seen[one] = true
			kept = append(kept, one)
		}
	}

	w.Platforms = kept

	return w
}

// Check says why a switch cannot be used, or nothing where it can.
func (s Switch) Check() error {
	if !ruleName.MatchString(s.Feature) {
		return BadFeature
	}

	if utf8.RuneCountInString(s.Note) > NoteLength {
		return NoteTooLong
	}

	return s.Where.check()
}

func (w Where) check() error {
	for _, one := range w.Platforms {
		if !platforms[one] {
			return NoSuchPlatform
		}
	}

	for _, bound := range []string{w.From, w.Below} {
		if bound != "" && !version.MatchString(bound) {
			return NotAVersion
		}
	}

	return nil
}

/*
CheckNotice holds a notice a page is publishing to what the apps can be shown,
and gives it back as it will be written.

Stricter than reading the file. What a page sends that could not be shown is
said to whoever pressed publish, while they can still correct it; read from the
file, the same thing can only be passed over and logged, since there is nobody
there to tell. So a language that is not one, a level that is neither, and a
notice too long are refused here rather than quietly lost, and a notice that
would already be over is refused rather than published to nobody.

The end is written in UTC and to the second, whatever the page sent, so that
every app reads the same instant in the same form.
*/
func CheckNotice(notice Notice, now time.Time) (Notice, error) {
	checked := Notice{ID: strings.TrimSpace(notice.ID), Level: strings.TrimSpace(notice.Level)}

	if checked.ID == "" || utf8.RuneCountInString(checked.ID) > IDLength {
		return Notice{}, BadNoticeID
	}

	switch checked.Level {
	case "":
		checked.Level = Info
	case Info, Warning:
	default:
		return Notice{}, NoSuchLevel
	}

	checked.Text = make(map[string]string, len(notice.Text))

	for tag, one := range notice.Text {
		if !language.MatchString(tag) {
			return Notice{}, NotALanguage
		}

		one = strings.TrimSpace(one)
		if one == "" {
			continue
		}

		if utf8.RuneCountInString(one) > NoticeLength {
			return Notice{}, NoticeTooLong
		}

		checked.Text[tag] = one
	}

	if len(checked.Text) == 0 {
		return Notice{}, NoNoticeText
	}

	if until := strings.TrimSpace(notice.Until); until != "" {
		at, err := time.Parse(time.RFC3339, until)
		if err != nil {
			return Notice{}, NotATime
		}

		if !now.Before(at) {
			return Notice{}, NoticeOver
		}

		checked.Until = at.UTC().Format(time.RFC3339)
	}

	return checked, nil
}

// ErrUnreadable is a file that is there and is not a JSON object, which no
// section of can be replaced without losing the rest.
var ErrUnreadable = errors.New("the apps' remote settings are not a JSON object, so one section of them cannot be replaced without losing the others")

// ErrNoDirectory is a deployment with no apps directory, which has nowhere to
// keep the file.
var ErrNoDirectory = errors.New("no apps directory is configured (meet.apps.mac_dir), so there is nowhere to keep the apps' remote settings")

// SetNotice publishes a notice, or with nil takes the one there down.
func (f *File) SetNotice(notice *Notice) error {
	if notice == nil {
		return f.replace("notice", nil)
	}

	value, err := indented(notice)
	if err != nil {
		return err
	}

	return f.replace("notice", value)
}

// SetSwitches replaces every switch with the list given.
func (f *File) SetSwitches(switches []Switch) error {
	if switches == nil {
		switches = []Switch{}
	}

	value, err := indented(switches)
	if err != nil {
		return err
	}

	return f.replace("switches", value)
}

// indented is a section as it is written into the file: indented to sit one
// level in, and without the escaping a browser would want, since it is read
// by people in an editor and by apps that are not browsers.
func indented(value any) ([]byte, error) {
	var written bytes.Buffer

	encoder := json.NewEncoder(&written)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("  ", "  ")

	if err := encoder.Encode(value); err != nil {
		return nil, err
	}

	return bytes.TrimRight(written.Bytes(), "\n"), nil
}

// replace writes one section, or with nil removes it, and leaves the rest of
// the file as it was.
func (f *File) replace(section string, value []byte) error {
	if f == nil || f.dir == "" {
		return ErrNoDirectory
	}

	f.writing.Lock()
	defer f.writing.Unlock()

	// Through a link to what it names, so that an operator who keeps the file
	// elsewhere and links it here still has the link after a page writes:
	// renaming over the link itself would replace it with a file.
	path := f.path()
	if target, err := filepath.EvalSymlinks(path); err == nil {
		path = target
	}

	mode := fs.FileMode(0o644)

	current, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		// Nothing to take down from a file that is not there, and no reason
		// to create one to say so.
		if value == nil {
			return nil
		}
	case err != nil:
		return err
	default:
		if info, err := os.Stat(path); err == nil {
			mode = info.Mode().Perm()
		}
	}

	written, err := splice(current, section, value)
	if err != nil {
		return err
	}

	return renamedInto(path, written, mode)
}

// splice is a file with one section replaced, removed or added.
//
// The other sections are copied as they were written, in the order they were
// written, which is what the decoder's raw values are: the bytes of each value
// as it stands in the file. A section given twice keeps its first place and
// loses the rest, so that the file reads afterwards as the page wrote it.
func splice(current []byte, section string, value []byte) ([]byte, error) {
	type part struct {
		key string
		raw []byte
	}

	var parts []part

	if len(bytes.TrimSpace(current)) > 0 {
		if !json.Valid(current) {
			return nil, ErrUnreadable
		}

		decoder := json.NewDecoder(bytes.NewReader(current))

		open, err := decoder.Token()
		if err != nil {
			return nil, ErrUnreadable
		}

		// A file holding null is one holding nothing, as it is read.
		if open != nil {
			if open != json.Delim('{') {
				return nil, ErrUnreadable
			}

			for decoder.More() {
				token, err := decoder.Token()
				if err != nil {
					return nil, ErrUnreadable
				}

				var raw json.RawMessage
				if err := decoder.Decode(&raw); err != nil {
					return nil, ErrUnreadable
				}

				key, _ := token.(string)
				parts = append(parts, part{key: key, raw: raw})
			}
		}
	}

	kept := make([]part, 0, len(parts)+1)
	placed := false

	for _, one := range parts {
		if one.key != section {
			kept = append(kept, one)
			continue
		}

		if placed {
			continue
		}

		placed = true

		if value != nil {
			kept = append(kept, part{key: section, raw: value})
		}
	}

	if !placed && value != nil {
		kept = append(kept, part{key: section, raw: value})
	}

	var written bytes.Buffer

	written.WriteString("{")

	for at, one := range kept {
		if at > 0 {
			written.WriteString(",")
		}

		key, err := json.Marshal(one.key)
		if err != nil {
			return nil, err
		}

		written.WriteString("\n  ")
		written.Write(key)
		written.WriteString(": ")
		written.Write(one.raw)
	}

	if len(kept) > 0 {
		written.WriteString("\n")
	}

	written.WriteString("}\n")

	return written.Bytes(), nil
}

// renamedInto writes a file whole and renames it into place, so that whatever
// reads it meanwhile reads the old file or the new one and never a part of
// either. In the same directory, since a rename does not cross filesystems.
func renamedInto(path string, data []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)

	temporary, err := os.CreateTemp(dir, "."+Name+".*")
	if err != nil {
		return fmt.Errorf("the apps' remote settings could not be written beside %s: %w", path, err)
	}

	name := temporary.Name()

	failed := func(err error) error {
		_ = temporary.Close()
		_ = os.Remove(name)
		return fmt.Errorf("the apps' remote settings could not be written to %s: %w", path, err)
	}

	if _, err := temporary.Write(data); err != nil {
		return failed(err)
	}

	if err := temporary.Chmod(mode); err != nil {
		return failed(err)
	}

	// On the disk before it is renamed into place, or a power cut after the
	// rename can leave the name pointing at a file with nothing in it.
	if err := temporary.Sync(); err != nil {
		return failed(err)
	}

	if err := temporary.Close(); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("the apps' remote settings could not be written to %s: %w", path, err)
	}

	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("the apps' remote settings could not be put in place at %s: %w", path, err)
	}

	// And the directory, so that the rename itself is kept. Not every system
	// lets a directory be synced, and the file is in place either way.
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}

	return nil
}
