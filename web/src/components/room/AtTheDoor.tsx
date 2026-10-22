import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { type Knocking as Waiting, answer, knocking } from "@/live/knock";
import { useCallback, useEffect, useState } from "react";

/** How often somebody in the room looks to see whether anybody is outside. */
const LOOK_EVERY = 4000;

/**
 * Watching the door, for as long as somebody in the room can open it.
 *
 * Held here rather than inside the panel, which is where it started and where
 * it was useless: the panel is behind the crown, so it is mounted only while
 * the host has it open, and nothing asked whether anybody was outside the rest
 * of the time. The first end-to-end run of this had a stranger knock, wait the
 * whole two and a half minutes and give up, with the host in the call and no
 * sign on their screen that it had happened.
 *
 * So the room watches and the panel only draws. What the watching produces —
 * a count on the crown and a notice that stays up — is what a host actually
 * sees, and the panel is where they act on it.
 */
export function useTheDoor(room: string, token: string, watching: boolean) {
	const [waiting, setWaiting] = useState<Waiting[]>([]);
	const [busy, setBusy] = useState<string>();

	const look = useCallback(async () => {
		if (!watching) return;

		try {
			const said = await knocking(room, token);
			setWaiting(said.knocking ?? []);
		} catch {
			// A round that did not answer is not an empty door.
		}
	}, [room, token, watching]);

	useEffect(() => {
		if (!watching) {
			setWaiting([]);
			return;
		}

		let live = true;

		const tick = async () => {
			if (!live) return;
			await look();
			if (live) timer = window.setTimeout(tick, LOOK_EVERY);
		};

		let timer = window.setTimeout(tick, 0);

		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [look, watching]);

	const decide = useCallback(
		async (id: string, admit: boolean) => {
			setBusy(id);

			try {
				await answer(room, id, token, admit);

				// Taken off the list here rather than waiting for the next round,
				// so a press does something the moment it is pressed.
				setWaiting((was) => was.filter((one) => one.id !== id));
			} catch {
				await look();
			} finally {
				setBusy(undefined);
			}
		},
		[look, room, token],
	);

	return { waiting, busy, decide };
}

export type Door = ReturnType<typeof useTheDoor>;

/**
 * Who is at the door, for somebody who can open it.
 *
 * Drawn only when somebody is there. A permanent empty list would be a thing
 * the host learns to stop reading, and the whole value of this is that a name
 * appearing in it is noticed.
 *
 * Both halves of what there is to go on are shown: what they typed to be
 * called, which is a claim, and where they knocked from, which is not. Neither
 * is proof and the panel does not pretend otherwise — it is the same
 * information the host would have if somebody knocked on a real door, which is
 * a voice and nothing else.
 */
export function AtTheDoor({ waiting, busy, decide }: Door) {
	const t = useT();

	if (waiting.length === 0) return null;

	return (
		<div className="flex flex-col gap-1.5 border-border border-t pt-2">
			<p className="text-fg-muted text-[11px]">{t("Waiting to be let in")}</p>

			{waiting.map((one) => (
				<div key={one.id} className="flex items-center gap-2">
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[12.5px]">{one.name || t("Somebody")}</span>
						<span className="readout block truncate text-[10.5px] text-fg-muted">
							{one.address}
						</span>
					</span>

					<button
						type="button"
						disabled={busy === one.id}
						onClick={() => void decide(one.id, true)}
						className={cn(
							"rounded-md bg-fg px-2 py-1 text-[11px] text-bg",
							"transition-opacity hover:opacity-90 disabled:opacity-40",
						)}
					>{t("Let in")}</button>

					<button
						type="button"
						disabled={busy === one.id}
						onClick={() => void decide(one.id, false)}
						className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-surface-hi"
					>{t("Not now")}</button>
				</div>
			))}
		</div>
	);
}
