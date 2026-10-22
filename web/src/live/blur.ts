import { BackgroundProcessor, supportsBackgroundProcessors } from "@livekit/track-processors";
import type { LocalVideoTrack } from "livekit-client";
import { blurWanted, rememberBlur } from "./preferences";

/**
 * Blurring whatever is behind somebody.
 *
 * A person joining from a kitchen, a bedroom or an office with other people's
 * screens in it is choosing between showing that and turning the camera off,
 * and most of them turn the camera off. That is the whole reason this exists.
 *
 * ## Where the model comes from, which is the entire difficulty
 *
 * Segmentation is MediaPipe's, run through livekit's track processors. Left
 * alone that package fetches two things at runtime: its WebAssembly runtime
 * from jsdelivr and the model from Google's storage. Neither host answers from
 * mainland China, which is where most of the people using this deployment are,
 * so the ordinary integration is one that works everywhere it was tested and
 * nowhere it is used — and fails as a spinner rather than as an error, because
 * a fetch that never completes is not a fetch that failed.
 *
 * So both are served from this deployment, out of `web/public/segment`, and
 * `assetPaths` below is what points at them. They are committed rather than
 * downloaded during the build for the same reason: a build that reaches those
 * hosts is a build that cannot be run from the machines this is developed on.
 *
 * The runtime is nine megabytes and is stored compressed, at about two. See
 * `internal/app/web.go` — the server serves `.br` under the real name, which
 * exists for this file.
 *
 * ### Refreshing them
 *
 * The runtime has to match the version `@livekit/track-processors` imports,
 * and `segment.test.ts` fails if the two drift. To bring them forward:
 *
 * ```
 * pnpm add -D @mediapipe/tasks-vision@<the pinned version>
 * cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js public/segment/
 * brotli -q 11 -o public/segment/vision_wasm_internal.wasm.br \
 *   node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm
 * pnpm remove @mediapipe/tasks-vision
 * ```
 *
 * It is removed again afterwards because nothing in this source imports it —
 * the package is track-processors' own dependency, and declaring it here would
 * be a line in the manifest that no import justifies.
 *
 * Only the SIMD build is kept. MediaPipe asks for a `nosimd` one where the
 * browser has no WebAssembly SIMD, which no browser that can hold a video call
 * has lacked since 2021; shipping a second nine-megabyte runtime for that case
 * is nine megabytes copied to every relay for nobody.
 */

/** Where the runtime and the model are served from. */
const ASSETS = {
	tasksVisionFileSet: "/segment",
	modelAssetPath: "/segment/selfie_segmenter.tflite",
};

/**
 * How much to blur.
 *
 * Enough that a room is unreadable and not so much that the edge of somebody's
 * hair becomes a smear. The package's own default is lower and leaves a kitchen
 * legible, which is not what anybody turning this on is asking for.
 */
const RADIUS = 12;

/**
 * Fetch the runtime and the model before anybody asks for them.
 *
 * Installing a processor whose runtime is still arriving, in a call that is
 * already running, produces a canvas track that never draws a frame — the
 * install reports success, the picture goes to nothing, and turning blur off
 * again does not bring it back. It is a timing fault and nothing else: the same
 * browser, the same room and the same code work when the files are already in
 * its cache and fail when they are not, which is why it never appeared in
 * development and appeared every time on a deployment.
 *
 * So the wait is moved off the switch. This is called when a call starts, costs
 * one fetch of the same bytes somebody would have paid for on their first press,
 * and leaves the press itself instant.
 *
 * Failures are ignored on purpose. This is a head start, not a requirement; the
 * check in blur below is what makes a cold install safe.
 */
export async function warm(): Promise<void> {
	if (!possible()) return;

	try {
		await Promise.all(
			[
				`${ASSETS.tasksVisionFileSet}/vision_wasm_internal.js`,
				`${ASSETS.tasksVisionFileSet}/vision_wasm_internal.wasm`,
				ASSETS.modelAssetPath,
			].map((at) => fetch(at, { cache: "force-cache" })),
		);
	} catch {
		// An offline browser, or a deployment not serving these. The switch is
		// still offered and still checks its own work.
	}
}

/** Whether this browser can do it at all. */
export function possible(): boolean {
	try {
		return supportsBackgroundProcessors();
	} catch {
		return false;
	}
}

/**
 * Whether this browser was asked to blur, so it does not have to be asked again.
 *
 * Kept in preferences.ts, which the account page also writes, so that the page
 * offering the setting ahead of a call does not have to load this file — and
 * with it the segmentation runtime — to learn which key it is.
 */
export const wanted = blurWanted;
export const remember = rememberBlur;

/**
 * Turn it on or off for one camera track.
 *
 * Answers whether the picture is blurred now, rather than whether the press
 * worked, so a caller that asked for blur and did not get it can say so and
 * put its switch back. The first call loads two and a half megabytes and takes
 * a moment; every later one is immediate.
 */
export async function blur(track: LocalVideoTrack, on: boolean): Promise<boolean> {
	if (!on) {
		try {
			// false is keepElement, and it is not a detail.
			//
			// The default keeps the element the processor was drawing into, and
			// that element is what the room is showing — so turning blur off in
			// a call left a picture that was live, unmuted, playing, and two
			// pixels across. It measured as a black tile. The preview screen was
			// unaffected and looked correct, which is why this needed a
			// measurement inside a call rather than an eye on a self view.
			await track.stopProcessor(false);
		} catch {
			// Already stopped, or a track that has gone away. Either way there
			// is no processor on it now, which is what was asked for.
		}

		return false;
	}

	if (!possible()) return false;

	try {
		await track.setProcessor(
			BackgroundProcessor({ mode: "background-blur", blurRadius: RADIUS, assetPaths: ASSETS }),
		);

		return true;
	} catch {
		// A model that would not load, a browser that will not do the work, a
		// track that ended while it was loading. The caller says so.
		return false;
	}
}
