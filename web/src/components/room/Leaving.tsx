import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { dissolve } from "@/live/host";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import type { Room } from "livekit-client";
import { DoorClosed, Loader2, LogOut, PhoneOff } from "lucide-react";
import { useEffect, useState } from "react";

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
	// something is a dialog somebody chooses something in by accident.
	useEffect(() => {
		if (!open) return;

		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("keydown", escape);

		return () => document.removeEventListener("keydown", escape);
	}, [open]);

	return (
		<div className="relative">
			<button
				type="button"
				aria-label={t("Leave")}
				aria-expanded={open}
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"grid size-11 place-items-center rounded-full bg-danger text-danger-fg",
					"transition-[transform,opacity] hover:opacity-90 active:scale-95",
				)}
			>
				<PhoneOff className="size-5" />
			</button>

			{mounted && (
				<>
					{/*
					 * Nothing to look at, and its whole job is to be pressed.
					 *
					 * A question needs a way out that is not an answer, and on a
					 * screen this is a press anywhere else. Left as a bare document
					 * listener it would also catch the press that opened it, so it
					 * is a layer instead — which additionally stops the press
					 * landing on whatever was underneath.
					 */}
					<button
						type="button"
						aria-label={t("Cancel")}
						onClick={() => setOpen(false)}
						className="fixed inset-0 z-40 cursor-default"
					/>

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
						role="dialog"
						aria-modal
						className={cn(
							"absolute bottom-full left-1/2 z-50 mb-3 w-64 -translate-x-1/2",
							"flex flex-col gap-1 rounded-2xl border border-border p-2",
							"bg-surface-hi/95 shadow-2xl ring-1 ring-black/40 backdrop-blur",
							// From the button rather than from nowhere, and back into
							// it on the way out.
							"origin-bottom",
							leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<button
							type="button"
							disabled={busy}
							onClick={onLeave}
							className={cn(
								"flex items-center gap-3 rounded-xl px-3 py-2.5 text-left",
								"transition-colors hover:bg-fg/5 disabled:opacity-40",
							)}
						>
							<LogOut className="size-4 shrink-0 text-fg-muted" />
							<span className="flex flex-col gap-0.5">
								<span className="text-[13.5px] text-fg">{t("Leave the call")}</span>
								<span className="text-[11.5px] text-fg-muted leading-snug">
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
									"flex items-center gap-3 rounded-xl px-3 py-2.5 text-left",
									"transition-colors hover:bg-danger/10 disabled:opacity-40",
								)}
							>
								{busy ? (
									<Loader2 className="size-4 shrink-0 animate-spin text-danger" />
								) : (
									<DoorClosed className="size-4 shrink-0 text-danger" />
								)}
								<span className="flex flex-col gap-0.5">
									<span className="text-[13.5px] text-fg">{t("End for everybody")}</span>
									<span className="text-[11.5px] text-fg-muted leading-snug">
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
