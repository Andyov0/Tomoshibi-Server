import { useEffect, useState } from "react";

/** How long a room has to be left alone before the controls step aside. */
const AFTER = 3000;

/**
 * Whether nobody has touched anything for a while.
 *
 * Only pointer movement, keys and touches count. Not scrolling, which a shared
 * screen does on its own, and not the passage of frames — a call where somebody
 * is talking and still is a call where the controls should go away, and a call
 * where somebody is reaching for mute is one where the pointer has already
 * moved before the hand arrives.
 *
 * `watching` is false wherever this is not wanted, because a hook cannot be
 * called conditionally and listening for nothing on every room is worse than a
 * branch inside.
 */
export function useIdle(watching: boolean): boolean {
	const [idle, setIdle] = useState(false);

	useEffect(() => {
		if (!watching) {
			setIdle(false);
			return;
		}

		let timer = 0;

		const wake = () => {
			setIdle(false);
			window.clearTimeout(timer);
			timer = window.setTimeout(() => setIdle(true), AFTER);
		};

		// Listened for on the window with capture, so a pointer moving over a
		// video tile — which stops the event before it bubbles anywhere useful —
		// still counts as somebody being here.
		const kinds = ["pointermove", "pointerdown", "keydown", "touchstart", "wheel"] as const;
		for (const kind of kinds) window.addEventListener(kind, wake, { capture: true, passive: true });

		wake();

		return () => {
			window.clearTimeout(timer);
			for (const kind of kinds) window.removeEventListener(kind, wake, { capture: true });
		};
	}, [watching]);

	return idle;
}
