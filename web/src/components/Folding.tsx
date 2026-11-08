import { useLingering } from "@/hooks/useLingering";
import { cn } from "@/lib/utils";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/*
 * Things that fold away and unfold, on the lobby and the account page: the
 * arranging form and the cards it folds away (Schedule, Lobby), and the
 * account's settings. One time and one curve for all of them, and one way of
 * moving a height a stylesheet does not know, so that nothing folding beside
 * something else moves at another pace and makes the page around them jump.
 */

/**
 * How long the form takes to unfold and to fold away, on one curve both ways
 * (FOLD_EASE), which is also how long it is kept after the press that
 * closes it (useLingering).
 *
 * The same time and the same curve as the lobby's starting and joining take to
 * fold the other way (Folding, below), and that is the point of it. Closing
 * once ran this quicker and on the leaving curve while those came back slower
 * on settle, so the column first grew, by 80 pixels, and then shrank: the
 * lobby jumped as the form closed, which the owner found the worst of it. On
 * one curve over one time the column's height moves one way only.
 */
export const FOLD_MS = 420;

/**
 * The curve every fold runs on: easing in and out, so that a height begins
 * moving gently, travels evenly and settles.
 *
 * It ran on the stylesheet's settle, which is most of the way in the first
 * fifth of the time: recorded frame by frame, the starting card as the form
 * closed went from nothing to 68 of its 154 pixels in one frame and to 132 in
 * three, fading from a tenth to three quarters in two, and the owner saw it
 * flash in rather than come back. Settle suits a panel that appears on a
 * press and is looked at once it has; a height that pushes everything below it
 * wants to start as gently as it stops.
 */
export const FOLD_EASE = "cubic-bezier(0.45, 0, 0.15, 1)";

/**
 * How what comes back fades in: once its room is mostly open, so that the room
 * opens and then the card is seen in it, rather than a card arriving while its
 * room is still being made, cut off at its foot.
 */
const APPEAR = "opacity 320ms cubic-bezier(0.25, 0.1, 0.25, 1) 120ms";
/** And how what goes fades out: at once and quickly, before its room closes. */
const VANISH = "opacity 150ms ease";

/**
 * Something drawn only while open, unfolding from the head of its card rather
 * than appearing below it, and folding back before it is taken away: the
 * arranging form, and the account's settings.
 *
 * The form was put there whole on the press, at its full height in one frame
 * with only its contents fading in, and taken away whole a moment after the
 * press that closed it; the card, and everything below and beside it, jumped
 * twice, and the owner found the opening and the closing both not smooth. The
 * height runs between nothing and its own through a grid row going from 0fr to
 * 1fr, which is the one way a stylesheet can move a height it does not know,
 * and starts from 0fr on its first frame (@starting-style), so nothing waits a
 * frame to begin. The contents fade as it opens, without travelling. Clipped
 * while open, so it shows as the card grows rather than spilling below it; a
 * menu inside it is drawn outside the page and is not clipped.
 */
export function Unfolding({ open, children }: { open: boolean; children: ReactNode }) {
	const { mounted, leaving } = useLingering(open, FOLD_MS);
	if (!mounted) return null;

	return (
		<div
			className={cn(
				"grid motion-reduce:transition-none! starting:grid-rows-[0fr]",
				leaving ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
			)}
			style={{ transition: `grid-template-rows ${FOLD_MS}ms ${FOLD_EASE}` }}
		>
			<div className="min-h-0 overflow-hidden">
				<div
					className={cn(
						"motion-reduce:transition-none!",
						leaving ? "pointer-events-none opacity-0" : "opacity-100 starting:opacity-0",
					)}
					style={{ transition: leaving ? VANISH : APPEAR }}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

/**
 * Something in the lobby that folds away and back with the arranging form
 * (Schedule), its height running to nothing and back through a grid row going
 * between 1fr and 0fr, the one way a stylesheet can move a height it does not
 * know, and fading as it goes.
 *
 * Kept while folded, so a name somebody had typed is still there when it comes
 * back, and out of reach meanwhile: inert, so neither a tab nor a screen reader
 * finds a form nobody can see. Clipped only while it moves; at rest the card's
 * own rise as the lobby appears and the ring around a focused field would be
 * cut by it.
 */
export function Folding({ open, children }: { open: boolean; children: ReactNode }) {
	const [still, setStill] = useState(true);
	const was = useRef(open);
	const fold = useRef<HTMLDivElement>(null);

	// Set on the element, because React 18 does not know the attribute and
	// drops a boolean it does not know.
	useLayoutEffect(() => {
		if (fold.current) fold.current.inert = !open;
	}, [open]);

	useEffect(() => {
		if (was.current === open) return;
		was.current = open;
		setStill(false);
		const timer = setTimeout(() => setStill(true), FOLD_MS);
		return () => clearTimeout(timer);
	}, [open]);

	return (
		<div
			ref={fold}
			data-folding={open ? "open" : "folded"}
			className="grid motion-reduce:transition-none!"
			style={{
				gridTemplateRows: open ? "1fr" : "0fr",
				opacity: open ? 1 : 0,
				// The arranging form's time and curve, both ways (Schedule
				// FOLD_MS says why they have to be the same).
				transition: `grid-template-rows ${FOLD_MS}ms ${FOLD_EASE}, ${open ? APPEAR : VANISH}`,
			}}
		>
			<div className={cn("min-h-0", open && still ? "overflow-visible" : "overflow-hidden")}>{children}</div>
		</div>
	);
}
