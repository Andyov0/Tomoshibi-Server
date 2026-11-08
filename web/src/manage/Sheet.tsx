import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * A sheet that holds one thing's detail over the page it was opened from.
 *
 * From the right edge on a wide screen, as the system's inspectors are, and up
 * from the bottom on a phone, as the call's own panels are; both leave the way
 * they came, faster than they arrived. The page behind stays where it was, so
 * closing the sheet puts somebody back at the row they opened rather than at
 * the top of a list they had scrolled.
 *
 * Put on the body rather than where it is written. Every panel arrives with an
 * animation that moves it, and a fixed element inside a moved one is fixed to
 * that element instead of the window — the fault the call's leave dialog had,
 * where the dimmed layer covered only the control bar.
 *
 * It takes the keyboard while it is open: focus goes in on opening and back
 * to whatever opened it on closing, Tab stays inside, and Escape closes it.
 */
export function Sheet({
	open,
	title,
	label,
	onClose,
	children,
}: {
	open: boolean;
	/** What the bar across its top says: the kind of thing, as the body names the thing itself. */
	title: string;
	/** What a screen reader is told the sheet is, which is the thing. */
	label?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const t = useT();

	const { mounted, leaving } = useLingering(open, 200);
	const panel = useRef<HTMLDivElement>(null);
	const opener = useRef<Element | null>(null);

	const close = useRef(onClose);
	close.current = onClose;

	useEffect(() => {
		if (!open) return;

		opener.current = document.activeElement;
		panel.current?.querySelector<HTMLElement>("[data-sheet-close]")?.focus();

		const onKey = (event: KeyboardEvent) => {
			// A field inside that takes Escape for itself — cancelling an edit —
			// says so by preventing it, and the sheet stays.
			if (event.key === "Escape") {
				if (event.defaultPrevented) return;
				event.preventDefault();
				close.current();
				return;
			}

			if (event.key !== "Tab" || !panel.current) return;

			const stops = [...panel.current.querySelectorAll<HTMLElement>(
				"button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex]:not([tabindex='-1'])",
			)].filter((one) => one.getClientRects().length > 0);
			const first = stops[0];
			const last = stops[stops.length - 1];
			if (!first || !last) return;

			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", onKey);

		return () => {
			document.removeEventListener("keydown", onKey);
			if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
		};
	}, [open]);

	if (!mounted) return null;

	return createPortal(
		<div className="fixed inset-0 z-40">
			<div
				aria-hidden
				onClick={onClose}
				className={cn("absolute inset-0 bg-shade/40", leaving ? "animate-fade-out" : "animate-fade-in")}
			/>

			<div
				ref={panel}
				role="dialog"
				aria-modal="true"
				aria-label={label ?? title}
				className={cn(
					"absolute flex flex-col overflow-hidden bg-bg text-fg",
					// A phone: nearly the whole height, with the top of the page
					// still showing so it reads as a sheet over it.
					"inset-x-0 bottom-0 top-[max(2.75rem,env(safe-area-inset-top))] rounded-t-[22px]",
					"shadow-[0_-8px_32px_-12px_rgb(0_0_0/0.45)]",
					leaving ? "max-lg:animate-sheet-leave" : "max-lg:animate-sheet",
					// A wide screen: a column at the right edge, full height.
					"lg:inset-y-0 lg:top-0 lg:right-0 lg:left-auto lg:w-[460px] lg:rounded-none",
					"lg:border-border lg:border-l lg:shadow-[-12px_0_40px_-16px_rgb(0_0_0/0.35)]",
					leaving ? "lg:animate-side-leave" : "lg:animate-side",
				)}
			>
				<header className="flex shrink-0 items-center gap-2 border-border border-b bg-bg px-4 py-2.5 lg:px-5">
					<h2 className="min-w-0 flex-1 truncate font-semibold text-[15px]">{title}</h2>
					<button
						type="button"
						data-sheet-close
						onClick={onClose}
						aria-label={t("Close")}
						className={cn(
							"pressable relative flex size-8 items-center justify-center rounded-full bg-surface-hi text-fg-muted outline-none",
							"hover:bg-surface-hi-hover hover:text-fg active:bg-surface-hi-press",
							"focus-visible:ring-2 focus-visible:ring-fg/70",
							"before:absolute before:-inset-1.5 before:hidden pointer-coarse:before:block",
						)}
					>
						<X className="size-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:px-5">{children}</div>
			</div>
		</div>,
		document.body,
	);
}
