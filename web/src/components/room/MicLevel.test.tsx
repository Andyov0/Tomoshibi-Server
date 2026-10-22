import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The meter is animated with one property, and only one.
 *
 * Tailwind v4 writes its scale utilities to the `scale` property —
 * `.scale-x-0` compiles to `scale: 0% var(--tw-scale-y)` — while the metering
 * loop writes `transform: scaleX(n)` sixty times a second. Those are two
 * different properties and the browser applies both, so a class saying "zero"
 * multiplied whatever the loop wrote and the fill was invisible at every
 * volume.
 *
 * What that looks like is not a missing bar. The track behind the fill is still
 * drawn, so the screen shows a full-width bar that never moves, next to a label
 * reading "Hearing you" — because the wording comes from state and only the bar
 * was written the other way. It reads as a meter that is broken at measuring
 * rather than one that is not being drawn.
 *
 * Asserted against the source because that is where the mistake is legible: the
 * class name looks exactly right, and the two halves are forty lines apart.
 */
describe("the microphone meter", () => {
	const source = readFileSync(join(import.meta.dirname, "MicLevel.tsx"), "utf8");

	// Without the prose. The comment explaining this names the class it is
	// warning about, and an assertion that reads the whole file fails on the
	// explanation — which is the test being right about the letters and wrong
	// about the thing.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

	it("does not mix a scale utility with a transform it writes itself", () => {
		expect(code).toMatch(/style\.transform\s*=\s*`scaleX/);
		expect(code).not.toMatch(/scale-x-\d/);
	});

	it("starts at nothing, so the fill is not full before anybody speaks", () => {
		expect(code).toMatch(/transform:\s*"scaleX\(0\)"/);
	});
});
