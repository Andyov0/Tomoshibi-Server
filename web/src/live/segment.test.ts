import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/*
 * That the segmentation runtime committed here is the one the code will ask for.
 *
 * Background blur runs MediaPipe, and MediaPipe's runtime cannot be fetched
 * from where it is published: jsdelivr and Google's storage are both
 * unreachable from mainland China, which is where most of the people using this
 * deployment are. So it is committed, under web/public/segment, and served from
 * the deployment itself.
 *
 * Committed files go stale silently. `@livekit/track-processors` pins the
 * version of `@mediapipe/tasks-vision` whose API it calls; when that pin moves,
 * the runtime in this repository is the old one and the glue calling it is the
 * new one, and what somebody sees is blur that does not come on. There is no
 * error worth reading — the loader fails inside a worker.
 *
 * So the pin is read from the installed package and compared against what was
 * vendored. A mismatch here means: follow the instructions in live/blur.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** The version the committed runtime came from. */
const VENDORED = "0.10.14";

it("vendors the MediaPipe runtime the processors were built against", () => {
	const manifest = JSON.parse(
		readFileSync(join(root, "node_modules/@livekit/track-processors/package.json"), "utf8"),
	) as { dependencies?: Record<string, string> };

	const pinned = manifest.dependencies?.["@mediapipe/tasks-vision"];

	expect(pinned, "track-processors no longer names a tasks-vision version").toBeTruthy();
	expect(
		pinned?.replace(/^[\^~]/, ""),
		"the committed runtime under public/segment is from a different version of " +
			"@mediapipe/tasks-vision than the processors call. See the refresh steps in live/blur.ts",
	).toBe(VENDORED);
});

/*
 * And that the three files are actually there.
 *
 * They are large, they are binary, and they are exactly the kind of thing a
 * .gitignore rule swallows without saying anything. Missing, the feature is a
 * switch that turns nothing on.
 */
it("carries the runtime, the loader and the model", () => {
	for (const [name, least] of [
		["vision_wasm_internal.js", 100_000],
		["vision_wasm_internal.wasm.br", 1_000_000],
		["selfie_segmenter.tflite", 100_000],
	] as const) {
		const at = join(root, "public/segment", name);

		expect(() => statSync(at), `public/segment/${name} is missing`).not.toThrow();
		expect(statSync(at).size, `public/segment/${name} is too small to be the real file`).toBeGreaterThan(least);
	}
});
