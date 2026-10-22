import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REACTIONS, REACTION_FOR } from "./hands";

/*
 * The two halves are different kinds of thing, and the difference is the design.
 *
 * A raised hand is state: true until lowered, visible to somebody who joins ten
 * minutes later, and gone when that browser closes. That is an attribute, which
 * travels with the roster and needs nothing to expire it.
 *
 * A reaction is an event: it happened, it was seen, it is over. Nobody arriving
 * afterwards should be shown a thumbs-up from before they got there, and
 * reacting twice is two reactions rather than one that is still true. That is a
 * data message.
 *
 * Sending either the other way round is a real fault rather than a preference:
 * a hand as an event is invisible to late arrivals and needs a heartbeat, and a
 * reaction as state is a thumbs-up stuck to a tile for the rest of the call.
 * These assert the shape of the module against that, because the mistake is
 * made in the transport rather than in the rendering.
 */
describe("hands and reactions", () => {
	it("keeps a hand as an attribute and a reaction as a message", () => {
		const source = readFileSync(join(import.meta.dirname, "hands.ts"), "utf8");

		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

		expect(code).toMatch(/setAttributes\(\{\s*\[RAISED\]/);
		expect(code).toMatch(/publishData\(payload,\s*\{[^}]*topic:\s*REACTION/);

		// And not the other way round, which is the mistake worth a test.
		expect(code).not.toMatch(/publishData[^)]*RAISED/);
		expect(code).not.toMatch(/setAttributes[^)]*REACTION\b/);
	});

	it("offers a short list of reactions rather than any text at all", () => {
		expect(REACTIONS.length).toBeGreaterThan(0);
		expect(REACTIONS.length).toBeLessThanOrEqual(8);

		// Each is one glyph a tile badge can hold. A picker that took anything
		// would be a way to put arbitrary text on somebody else's screen.
		for (const one of REACTIONS) {
			expect([...one].length).toBeLessThanOrEqual(3);
		}
	});

	it("shows a reaction for long enough to be seen and not long enough to linger", () => {
		expect(REACTION_FOR).toBeGreaterThanOrEqual(2000);
		expect(REACTION_FOR).toBeLessThanOrEqual(8000);
	});
});
