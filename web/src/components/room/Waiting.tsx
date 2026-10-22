import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { Refused } from "@/live/api";
import { type Arrangement, HOST_NOT_COMING_AFTER, arranged, askEvery, whenSaid } from "@/live/meeting";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The join screen's button, for somebody who arrived on a meeting link.
 *
 * Everything else on the screen is the ordinary one — name, camera,
 * microphone, which door to dial — because the whole point of arriving early is
 * to have those settled before the meeting. What changes is the button: the
 * meeting may not have begun, and until it has there is nothing to join.
 *
 * ## Three branches, not two
 *
 * Somebody waiting presses and waits. Somebody who arrived after it began
 * presses Join and goes in with the invitation the link now carries. And the
 * person who arranged it presses Start and goes in outright — their join is
 * the event everybody else is waiting for. The first version had the first two
 * and sent the host down the waiting path, where they waited for themselves.
 *
 * The host is offered Start only inside the window in which the server will
 * actually begin the meeting. Outside it the join goes through and begins
 * nothing, which from the host's chair is a Start that silently did not.
 *
 * ## The shape is the waiting room's
 *
 * Nothing here happens until the button is pressed. An earlier draft began
 * asking the moment the page opened and joined the moment the answer came, and
 * that had two dead ends: a person still typing their name when the host
 * arrived was joined with no name, which the join refuses silently; and a
 * person who opened the link after it began was joined before they had looked
 * at their own camera, which is the one thing they were told they would get to
 * do first.
 *
 * ## What it says while waiting, and when it stops
 *
 * When the meeting is for, in the reader's own clock and zone. It stops when
 * the host has come, when the meeting has ended or been cancelled, or two
 * hours after the arranged time with no host — said, with a way to ask again,
 * because a screen that waits for ever is indistinguishable from one that is
 * broken and a screen that gives up for ever is a reload away from working.
 *
 * A read that fails is retried, and after the first failure says so. A first
 * read that failed used to leave the button disabled for good with nothing on
 * the screen to explain it, which is the same shape of fault as the black tile
 * elsewhere in this codebase: nothing wrong to look at, nothing to press.
 */

/** How often to retry a read that did not answer. Slower than the poll: a
 * server that is not answering is not helped by being asked faster. */
const RETRY_EVERY = 30_000;

export function Waiting({
	token,
	name,
	onArranged,
	onGo,
	onStart,
}: {
	token: string;
	/** What they typed to be called. Nothing is asked until there is one. */
	name: string;
	/** The meeting, as soon as it is known and whenever it changes. */
	onArranged: (meeting: Arrangement) => void;
	/** Go in, carrying the invite the meeting produced. */
	onGo: (invite: string) => void;
	/**
	 * Go in as the host, which is what begins the meeting.
	 *
	 * A separate door from onGo because the host carries no invitation and
	 * needs none: their own join is the event everybody else is waiting for.
	 */
	onStart: () => void;
}) {
	const t = useT();

	const [meeting, setMeeting] = useState<Arrangement>();
	const [gone, setGone] = useState<"ended" | "cancelled" | "not-coming">();
	const [asking, setAsking] = useState(false);
	const [unreachable, setUnreachable] = useState(false);
	// A clock, so the host's button comes alive when the window opens without
	// anybody reloading the page.
	const [now, setNow] = useState(() => Date.now());

	const told = useRef(onArranged);
	told.current = onArranged;
	const go = useRef(onGo);
	go.current = onGo;
	const start = useRef(onStart);
	start.current = onStart;

	const look = useCallback(async (): Promise<Arrangement | undefined> => {
		try {
			const said = await arranged(token);
			setMeeting(said);
			setUnreachable(false);
			told.current(said);

			if (said.ended) setGone("ended");

			return said;
		} catch (whatever) {
			if (whatever instanceof Refused && whatever.reason === "no_such_meeting") {
				setGone("cancelled");
				return undefined;
			}

			// A rate limit, a lost connection: not an answer. Said, and tried
			// again below, rather than left as a button that never enables.
			setUnreachable(true);

			return undefined;
		}
	}, [token]);

	// Read on arrival so the screen can say what it is for, and again until it
	// can.
	useEffect(() => {
		let live = true;
		let timer = 0;

		const tick = async () => {
			if (!live) return;

			const said = await look();

			if (!live || said) return;

			timer = window.setTimeout(tick, RETRY_EVERY);
		};

		timer = window.setTimeout(tick, 0);

		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [look]);

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);

		return () => window.clearInterval(timer);
	}, []);

	// Asking until the door answers, once somebody has pressed.
	useEffect(() => {
		if (!asking) return;

		let live = true;
		let timer = 0;

		const tick = async () => {
			if (!live) return;

			const said = await look();

			if (!live) return;

			if (said?.ended) {
				setAsking(false);
				return;
			}

			if (said?.started && said.invite) {
				setAsking(false);
				go.current(said.invite);
				return;
			}

			// The host is not coming. Said, rather than waited for.
			if (said && Date.now() - new Date(said.at).getTime() > HOST_NOT_COMING_AFTER) {
				setAsking(false);
				setGone("not-coming");
				return;
			}

			// A read that failed is not a reason to ask faster.
			const next = said ? askEvery(said.at, Date.now()) : RETRY_EVERY;
			timer = window.setTimeout(tick, next);
		};

		timer = window.setTimeout(tick, 0);

		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [asking, look]);

	const when = meeting ? whenSaid(meeting.at) : "";

	if (gone === "cancelled") {
		return <p className="text-fg-muted text-sm">{t("That invitation is no longer good. Ask for another.")}</p>;
	}

	if (gone === "ended") {
		return <p className="text-fg-muted text-sm">{t("That meeting has ended.")}</p>;
	}

	if (gone === "not-coming") {
		return (
			<div className="flex flex-col gap-2">
				<p className="text-fg-muted text-sm">{t("The host has not started this meeting.")}</p>
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						setGone(undefined);
						setAsking(true);
					}}
				>
					{t("Ask again")}
				</Button>
			</div>
		);
	}

	// Begun, and the invitation in hand: the ordinary button, because there is
	// nothing to wait for. Begun with no invitation means the room was closed
	// and the link has not caught up; the wait finds that out.
	const ready = Boolean(meeting?.started && meeting.invite);

	// The host may begin only from `from`. Before that the button is disabled
	// and says when, rather than offering a Start that begins nothing.
	const opens = meeting ? new Date(meeting.from ?? meeting.at).getTime() : 0;
	const tooEarly = Boolean(meeting?.mine && !ready && now < opens);

	return (
		<div className="flex flex-col gap-2">
			{meeting && !ready && (
				<p className="text-fg-muted text-xs leading-snug">
					{meeting.mine
						? tooEarly
							? t("Your meeting can start from {when}.", { when: whenSaid(new Date(opens).toISOString()) })
							: t("Your meeting is arranged for {when}. Joining starts it.", { when })
						: t("This meeting is arranged for {when}.", { when })}
				</p>
			)}

			{unreachable && !meeting && (
				<p className="text-fg-muted text-xs leading-snug">{t("Could not reach the meeting. Trying again.")}</p>
			)}

			<Button
				type="button"
				variant="primary"
				size="lg"
				className="w-full"
				disabled={!name.trim() || asking || !meeting || tooEarly}
				onClick={() => {
					if (ready && meeting?.invite) {
						go.current(meeting.invite);
						return;
					}

					// The host does not wait for the host.
					if (meeting?.mine) {
						start.current();
						return;
					}

					setAsking(true);
				}}
			>
				{asking ? (
					<span className="flex items-center gap-2">
						<Loader2 className="size-4 animate-spin" />
						{t("Waiting for the host to start the meeting.")}
					</span>
				) : ready ? (
					t("Join")
				) : meeting?.mine ? (
					t("Start the meeting")
				) : (
					t("Wait for the host")
				)}
			</Button>
		</div>
	);
}
