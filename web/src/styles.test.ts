import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A class that does not exist is a class that does nothing, quietly.
 *
 * Every fault this file guards has the same shape and none of them could be
 * seen. A colour token that was never defined left eighty-two hover states with
 * no hover. An animation from a package that is not installed, and has never
 * been installed, left five menus cutting in and out. And the replacement for
 * that animation — this application's own, correctly named, present in the
 * stylesheet — was still dead, because Tailwind builds a variant's rule from a
 * utility declared with @utility and passes hand-written CSS through without
 * permuting it, so `data-[state=open]:animate-arrive` compiled to nothing while
 * `animate-arrive` compiled fine. Reading the source could not tell those two
 * apart. Nothing in the interface looked wrong in any of the three cases,
 * because a style that does not apply looks exactly like a style nobody wrote.
 *
 * So this reads the source rather than the rendering, which is the part a unit
 * test can honestly hold: every colour a class asks for is a token the theme
 * defines, and every animation is one this application declares in a form that
 * can carry a variant.
 */

const root = import.meta.dirname;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);

		if (entry.isDirectory()) return sources(path);

		return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

const css = readFileSync(join(root, "index.css"), "utf8");
const code = sources(root).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** The colour names the theme defines, which are the only ones that resolve. */
const defined = new Set([...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1] ?? ""));

describe("every colour a class asks for", () => {
	/*
	 * Only names that extend one this theme defines, which is narrow on purpose.
	 *
	 * A wider check — every bg-, text-, border- in the source — cannot be
	 * written without a list of everything Tailwind means by those prefixes,
	 * which is sizes, alignments, sides and weights as well as colours, and a
	 * test carrying that list is one that fails whenever Tailwind grows. The
	 * fault this guards is narrower and has a shape: somebody reaches for a
	 * variation of a token that exists — surface-2 beside surface — and the
	 * class compiles to nothing, because only surface was ever declared. That is
	 * what happened, eighty-two times, and it is what this catches.
	 */
	it("is one this theme defines, and not a variation of one", () => {
		const stems = [...defined].filter((name) => !name.includes("-"));
		const prefixes =
			"bg|text|border|ring|fill|stroke|from|to|via|outline|shadow|accent|caret|divide|placeholder";
		const missing: string[] = [];

		for (const { path, text } of code) {
			for (const stem of stems) {
				for (const [, name] of text.matchAll(
					new RegExp(`\\b(?:${prefixes})-(${stem}-[a-z0-9-]+)`, "g"),
				)) {
					if (!name || defined.has(name)) continue;

					missing.push(`${path.replace(root, "")}: ${name}`);
				}
			}
		}

		expect(
			[...new Set(missing)],
			"these extend a token this theme defines and are not themselves defined, so they " +
				"compile to nothing and the style silently does not apply",
		).toEqual([]);
	});
});

describe("every colour named for what it means", () => {
	/*
	 * The other half of the same fault: a name that extends nothing, reached for
	 * because it is what a colour for that purpose is called somewhere else.
	 *
	 * The button that lets somebody in from the door asked for `bg-ok` and the
	 * host's crown for `text-warn`, and this theme has neither. The button
	 * rendered as dark text on no background at all, which a host looking for
	 * a way to admit somebody read as there being only "Not now"; the crown
	 * that is coloured so a knock is seen out of the corner of an eye was never
	 * coloured. Neither looked broken, because a missing colour looks like a
	 * plain one. A list of the names such colours go by elsewhere is short and
	 * does not grow with Tailwind, which is why it is a list.
	 */
	it("is one this theme defines", () => {
		const meanings = "ok|warn|warning|success|error|info|positive|negative|caution|alert|attention|primary|secondary";
		const prefixes = "bg|text|border|ring|fill|stroke|outline|accent|caret|divide|from|to|via";
		const missing: string[] = [];

		for (const { path, text } of code) {
			for (const [, name] of text.matchAll(
				new RegExp(`(?<![\\w-])(?:${prefixes})-(${meanings})(?![\\w-])`, "g"),
			)) {
				if (!name || defined.has(name)) continue;

				missing.push(`${path.replace(root, "")}: ${name}`);
			}
		}

		expect(
			[...new Set(missing)],
			"these name a colour this theme does not define, so they compile to nothing",
		).toEqual([]);
	});
});

describe("every animation a class asks for", () => {
	/** Declared with @utility, which is what makes a variant of it possible. */
	const utilities = new Set([...css.matchAll(/@utility\s+(animate-[a-z-]+)/g)].map((m) => m[1] ?? ""));

	it("is declared here rather than by a package that is not installed", () => {
		const foreign = code.flatMap(({ path, text }) =>
			[...text.matchAll(/\b(animate-in|animate-out|fade-in-\d|fade-out-\d|zoom-in-\d+|slide-in-from-[a-z-]+)\b/g)]
				// Named in prose, which is how the removal is explained.
				.filter((m) => !text.slice(0, m.index).endsWith("// ") && !/\/\/[^\n]*$/.test(text.slice(0, m.index).split("\n").pop() ?? ""))
				.map((m) => `${path.replace(root, "")}: ${m[1]}`),
		);

		expect(foreign, "tailwindcss-animate is not a dependency and these compile to nothing").toEqual([]);
	});

	it("is declared with @utility wherever a variant is applied to it", () => {
		const dead: string[] = [];

		for (const { path, text } of code) {
			for (const [, animation] of text.matchAll(/[a-z0-9\]]:(animate-[a-z-]+)/g)) {
				if (!animation || utilities.has(animation)) continue;

				dead.push(`${path.replace(root, "")}: ${animation}`);
			}
		}

		expect(
			dead,
			"a variant is only generated for a utility declared with @utility; a plain rule in " +
				"@layer utilities is passed through and never permuted, so this compiles to nothing",
		).toEqual([]);
	});
});

/*
That the controls, when they are down the side, have the side to themselves.

Five things float at the right of a room — the paging arrows, the reaction
bubbles, the messages card, the sound panel, and the list of who has a share
open — and every one of them was written at right-3 by somebody who did not know
the control island could be moved there. Choosing the side put the bar through
all five. Measured before the fix: the messages card ran from y 472 to 888 and
the bar from 253 to 648, so the card covered the lower half of the controls,
leaving included.

One margin fixes all five, because they are all positioned against the same
element. That is also what makes it worth a test: five components depend on one
line in a sixth, none of them mentions it, and deleting it breaks nothing that
any of them can see. The failure is a button underneath a card.
*/
describe("the controls' lane", () => {
	it("is reserved by the stage rather than by the things that would sit in it", () => {
		const room = code.find(({ path }) => path.endsWith("routes/Room.tsx"));

		expect(room, "Room.tsx has moved").toBeTruthy();

		expect(
			/aside && "mr-\[/.test(room?.text ?? ""),
			"the stage no longer gives up a margin when the controls are down the side, so " +
				"everything anchored to the right edge is drawing on top of them again",
		).toBe(true);
	});
});

/*
 * A rule written against a library's own styles, that loses to them.
 *
 * Sonner injects its stylesheet at runtime, outside every cascade layer, and
 * writes its offsets as inline custom properties on the toaster. A rule of ours
 * inside `@layer` loses to the first whatever its specificity, and a custom
 * property of ours loses to the second whatever its layer. Both had happened:
 * the rule meant to lift notices clear of the call's controls set
 * `--mobile-offset-bottom` from inside the utilities layer and never applied, so
 * notices sat over the hang-up button on every phone (2026-10-14); and the width
 * of the column beside it had been lost the same way without anybody noticing.
 * Neither looked wrong in the source, and a unit test cannot run the cascade,
 * so this holds the two conditions that make such a rule able to apply at all.
 */
describe("a rule aimed at the notices' own elements", () => {
	/** Every block in the stylesheet, with the headers of the blocks around it. */
	function blocks(text: string) {
		const found: { header: string; within: string[]; body: string }[] = [];
		const open: { header: string; start: number }[] = [];
		let since = 0;

		for (let at = 0; at < text.length; at++) {
			const char = text[at];
			if (char === "{") {
				open.push({ header: text.slice(since, at).replace(/\/\*[\s\S]*?\*\//g, "").trim(), start: at + 1 });
				since = at + 1;
			} else if (char === "}") {
				const block = open.pop();
				if (block) found.push({ header: block.header, within: open.map((one) => one.header), body: text.slice(block.start, at) });
				since = at + 1;
			} else if (char === ";") {
				since = at + 1;
			}
		}

		return found;
	}

	const aimed = blocks(css).filter((block) => block.header.includes("data-sonner-toaster"));

	it("is found, so that the checks below are checking something", () => {
		expect(aimed.length).toBeGreaterThanOrEqual(2);
	});

	it("is outside every layer, where the library's own rules are", () => {
		const layered = aimed.filter((block) => block.within.some((header) => header.startsWith("@layer")));
		expect(layered.map((block) => block.header)).toEqual([]);
	});

	it("does not try to set an offset the library writes inline", () => {
		const overridden = aimed.filter((block) => /--(mobile-)?offset-/.test(block.body));
		expect(overridden.map((block) => block.header)).toEqual([]);
	});
});
