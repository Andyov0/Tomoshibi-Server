import { type Appearance, appearance, holdNight, subscribe } from "@/live/appearance";
import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Night on the document for as long as the calling component is on screen, or
 * for as long as `on` says. See live/appearance.ts for why the document.
 *
 * A layout effect rather than an ordinary one, so that the first frame of a
 * call is already dark: an ordinary effect runs after the browser has painted,
 * and the frame in between is the call's menus and its notices by day.
 */
export function useNight(on = true): void {
	useLayoutEffect(() => (on ? holdNight() : undefined), [on]);
}

/** Day or night, as drawn now; for what has to be coloured outside the stylesheet. */
export function useAppearance(): Appearance {
	return useSyncExternalStore(subscribe, appearance);
}
