import type { ReactNode } from "react";

/*
Flags, drawn rather than typed.

The relay labels lean on flag emoji, and on Windows there are none: the font has
no glyph for a pair of regional indicators, so the pair falls back to what it
literally is and "🇨🇳Shanghai CT" arrives as "CNShanghai CT". Nothing is broken and
nothing says so — the geography, which on a list of eleven machines is the fastest
thing to read, is simply gone for everybody on the platform most people use.

So the pairs are replaced with pictures. Twemoji's own artwork, served from this
deployment rather than from a public CDN: a page that reaches out to jsdelivr to
draw a flag is a page that does not draw one behind a firewall that blocks it,
which is precisely where the people using this deployment are. All 259 of them
live in the binary, and a browser fetches the two or three it actually shows.

Every platform, not only the ones missing glyphs. It could be done by detection —
Apple has flags, Windows does not — and consistency is worth more than the request
saved: the same relay should look the same to everybody in a call talking about
it, and a feature test for glyph coverage is a thing that goes quietly wrong on
some browser nobody has.
*/

/**
 * A pair of regional indicator symbols, which is what a flag emoji is.
 *
 * Matched as a pair rather than singly. One on its own is not a flag and is a
 * letter somebody may legitimately have typed; two together are a country.
 */
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/** The two letters a pair stands for. */
function code(pair: string): string {
	return [...pair].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join("");
}

/**
 * A label with its flags drawn.
 *
 * Text either side is left exactly as it was, including the absence of a space
 * after the flag — that is how the operator typed it, and tidying somebody's
 * label while displaying it is how a name comes to differ from itself between
 * two screens.
 */
export function Flagged({ text }: { text: string }): ReactNode {
	if (!text) return null;

	const parts: ReactNode[] = [];
	let at = 0;

	for (const found of text.matchAll(FLAG)) {
		const start = found.index;

		if (start > at) parts.push(text.slice(at, start));

		const cc = code(found[0]);

		parts.push(
			<img
				key={`${start}${cc}`}
				src={`/flags/${cc.toLowerCase()}.svg`}
				alt=""
				// Sized in ems so it rides with whatever text it is beside, and
				// nudged down because a glyph's baseline is not its bottom edge.
				// Empty alt because the name it sits against already says the
				// place: read aloud, the flag would be the country said twice.
				className="inline-block h-[1em] w-[1.3em] align-[-0.15em] object-contain"
			/>,
		);

		at = start + found[0].length;
	}

	if (at === 0) return text;

	if (at < text.length) parts.push(text.slice(at));

	return parts;
}
