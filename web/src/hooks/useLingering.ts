import { useEffect, useRef, useState } from "react";

/**
 * Keep something on screen long enough to leave.
 *
 * A panel rendered as `open && <Panel/>` arrives with an animation and then, on
 * the press that closes it, is simply gone on the next frame. The asymmetry is
 * what makes it look broken: the opening says the panel came from the button,
 * and the closing says the page redrew itself. It reads as a glitch rather than
 * as a dismissal, and the complaint it draws is never "there is no exit
 * animation" — it is that the thing is ugly.
 *
 * So the caller renders while `mounted`, and applies the leaving class while
 * `leaving`. React has no idea the element wants to persist past its own
 * condition; something has to hold it, and this is the smallest thing that can.
 *
 * The timer rather than `animationend`: an element inside a container that has
 * been display:none'd — a background tab, a collapsed panel — never fires the
 * event, and the node would stay mounted forever. A timer is wrong by at most a
 * frame and cannot get stuck.
 */
export function useLingering(open: boolean, ms = 180): { mounted: boolean; leaving: boolean } {
	const [mounted, setMounted] = useState(open);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => {
		clearTimeout(timer.current);

		if (open) {
			setMounted(true);
			return;
		}

		// Nothing to wait for if it was never up. Setting a timer here would be
		// harmless and would also mean the first render of a closed panel
		// scheduled work, which is the kind of thing that shows up later as a
		// test that has to wait.
		if (!mounted) return;

		timer.current = setTimeout(() => setMounted(false), ms);

		return () => clearTimeout(timer.current);
	}, [open, ms, mounted]);

	return { mounted, leaving: mounted && !open };
}
