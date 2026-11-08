import { useLingering } from "@/hooks/useLingering";
import { cn } from "@/lib/utils";
import { useDismiss } from "@/hooks/useDismiss";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
The pieces the redrawn pages are made of: a heading, a group of rows under it,
and the rows.

Drawn the way the platforms draw their own settings — a group on the page's
ground with its heading outside it in the quieter ink, rows separated by a
hairline that starts where the text does — rather than as a page of identical
bordered cards each with a title bar. The cards were the management pages'
first shape, and the reason they read as a dashboard kit is that every block
of every kind wore the same frame, so a list of people and a pair of totals
looked like the same sort of thing. A group is a list; what is not a list is
not put in one.

No border by day, where the white group on the grey ground is the edge, as it
is in the system's own grouped lists; a hairline at night, where the two greys
are a step apart and a group of rows otherwise runs into the page.
*/

/** A heading over a group, and what sits at its right. */
export function Section({
	title,
	note,
	actions,
	children,
	className,
	id,
}: {
	title: ReactNode;
	note?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	id?: string;
}) {
	return (
		<section className={cn("flex min-w-0 flex-col gap-2", className)} aria-labelledby={id}>
			<header className="flex min-h-7 flex-wrap items-end gap-x-3 gap-y-1 px-1">
				<h2 id={id} className="font-semibold text-[15px]">
					{title}
				</h2>
				{note && <span className="pb-px text-fg-muted text-[13px]">{note}</span>}
				{actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
			</header>
			{children}
		</section>
	);
}

/** The group itself. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"min-w-0 overflow-hidden rounded-[14px] bg-surface",
				"border border-border day:border-transparent",
				className,
			)}
		>
			{children}
		</div>
	);
}

/**
 * A row in a group, with the hairline above it that every row but the first
 * has, starting at `inset` so it begins where the row's words do.
 */
export function Row({
	children,
	className,
	inset = 16,
	leaving,
}: {
	children: ReactNode;
	className?: string;
	inset?: number;
	/** Drawn on its way out, for a row whose subject has just gone. */
	leaving?: boolean;
}) {
	return (
		<div
			className={cn(
				"relative min-w-0",
				"before:absolute before:top-0 before:right-0 before:h-px before:bg-border first:before:hidden",
				"before:left-[var(--inset)]",
				leaving ? "animate-depart" : "animate-fade-in",
				className,
			)}
			style={{ "--inset": `${inset}px` } as React.CSSProperties}
		>
			{children}
		</div>
	);
}

/**
 * The items of a list, with the ones that have just gone kept for long enough
 * to leave.
 *
 * Somebody leaving a call was a row that vanished between two polls, and the
 * rows under it jumped up to fill the gap — which is how a list redraws, not
 * how a person leaves. Each departed item is held, marked leaving, for the
 * length of the exit, and then let go; an item that comes back while leaving
 * is simply present again.
 */
export function usePresence<T>(items: readonly T[], key: (item: T) => string, ms = 180): { item: T; leaving: boolean }[] {
	const [gone, setGone] = useState<Map<string, { item: T; at: number; index: number }>>(new Map());
	const last = useRef<readonly T[]>(items);

	// The timers that let the departed go, kept apart from the effect below so
	// that it running again does not cancel them. They were the effect's own
	// cleanup, and a list handed over again inside the exit — a poll answering,
	// or a press that lifted a lockout and then asked for the list — cleared
	// the timer of an item that had already left the list, so nothing ever let
	// it go: the row stayed on the page, invisible at the end of its exit, as
	// a blank the height of a row. Found by the sign-in lockouts, whose lift
	// asks for the list at once.
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const held = timers.current;
		return () => {
			for (const timer of held) clearTimeout(timer);
		};
	}, []);

	useEffect(() => {
		const now = new Set(items.map(key));
		const departed = last.current
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => !now.has(key(item)));
		last.current = items;

		// The moment these left, taken once, so that the timer below lets go of
		// exactly what left by then: read again inside the updater it could be
		// a moment later than the timer's start, and the timer would find the
		// item not yet due and never come back for it.
		const at = Date.now();

		// The same map back where nothing changed, so a caller that hands over
		// a new list on every render is not drawn again on every render.
		setGone((was) => {
			if (departed.length === 0 && ![...was.keys()].some((k) => now.has(k))) return was;

			const next = new Map(was);
			for (const k of next.keys()) if (now.has(k)) next.delete(k);
			for (const { item, index } of departed) next.set(key(item), { item, at, index });
			return next;
		});

		if (departed.length === 0) return;

		const timer = setTimeout(() => {
			timers.current.delete(timer);
			setGone((was) => {
				const next = new Map(was);
				for (const [k, v] of next) if (v.at <= at) next.delete(k);
				return next.size === was.size ? was : next;
			});
		}, ms);
		timers.current.add(timer);
		// biome-ignore lint/correctness/useExhaustiveDependencies: the list is the trigger; the key function is not
	}, [items, ms]);

	const shown: { item: T; leaving: boolean }[] = items.map((item) => ({ item, leaving: false }));
	for (const { item, index } of gone.values()) {
		if (shown.some((one) => key(one.item) === key(item))) continue;
		shown.splice(Math.min(index, shown.length), 0, { item, leaving: true });
	}

	return shown;
}

/**
 * Something said once in a group, which comes and goes with what it is about.
 */
export function Note({ show = true, children, className }: { show?: boolean; children: ReactNode; className?: string }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return (
		<p className={cn("text-fg-muted text-[12.5px] leading-relaxed", leaving ? "animate-fade-out" : "animate-fade-in", className)}>
			{children}
		</p>
	);
}

/** A person's initial, filled for somebody this deployment knows and outlined for a guest. */
export function Initial({ name, guest, size = "md" }: { name: string; guest?: boolean; size?: "md" | "lg" }) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full font-medium",
				size === "lg" ? "size-14 text-[22px]" : "size-8 text-[13px]",
				guest ? "border border-border text-fg-muted" : "bg-surface-hi text-fg",
			)}
		>
			{Array.from(name.trim())[0]?.toUpperCase() ?? "?"}
		</span>
	);
}

/** Between a popover and the button it hangs from, and between it and the window's edge. */
const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;

/**
 * A small sheet of choices that drops from the button that opened it.
 *
 * Opaque, and white by day with the one soft shadow, as every menu in the
 * product is (index.css, afloat). It closes on a press anywhere else and on
 * Escape, and it leaves as it came. The trigger is the caller's, so a menu can
 * hang from an icon or from a word.
 *
 * On the document rather than beside its button, placed in the window's
 * coordinates. A group clips what is inside it to its rounded corners
 * (overflow-hidden), and a sheet hung absolutely from a button in a group was
 * cut off at the group's edge: the relays a person could be sent in through
 * showed one name and a sliver, the rest under the next section (the owner,
 * 2026-11-05). Out of the group it is out of reach of that, and of a transform
 * left above it by an arrival, which would do the same to a fixed sheet that
 * stayed inside (ServerPicker says how that was found). It opens downward,
 * upward where there is more room above, and scrolls if it is taller than
 * either.
 */
export function Popover({
	open,
	onClose,
	align = "left",
	trigger,
	children,
	className,
}: {
	open: boolean;
	onClose: () => void;
	align?: "left" | "right";
	trigger: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	const holder = useRef<HTMLSpanElement>(null);
	const sheet = useRef<HTMLDivElement>(null);
	const { mounted, leaving } = useLingering(open, 160);
	// The sheet is no longer inside the holder: a press on it is not a press elsewhere.
	useDismiss(open, [holder, sheet], onClose);

	const [place, setPlace] = useState<{
		top: number;
		left?: number;
		right?: number;
		tall: number;
		up: boolean;
	} | null>(null);

	useLayoutEffect(() => {
		if (!mounted) {
			setPlace(null);
			return;
		}

		const settle = () => {
			const box = holder.current?.getBoundingClientRect();
			if (!box) return;
			const height = sheet.current?.scrollHeight ?? 0;
			const below = window.innerHeight - box.bottom - POPOVER_GAP - POPOVER_MARGIN;
			const above = box.top - POPOVER_GAP - POPOVER_MARGIN;
			const up = height > below && above > below;
			const tall = Math.max(0, up ? above : below);
			const top = up ? box.top - POPOVER_GAP - Math.min(height, tall) : box.bottom + POPOVER_GAP;
			setPlace(
				align === "right"
					? { top, right: window.innerWidth - box.right, tall, up }
					: { top, left: box.left, tall, up },
			);
		};

		settle();
		// Either moves the button out from under a sheet that would no longer
		// be beside anything.
		window.addEventListener("resize", settle);
		window.addEventListener("scroll", settle, true);
		return () => {
			window.removeEventListener("resize", settle);
			window.removeEventListener("scroll", settle, true);
		};
	}, [mounted, align]);

	return (
		<span ref={holder} className="relative inline-flex">
			{trigger}
			{mounted &&
				createPortal(
					<div
						ref={sheet}
						style={
							place
								? { top: place.top, left: place.left, right: place.right, maxHeight: place.tall }
								: { visibility: "hidden", top: 0, left: 0 }
						}
						className={cn(
							"fixed z-50 flex w-64 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-[14px] border border-border bg-surface-hi p-1.5",
							"shadow-[0_16px_40px_-12px_rgb(0_0_0/0.6)] afloat",
							place?.up ? "origin-bottom" : "origin-top",
							leaving ? "animate-depart" : "animate-arrive",
							className,
						)}
					>
						{children}
					</div>,
					document.body,
				)}
		</span>
	);
}

/** A row in a popover. */
export function Choice({
	onClick,
	disabled,
	danger,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"flex min-h-9 w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13.5px] outline-none pointer-coarse:min-h-11",
				"transition-colors hover:bg-wash active:bg-wash-press focus-visible:bg-wash disabled:opacity-40 disabled:hover:bg-transparent",
				danger ? "text-danger-ink" : "text-fg",
			)}
		>
			{children}
		</button>
	);
}

/**
 * A quiet control the size of the shared scale's small step: thirty-two to a
 * cursor and forty-four to a finger, transparent until it is pointed at.
 */
export const quiet = cn(
	"pressable inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] px-2.5 text-[13px] outline-none",
	"text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-press focus-visible:ring-2 focus-visible:ring-fg/70",
	"disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0",
);

/** The same, square, for an icon alone. */
export const quietIcon = cn(quiet, "w-8 px-0 pointer-coarse:w-11");

/** A field at the button's height, sixteen pixels under a finger so Safari does not zoom. */
export const field = cn(
	"h-9 w-full min-w-0 rounded-[10px] border border-border bg-bg px-3 text-[14px] text-fg outline-none transition-colors",
	"placeholder:text-fg-muted pointer-coarse:h-11 pointer-coarse:text-base",
	"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30 disabled:opacity-60",
);
