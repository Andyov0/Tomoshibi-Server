import { useDismiss } from "@/hooks/useDismiss";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { dissolve } from "@/live/host";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import type { Room } from "livekit-client";
import { DoorClosed, Loader2, LogOut, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Leaving, and — for whoever runs the room — ending it.
 *
 * The two live together because they are the same intention arriving at
 * different scales: somebody is finished. Putting the second one in a panel
 * elsewhere meant a host who was finished pressed the red button, left, and left
 * the meeting running behind them under a name they will use again next week.
 *
 * Asked rather than done, and asked with the consequence rather than with "are
 * you sure" — a question nobody has ever answered no to by reading it. Leaving a
 * call is not destructive and would not need a question at all if it were not
 * sitting next to one that is; what the question really guards is the distance
 * between the two, which is now one line of a list.
 */
export function Leaving({
	room,
	host,
	onLeave,
}: {
	room: Room;
	/** Whether this person may end the meeting for everybody. */
	host: boolean;
	onLeave: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const { mounted, leaving } = useLingering(open, 160);

	// Escape closes it, because a dialog that can only be dismissed by choosing
	// something is a dialog somebody chooses something in by accident; and so
	// does a press anywhere else, which is a question's way out that is not an
	// answer.
	//
	// That press was a transparent layer over the window, and it covered the
	// island and nothing else. It was fixed to the window by its class, and a
	// fixed element inside a transformed or blurred ancestor is fixed to that
	// ancestor instead — the island is both, being centred by a transform and
	// drawn in a blurred material — so a press on the pictures went straight
	// through to them with the question still open.
	const near = useRef<HTMLDivElement>(null);
	useDismiss(open, near, () => setOpen(false));

	// Into the question when it is asked, and back to the button when it is
	// put away. It opened with the focus left on the red button, so a keyboard
	// had to find its way up into a dialog that said it was modal.
	const dialog = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// Once it is drawn, which is a render after it is asked for.
		if (open) {
			if (mounted) dialog.current?.querySelector("button")?.focus();
			return;
		}
		if (near.current?.contains(document.activeElement)) button.current?.focus();
	}, [open, mounted]);

	return (
		<div ref={near} className="relative">
			<button
				ref={button}
				type="button"
				aria-label={t("Leave")}
				aria-expanded={open}
				onClick={() => setOpen((was) => !was)}
				className={cn(
					// A capsule, the one shape on the island that is not a circle,
					// so that the one red thing is also the one that is not the
					// same shape as the rest; and the shape the native clients'
					// hang-up button already has, at their size. The handset is
					// laid down, as a telephone's own is, rather than struck
					// through: a slash on a red button said "off" twice.
					"pressable grid h-11 w-14 place-items-center rounded-full bg-danger text-danger-fg outline-none",
					"hover:bg-danger/90 active:bg-danger/80",
					"focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
				)}
			>
				<Phone className="size-[18px] rotate-[135deg] fill-current stroke-[1.5]" />
			</button>

			{mounted && (
				<>
					{/*
					 * Above the button it belongs to, rather than in the middle of
					 * the window.
					 *
					 * The control bar sits along the bottom edge, so a dialog
					 * centred in the window puts the answer a long way from the
					 * question — and on a hand-held screen it reads as being
					 * somewhere else entirely. Anchored, the two are one gesture:
					 * press, and the choice is where your thumb already is.
					 */}
					<div
						ref={dialog}
						role="dialog"
						aria-modal
						aria-label={t("Leave")}
						onKeyDown={(event) => {
							// Held inside while it is open, as a modal dialog says it
							// is: two rows, and Tab goes round them.
							if (event.key !== "Tab") return;
							const rows = [...(dialog.current?.querySelectorAll("button") ?? [])];
							const first = rows[0];
							const last = rows[rows.length - 1];
							if (!event.shiftKey && document.activeElement === last) {
								event.preventDefault();
								first?.focus();
							} else if (event.shiftKey && document.activeElement === first) {
								event.preventDefault();
								last?.focus();
							}
						}}
						className={cn(
							// Its right edge on the button's rather than its middle.
							// The button is the last thing on the island, and centred
							// on it the dialog ran past the right of a phone's screen
							// by sixty pixels, its words cut off at the edge.
							"absolute right-0 bottom-full z-50 mb-3 w-64 max-w-[calc(100vw-1.5rem)]",
							// Rows of eight inside a card of sixteen, with eight
							// between: concentric.
							"flex flex-col gap-1 rounded-2xl border border-border p-2",
							// Opaque. What it asks has consequences, and the words
							// asking it were drawn over moving pictures at ninety-five
							// per cent.
							"bg-surface-hi shadow-2xl ring-1 ring-shade/40 afloat",
							// From the button rather than from nowhere, and back into
							// it on the way out.
							"origin-bottom-right",
							leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<button
							type="button"
							disabled={busy}
							onClick={onLeave}
							className={cn(
								"pressable flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none",
								"hover:bg-wash focus-visible:bg-wash active:bg-wash-press disabled:opacity-40",
							)}
						>
							<LogOut className="size-4 shrink-0 text-fg-muted" />
							<span className="flex flex-col gap-0.5">
								<span className="font-medium text-[14px] text-fg">{t("Leave the call")}</span>
								<span className="text-[12px] text-fg-muted leading-snug">
									{t("The meeting carries on without you.")}
								</span>
							</span>
						</button>

						{host && (
							<button
								type="button"
								disabled={busy}
								onClick={async () => {
									setBusy(true);

									try {
										await dissolve(room);

										// The media server disconnects everybody, this
										// browser among them, and that is what should
										// carry the host out — the screen they land on
										// is then the one everybody else lands on.
										//
										// Waited for rather than relied on. If the
										// disconnect does not arrive, the person who
										// just ended the meeting is left sitting in it
										// looking at a room that no longer exists, which
										// is the worst outcome of the three and the one
										// that actually happened.
										setTimeout(onLeave, 1200);
									} catch {
										actionFailed(t("That could not be done. Try again."));
										setBusy(false);
									}
								}}
								className={cn(
									"pressable flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none",
									"hover:bg-danger/10 focus-visible:bg-danger/10 active:bg-danger/15 disabled:opacity-40",
								)}
							>
								{busy ? (
									<Loader2 className="size-4 shrink-0 animate-spin text-danger-ink" />
								) : (
									<DoorClosed className="size-4 shrink-0 text-danger-ink" />
								)}
								<span className="flex flex-col gap-0.5">
									<span className="font-medium text-[14px] text-danger-ink">{t("End for everybody")}</span>
									<span className="text-[12px] text-fg-muted leading-snug">
										{t("Everybody is disconnected and links stop working.")}
									</span>
								</span>
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
