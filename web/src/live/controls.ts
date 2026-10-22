import { keep, recall } from "@/lib/storage";
/**
 * Where the controls sit, and whether they get out of the way.
 *
 * The island at the bottom of the room is over the pictures rather than beside
 * them, which is right for a control that is used every few minutes and wrong
 * for one that is used twice: on a tall window, or with a shared screen, or
 * with somebody's slides in the middle, it covers the part being looked at and
 * there is nothing to be done about it.
 *
 * There is no single right answer here, which is why this is a choice rather
 * than a better default. Somebody on a laptop reaching for mute wants it where
 * it always is; somebody watching a shared screen for half an hour wants it
 * gone; somebody on a wide monitor would rather give up a strip of width than
 * any height at all.
 */

export type Placement =
	/** Always where it has always been. */
	| "always"
	/** At the bottom, out of sight until the pointer moves. */
	| "idle"
	/** Down the side, where it costs width instead of height. */
	| "side";

const KEY = "meet-live.controls";

/**
 * Anything unrecognised reads as always shown.
 *
 * The failure this avoids is worth naming: a value written by a later build, or
 * a half-finished write, would otherwise be a room whose controls are hidden
 * with no way to bring them back — the setting that would fix it lives behind
 * one of the buttons that is hidden. The default has to be the visible one.
 */
export function placement(): Placement {
	try {
		const said = recall(KEY);

		return said === "idle" || said === "side" ? said : "always";
	} catch {
		return "always";
	}
}

export function remember(where: Placement): void {
	try {
		if (where === "always") keep(KEY, undefined);
		else keep(KEY, where);
	} catch {
		// A browser refusing storage costs the choice its memory and nothing
		// else; the room still honours it for as long as it is open.
	}
}
