import { useT } from "@/hooks/useT";
import { useLingering } from "@/hooks/useLingering";
import { useDismiss } from "@/hooks/useDismiss";
import { cn } from "@/lib/utils";
import { REACTIONS, type Reaction } from "@/live/hands";
import { ChevronUp, Hand, SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Putting a hand up, and the reactions that live behind it.
 *
 * One control for two things because they are the same intention: saying
 * something without interrupting whoever is talking. Separating them would put
 * two buttons on a bar that is already the width of the screen on a phone, to
 * distinguish a distinction nobody making it is thinking about.
 *
 * The hand is the button and the reactions are behind a press-and-hold — no,
 * behind the menu, because press-and-hold is a gesture nobody discovers and
 * has no keyboard equivalent at all. A press raises the hand, which is the
 * common case; the caret opens the rest.
 *
 * Except where the island is narrow (`split` off). There the caret was a
 * nineteen-pixel sliver beside a thirty-four-pixel hand, the two smallest
 * targets on the screen side by side; the reactions move to a button of their
 * own in the island's second row (ReactionsButton, below) and the hand is a
 * whole button again.
 */
export function HandButton({
	up,
	onRaise,
	onReact,
	split = true,
}: {
	up: boolean;
	onRaise: (up: boolean) => void;
	onReact: (what: Reaction) => void;
	/** The caret for the reactions beside the hand, where the island has room for it. */
	split?: boolean;
}) {
	const t = useT();

	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLSpanElement>(null);

	return (
		<span ref={anchor} className="relative flex items-center">
			{split && <ReactionTray open={open} anchor={anchor} onClose={() => setOpen(false)} onReact={onReact} />}

			<button
				type="button"
				// Named for what a press does, and nothing else. It also said
				// aria-pressed, so a reader heard "Lower your hand, pressed",
				// which is two answers to one question; the native clients say
				// only the action, and so does this now.
				aria-label={up ? t("Lower your hand") : t("Raise your hand")}
				onClick={() => onRaise(!up)}
				/* Held open by a second press on the caret rather than by this
				   one, so the common act — putting a hand up — is one press and
				   never opens anything. */
				onContextMenu={(event) => {
					if (!split) return;
					event.preventDefault();
					setOpen((was) => !was);
				}}
				className={cn(
					"pressable flex size-11 items-center justify-center outline-none",
					"focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
					"[&_svg]:size-5 [&_svg]:stroke-[1.75]",
					split ? "rounded-l-full rounded-r-none pl-0.5" : "rounded-full",
					up
						? "bg-tally text-tally-fg hover:bg-tally/90 active:bg-tally/80"
						: "bg-surface-hi text-fg hover:bg-surface-hi-hover active:bg-surface-hi-press",
				)}
			>
				<Hand />
			</button>

			{split && (
				<button
					type="button"
					aria-label={t("Reactions")}
					aria-expanded={open}
					onClick={() => setOpen((was) => !was)}
					className={cn(
						// Thirty-two wide and the island's full height, forty-four
						// where a finger is aiming, with an icon
						// rather than a typed triangle. The triangle was a character of
						// the font at eleven pixels, five wide on screen, in a target
						// nineteen pixels across; it read as a stray mark beside the
						// hand, and was the smallest thing on the island to aim at.
						"pressable flex h-11 w-8 items-center justify-center rounded-r-full rounded-l-none pr-1 outline-none",
						"pointer-coarse:w-11",
						"border-shade/30 border-l",
						"focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
						open
							? "bg-surface-hi-press text-fg"
							: up
								? "bg-tally text-tally-fg hover:bg-tally/90"
								: "bg-surface-hi text-fg-muted hover:bg-surface-hi-hover hover:text-fg active:bg-surface-hi-press",
					)}
				>
					<ChevronUp
						className={cn("size-3.5 stroke-[2.25] transition-transform duration-200", open && "rotate-180")}
					/>
				</button>
			)}
		</span>
	);
}

/**
 * The reactions on a button of their own, for the island's second row on a
 * narrow screen. The same tray as the caret opens, from a different place.
 */
export function ReactionsButton({
	onReact,
	place,
}: {
	onReact: (what: Reaction) => void;
	/**
	 * Where the row of faces opens: over the middle of the island's second
	 * row, which is the middle of the screen, or from the right edge of a
	 * column down the side. Centred on this button, the first in the second
	 * row, it ran off the left of a phone by a third of its width.
	 */
	place: "row" | "end";
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLSpanElement>(null);

	return (
		// Not positioned in the row, so that the faces are placed against the
		// row itself; see `place`.
		<span ref={anchor} className={cn("flex items-center", place === "end" && "relative")}>
			<ReactionTray open={open} anchor={anchor} onClose={() => setOpen(false)} onReact={onReact} end={place === "end"} />

			<button
				type="button"
				aria-label={t("Reactions")}
				aria-expanded={open}
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"pressable flex size-11 items-center justify-center rounded-full outline-none",
					"focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
					"[&_svg]:size-5 [&_svg]:stroke-[1.75]",
					open
						? "bg-surface-hi-press text-fg"
						: "bg-surface-hi text-fg hover:bg-surface-hi-hover active:bg-surface-hi-press",
				)}
			>
				<SmilePlus />
			</button>
		</span>
	);
}

/**
 * The row of reactions, above whatever opened it.
 *
 * It closes on a press anywhere else and on Escape, and it did neither. It
 * closed only when a reaction was chosen or the caret pressed again, so
 * somebody who opened it and changed their mind had a row of faces left over
 * their own picture for the rest of the call; the screenshots for this change
 * caught it still open behind the leave dialog, the messages and the sound
 * panel, opened three menus earlier. Every other thing on the island that
 * opens closes both ways.
 */
function ReactionTray({
	open,
	anchor,
	onClose,
	onReact,
	end = false,
}: {
	open: boolean;
	anchor: React.RefObject<HTMLElement>;
	onClose: () => void;
	onReact: (what: Reaction) => void;
	/** Opened from the right edge rather than centred. */
	end?: boolean;
}) {
	const t = useT();
	const { mounted, leaving } = useLingering(open, 140);
	useDismiss(open, anchor, onClose);
	const tray = useRef<HTMLSpanElement>(null);

	// Into the row when it opens and back to what opened it when it closes,
	// so that a keyboard can use it at all: it opened with the focus left on
	// the caret, and the faces were seven presses of Tab away, past the rest
	// of the island.
	useEffect(() => {
		// Once the row is drawn, which is a render after it is asked for.
		if (open) {
			if (mounted) tray.current?.querySelector("button")?.focus();
			return;
		}

		const within = anchor.current?.contains(document.activeElement);
		if (within && document.activeElement !== anchor.current?.querySelector("[aria-expanded]")) {
			(anchor.current?.querySelector("[aria-expanded]") as HTMLElement | null)?.focus();
		}
	}, [open, mounted, anchor]);

	if (!mounted) return null;

	return (
		<span
			ref={tray}
			role="group"
			aria-label={t("Reactions")}
			className={cn(
				"absolute bottom-full z-10 mb-2.5 flex gap-0.5",
				end ? "right-0" : "-translate-x-1/2 left-1/2",
				"rounded-full border border-border bg-surface-hi p-1 shadow-2xl ring-1 ring-shade/40 afloat",
				end ? "origin-bottom-right" : "origin-bottom",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			{REACTIONS.map((one) => (
				<button
					key={one}
					type="button"
					aria-label={one}
					onClick={() => {
						onReact(one);
						onClose();
					}}
					className={cn(
						"pressable grid size-10 place-items-center rounded-full text-[22px] leading-none outline-none",
						"pointer-coarse:size-11",
						"hover:bg-wash focus-visible:bg-wash focus-visible:ring-2 focus-visible:ring-fg/70",
					)}
				>
					{one}
				</button>
			))}
		</span>
	);
}
