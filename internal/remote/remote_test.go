package remote

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

/*
The file the apps are told their words, switches, numbers and notice from.

What would go wrong here without anybody seeing is mostly one of three things.
A piece written wrongly taking the rest with it, so that a missing comma in a
phrase keeps an urgent notice from being shown. A rule read wider than it was
written, so that a misspelled platform or field turns a feature off for every
app rather than for none. And a page's save rewriting what an operator laid
out by hand, or a file nobody can parse being overwritten with only what the
page knew about.

The answer as an app receives it, platform and version applied, is tested
where it is worked out (internal/app/remote_test.go).
*/

// logged captures what the package says, for the length of a test.
func logged(t *testing.T) *bytes.Buffer {
	t.Helper()

	var said bytes.Buffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&said, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })

	return &said
}

// written puts a remote.json into a new directory and returns the file.
func written(t *testing.T, contents string) *File {
	t.Helper()

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, Name), []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}

	return At(dir)
}

func contentsOf(t *testing.T, file *File) string {
	t.Helper()

	raw, err := os.ReadFile(file.path())
	if err != nil {
		t.Fatal(err)
	}

	return string(raw)
}

func TestNoFileSaysNothingAndIsNotMentioned(t *testing.T) {
	said := logged(t)

	for _, file := range []*File{At(t.TempDir()), At(""), nil} {
		if got := file.Read(); !reflect.DeepEqual(got, Settings{}) {
			t.Errorf("a missing file read as %+v", got)
		}
	}

	if said.Len() != 0 {
		t.Errorf("a file that is not there was mentioned; most deployments never have one:\n%s", said)
	}
}

func TestAFileThatIsNotAnObjectSaysNothingAndSaysWhy(t *testing.T) {
	for _, contents := range []string{`{"phrases": {`, `[]`, `"notice"`, ``} {
		said := logged(t)

		if got := written(t, contents).Read(); !reflect.DeepEqual(got, Settings{}) {
			t.Errorf("%q read as %+v", contents, got)
		}

		if !strings.Contains(said.String(), "not a JSON object") {
			t.Errorf("%q was not said to be unreadable:\n%s", contents, said)
		}
	}
}

func TestASectionWrittenWronglyCostsOnlyItself(t *testing.T) {
	said := logged(t)

	file := written(t, `{
		"phrases":  {"Join": {"zh-Hans": "加入"}},
		"switches": {"feature": "music", "off": true},
		"params":   "screen_share_max_fps=30",
		"notice":   {"id": "n1", "text": {"en": "Maintenance tonight"}}
	}`)

	got := file.Read()

	if got.Phrases["Join"]["zh-Hans"] != "加入" {
		t.Errorf("the phrases were lost with the switches: %v", got.Phrases)
	}

	if got.Notice == nil || got.Notice.Text["en"] != "Maintenance tonight" {
		t.Errorf("the notice was lost with the switches: %+v", got.Notice)
	}

	if got.Switches != nil || got.Params != nil {
		t.Errorf("a section that is not a list read as %+v and %+v", got.Switches, got.Params)
	}

	if got.UnreadSwitches != 1 {
		t.Errorf("a switches section that is not a list counts %d unread; the page must be told", got.UnreadSwitches)
	}

	for _, section := range []string{"switches are not a list", "params are not a list"} {
		if !strings.Contains(said.String(), section) {
			t.Errorf("the log does not say the %s:\n%s", section, said)
		}
	}
}

/*
Each of these would be a rule wider than it was written if it were read at
all: a platform nobody has, read as none, which is every platform; a field
misspelled, read as absent, which is every platform or every version; a
version that is not one, read as no bound. They are passed over instead, and
the rules around them kept.
*/
func TestARuleThatWouldReadWiderThanWrittenIsPassedOver(t *testing.T) {
	said := logged(t)

	file := written(t, `{"switches": [
		{"feature": "screen-share", "off": true, "platforms": ["andriod"]},
		{"feature": "screen-share", "off": true, "platfroms": ["android"]},
		{"feature": "screen-share", "off": true, "from": "zero.one"},
		{"feature": "screen-share", "off": "true"},
		{"feature": "", "off": true},
		{"feature": "Screen Share", "off": true},
		null,
		{"feature": "music", "off": true, "platforms": [" Android ", "android", "ios"]}
	], "params": [
		{"name": "screen_share_max_fps", "value": "30"},
		{"name": "screen_share_max_fps", "value": true},
		{"name": "screen_share_max_fps"},
		{"name": "screen_share_max_fps", "value": 30, "platfroms": ["android"]},
		{"name": "screen_share_max_fps", "value": 24, "platforms": ["android"], "note": "hot phones"}
	]}`)

	got := file.Read()

	want := []Switch{{Feature: "music", Off: true, Where: Where{Platforms: []string{"android", "ios"}}}}
	if !reflect.DeepEqual(got.Switches, want) {
		t.Errorf("switches read as %+v; want only %+v", got.Switches, want)
	}

	if got.UnreadSwitches != 7 {
		t.Errorf("%d switches counted unread, want 7", got.UnreadSwitches)
	}

	wantParams := []Param{{Name: "screen_share_max_fps", Value: 24, Where: Where{Platforms: []string{"android"}}, Note: "hot phones"}}
	if !reflect.DeepEqual(got.Params, wantParams) {
		t.Errorf("params read as %+v; want only %+v — a number in quotes, a boolean or nothing is "+
			"not a number, and nought is a value these can hold", got.Params, wantParams)
	}

	if n := strings.Count(said.String(), "passed over"); n != 11 {
		t.Errorf("%d rules were said to be passed over, want 11:\n%s", n, said)
	}
}

func TestPhrasesAreKeptInTheFilesOrderUpToTheLimit(t *testing.T) {
	said := logged(t)

	var phrases []string
	for at := range MaxPhrases + 3 {
		phrases = append(phrases, fmt.Sprintf(`"phrase %05d": {"ja": "訳 %d"}`, MaxPhrases+3-at, at))
	}

	got := written(t, `{"phrases": {`+strings.Join(phrases, ",")+`}}`).Read()

	if len(got.Phrases) != MaxPhrases {
		t.Fatalf("%d phrases kept, want %d", len(got.Phrases), MaxPhrases)
	}

	// Written in descending order, so that the first so many in the file are
	// not also the first so many by name: a ceiling applied to a map's order,
	// or to a sorted one, would keep a different set.
	for _, gone := range []string{"phrase 00001", "phrase 00002", "phrase 00003"} {
		if _, kept := got.Phrases[gone]; kept {
			t.Errorf("%s, past the limit in the file's order, was kept", gone)
		}
	}

	if _, kept := got.Phrases[fmt.Sprintf("phrase %05d", MaxPhrases+3)]; !kept {
		t.Error("the first phrase in the file was not kept")
	}

	if !strings.Contains(said.String(), "past_the_limit=3") {
		t.Errorf("the three past the limit were not said:\n%s", said)
	}
}

func TestATranslationThatCannotBeShownCostsOnlyItself(t *testing.T) {
	logged(t)

	long := strings.Repeat("字", PhraseLength+1)
	edge := strings.Repeat("字", PhraseLength)

	got := written(t, `{"phrases": {
		"Join": {"zh-Hans": "加入", "zh-Hant": "`+long+`", "ja": 7, "../etc": "x", "en": ""},
		"Leave": {"zh-Hans": "`+edge+`"},
		"`+long+`": {"zh-Hans": "太长"},
		"Mute": "静音",
		"Gone": {"ja": "`+long+`"},
		"Join": {"zh-Hans": "加入会议"}
	}}`).Read()

	want := map[string]map[string]string{
		// The later of two, as JSON reads an object.
		"Join":  {"zh-Hans": "加入会议"},
		"Leave": {"zh-Hans": edge},
	}

	if !reflect.DeepEqual(got.Phrases, want) {
		t.Errorf("phrases read as %v;\nwant %v", keysOf(got.Phrases), keysOf(want))
	}
}

/*
A translation whose placeholders are not its English's reaches the screen with
its braces showing, or without the value: the apps and the browser fill a
phrase's {name}s by name. Only that language goes; a placeholder said twice is
still the same set; and braces around something that is not a word are text,
as the clients cut a phrase.
*/
func TestATranslationWithOtherPlaceholdersCostsOnlyThatLanguage(t *testing.T) {
	said := logged(t)

	got := written(t, `{"phrases": {
		"Tomoshibi {version} is available": {
			"zh-Hans": "Tomoshibi {version} 已可更新",
			"zh-Hant": "Tomoshibi 已可更新",
			"ja": "Tomoshibi {バージョン} が利用可能です",
			"en": "Tomoshibi {versoin} is available",
			"ko": "Tomoshibi {version} {version}",
			"fr": "Tomoshibi {version} est disponible pour {name}"
		},
		"{name} and {count} others": {"ja": "{name} さんほか {count} 人", "zh-Hans": "{count} 人和 {name}"},
		"Join": {"zh-Hans": "加入 {room}", "ja": "{参加}"}
	}}`).Read()

	want := map[string]map[string]string{
		"Tomoshibi {version} is available": {
			"zh-Hans": "Tomoshibi {version} 已可更新",
			"ko":      "Tomoshibi {version} {version}",
		},
		// In another order is the same placeholders.
		"{name} and {count} others": {"ja": "{name} さんほか {count} 人", "zh-Hans": "{count} 人和 {name}"},
		"Join":                      {"ja": "{参加}"},
	}

	if !reflect.DeepEqual(got.Phrases, want) {
		t.Errorf("phrases read as %v;\nwant %v", got.Phrases, want)
	}

	for _, language := range []string{"zh-Hant", "ja", "en", "fr"} {
		if !strings.Contains(said.String(), "language="+language) {
			t.Errorf("the %s translation with other placeholders was not named in the log:\n%s", language, said)
		}
	}

	if !strings.Contains(said.String(), "placeholders=5") {
		t.Errorf("the five passed over were not counted:\n%s", said)
	}
}

func TestPlaceholdersWrongThroughoutAreNamedOnlySoOften(t *testing.T) {
	said := logged(t)

	var phrases []string
	for at := range saidOneByOne + 5 {
		phrases = append(phrases, fmt.Sprintf(`"Room {room} %d": {"ja": "部屋 %d"}`, at, at))
	}

	got := written(t, `{"phrases": {`+strings.Join(phrases, ",")+`}}`).Read()

	if len(got.Phrases) != 0 {
		t.Errorf("%d phrases were kept with their placeholder missing", len(got.Phrases))
	}

	if n := strings.Count(said.String(), "names other placeholders"); n != saidOneByOne {
		t.Errorf("%d translations were named one by one, want %d", n, saidOneByOne)
	}

	if !strings.Contains(said.String(), fmt.Sprintf("placeholders=%d", saidOneByOne+5)) {
		t.Errorf("the count does not say all of them:\n%s", said)
	}
}

func keysOf(phrases map[string]map[string]string) map[string][]string {
	keys := map[string][]string{}
	for phrase, said := range phrases {
		short := phrase
		if len(short) > 12 {
			short = short[:12] + "…"
		}
		for tag, text := range said {
			keys[short] = append(keys[short], fmt.Sprintf("%s:%d", tag, len([]rune(text))))
		}
	}
	return keys
}

func TestANoticeIsShownOnlyWithAnIDAndSomethingToSay(t *testing.T) {
	long := strings.Repeat("知", NoticeLength+1)
	edge := strings.Repeat("知", NoticeLength)

	for _, c := range []struct {
		name, notice string
		want         *Notice
		said         string
	}{
		{"no id", `{"text": {"en": "Maintenance"}}`, nil, "no id"},
		{"a blank id", `{"id": "  ", "text": {"en": "Maintenance"}}`, nil, "no id"},
		{"an end that is not a time", `{"id": "n", "until": "tomorrow", "text": {"en": "Maintenance"}}`, nil, "not a time"},
		{"nothing to say", `{"id": "n", "text": {"en": " ", "ja": 5}}`, nil, "nothing in any language"},
		{"every language too long", `{"id": "n", "text": {"en": "` + long + `"}}`, nil, "nothing in any language"},
		{"one language too long", `{"id": "n", "level": "warning", "text": {"en": "` + long + `", "ja": "` + edge + `"}}`,
			&Notice{ID: "n", Level: Warning, Text: map[string]string{"ja": edge}}, "too_long=1"},
		{"a level it does not know", `{"id": " n ", "level": "urgent", "until": "2026-10-23T12:00:00Z", "text": {"zh-Hans": " 今晚维护 "}}`,
			&Notice{ID: "n", Level: Info, Text: map[string]string{"zh-Hans": "今晚维护"}, Until: "2026-10-23T12:00:00Z"}, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			said := logged(t)

			got := written(t, `{"notice": `+c.notice+`}`).Read().Notice

			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("read as %+v, want %+v", got, c.want)
			}

			if c.said != "" && !strings.Contains(said.String(), c.said) {
				t.Errorf("the log does not say %q:\n%s", c.said, said)
			}
		})
	}
}

func TestANoticeShowsUntilItsEnd(t *testing.T) {
	end := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	notice := &Notice{ID: "n", Until: end.Format(time.RFC3339)}

	if !notice.Showing(end.Add(-time.Second)) {
		t.Error("a notice was not showing a second before its end")
	}

	if notice.Showing(end) || notice.Showing(end.Add(time.Second)) {
		t.Error("a notice was still showing at its end")
	}

	if !(&Notice{ID: "n"}).Showing(end) {
		t.Error("a notice without an end was not showing")
	}

	if (*Notice)(nil).Showing(end) {
		t.Error("no notice was showing")
	}
}

// The file is remembered by what is in it and not by when it was written. A
// number changed from 30 to 60 is the same size, and within the same second of
// the last write it has the same time on a filesystem whose clock is coarse; a
// memory keyed on either would go on telling every app 30.
func TestAFileChangedInPlaceIsReadAgain(t *testing.T) {
	file := written(t, `{"params": [{"name": "screen_share_max_fps", "value": 30}]}`)

	info, err := os.Stat(file.path())
	if err != nil {
		t.Fatal(err)
	}

	if got := file.Read().Params; len(got) != 1 || got[0].Value != 30 {
		t.Fatalf("read as %+v", got)
	}

	if err := os.WriteFile(file.path(), []byte(`{"params": [{"name": "screen_share_max_fps", "value": 60}]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.Chtimes(file.path(), info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}

	if got := file.Read().Params; len(got) != 1 || got[0].Value != 60 {
		t.Errorf("a file rewritten to the same size and time read as %+v, the old file", got)
	}
}

func TestAnUnchangedFileIsNotReadAgainNorSaidAgain(t *testing.T) {
	said := logged(t)

	file := written(t, `{"switches": [{"feature": "music", "off": true, "platforms": ["andriod"]}]}`)

	file.Read()
	file.Read()

	if n := strings.Count(said.String(), "passed over"); n != 1 {
		t.Errorf("the same mistake was said %d times for one file; once per file is enough", n)
	}
}

/*
What the pages write.

The file is somebody's: phrases laid out by hand, a section a later server will
read, a key in an order that means something to them. A page publishing a
notice changes the notice and nothing else, down to the spaces.
*/

const handwritten = `{
    "phrases": {
        "Join":   { "zh-Hans": "加入",   "ja": "参加" },
        "Leave":  { "zh-Hans": "离开" }
    },
  "params":[{"name":"screen_share_max_fps","value":30}],
  "later": {"something": "a newer server reads"},
  "notice": {"id": "old", "text": {"en": "Old"}}
}
`

func TestPublishingANoticeKeepsTheRestOfTheFileAsWritten(t *testing.T) {
	file := written(t, handwritten)

	notice := &Notice{ID: "2026-10-22-1", Level: Warning, Text: map[string]string{"en": "<b>Tonight</b> & tomorrow"}}
	if err := file.SetNotice(notice); err != nil {
		t.Fatal(err)
	}

	after := contentsOf(t, file)

	for _, kept := range []string{
		`"phrases": {
        "Join":   { "zh-Hans": "加入",   "ja": "参加" },
        "Leave":  { "zh-Hans": "离开" }
    }`,
		`"params": [{"name":"screen_share_max_fps","value":30}]`,
		`"later": {"something": "a newer server reads"}`,
	} {
		if !strings.Contains(after, kept) {
			t.Errorf("the file no longer holds, as written,\n%s\nin\n%s", kept, after)
		}
	}

	// In its old place, and once.
	if strings.Count(after, `"notice"`) != 1 || strings.Index(after, `"notice"`) < strings.Index(after, `"later"`) {
		t.Errorf("the notice is not where it was:\n%s", after)
	}

	if !strings.Contains(after, `<b>Tonight</b> & tomorrow`) {
		t.Errorf("the notice was escaped for a browser, which neither its readers nor the apps are:\n%s", after)
	}

	if got := file.Read().Notice; !reflect.DeepEqual(got, notice) {
		t.Errorf("the notice reads back as %+v, want %+v", got, notice)
	}

	if got := file.Read().Phrases["Join"]["ja"]; got != "参加" {
		t.Errorf("the phrases read back as %q", got)
	}
}

func TestTakingTheNoticeDownTakesOnlyIt(t *testing.T) {
	file := written(t, handwritten)

	if err := file.SetNotice(nil); err != nil {
		t.Fatal(err)
	}

	after := contentsOf(t, file)

	if strings.Contains(after, `"notice"`) {
		t.Errorf("the notice is still in the file:\n%s", after)
	}

	if !strings.Contains(after, `"params": [{"name":"screen_share_max_fps","value":30}]`) {
		t.Errorf("the params were changed with the notice:\n%s", after)
	}

	if file.Read().Notice != nil {
		t.Error("the notice still reads")
	}
}

func TestTheSwitchesAreWrittenWholeAndInOrder(t *testing.T) {
	file := written(t, `{"switches": [{"feature": "music", "off": true}], "switches": [{"feature": "old"}], "notice": null}`)

	list := []Switch{
		{Feature: "screen-share", Off: true, Where: Where{Platforms: []string{"android"}, From: "0.1.4", Below: "0.1.5"}, Note: "crashes"},
		{Feature: "screen-share", Off: false, Where: Where{Platforms: []string{"android"}, From: "0.1.4.2"}},
	}

	if err := file.SetSwitches(list); err != nil {
		t.Fatal(err)
	}

	if got := file.Read().Switches; !reflect.DeepEqual(got, list) {
		t.Errorf("the switches read back as %+v", got)
	}

	if after := contentsOf(t, file); strings.Count(after, `"switches"`) != 1 || !strings.Contains(after, `"notice": null`) {
		t.Errorf("a section given twice was not made one, or the rest was changed:\n%s", after)
	}

	if err := file.SetSwitches(nil); err != nil {
		t.Fatal(err)
	}

	if after := contentsOf(t, file); !strings.Contains(after, `"switches": []`) {
		t.Errorf("no switches were written as something other than an empty list:\n%s", after)
	}
}

func TestAFileThatIsNotJSONIsNeverWrittenOver(t *testing.T) {
	for _, broken := range []string{`{"phrases": {"Join": {"zh-Hans": "加入"}`, `["not", "an", "object"]`, `{"a": 1} {"b": 2}`} {
		file := written(t, broken)

		err := file.SetNotice(&Notice{ID: "n", Level: Info, Text: map[string]string{"en": "Hello"}})
		if !errors.Is(err, ErrUnreadable) {
			t.Errorf("writing over %q was %v, want ErrUnreadable", broken, err)
		}

		if after := contentsOf(t, file); after != broken {
			t.Errorf("%q was written over with %q; what somebody was half way through is gone", broken, after)
		}
	}
}

func TestNoFileIsMadeToSayThereIsNoNotice(t *testing.T) {
	dir := t.TempDir()
	file := At(dir)

	if err := file.SetNotice(nil); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dir, Name)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("taking down a notice from no file made one: %v", err)
	}

	if err := file.SetSwitches([]Switch{{Feature: "music", Off: true}}); err != nil {
		t.Fatal(err)
	}

	if got := file.Read().Switches; len(got) != 1 {
		t.Errorf("a first write did not make the file: %+v", got)
	}

	if err := At("").SetNotice(nil); !errors.Is(err, ErrNoDirectory) {
		t.Errorf("a deployment with no directory wrote somewhere: %v", err)
	}
}

func TestAWriteLeavesNothingBesideTheFileAndKeepsItsMode(t *testing.T) {
	file := written(t, `{}`)
	if err := os.Chmod(file.path(), 0o640); err != nil {
		t.Fatal(err)
	}

	if err := file.SetSwitches([]Switch{{Feature: "music", Off: true}}); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(file.dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(entries) != 1 || entries[0].Name() != Name {
		var names []string
		for _, one := range entries {
			names = append(names, one.Name())
		}
		t.Errorf("the directory holds %v after a write; a temporary file was left behind", names)
	}

	if info, _ := os.Stat(file.path()); info.Mode().Perm() != 0o640 {
		t.Errorf("the file is %v after a write, was 0640", info.Mode().Perm())
	}
}

func TestAWriteThroughALinkKeepsTheLink(t *testing.T) {
	elsewhere := filepath.Join(t.TempDir(), "kept-here.json")
	if err := os.WriteFile(elsewhere, []byte(`{"params": []}`), 0o644); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(dir, Name)); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}

	file := At(dir)
	if err := file.SetSwitches([]Switch{{Feature: "music", Off: true}}); err != nil {
		t.Fatal(err)
	}

	if info, err := os.Lstat(filepath.Join(dir, Name)); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link was replaced by a file: %v", err)
	}

	if raw, _ := os.ReadFile(elsewhere); !strings.Contains(string(raw), `"music"`) {
		t.Errorf("the file the link names was not written: %s", raw)
	}
}

func TestANoticeFromAPageIsHeldToWhatCanBeShown(t *testing.T) {
	now := time.Date(2026, 10, 22, 8, 0, 0, 0, time.UTC)
	text := map[string]string{"en": "Maintenance tonight"}

	for _, c := range []struct {
		name   string
		notice Notice
		want   error
	}{
		{"no id", Notice{Text: text}, BadNoticeID},
		{"an id too long", Notice{ID: strings.Repeat("n", IDLength+1), Text: text}, BadNoticeID},
		{"no level it knows", Notice{ID: "n", Level: "urgent", Text: text}, NoSuchLevel},
		{"nothing to say", Notice{ID: "n", Text: map[string]string{"en": "  "}}, NoNoticeText},
		{"too much to say", Notice{ID: "n", Text: map[string]string{"en": strings.Repeat("a", NoticeLength+1)}}, NoticeTooLong},
		{"not a language", Notice{ID: "n", Text: map[string]string{"english": "Hello"}}, NotALanguage},
		{"an end that is not a time", Notice{ID: "n", Text: text, Until: "tomorrow"}, NotATime},
		{"an end already past", Notice{ID: "n", Text: text, Until: "2026-10-22T08:00:00Z"}, NoticeOver},
	} {
		if _, err := CheckNotice(c.notice, now); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}

	got, err := CheckNotice(Notice{
		ID: " 2026-10-22-080000 ", Text: map[string]string{"en": " Tonight ", "ja": "", "zh-Hans": strings.Repeat("字", NoticeLength)},
		Until: "2026-10-23T20:00:00.000+08:00",
	}, now)
	if err != nil {
		t.Fatal(err)
	}

	want := Notice{
		ID: "2026-10-22-080000", Level: Info,
		Text:  map[string]string{"en": "Tonight", "zh-Hans": strings.Repeat("字", NoticeLength)},
		Until: "2026-10-23T12:00:00Z",
	}

	if !reflect.DeepEqual(got, want) {
		t.Errorf("checked as %+v, want %+v", got, want)
	}
}
