import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { ASK_EVERY, GIVE_UP_AFTER, atTheDoor, knock } from "@/live/knock";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Standing at the door of a meeting that turned you away.
 *
 * Offered after the refusal rather than beside the join, because most people
 * pressing Join have a link and will never see either. Somebody who is refused
 * is exactly the person this is for, and at that moment it is the only thing on
 * the screen worth pressing.
 *
 * What being let in produces is an invite, and the invite is then joined with
 * in the ordinary way — so nothing here is a second way into a room. It is a
 * way of being handed the first one.
 */
export function Knocking({
	room,
	name,
	onAdmitted,
}: {
	room: string;
	name: string;
	onAdmitted: (invite: string) => void;
}) {
	const t = useT();

	const [asking, setAsking] = useState(false);
	const [gaveUp, setGaveUp] = useState(false);
	const [failed, setFailed] = useState(false);

	// Held in a ref so that the polling effect does not restart when it changes,
	// and so a second press cannot start a second knock.
	const token = useRef<string>();
	const admitted = useRef(onAdmitted);
	admitted.current = onAdmitted;

	const start = useCallback(async () => {
		if (asking) return;

		setFailed(false);
		setGaveUp(false);

		try {
			const said = await knock(room, name);
			token.current = said.token;
			setAsking(true);
		} catch {
			setFailed(true);
		}
	}, [asking, name, room]);

	useEffect(() => {
		if (!asking) return;

		let live = true;
		// The door decides when this is over, not a clock out here. See
		// GIVE_UP_AFTER: this one is only for a server that never answers.
		const until = Date.now() + GIVE_UP_AFTER;

		const look = async () => {
			if (!live || !token.current) return;

			try {
				const said = await atTheDoor(room, token.current);

				if (!live) return;

				if (said.state === "admitted" && said.invite) {
					setAsking(false);
					admitted.current(said.invite);
					return;
				}

				// A refusal and a knock nobody answered arrive the same, because
				// they are the same thing from out here. Both stop the waiting.
				if (said.state === "refused") {
					setAsking(false);
					setGaveUp(true);
					return;
				}
			} catch {
				// A round that did not answer is not the end of waiting: the
				// person inside has not gone anywhere.
			}

			if (!live) return;

			if (Date.now() > until) {
				setAsking(false);
				setGaveUp(true);
				return;
			}

			timer = window.setTimeout(look, ASK_EVERY);
		};

		let timer = window.setTimeout(look, ASK_EVERY);

		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [asking, room]);

	if (asking) {
		return (
			<p className="flex items-center justify-center gap-2 text-fg-muted text-xs">
				<Loader2 className="size-3.5 animate-spin" />
				{t("Waiting for somebody to let you in.")}
			</p>
		);
	}

	return (
		<div className="flex flex-col items-center gap-1.5">
			<button
				type="button"
				disabled={!name.trim()}
				onClick={() => void start()}
				className={cn(
					"rounded-full border border-border px-3 py-1.5 text-xs",
					"transition-colors hover:bg-surface-hi disabled:opacity-40",
				)}
			>{t("Ask to be let in")}</button>

			{/* Said the same way for both, because they are the same thing from
			    out here: nobody answered, or somebody said no, and telling them
			    apart would say something about the room to whoever knocked. */}
			{gaveUp && (
				<p className="text-fg-muted text-[11px]">{t("Nobody let you in. Ask for a link.")}</p>
			)}

			{failed && <p className="text-tally text-[11px]">{t("That could not be sent.")}</p>}
		</div>
	);
}
