import type { Track } from "livekit-client";
import { describe, expect, it } from "vitest";
import { facingUser } from "./facing";

/*
 * Which way a camera points, and the three different ways a browser answers.
 *
 * Mirroring one's own picture has a reason — an unmirrored view of yourself
 * makes reaching for something on screen feel backwards — and the reason stops
 * applying the moment the camera is pointed away. A phone switched to its back
 * camera was still being flipped, so every sign and every page it was aimed at
 * came out reversed.
 *
 * What makes this worth testing rather than reading is that the three answers
 * are not interchangeable. A phone says which way it settled. A camera that can
 * only face outward may say nothing about the present and everything about what
 * it is able to do. A laptop webcam says neither, and is pointed at its owner.
 */

/** A track that answers the way some particular browser would. */
function camera(settings: MediaTrackSettings, capabilities?: MediaTrackCapabilities): Track {
	return {
		mediaStreamTrack: {
			getSettings: () => settings,
			getCapabilities: capabilities ? () => capabilities : undefined,
		},
	} as never;
}

describe("facingUser", () => {
	it("believes a camera that says which way it settled", () => {
		expect(facingUser(camera({ facingMode: "user" }))).toBe(true);
		expect(facingUser(camera({ facingMode: "environment" }))).toBe(false);
	});

	/*
	 * The case this was reported for. Picking a camera from a menu sends a
	 * device id and nothing about direction, so on some browsers the settings
	 * come back without one — and the only thing that knows is the list of what
	 * that device can do.
	 */
	it("falls back to what the camera is able to do", () => {
		expect(facingUser(camera({}, { facingMode: ["environment"] }))).toBe(false);
		expect(facingUser(camera({}, { facingMode: ["user"] }))).toBe(true);

		// One that can turn round is a phone answering about the device rather
		// than the camera, and mirroring is the safer of the two guesses: it is
		// what somebody looking at their own face expects.
		expect(facingUser(camera({}, { facingMode: ["user", "environment"] }))).toBe(true);
	});

	// A laptop webcam answers neither question and points at its owner, as does
	// any browser too old to be asked. Both were mirrored before this existed
	// and both stay mirrored.
	it("mirrors where nothing can be found out", () => {
		expect(facingUser(camera({}, { facingMode: [] }))).toBe(true);
		expect(facingUser(camera({}))).toBe(true);
		expect(facingUser(undefined)).toBe(true);
	});

	// A settled answer outranks a list of what is possible, because one of them
	// is about now.
	it("prefers what happened to what could have", () => {
		expect(facingUser(camera({ facingMode: "environment" }, { facingMode: ["user"] }))).toBe(false);
	});
});
