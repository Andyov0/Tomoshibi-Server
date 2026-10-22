import { Flagged } from "@/components/room/Flag";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { type Door, AtTheDoor, useTheDoor } from "./AtTheDoor";
import { tokenFor } from "@/live/room";
import type { Phrase } from "@/live/i18n";
import {
	dissolve,
	handOver,
	invite,
	moveRoom,
	revoke,
	silence,
	turnOut,
	useOthers,
	type Standing,
} from "@/live/host";
import { scopeOf } from "@/live/names";
import { signatureOf } from "@/live/name";
import { actionDone, actionFailed, atTheDoor } from "@/live/notices";
import { cn } from "@/lib/utils";
import type { Room } from "livekit-client";
import {
	Check,
	Crown,
	DoorClosed,
	Link2,
	Link2Off,
	Loader2,
	Server,
	MicOff,
	UserMinus,
	X,
} from "lucide-react";
import { type Relay, relays } from "@/live/relays";
import { useEffect, useState } from "react";

/**
 * The small console for whoever is running the meeting.
 *
 * Three things and a link, which is the whole of what a meeting needs and
 * deliberately less than what the management pages can do. Those belong to
 * whoever runs the deployment and reach every room on every relay; this belongs
 * to whoever opened this one and reaches nobody outside it.
 *
 * Quietening somebody is done at the server rather than by asking them, because
 * the case it exists for is a microphone left open in a noisy room by somebody
 * who is not reading the chat. Handing the room over is here because the person
 * who opened a recurring meeting is often not the person running it, and because
 * they leave — a room whose host has gone is a room nobody can quiet.
 *
 * Removing somebody does not stop them coming back. Saying so on the button
 * would be noise; not knowing it would be worse, so it is said once, under the
 * list, where somebody about to use it will read it.
 */
export function HostPanel({
	door,
	room,
	standing,
	onClose,
}: {
	door: Door;
	room: Room;
	standing: Standing;
	onClose: () => void;
}) {
	const t = useT();
	const others = useOthers(room);

	// A room held under a scope has no host to hand over: every member runs it,
	// and the server refuses the handover outright. The button goes rather than
	// answering with a refusal, because a control that can never work is a
	// question somebody asks and nobody can answer.
	const scoped = scopeOf(room.name) !== "";
	const [busy, setBusy] = useState<string>();
	const [link, setLink] = useState<string>();
	const [copied, setCopied] = useState(false);

	// Asked once rather than done at once. Ending a meeting for eleven people is
	// not undoable and the button for it sits next to three that are, so the
	// press that matters is deliberately the second one — and the question names
	// what will happen rather than asking whether they are sure, which is a
	// question nobody has ever answered no to by reading it.
	const [ending, setEnding] = useState(false);

	const act = async (who: string, run: () => Promise<unknown>) => {
		if (busy) return;

		setBusy(who);

		try {
			await run();
		} catch (err) {
			actionFailed(explain(err, t));
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<aside
			className={cn(
				"pointer-events-auto flex w-72 flex-col gap-2 rounded-xl border border-border p-3",
				"bg-surface/95 shadow-2xl backdrop-blur",
				"origin-top-right animate-arrive",
			)}
		>
			<header className="flex items-center gap-2">
				<Crown className="size-3.5 text-tally" />
				<h2 className="font-medium text-[13px]">{t("Running this room")}</h2>

				<button
					type="button"
					onClick={onClose}
					aria-label={t("Close")}
					className="ml-auto rounded-md p-1 text-fg-muted hover:bg-surface-hi hover:text-fg"
				>
					<X className="size-3.5" />
				</button>
			</header>

			{/*
			  * A link somebody can be sent, which is the thing a host reaches for
			  * most and the one that needs no target. It lets one person in, once,
			  * without a passphrase — so a guest is invited to a meeting rather
			  * than given an account or a room name that works forever.
			  */}
			<div className="flex flex-col gap-1.5">
				<button
					type="button"
					disabled={busy === "invite"}
					onClick={() =>
						act("invite", async () => {
							const made = await invite(room);
							setLink(made);
							setCopied(false);

							// Copied as well as shown. Whoever pressed this is about
							// to paste it somewhere, and a link they have to select
							// out of a box first is a link they select badly.
							await navigator.clipboard.writeText(made).then(
								() => setCopied(true),
								() => setCopied(false),
							);
						})
					}
					className={cn(
						"flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12.5px]",
						"transition-colors hover:bg-surface-hi disabled:opacity-40",
					)}
				>
					{busy === "invite" ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : copied ? (
						<Check className="size-3.5 text-tally" />
					) : (
						<Link2 className="size-3.5" />
					)}
					{copied ? t("Link copied") : t("Invite somebody")}
				</button>

				{/* Who is outside, under the control for letting people in — the
				    two are the same thought, and a knock is only ever answered by
				    somebody who was already deciding who is in the room. */}
				<AtTheDoor {...door} />

				{link && (
					<>
						<p className="readout break-all rounded-md bg-surface-hi px-2 py-1.5 text-[10.5px] text-fg-muted">
							{link}
						</p>

						<p className="text-[10.5px] text-fg-muted/80 leading-snug">
							{t("Anybody with this link can join, until you end the meeting. No passphrase needed.")}{" "}
							{/* The ceiling under that rule, which the panel never mentioned.
							    Most meetings end long before it and never meet it; the one
							    that does is a link sent on Friday for a Monday morning,
							    which stops working overnight with nothing anywhere saying
							    it would. */}
							{t("It stops working after a day either way.")}
						</p>

						{/*
						 * Because a link goes out and cannot be taken back.
						 *
						 * It gets pasted into the wrong window, or into the right one
						 * with the wrong person in it, and until this existed the only
						 * way to make it stop working was to end the meeting — which
						 * is a far larger thing to do about a mistake with a URL.
						 */}
						<button
							type="button"
							disabled={busy === "revoke"}
							onClick={() =>
								act("revoke", async () => {
									const gone = await revoke(room);
									setLink(undefined);
									setCopied(false);

									// Said, because "nothing happened" and "three links
									// stopped working" look identical otherwise, and the
									// reason to press this is not being sure which.
									actionDone(
										gone === 1
											? t("One link stopped working.")
											: t("{count} links stopped working.", { count: String(gone) }),
									);
								})
							}
							className={cn(
								"flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[11px]",
								"text-fg-muted transition-colors hover:bg-danger/10 hover:text-fg",
								"disabled:opacity-40",
							)}
						>
							{busy === "revoke" ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<Link2Off className="size-3" />
							)}
							{/* Under a scope the revocation also takes the standing
							    links members made on their own pages, so the button
							    says every link rather than this one. */}
							{scoped ? t("Stop every link to this room working") : t("Stop this link working")}
						</button>
					</>
				)}
			</div>

			<div className="h-px bg-border" />

			{/*
			 * Where the meeting is held, changed without ending it.
			 *
			 * Reserved machines are offered only to somebody who may use one. The
			 * server refuses the rest regardless — a name travels in a request
			 * anybody can write — so this is about not showing a host a door that
			 * will not open, rather than about keeping anything from them.
			 */}
			<Elsewhere
				admin={standing.admin}
				busy={busy === "move"}
				onMove={(relay) => act("move", () => moveRoom(room, relay))}
			/>

			<div className="h-px bg-border" />

			{others.length === 0 ? (
				<p className="px-0.5 py-1 text-[11.5px] text-fg-muted">{t("Nobody else is here.")}</p>
			) : (
				<ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
					{others.map((one) => (
						<li
							key={one.identity}
							className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-hi"
						>
							<span className="min-w-0 flex-1 truncate text-[12.5px]">
								{one.name || one.identity}
							</span>

							{busy === one.identity && (
								<Loader2 className="size-3.5 animate-spin text-fg-muted" />
							)}

							<button
								type="button"
								disabled={busy !== undefined || !one.isMicrophoneEnabled}
								onClick={() => act(one.identity, () => silence(room, one))}
								aria-label={t("Mute")}
								title={t("Mute")}
								className="rounded p-1 text-fg-muted hover:bg-surface-hi hover:text-fg disabled:opacity-30"
							>
								<MicOff className="size-3.5" />
							</button>

							{!scoped && (
								<HandOver
									guest={signatureOf(one.identity)?.proven === false}
									busy={busy !== undefined}
									onHandOver={() => act(one.identity, () => handOver(room, one))}
								/>
							)}

							<button
								type="button"
								disabled={busy !== undefined}
								onClick={() => act(one.identity, () => turnOut(room, one))}
								aria-label={t("Remove from room")}
								title={t("Remove from room")}
								className="rounded p-1 text-fg-muted hover:bg-surface-hi hover:text-danger disabled:opacity-30"
							>
								<UserMinus className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="h-px bg-border" />

			{ending ? (
				<div className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5">
					<p className="text-[11.5px] text-fg leading-snug">
						{scoped
							? t("Everybody will be disconnected and told the room has closed. Links made in the call stop working; links made on an account page do not.")
							: t("Everybody will be disconnected and told the room has closed. Links to it stop working.")}
					</p>

					<div className="flex gap-2">
						<button
							type="button"
							disabled={busy === "close"}
							onClick={() => act("close", () => dissolve(room))}
							className={cn(
								"flex flex-1 items-center justify-center gap-1.5 rounded-md bg-danger px-2.5 py-1.5",
								"text-[12px] text-danger-fg transition-opacity hover:opacity-90 disabled:opacity-40",
							)}
						>
							{busy === "close" && <Loader2 className="size-3.5 animate-spin" />}
							{t("Close the room")}
						</button>

						<button
							type="button"
							onClick={() => setEnding(false)}
							className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-hi"
						>
							{t("Cancel")}
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setEnding(true)}
					className={cn(
						"flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12.5px]",
						"text-fg-muted transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-fg",
					)}
				>
					<DoorClosed className="size-3.5" />
					{t("End this meeting")}
				</button>
			)}

			{/*
			 * Said once, here, because it is the one thing about these controls
			 * that is not obvious and the one that decides whether somebody
			 * reaches for the right one. Removing ends a call; it does not lock a
			 * door, because there is no door — a room is a name.
			 */}
			<p className="px-0.5 text-[10.5px] text-fg-muted/80 leading-snug">
				{standing.admin
					? t("You can do this because you administer this server. Removing somebody ends their call; it does not stop them rejoining.")
					: t("Removing somebody ends their call. It does not stop them rejoining with the same name.")}
			</p>
		</aside>
	);
}

/** The button that opens it, and the panel, with an exit that is not a vanishing. */
export function Hosting({ room, standing }: { room: Room; standing: Standing }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { mounted, leaving } = useLingering(open);

	// Watched from here rather than from inside the panel, because the panel is
	// behind this button and is mounted only while it is open. See useTheDoor:
	// somebody knocked, waited, and gave up, with the host in the call.
	//
	// Only for whoever runs the room. Everybody else calls this hook and it does
	// nothing, which is a hook that has to be called unconditionally rather than
	// a branch above it.
	const door = useTheDoor(room.name, tokenFor(room), standing.yours);
	const waiting = door.waiting.length;

	// Said out loud, and taken back the moment the door is empty. A count on a
	// small crown in the corner is not something somebody looking at a face
	// notices, and this is the one thing in the room where nobody noticing means
	// a person waits outside until they give up.
	useEffect(() => {
		if (waiting === 0 || open) return;

		return atTheDoor(waiting, () => setOpen(true));
	}, [waiting, open]);

	if (!standing.yours) return null;

	return (
		<div className="pointer-events-auto flex flex-col items-end gap-2">
			<button
				type="button"
				onClick={() => setOpen((was) => !was)}
				aria-label={t("Running this room")}
				aria-pressed={open}
				className={cn(
					"flex items-center gap-1.5 rounded-full bg-surface-hi/90 px-2.5 py-1.5 shadow backdrop-blur",
					"text-xs transition-colors hover:bg-surface-hi",
					open && "text-tally",
					// Coloured rather than only counted: the number is four pixels
					// tall and the colour is the thing seen out of the corner of an
					// eye.
					!open && waiting > 0 && "text-tally",
				)}
			>
				<Crown className="size-3.5" />

				{waiting > 0 && (
					<span className="readout text-[11px] leading-none">{waiting}</span>
				)}
			</button>

			{mounted && (
				<div className={leaving ? "animate-depart" : undefined}>
					<HostPanel door={door} room={room} standing={standing} onClose={() => setOpen(false)} />
				</div>
			)}
		</div>
	);
}


/**
 * The crown beside somebody, which makes them the host.
 *
 * Drawn as unavailable beside a guest — somebody whose identity was drawn from
 * nothing rather than from a passphrase — because the server refuses to hand a
 * room to one: the mark is worn by whoever reads it, so a room parked on it
 * answers to anybody. It used to be pressable like any other, and the refusal
 * came back as "they have already left", about somebody visibly still in the
 * call.
 *
 * Dimmed rather than taken away, so a host looking for the control finds it and
 * finds out why; and pressable rather than disabled, because a disabled button
 * explains itself only to a pointer that can hover — on a phone, which is where
 * plenty of hosts are, a title is never seen. A press says the reason and asks
 * the server nothing. Named by the signature's prefix and nothing else: an
 * identity that does not parse as either is left to the server, which knows it
 * as nobody.
 */
function HandOver({ guest, busy, onHandOver }: { guest: boolean; busy: boolean; onHandOver: () => void }) {
	const t = useT();
	const why = t("They joined without a passphrase, so they cannot run the room. Ask them to rejoin with one.");

	return (
		<button
			type="button"
			disabled={busy}
			aria-disabled={guest || undefined}
			onClick={guest ? () => actionFailed(why) : onHandOver}
			aria-label={t("Make host")}
			title={guest ? why : t("Make host")}
			className={cn(
				"rounded p-1 text-fg-muted transition-colors disabled:opacity-30",
				guest ? "cursor-not-allowed opacity-30" : "hover:bg-surface-hi hover:text-tally",
			)}
		>
			<Crown className="size-3.5" />
		</button>
	);
}

/** Choosing where the meeting is held, from inside it. */
function Elsewhere({
	admin,
	busy,
	onMove,
}: {
	admin: boolean;
	busy: boolean;
	onMove: (relay: string) => void;
}) {
	const t = useT();
	const [servers, setServers] = useState<Relay[]>([]);
	const [open, setOpen] = useState(false);
	const { mounted, leaving } = useLingering(open, 160);

	useEffect(() => {
		void relays().then((offered) => setServers(offered.relays));
	}, []);

	// Reserved machines only where they can be used. Everywhere else this list
	// shows them greyed, because hiding a machine somebody used yesterday makes
	// it look deleted — here it is a choice rather than a description, and a
	// choice nobody may take is a choice that should not be offered.
	const usable = servers.filter((relay) => !relay.maintenance && (admin || !relay.adminOnly));

	if (usable.length < 2) return null;

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				disabled={busy}
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12.5px]",
					"transition-colors hover:bg-surface-hi disabled:opacity-40",
				)}
			>
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Server className="size-3.5" />}
				{t("Hold this call somewhere else")}
			</button>

			{mounted && (
				<div
					className={cn(
						"flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-1",
						"origin-top bg-surface",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<p className="px-2 py-1 text-[10.5px] text-fg-muted leading-snug">
						{t("Everybody is reconnected. Nobody has to do anything.")}
					</p>

					{usable.map((relay) => (
						<button
							key={relay.name}
							type="button"
							onClick={() => {
								onMove(relay.name);
								setOpen(false);
							}}
							className="rounded px-2 py-1 text-left text-[12px] transition-colors hover:bg-surface-hi"
						>
							<Flagged text={relay.label || relay.name} />
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * The server sends a code; this owns the sentence.
 *
 * Written out one code at a time rather than looked up, because each of these
 * wants a different next move and a table would tempt somebody to give two of
 * them the same words. The one that matters most is the unreachable relay: it
 * is the failure this deployment actually has, it is not the host's fault, and
 * "try again" — which is what every one of these used to say — is the one piece
 * of advice that cannot help.
 */
function explain(err: unknown, t: (phrase: Phrase) => string): string {
	const code = err instanceof Error ? err.message : "";

	switch (code) {
		case "media_unreachable":
			return t("That server did not answer. The meeting has not been moved.");
		case "no_such_relay":
			return t("That server is no longer on this deployment.");
		case "relay_not_allowed":
			return t("That server is reserved, and this meeting may not be put on it.");
		case "no_such_person":
			return t("They have already left.");
		case "not_proven":
			return t("They joined without a passphrase, so they cannot run the room. Ask them to rejoin with one.");
		case "not_yours":
			return t("You no longer run this room.");
		case "scoped_room":
			return t("Every member of this room's scope runs it, so there is nobody to hand it to.");
		case "rate_limited":
			return t("Too many attempts. Try again in a moment.");
		default:
			return t("That could not be done. Try again.");
	}
}
