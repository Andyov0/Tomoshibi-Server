import type { Track } from "livekit-client";

/**
 * Which way a camera is pointed, and therefore whether to mirror it.
 *
 * Mirroring one's own picture is right and has a reason: an unmirrored view of
 * yourself makes reaching for something on screen feel backwards, which is why
 * every shop window and every video call does it. The reason stops applying the
 * moment the camera is pointed away. A rear camera is filming the world rather
 * than the person holding it, and flipping the world puts every sign, every page
 * and every hand on the wrong side — which is what a phone switched to its back
 * camera was doing here.
 *
 * Nothing about the picture says which it is, so the track is asked.
 */
export function facingUser(track: Track | undefined): boolean {
	const media = track?.mediaStreamTrack;
	if (!media) return true;

	// What the camera actually settled on, which is the answer where there is
	// one. Phones report it; the deviceId a person picked from a menu does not
	// carry it, so this is read from the track rather than from the request.
	const settled = media.getSettings().facingMode;
	if (settled) return settled === "user";

	// What it is able to be. A camera that can only face outward is facing
	// outward, whatever it neglected to say about the present moment.
	const able = media.getCapabilities?.().facingMode;
	if (able && able.length > 0) return able.includes("user");

	// A laptop webcam answers neither question and points at its owner. So does
	// any browser too old to be asked, and mirroring is what this did for all of
	// them before the question was put.
	return true;
}
