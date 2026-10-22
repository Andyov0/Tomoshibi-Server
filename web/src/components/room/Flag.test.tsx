import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Flagged } from "./Flag";

/*
What this guards is a label coming out wrong on one platform and right on every
other, which is the class of fault nobody who builds the thing ever sees.

Windows has no glyph for a pair of regional indicators, so "🇨🇳Shanghai CT" arrives
there as "CNShanghai CT" — not an error, not logged, and the geography gone for
most of the people looking. The pairs are replaced with pictures, and the two ways
that can go wrong are dropping the words around them and mangling text that merely
contains letters.
*/

describe("Flagged", () => {
	const drawn = (text: string) => render(<span>{Flagged({ text })}</span>).container;

	it("draws the flag and keeps every character around it", () => {
		const at = drawn("🇨🇳Shanghai CT");

		expect(at.querySelector("img")?.getAttribute("src")).toBe("/flags/cn.svg");

		// Including the missing space, which is how the operator typed it. A
		// label tidied on the way to the screen is a label that differs from
		// itself between two pages.
		expect(at.textContent).toBe("Shanghai CT");
	});

	it("leaves text with no flag in it completely alone", () => {
		const at = drawn("Shanghai CT");

		expect(at.querySelector("img")).toBeNull();
		expect(at.textContent).toBe("Shanghai CT");
	});

	it("does not mistake a single indicator for a flag", () => {
		// One is not a country. Left as it was rather than guessed at, or a label
		// with an odd number of them would swallow the letter after it.
		const at = drawn("\u{1F1E8} alone");

		expect(at.querySelector("img")).toBeNull();
	});

	it("draws several, and the text between them", () => {
		const at = drawn("🇭🇰 to 🇸🇬");

		expect([...at.querySelectorAll("img")].map((one) => one.getAttribute("src"))).toEqual([
			"/flags/hk.svg",
			"/flags/sg.svg",
		]);

		expect(at.textContent).toBe(" to ");
	});
});
