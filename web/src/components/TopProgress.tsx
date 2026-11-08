import { arrived, useWaitPhase } from "@/live/progress";
import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The thin bar along the top of the page while it waits on its server for
 * somebody (live/progress.ts says when), which the owner asked for.
 *
 * It does not know how far along a request is, and does not pretend to: it
 * moves quickly at first and then ever more slowly towards nine tenths, and
 * runs the rest of the way when the wait is over, then fades. A wait shorter
 * than SHOW_AFTER_MS is not shown at all, so a quick answer does not flash a
 * line across the top of the page.
 *
 * In the person's colour, at every width and in day and night, and drawn as
 * the bar the document draws for itself before any script has arrived
 * (vite.config.ts bootProgress), which this takes over from where it got to,
 * so the page's arrival is one bar and not two.
 */

/** A wait shorter than this is not shown. */
export const SHOW_AFTER_MS = 150;

/** Where a bar shown for a new wait starts, and how near it creeps to the end. */
const START = 0.12;
const CEILING = 0.9;

/** How often it creeps, and by what part of the way left. */
const CREEP_MS = 400;
const CREEP = 0.12;

/** How long it takes to run to the end, and then to fade. */
const FILL_MS = 220;
const FADE_MS = 320;

/** The bar the document draws before the script arrives. */
export const BOOT_ID = "boot-progress";

interface Bar {
	/** How far along, from 0 to 1. */
	at: number;
	shown: boolean;
	/** Moved there without a transition: taken over, or put back to the start. */
	jump: boolean;
}

const IDLE: Bar = { at: 0, shown: false, jump: true };

/** Where the document's own bar got to, and takes it away. */
function takeOverBoot(): Bar | undefined {
	const boot = document.getElementById(BOOT_ID);
	if (!boot) return undefined;

	const style = getComputedStyle(boot);
	// matrix(a, b, c, d, e, f) with a the horizontal scale it has grown to, as
	// a browser computes it; scaleX(a) where nothing computes it.
	const scale = /(?:matrix|scaleX)\(\s*([-\d.e]+)/.exec(style.transform);
	const at = scale ? Number(scale[1]) : START;
	const shown = Number(style.opacity) > 0.5;
	boot.remove();

	return { at: Number.isFinite(at) ? Math.min(Math.max(at, 0), CEILING) : START, shown, jump: true };
}

export function TopProgress() {
	const now = useWaitPhase();
	const [bar, setBar] = useState<Bar>(IDLE);
	// When the wait began, so that one made of quick questions in a chain is
	// shown once the chain has taken long enough, however short each part.
	const began = useRef<number | undefined>(undefined);

	// Before the first paint, so the document's bar and this one are never
	// both on screen, nor neither for a frame between them.
	useLayoutEffect(() => {
		const taken = takeOverBoot();
		if (taken) setBar(taken);
	}, []);

	// After every effect of the page drawn before this one, which is where the
	// page's first requests are made.
	useEffect(() => arrived(), []);

	// Every change below is made from the bar as it is by then rather than as
	// this effect saw it: the bar taken over from the document is set in the
	// layout effect above, after this effect's first run was already queued,
	// and a decision read from the earlier bar put the taken-over one away.
	useEffect(() => {
		if (now === "idle") {
			began.current = undefined;
			setBar((held) => (held.shown ? { ...held, at: 1, jump: false } : held.at === 0 ? held : IDLE));
			const fade = setTimeout(() => setBar((held) => (held.shown ? { ...held, shown: false } : held)), FILL_MS);
			const reset = setTimeout(() => setBar((held) => (held.shown ? held : IDLE)), FILL_MS + FADE_MS);

			return () => {
				clearTimeout(fade);
				clearTimeout(reset);
			};
		}

		began.current ??= Date.now();

		const creep = setInterval(() => {
			setBar((held) => {
				if (!held.shown) return held;
				// A wait that began again while the last one was running
				// out starts over rather than creeping backwards from the end.
				if (held.at >= CEILING) return { at: START, shown: true, jump: true };
				return { ...held, at: held.at + (CEILING - held.at) * CREEP, jump: false };
			});
		}, CREEP_MS);

		// Only while something is outstanding: the moment after an answer is
		// not more of the wait, and a bar not yet shown is not shown in it.
		const appear =
			now === "waiting"
				? setTimeout(
						() => setBar((held) => (held.shown ? held : { at: Math.max(held.at, START), shown: true, jump: false })),
						Math.max(0, SHOW_AFTER_MS - (Date.now() - began.current)),
					)
				: undefined;

		return () => {
			clearTimeout(appear);
			clearInterval(creep);
		};
	}, [now]);

	return (
		<div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
			<div
				data-progress={bar.shown ? "shown" : "hidden"}
				className={cn(
					"h-full origin-left bg-tally shadow-[0_0_10px_var(--color-tally)]",
					// Important, to win over the transition set beside it.
					"motion-reduce:transition-none!",
				)}
				style={{
					transform: `scaleX(${bar.at})`,
					opacity: bar.shown ? 1 : 0,
					transition: bar.jump
						? undefined
						: bar.at >= 1
							? `transform ${FILL_MS}ms var(--ease-settle), opacity ${FADE_MS}ms ease`
							: `transform ${CREEP_MS}ms var(--ease-settle), opacity 150ms ease`,
				}}
			/>
		</div>
	);
}
