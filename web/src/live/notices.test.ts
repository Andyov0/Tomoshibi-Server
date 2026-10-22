import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * What this guards is a fourth way of saying something went wrong.
 *
 * There were three. Toasts in the room; a red bar the first screen kept for
 * itself, because the toasts lived inside the room and this happened before
 * there was one; and a banner the management pages invented, having no toasts
 * at all. Each was reasonable where it was written. Together they meant a
 * person saw a different shape depending on which screen they were on when it
 * broke.
 *
 * One rule, and it is about lifetime rather than severity. Something that
 * happened fades; something still true stays. Neither is a bare element some
 * component drew for one occasion, and that is what this looks for.
 */

const root = join(import.meta.dirname, "..");

function sources(): { path: string; text: string }[] {
	const found: { path: string; text: string }[] = [];

	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);

			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;

			found.push({ path: entry.name, text: readFileSync(path, "utf8") });
		}
	};

	walk(root);

	return found;
}

describe("notices", () => {
	it("are the only thing that raises one", () => {
		// Reaching for the library directly is how the shapes diverged the first
		// time: each caller picked its own duration, its own colour, and its own
		// idea of whether the thing stayed.
		const direct = sources()
			.filter(({ text }) => /from ["']sonner["']/.test(text))
			.map(({ path }) => path)
			.filter((path) => path !== "Notices.tsx");

		expect(direct, "importing sonner rather than the notices").toEqual([]);
	});

	it("leave no hand-drawn error of their own", () => {
		// The bar that used to sit at the bottom of the first screen: a fixed
		// element, the danger colour, and text nobody could dismiss.
		const drawn = sources()
			.filter(({ text }) => /(fixed|absolute)[^"']*bg-danger(?!\/)/.test(text))
			.map(({ path }) => path);

		expect(drawn, "an error drawn in place rather than raised").toEqual([]);
	});
});
