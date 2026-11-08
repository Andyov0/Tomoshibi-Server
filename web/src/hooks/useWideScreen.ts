import { useSyncExternalStore } from "react";

/**
 * The width from which the stylesheet's `md:` rules apply (Tailwind's 48rem).
 * Kept beside them in meaning, not in code: a component reads this only where
 * it has to decide what to draw rather than how, and the stylesheet stays the
 * one that lays things out.
 */
const WIDE = "(min-width: 48rem)";

function subscribe(listener: () => void): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const query = matchMedia(WIDE);
	query.addEventListener?.("change", listener);
	return () => query.removeEventListener?.("change", listener);
}

function wide(): boolean {
	return typeof matchMedia === "function" && matchMedia(WIDE).matches;
}

/**
 * Whether the window is at least as wide as the stylesheet's `md:`, and so
 * whether a layout that changes there is the wide one.
 *
 * Needed where the wide layout and the narrow one hold different things, not
 * merely the same things placed differently: the lobby keeps the servers beside
 * the meeting on a wide screen, so arranging a meeting there brings in no list
 * of its own, while on a phone the list is brought into the form, which a
 * stylesheet cannot decide because it is a question of which list exists.
 */
export function useWideScreen(): boolean {
	return useSyncExternalStore(subscribe, wide, () => false);
}
