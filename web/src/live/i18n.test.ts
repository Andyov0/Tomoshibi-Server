import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./dictionaries/en";
import { DICTIONARIES_FOR_TEST, LOCALES, LOCALE_NAMES, segments, t } from "./i18n";

/*
 * What these guard is the one failure a translated interface has that an
 * untranslated one does not: words that quietly stop agreeing with each other.
 *
 * A phrase renamed in English leaves four dictionaries pointing at nothing. A
 * placeholder translated along with the sentence around it — `{name}` becoming
 * `{名前}` — produces a label reading "Show {name} larger" with the braces
 * showing, in a language the person checking the build cannot read. Neither
 * fails a type check, neither throws, and both are invisible to whoever made
 * the change.
 */

const OTHERS = LOCALES.filter((locale) => locale !== "en");
const BASE = Object.keys(en);

/** The names inside the braces of a phrase, in order. */
function placeholders(template: string): string[] {
	return segments(template)
		.map((segment) => segment.value)
		.filter((value): value is string => value !== undefined)
		.sort();
}

describe.each(OTHERS)("%s", (locale) => {
	const dictionary = DICTIONARIES_FOR_TEST[locale] as Record<string, string>;

	it("says everything the interface can say", () => {
		const missing = BASE.filter((phrase) => !(phrase in dictionary));
		expect(missing).toEqual([]);
	});

	/*
	 * The other direction, which is the one that rots quietly: an entry for a
	 * phrase nobody says any more costs nothing at runtime and so survives every
	 * rename, until a dictionary is mostly archaeology.
	 */
	it("says nothing the interface no longer says", () => {
		const extra = Object.keys(dictionary).filter((phrase) => !BASE.includes(phrase));
		expect(extra).toEqual([]);
	});

	it("keeps every placeholder exactly as it was", () => {
		for (const [phrase, translated] of Object.entries(dictionary)) {
			expect(placeholders(translated), phrase).toEqual(placeholders(phrase));
		}
	});

	it("actually translates, rather than repeating the English", () => {
		// Proper nouns and single words can legitimately match. A dictionary that
		// matched throughout would be a file somebody created and never filled.
		const same = Object.entries(dictionary).filter(([phrase, value]) => phrase === value);
		expect(same.length).toBeLessThan(BASE.length / 4);
	});
});

describe("the vocabulary", () => {
	it("is used by name, so that nothing is said off the record", () => {
		// Every phrase reached through `t` is checked against this list by the
		// compiler. What cannot be checked is a component that skipped `t` and
		// wrote the words inline, which is what this looks for.
		const root = join(import.meta.dirname, "..");
		const suspicious: string[] = [];

		const walk = (directory: string) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);

				if (entry.isDirectory()) {
					// The management pages used to be skipped here, under a
					// paragraph explaining that they were English on purpose. They
					// were not: four of their panels held a hundred and eighty-eight
					// translated phrases and four held none, which is drift with a
					// justification written in front of it. src/manage/phrases.test.ts
					// says so at length and holds the finished state; this exemption
					// was what let the last handful of bare labels survive it.
					walk(path);
					continue;
				}
				if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;

				for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
					// A label given as a bare string, which is how every one of
					// these looked before they were collected into a dictionary.
					// The attribute names are listed rather than matched generally,
					// because most attributes carry class names and identifiers
					// rather than sentences. This list is short by accident and not
					// by design: `describes` was missing, and three sentences on the
					// panel that decides who may open a room sat untranslated beside
					// labels that were, for as long as it was.
					const bare = /(aria-label|placeholder|title|describes|label|heading|hint|note)="[A-Z]/.test(
						line,
					);
					if (bare) suspicious.push(`${entry.name}:${index + 1}`);
				}
			}
		};

		walk(root);
		expect(suspicious).toEqual([]);
	});

	it("names each language in itself", () => {
		// The one list read by somebody who cannot read the language it is
		// currently displayed in.
		for (const locale of LOCALES) {
			expect(LOCALE_NAMES[locale]).toBeTruthy();
		}
		expect(LOCALE_NAMES.ja).not.toMatch(/[A-Za-z]/);
		expect(LOCALE_NAMES["zh-Hant"]).not.toMatch(/[A-Za-z]/);
	});
});

describe("t", () => {
	it("falls back to a whole sentence rather than a key", () => {
		// English is the key, so an untranslated phrase reads as English rather
		// than as a dotted path somebody has to go and look up.
		expect(t("Nobody else is here.")).toBe("Nobody else is here.");
	});

	it("puts values where the phrase asks for them", () => {
		expect(t("Show {name} larger", { name: "Ada" })).toBe("Show Ada larger");
		expect(t("Device {number}", { number: 2 })).toBe("Device 2");
	});

	it("leaves a phrase alone when it carries nothing", () => {
		expect(t("Leave")).toBe("Leave");
	});
});

describe("segments", () => {
	it("cuts a phrase at its placeholders and keeps the rest", () => {
		const parts = segments("Joining as {name} with a signature");

		expect(parts.map((part) => part.value)).toEqual([undefined, "name", undefined]);
		expect(parts.map((part) => part.text).join("")).toBe("Joining as {name} with a signature");
	});

	it("handles a phrase that begins or ends with a value", () => {
		expect(segments("{name} joined").map((part) => part.value)).toEqual(["name", undefined]);
		expect(segments("Could not join {room}").map((part) => part.value)).toEqual([
			undefined,
			"room",
		]);
	});
});

/*
 * And the direction nobody was checking at all: English against the interface.
 *
 * The three tests above hold the other dictionaries to the English one, so a
 * phrase that stops being said is removed from three files and kept in the
 * fourth — where it is the key, so nothing is inconsistent and nothing fails.
 * Five had accumulated that way. Three belonged to a management panel deleted
 * months ago, one to a badge state whose own comment says it now draws nothing,
 * and one to a room description that was rewritten. Each was carried in four
 * languages, so five dead phrases were twenty dead lines and four translators'
 * worth of work spent on sentences no reader could reach.
 *
 * It costs nothing at runtime, which is exactly why it survives. An inventory
 * problem is checked by counting.
 */

/**
 * Phrases the interface never writes down, because it does not know them.
 *
 * Relay labels and region names are typed into a management page by whoever
 * runs the deployment and arrive at the client as data, so they go through
 * [say] rather than [t] and a search of the source cannot see them. A
 * deployment that calls a machine "Shanghai Telecom" gets that translated for
 * a reader in Japanese; one that calls it something else gets what was typed.
 *
 * Adding a place here is how a new one gets a translation. Nothing else is
 * allowed in: an entry in this list is a claim that something says the phrase,
 * and a wrong claim is how the five above survived.
 */
const SUPPLIED_BY_THE_DEPLOYMENT = [
	"Guangzhou Tencent",
	"Shanghai Tencent",
	"Shanghai Telecom",
	"Hong Kong",
	"China Mainland",
	"Oversea",
	"Asia",
	"Europe",
	"America",
	"cn-east",
	"cn-south",
	"cn-north",
	"cn-west",
	// Written with the slash because that is what a deployment types into the
	// region field, and say() looks the whole string up before it looks at any
	// part of it. "Oversea" and "Asia" being here separately does not translate
	// "Oversea/Asia" — it left the fleet page showing two of its four headings
	// in English while the other two were translated, which reads as a bug in
	// the page rather than as a gap in a list.
	"Oversea/Asia",
	"Oversea/America",
	"Shanghai",
	"Guangzhou",
	"Beijing",
	"Japan",
	"Singapore",
	"Taiwan",
	"Korea",
	"United States",
];

describe("the English dictionary", () => {
	it("says nothing the interface no longer says", () => {
		const root = join(import.meta.dirname, "..");

		const sources: string[] = [];
		const walk = (at: string) => {
			for (const entry of readdirSync(at, { withFileTypes: true })) {
				const path = join(at, entry.name);

				if (entry.isDirectory()) {
					if (entry.name !== "dictionaries") walk(path);
					continue;
				}

				if (/\.tsx?$/.test(entry.name)) sources.push(readFileSync(path, "utf8"));
			}
		};
		walk(root);

		const said = sources.join("\n");

		// Matched as a whole string literal rather than as a substring. A bare
		// includes() cleared every short phrase that happened to sit inside a
		// longer identifier somewhere, which is a check that reports the absence
		// of exactly the phrases short enough to be worth checking for.
		//
		// And nothing here may name a phrase in quotes: this file is walked like
		// any other, so a phrase written out in a comment is a phrase this
		// declares to be alive. It happened while this was being written.
		const unsaid = BASE.filter(
			(phrase) =>
				!SUPPLIED_BY_THE_DEPLOYMENT.includes(phrase) && !said.includes(JSON.stringify(phrase)),
		);

		expect(unsaid).toEqual([]);
	});
});

/*
 * A key written twice, which JavaScript resolves by keeping the last and
 * mentioning nothing.
 *
 * TypeScript does object to it, so this is not the only thing standing in the
 * way — but the compiler's message names a line number in a file of four
 * hundred and says the property is duplicated, which is a puzzle rather than an
 * answer. This names the phrase. It went in after adding a phrase that was
 * already there under a different heading and reading four of those messages.
 */
describe("every dictionary", () => {
	it.each(["en", ...OTHERS])("says each phrase once (%s)", (locale) => {
		const source = readFileSync(
			join(import.meta.dirname, "dictionaries", `${locale}.ts`),
			"utf8",
		);

		const seen = new Map<string, number>();
		for (const line of source.split("\n")) {
			// A key is quoted only where it has to be, so an identifier-shaped one
			// sits bare.
			const found = /^\t(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*)):/.exec(line);
			if (!found) continue;

			const key = found[1] ?? found[2] ?? "";
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}

		expect([...seen].filter(([, n]) => n > 1).map(([key]) => key)).toEqual([]);
	});
});
