import { useLingering } from "@/hooks/useLingering";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/*
The pieces the permission and capability checkboxes are built from.

Native boxes, as the relay settings already use, rather than a component library
drawing its own: the platform's box is keyboard-reachable, announces its state,
and costs no dependency, and the one thing a drawn box would add here is a
colour the accent already gives.

Everything here that comes and goes does both with an animation. A hint that
appears because a box above it was unticked, a spinner that appears for the
length of a request: rendered as `cond && <X/>` each would arrive and vanish
between two frames, which on a row that has just been pressed reads as the row
redrawing itself rather than answering.
*/

/** One checkbox, its label, whether it is being saved, and what it needs saying. */
export function Box({
	label,
	checked,
	disabled,
	saving,
	onChange,
	tone,
	children,
	className,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	saving?: boolean;
	onChange: (checked: boolean) => void;
	/** Drawn in the signal colour, for the one box that spends money. */
	tone?: "tally";
	/** Hints under the label, each a Hint so it can come and go. */
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
			<label
				className={cn(
					"flex items-center gap-1.5 text-[12px]",
					tone === "tally" ? "text-tally" : "text-fg",
					disabled && "opacity-60",
				)}
			>
				<input
					type="checkbox"
					checked={checked}
					disabled={disabled}
					aria-busy={saving || undefined}
					onChange={(event) => onChange(event.target.checked)}
					className="size-3.5 shrink-0 accent-tally"
				/>
				{label}
				<Working on={saving ?? false} />
			</label>
			{children}
		</div>
	);
}

/**
 * A line under a box, there while it applies.
 *
 * Grey, and indented to the label rather than to the box, so it reads as being
 * about the word above it. The width of a phone is a third of a laptop's and
 * these are sentences, so they wrap rather than truncate.
 */
export function Hint({ show = true, children }: { show?: boolean; children: ReactNode }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return (
		<p
			className={cn(
				"pl-5 text-[11px] text-fg-muted leading-relaxed",
				leaving ? "animate-fade-out" : "animate-fade-in",
			)}
		>
			{children}
		</p>
	);
}

/** A spinner for as long as something is in flight, faded rather than cut. */
export function Working({ on, className }: { on: boolean; className?: string }) {
	const { mounted, leaving } = useLingering(on, 160);
	if (!mounted) return null;

	// The fade on a wrapper rather than on the icon, because the icon's one
	// animation property is already the spin and a second class would replace
	// it rather than join it.
	return (
		<span
			aria-hidden
			className={cn(
				"inline-flex shrink-0",
				leaving ? "animate-fade-out" : "animate-fade-in",
				className,
			)}
		>
			<Loader2 className="size-3.5 animate-spin text-fg-muted" />
		</span>
	);
}

/** Something inline that comes and goes, such as a badge. */
export function Fade({ show, children }: { show: boolean; children: ReactNode }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return (
		<span className={cn("inline-flex", leaving ? "animate-fade-out" : "animate-fade-in")}>
			{children}
		</span>
	);
}

/**
 * One thing in two states — a line and the field that edits it, a hint and
 * the answer that replaces it — each fading out as the other fades in.
 *
 * The two share one grid cell, so while one leaves and the other arrives they
 * sit over each other rather than side by side, and the row does not jump.
 * Each state was faded in and simply removed on the way out, between two
 * frames: the arrival said the field came from the line, and the departure
 * said the page had redrawn itself.
 *
 * The leaving one is hidden from assistive technology and from the pointer
 * while it goes, so a press on what is fading lands on nothing. A field that is
 * leaving keeps its handlers, and a caller whose field saves on blur has to ask
 * whether it is still the one shown.
 */
export function Swap({
	showing,
	children,
	className,
}: {
	/** Which of the two children is shown: the first, or the second. */
	showing: 0 | 1;
	children: [ReactNode, ReactNode];
	className?: string;
}) {
	const first = useLingering(showing === 0, 160);
	const second = useLingering(showing === 1, 160);

	const layer = (leaving: boolean) =>
		cn("col-start-1 row-start-1 min-w-0", leaving ? "pointer-events-none animate-fade-out" : "animate-fade-in");

	return (
		<span className={cn("grid min-w-0", className)}>
			{first.mounted && (
				<span className={layer(first.leaving)} aria-hidden={first.leaving || undefined}>
					{children[0]}
				</span>
			)}
			{second.mounted && (
				<span className={layer(second.leaving)} aria-hidden={second.leaving || undefined}>
					{children[1]}
				</span>
			)}
		</span>
	);
}
