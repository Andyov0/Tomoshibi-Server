import en from "./dictionaries/en";
import ja from "./dictionaries/ja";
import hans from "./dictionaries/zh-Hans";
import hant from "./dictionaries/zh-Hant";
import { keep, recall } from "@/lib/storage";

/**
 * What the interface says, in the language of whoever is reading it.
 *
 * No framework. The whole of what this application needs from one is a lookup
 * and a substitution: seventy short phrases, five of which carry a value, and
 * not a single one that changes shape with a number. A library would bring
 * plural rules for languages that have none here, a loader for dictionaries
 * already in the bundle, and a namespace scheme for a vocabulary that fits on
 * two screens — machinery heavier than the thing it manages.
 *
 * The current language is held here rather than in a React context, and that is
 * deliberate. Notices are raised from event handlers that no component owns: a
 * person arriving, a device refused, sound the browser would not start. Those
 * need the same words as everything else, and a context cannot reach them.
 */

/** Every language the interface is written in. */
export const LOCALES = ["en", "zh-Hans", "zh-Hant", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

/** What each calls itself. Never translated: a language picker is read by
 * somebody who cannot yet read the current language. */
export const LOCALE_NAMES: Record<Locale, string> = {
	en: "English",
	"zh-Hans": "简体中文",
	"zh-Hant": "繁體中文",
	ja: "日本語",
};

/**
 * A dictionary is the English phrase mapped to its translation.
 *
 * Keyed by the English rather than by a name like `controls.share.label`,
 * because the key is then also the fallback. A missing translation shows a
 * whole sentence in another language instead of a dotted path, which is the
 * failure everybody has shipped at least once. It also means a component reads
 * as the thing it says.
 */
export type Dictionary = Partial<Record<Phrase, string>>;

/** Every phrase the interface can say, taken from the English it says it in. */
export type Phrase = keyof typeof en;

const DICTIONARIES: Record<Locale, Dictionary> = {
	en,
	"zh-Hans": hans,
	"zh-Hant": hant,
	ja,
};

/*
 * The keys below still say the name this was called before.
 *
 * Deliberate, and not an oversight to tidy. They are what a browser already has
 * written down: a display name, a device choice, a language, an identity that
 * keeps somebody the same person across a reload. Renaming them renames nothing
 * — it abandons all of it, and everybody using this finds themselves nameless
 * and back in English on the morning after a deployment.
 */
const STORED = "meet-live.locale";

/**
 * Which language to open in.
 *
 * A choice already made outranks everything. Failing that the browser is asked,
 * and asked in order: `navigator.languages` is a preference list, and somebody
 * who lists Japanese before English means it.
 *
 * Matching is by prefix so that `zh-CN`, `zh-SG` and `zh` all reach simplified
 * Chinese while `zh-TW` and `zh-HK` reach traditional, which is the distinction
 * that actually matters to a reader and the one a bare language tag loses.
 */
function detect(): Locale {
	const chosen = read();
	if (chosen) return chosen;

	for (const tag of navigator.languages ?? [navigator.language]) {
		const lower = tag.toLowerCase();

		if (lower.startsWith("ja")) return "ja";
		if (lower.startsWith("zh")) {
			return /hant|tw|hk|mo/.test(lower) ? "zh-Hant" : "zh-Hans";
		}
		if (lower.startsWith("en")) return "en";
	}

	return "en";
}

function read(): Locale | undefined {
	try {
		const stored = recall(STORED);
		return LOCALES.find((candidate) => candidate === stored);
	} catch {
		// Storage is refused in some privacy modes, which is a preference nobody
		// recorded rather than an error worth reporting.
		return undefined;
	}
}

let current: Locale = "en";
const listeners = new Set<() => void>();

/** The language in use. */
export function locale(): Locale {
	return current;
}

/**
 * Change language, and say so.
 *
 * The document's own `lang` follows, because it is not decoration: a screen
 * reader picks its voice from it, and a browser picks line breaking and font
 * fallback from it. A page of Japanese labelled English is read aloud wrongly.
 */
export function setLocale(next: Locale): void {
	if (next === current) return;
	current = next;

	document.documentElement.lang = next;
	try {
		keep(STORED, next);
	} catch {
		// A language that lasts one session is better than none at all.
	}

	for (const listener of listeners) listener();
}

/** Watch for a change of language. Returns a function that stops watching. */
export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Settle on a language before anything is drawn in the wrong one. */
export function start(): void {
	current = detect();
	document.documentElement.lang = current;
}

/** Values a phrase may carry. */
export type Values = Record<string, string | number>;

/**
 * Say something.
 *
 * A phrase with no translation falls back to the English it is keyed by, which
 * is a whole sentence rather than a placeholder, so an incomplete dictionary
 * degrades into a mixed interface instead of a broken one.
 */
/**
 * Translate a string that only exists at runtime.
 *
 * For text the deployment supplies rather than the interface: a relay's label,
 * typed into a management page by whoever runs this. It cannot be typed as a
 * Phrase, because nobody knew it when the code was written — but a deployment
 * that labels a machine with something this application already says should get
 * the reader's own language for free, and one that labels it anything else
 * should get exactly what was typed.
 *
 * Kept apart from [t] rather than widening it. Losing the compiler's check on
 * every ordinary phrase to accommodate the handful that cannot have one would
 * trade a whole class of caught mistakes for a convenience.
 */
export function say(text: string): string {
	const dictionary = DICTIONARIES[current] as Record<string, string | undefined>;

	const exact = dictionary[text];
	if (exact !== undefined) return exact;

	// Then ignoring case, because this text was typed by a person into a field
	// and "CN-East", "cn-east" and "CN-EAST" are the same place. Requiring them
	// to have typed it exactly as the dictionary spells it would make the
	// translation a trick you had to know, and the untranslated half only shows
	// up for readers of the other languages — which is to say, not for whoever
	// typed it.
	const folded = text.toLowerCase();
	for (const key of Object.keys(dictionary)) {
		if (key.toLowerCase() === folded) return dictionary[key] ?? text;
	}

	return text;
}

export function t(phrase: Phrase, values?: Values): string {
	const template = DICTIONARIES[current][phrase] ?? phrase;
	if (!values) return template;

	return segments(template)
		.map((part) => (part.value === undefined ? part.text : String(values[part.value] ?? "")))
		.join("");
}

/** A piece of a phrase: either literal text, or the name of a value. */
export interface Segment {
	text: string;
	/** The name inside the braces, when this piece is one. */
	value?: string;
}

/**
 * Cut a phrase at its placeholders.
 *
 * Exposed because some phrases carry something that is not text — a name in
 * bold, a key drawn as a key. Those cannot be assembled by concatenating
 * translated fragments: word order is the first thing a translation changes, and
 * a sentence split into "Joining as" and "with a signature" can only be
 * reassembled in English. Cutting the finished translation instead lets the
 * value land wherever that language puts it.
 */
export function segments(template: string): Segment[] {
	const parts: Segment[] = [];
	const pattern = /\{(\w+)\}/g;
	let index = 0;

	for (let match = pattern.exec(template); match; match = pattern.exec(template)) {
		if (match.index > index) parts.push({ text: template.slice(index, match.index) });
		parts.push({ text: match[0], value: match[1] });
		index = match.index + match[0].length;
	}

	if (index < template.length) parts.push({ text: template.slice(index) });

	return parts;
}

/** The finished translation of a phrase, cut at its placeholders. */
export function phraseSegments(phrase: Phrase): Segment[] {
	return segments(DICTIONARIES[current][phrase] ?? phrase);
}

/** Every dictionary, for the tests that keep them in step with each other. */
export const DICTIONARIES_FOR_TEST = DICTIONARIES;
