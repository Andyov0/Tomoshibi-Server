import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * What this guards is twelve megabytes nobody noticed.
 *
 * A noise-cancellation package sat in the manifest for weeks without a single
 * import: installed, resolved, fetched by everybody who ever cloned this, and
 * reaching no line of code. A router did the same in a client that parses its
 * own address bar. Neither made anything slower — an unimported package is not
 * bundled — and that is precisely why neither was found. Nothing was wrong.
 *
 * It is not a build problem, so a build cannot catch it. It is an inventory
 * problem, and an inventory is checked by counting.
 */

const root = join(import.meta.dirname, "..");

/**
 * Packages used somewhere other than by importing them, which a search of the
 * source cannot see.
 *
 * Each needs a reason. "It might be useful" is what an unused dependency
 * always says for itself.
 */
const OTHERWISE_USED: Record<string, string> = {
	react: "JSX compiles to it without the file saying so",
	"react-dom": "reached through react-dom/client, and by the runtime",
	"tailwind-merge": "used through the cn helper, which imports it",
	clsx: "the other half of cn",
};

/** Everything the manifest says this project depends on. */
function declared(): string[] {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};

	return Object.keys(manifest.dependencies ?? {});
}

/** Every module named in an import anywhere in the source. */
function imported(): Set<string> {
	const found = new Set<string>();
	// Matches both static imports and the dynamic and side-effect forms, since
	// a package pulled in for its stylesheet alone is still a dependency.
	//
	// A module specifier holds no whitespace, and saying so is what keeps this
	// from reading English. The word "from" happens to end sentences, and a test
	// named for one ending in it — followed, as everything in a source file is,
	// by a quote — was being reported as a package nobody had installed.
	const pattern = /(?:from|import)\s*\(?\s*["']([^"'.\s][^"'\s]*)["']/g;

	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);

			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;

			for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
				const specifier = match[1];
				if (!specifier) continue;

				// `uplot/dist/uPlot.min.css` is the uplot dependency; `@livekit/x`
				// is two segments before it stops being a name.
				// The build aliases a bare `@` to the source directory, so
				// anything under it is this repository rather than a package.
				if (specifier.startsWith("@/")) continue;

				const parts = specifier.split("/");
				found.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
			}
		}
	};

	walk(join(root, "src"));

	return found;
}

describe("dependencies", () => {
	it("are all reached by something", () => {
		const used = imported();

		const idle = declared().filter((name) => !used.has(name) && !(name in OTHERWISE_USED));

		expect(idle, "declared but imported nowhere").toEqual([]);
	});

	/*
	 * The other direction. An import of something the manifest does not declare
	 * works for as long as another package happens to bring it, and stops the
	 * day that package tidies its own tree — on somebody else's machine, at
	 * install time, with an error naming a module this repository never chose.
	 */
	it("cover everything the source reaches for", () => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		const available = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
		]);

		const undeclared = [...imported()].filter(
			(name) => !available.has(name) && !name.startsWith("node:"),
		);

		expect(undeclared, "imported but declared nowhere").toEqual([]);
	});

	it("names a reason for anything kept without an import", () => {
		// The exemption list is where an unused dependency would hide, so it is
		// held to the same standard: every entry has to still be declared.
		const names = new Set(declared());

		for (const name of Object.keys(OTHERWISE_USED)) {
			expect(names.has(name), `${name} is exempted but no longer declared`).toBe(true);
		}
	});
});
