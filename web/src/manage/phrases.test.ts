import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
The management pages, and the sentence they say when something goes wrong.

For a long time a comment here claimed these pages were English on purpose. That
was not the state they were in: four panels held a hundred and eighty-eight
translated phrases and four held none, and the file that turns a refusal into a
sentence had no dictionary import at all — so a duplicate account name read as
"HTTP 409" while the panel beside it spoke four languages. The claim was not a
policy; it was drift with a paragraph in front of it.

These guard the finished state. They read the source rather than the rendering,
which is the part a unit test can honestly hold: nothing here says a sentence
without going through the dictionary, and nothing subscribes to the language
without also being able to say something.
*/

const root = join(import.meta.dirname);

const sources = readdirSync(root)
	.filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
	.map((name) => ({ name, text: readFileSync(join(root, name), "utf8") }));

describe("every sentence the management pages show", () => {
	it("goes through the dictionary", () => {
		const raw: string[] = [];

		for (const { name, text } of sources) {
			// Text sitting directly between tags, which is the shape a sentence
			// takes when somebody writes it where it appears.
			//
			// A generic looks the same to a regular expression — Promise<void>
			// is an angle bracket, a capital, and a lowercase run — so a match
			// has to contain a space or end a sentence to count as one. That is
			// a heuristic, and the alternative is parsing TypeScript to find
			// four strings.
			for (const [, said] of text.matchAll(/>\s*([A-Z][^<>{}\n]{3,})\s*</g)) {
				const words = said?.trim() ?? "";
				if (!/[a-z]/.test(words)) continue;
				if (!words.includes(" ") && !/[.!?]$/.test(words)) continue;

				raw.push(`${name}: ${words}`);
			}
		}

		expect(raw, "these are written where they are shown rather than in the dictionaries").toEqual(
			[],
		);
	});

	it("is said by something that follows the language", () => {
		const deaf: string[] = [];

		for (const { name, text } of sources) {
			// The plain translator reads the current language and does not
			// re-render when it changes, so a page importing it has a language
			// picker that appears to do nothing.
			// Assembled rather than written out, because dependencies.test.ts
			// reads every from-"..." in the source and would take this pattern
			// for a package this file imports.
			const plain = new RegExp(`import \\{[^}]*\\bt\\b[^}]*\\} from "@/live/${"i18n"}"`);

			if (plain.test(text)) {
				deaf.push(`${name}: imports t directly instead of useT`);
			}
		}

		expect(deaf, "a component that translates has to subscribe, or the picker is inert").toEqual(
			[],
		);
	});
});
