import { useT } from "@/hooks/useT";
import { Flagged } from "@/components/room/Flag";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLingering } from "@/hooks/useLingering";
import {
	ArrowRight,
	ChevronLeft,
	Clock,
	DoorClosed,
	LogIn,
	MicOff,
	Move,
	Pin,
	Server,
	Trash2,
	UserMinus,
} from "lucide-react";
import { useCallback, useState } from "react";
import { type Participant, type Relay, type Track, api } from "./api";
import { actionFailed } from "@/live/notices";
import { JoiningCard, OpeningCard } from "./OpeningCard";
import { usePoll } from "./poll";
import { useTwice } from "./twice";
import { Card, Empty, Failed, Waiting } from "./Shell";
import { bitrate, clock, day, since } from "./units";
import { WatchCard } from "./WatchCard";
import { Device } from "./Device";

/**
 * The rooms, and whoever is in the one selected.
 *
 * The right-hand side is the panel that earns this whole surface. What the
 * media server negotiated with each publisher — the codec, the resolution it
 * settled on, the layers underneath it and what each is allowed to spend — was
 * known here all along and visible nowhere. Working out whether a shared screen
 * was actually being sent at full resolution previously meant reading the
 * client's source and reasoning about it.
 */
export function RoomsPanel({
	canRooms,
	canSettings,
	onSignedOut,
}: {
	/** May close rooms, move them, and remove or mute the people in them. */
	canRooms: boolean;
	/** May change the deployment-wide switches drawn under the lists. */
	canSettings: boolean;
	onSignedOut: () => void;
}) {
	const t = useT();

	// The acts on a meeting, under the name every component below has always
	// used for them. They were moderate's until the acting half was cut along
	// what it acts on; the switches under the lists went to settings.
	const canModerate = canRooms;

	const [selected, setSelected] = useState<string>();
	const [acting, setActing] = useState(false);

	// The machines a room can be moved to. Read once here rather than inside the
	// detail beside it, so opening a room does not fetch a list that has not
	// changed since the page was drawn.
	const { value: fleet } = usePoll(api.relays, { every: 30_000, onSignedOut });
	const relays = fleet?.relays ?? [];

	const { value, error, refresh } = usePoll(api.rooms, { onSignedOut });

	const live = value?.live ?? [];
	const known = value?.known ?? [];

	// Whatever was selected, as long as this server has heard of it.
	//
	// This used to check the live list alone, so a room that ended while
	// somebody was watching it closed the panel under them — which was the point
	// — and, once the known list became something you could click, selecting one
	// did nothing at all: the name went into state and straight back out.
	//
	// The panel is worth having for both. A call in progress has people in it and
	// a history; a call that has ended has a history, which is the half an
	// operator asks about afterwards and the half that outlives the media server.
	const open =
		selected &&
		(live.some((one) => one.name === selected) || known.some((one) => one.name === selected))
			? selected
			: undefined;

	const act = useCallback(
		async (what: () => Promise<void>) => {
			setActing(true);

			try {
				await what();
				await refresh();
			} catch (err) {
				// Something that happened rather than something still true: the
				// room is still there, the panel still works, and one press did
				// not take. It fades, like every other event in this deployment.
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setActing(false);
			}
		},
		[refresh],
	);

	const onForget = useCallback(
		(name: string) => {
			void act(async () => {
				await api.forgetRoom(name);

				// Whatever was open may have been the row that just went.
				setSelected((was) => (was === name ? undefined : was));
			});
		},
		[act],
	);

	return (
		<div
			className={cn(
				"mx-auto grid max-w-6xl gap-3 sm:gap-4 lg:grid-cols-[20rem_1fr]",
				// A drill-down while narrow: the list, then the room, with a way
				// back. Stacked, the list would push the detail below the fold and
				// every tap would become a scroll back up.
				open && "max-lg:block",
			)}
		>
			<div className={cn("flex flex-col gap-3 sm:gap-4", open && "max-lg:hidden")}>
				<Card title={t("In progress")} note={`${live.length}`}>
					{error && <Failed>{error}</Failed>}

					{live.length === 0 ? (
						<Empty>
							{value?.liveUnavailable
								? t("The media servers did not answer, so what is happening now is unknown. What this server has written down is below.")
								: t("No calls right now.")}
						</Empty>
					) : (
						<ul>
							{live.map((one) => (
								<li key={one.sid}>
									<button
										type="button"
										onClick={() => setSelected(one.name)}
										className={cn(
											"flex w-full flex-col gap-0.5 border-border border-b px-4 py-2.5 text-left last:border-0",
											"transition-colors hover:bg-surface-hi",
											one.name === open && "bg-surface-hi",
										)}
									>
										<span className="flex w-full items-baseline gap-2">
											<span className="truncate text-[13px]">{one.name}</span>
											{/* How many are in it, and how many of those are
											    sending anything.
											    Eight people with one of them publishing is a
											    presentation; eight publishing is a meeting;
											    eight with none publishing is eight people
											    whose media never started, which is the one
											    an operator is looking for. The second number
											    has always been sent and only the first was
											    drawn, so all three read the same.
											    Only where they differ — on a room where
											    everybody is publishing, which is most rooms,
											    a second identical number is noise. */}
											<span className="ml-auto shrink-0 text-fg-muted text-xs tabular-nums">
												{one.publishers !== undefined && one.publishers !== one.participants
													? `${one.participants} (${one.publishers} sending)`
													: one.participants}{" "}
												· {since(one.createdAt)}
											</span>
										</span>

										{/* Which machine the meeting is actually on.
										    Not asked of the media server, which reports a
										    room from whichever node answered — every node
										    answers for the whole cluster, so that field
										    holds the machine that was asked rather than
										    the machine holding the call. */}
										{one.relay && (
											<span className="flex items-center gap-1 truncate text-[11px] text-fg-muted">
												{/* A placement does not expire and is not
												    spent by being obeyed, so it has to be
												    visible: a pin nobody remembers making
												    is a room that ignores every later
												    choice with nothing to say why. */}
												{one.placed && <Pin className="size-2.5 shrink-0" />}
												<Flagged text={one.relay} />
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					)}
				</Card>

				<Card title={t("Known")} note={t("Rooms this server has seen")}>
					{known.length === 0 ? (
						<Empty>{t("None yet.")}</Empty>
					) : (
						<ul className="max-h-80 overflow-y-auto">
							{known.map((one) => (
								<li key={one.name} className="group relative">
									{/* Opens the same panel a live room opens.

									    It was a plain list item, which made the most
									    interesting rooms on the page the only ones that
									    could not be looked at: what an operator asks about a
									    meeting — who was in it, from where, through which
									    machine — is asked after it has ended, and the only
									    rooms that answered were the ones still running. */}
									<button
										type="button"
										onClick={() => setSelected(one.name)}
										className={cn(
											"flex w-full items-baseline gap-2 border-border border-b px-4 py-2 text-left last:border-0",
											"transition-colors hover:bg-surface-hi",
											one.name === open && "bg-surface-hi",
										)}
									>
										<span className="truncate text-[13px]">{one.name}</span>

										{one.placed && one.relay && (
											<span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted">
												<Pin className="size-2.5 shrink-0" />
												<Flagged text={one.relay} />
											</span>
										)}

										<span className="ml-auto shrink-0 text-fg-muted text-xs">
											{day(one.lastSeen)}
										</span>
									</button>

									{/* Beside the row rather than inside it: a button inside
									    a button is not a thing, and the row is a button
									    because the whole of it opens the history. */}
									{canModerate && (
										<Forget
											room={one.name}
											acting={acting}
											onForget={() => onForget(one.name)}
										/>
									)}
								</li>
							))}
						</ul>
					)}
				</Card>

				{/* Last of the three, and the order is the argument: what is
				    happening, what has happened, and what may happen next. Put
				    above the live rooms it would push the reason anybody opened
				    this panel below the fold. */}
				<OpeningCard canSettings={canSettings} onSignedOut={onSignedOut} />
				<JoiningCard canSettings={canSettings} onSignedOut={onSignedOut} />
				<WatchCard canSettings={canSettings} onSignedOut={onSignedOut} />
			</div>

			{open ? (
				<People
					room={open}
					onBack={() => setSelected(undefined)}
					canModerate={canModerate}
					acting={acting}
					relays={relays}
					onSignedOut={onSignedOut}
					// Read off the listing rather than asked for again: the room
					// being looked at is one of the rows behind this panel, and
					// a second request for a boolean already on screen is a
					// second thing that can be out of date with the first.
					placed={live.find((one) => one.name === open)?.placed ?? false}
					onClose={() => act(() => api.closeRoom(open))}
					onPlace={(relay, now) => {
						void act(async () => {
							await api.placeRoom(open, relay, now);
						});
					}}
					onFree={() => {
						void act(async () => {
							await api.freeRoom(open);
						});
					}}
					onPlacePerson={(identity, relay) => {
						void act(async () => {
							await api.placePerson(open, identity, relay);
						});
					}}
					onRemove={(identity) => act(() => api.remove(open, identity))}
					onMute={(identity, track) => act(() => api.mute(open, identity, track))}
				/>
			) : (
				<Card title={t("Participants")}>
					<Empty>{t("Choose a room.")}</Empty>
				</Card>
			)}
		</div>
	);
}

function People({
	room,
	onBack,
	canModerate,
	acting,
	relays,
	onSignedOut,
	onClose,
	placed,
	onPlace,
	onFree,
	onPlacePerson,
	onRemove,
	onMute,
}: {
	room: string;
	onBack: () => void;
	canModerate: boolean;
	acting: boolean;
	relays: Relay[];
	onSignedOut: () => void;
	onClose: () => void;
	placed: boolean;
	onPlace: (relay: string, now: boolean) => void;
	onFree: () => void;
	onPlacePerson: (identity: string, relay: string) => void;
	onRemove: (identity: string) => void;
	onMute: (identity: string, track: string) => void;
}) {
	const t = useT();

	const ask = useCallback(() => api.participants(room), [room]);
	const { value, error, loading } = usePoll(ask, { onSignedOut, about: room });

	// Asked once rather than done at once. Nothing else on this panel ends a call
	// for everybody in it, and it used to be one press away from a list somebody
	// is scrolling.
	const [ending, setEnding] = useState(false);

	const people = value ?? [];

	// Read off whoever is in the room rather than passed down. The list beside
	// this one holds the same two facts and would have to thread them through
	// two components to say them here, and they are the same answer either way:
	// everybody in one room is on one machine, because a meeting lives on one.
	const held = people.find((one) => one.holding || one.relay)?.holding ?? people[0]?.relay;
	const started = people.reduce<string | undefined>(
		(first, one) => (!first || one.joinedAt < first ? one.joinedAt : first),
		undefined,
	);

	return (
		<Card
			title={room}
			// Two phrases rather than a word chosen in code and glued to a number.
			// The English plural was picked here and the whole thing never went
			// through the dictionary, so a page translated everywhere else said
			// "0 people" in the middle of it.
			note={people.length === 1 ? t("1 person") : t("{count} people", { count: people.length })}
			className="self-start"
			actions={
				// The way back, carrying nothing but its own arrow: the room's
				// name is already the title beside it.
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1 lg:hidden">
					<ChevronLeft className="size-3.5" />{t("Rooms")}</Button>
			}
		>
			{error && <Failed>{error}</Failed>}

			{/*
			 * What this room is, before what can be done to it.
			 *
			 * The panel used to open with a red button and a list of names. The
			 * button was the loudest thing on the page and the one nobody wants to
			 * press by accident, and the two facts an operator actually came for —
			 * which machine is carrying this and how long it has been going — were
			 * nowhere at all: they had to be read off a row in the list beside,
			 * one participant at a time.
			 */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-border border-b px-4 py-2.5 text-[11.5px] text-fg-muted">
				{held && (
					<span className="flex items-center gap-1.5">
						<Server className="size-3" />
						<Flagged text={held} />
					</span>
				)}

				{/*
				 * Where the next call under this name is held, and — separately —
				 * moving the one in progress.
				 *
				 * A meeting lives on one machine and the media server has no way
				 * to hand it to another while it runs, so those are two different
				 * actions rather than one with a caveat. Choosing a relay sets
				 * where the next one goes; moving it now ends this call so
				 * everybody comes back to the machine that was chosen, and says so
				 * before it does.
				 */}
				{canModerate && relays.length > 0 && (
					<Moving
						relays={relays}
						acting={acting}
						placed={placed}
						onPlace={(relay, now) => onPlace(relay, now)}
						onFree={onFree}
					/>
				)}

				{started && (
					<span className="flex items-center gap-1.5">
						<Clock className="size-3" />
						{since(started)}
					</span>
				)}

				{canModerate && (
					<span className="ml-auto">
						{ending ? (
							<span className="flex items-center gap-2">
								<span className="text-fg">{t("Everybody is disconnected.")}</span>

								<button
									type="button"
									disabled={acting}
									onClick={onClose}
									className={cn(
										"rounded-md bg-danger px-2 py-1 text-[11px] text-danger-fg",
										"transition-opacity hover:opacity-90 disabled:opacity-40",
									)}
								>{t("Close it")}</button>

								<button
									type="button"
									onClick={() => setEnding(false)}
									className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-surface-hi"
								>{t("Cancel")}</button>
							</span>
						) : (
							/*
							 * Quiet until it is asked for. Ending a call for eleven
							 * people is not undoable and had no step in front of it,
							 * sitting where a press meant for the list would land.
							 */
							<button
								type="button"
								onClick={() => setEnding(true)}
								className={cn(
									"flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
									"text-fg-muted transition-colors hover:bg-danger/10 hover:text-fg",
								)}
							>
								<DoorClosed className="size-3" />{t("Close this room")}</button>
						)}
					</span>
				)}
			</div>

			{loading ? (
				<Waiting />
			) : people.length === 0 ? (
				<Empty>{t("Nobody is here.")}</Empty>
			) : (
				<ul>
					{people.map((one) => (
						<Person
							key={one.sid}
							relays={relays}
							onPlace={(relay) => onPlacePerson(one.identity, relay)}
							person={one}
							canModerate={canModerate}
							acting={acting}
							onRemove={() => onRemove(one.identity)}
							onMute={(track) => onMute(one.identity, track)}
						/>
					))}
				</ul>
			)}

			<History room={room} onSignedOut={onSignedOut} />
		</Card>
	);
}

/**
 * Who has been in this room, as against who is in it.
 *
 * The list above asks the media server, so it answers nothing at all about a
 * meeting that has ended — and the questions an operator actually has about a
 * meeting are asked afterwards. Where somebody came from and which machine they
 * came in through are seen once, by this server, at the join, and are not
 * recoverable from anywhere else.
 *
 * Under the live list rather than instead of it, because both are true at once
 * during a call and the second explains the first: somebody in the room twice
 * over is one row above and two below, which is what a reconnect looks like.
 *
 * Bounded by the room's own life. A name nobody has joined for as long as the
 * deployment keeps names is forgotten whole and this goes with it, so the
 * addresses are not kept after the last thing that referred to them has gone.
 */
function History({ room, onSignedOut }: { room: string; onSignedOut: () => void }) {
	const t = useT();

	const ask = useCallback(() => api.visits(room), [room]);
	const { value, error, loading } = usePoll(ask, {
		every: 20_000,
		onSignedOut,
		about: room,
	});

	const visits = value?.visits ?? [];

	return (
		<div className="border-border border-t">
			<div className="flex items-baseline gap-2 px-4 py-2.5">
				<h3 className="font-medium text-[13px]">{t("Who has been here")}</h3>
				{/* And how many there were, where the page is not showing all of
				    them. A list cut at five hundred with nothing said reads as
				    the whole history — which is the same fault as a history that
				    stops at twelve hours, arrived at from the other end. */}
				<span className="text-fg-muted text-xs">
					{visits.length === 0
						? ""
						: value?.total
							? t("most recent {count} of {total} joins", {
									count: visits.length,
									total: value.total,
								})
							: t("{count} joins", { count: visits.length })}
				</span>
			</div>

			{error && <Failed>{error}</Failed>}

			{loading ? (
				<Waiting rows={4} />
			) : visits.length === 0 ? (
				<Empty>{t("Nothing recorded for this name.")}</Empty>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[42rem] border-collapse text-sm">
						<thead>
							<tr className="border-border border-b text-[11px] text-fg-muted">
								<th className="px-4 py-2 text-left font-normal">{t("when")}</th>
								<th className="px-2 py-2 text-left font-normal">{t("who")}</th>
								<th className="px-2 py-2 text-left font-normal">{t("device")}</th>
								<th className="px-2 py-2 text-left font-normal">{t("from")}</th>
								<th className="px-4 py-2 text-left font-normal">{t("through")}</th>
							</tr>
						</thead>

						<tbody>
							{visits.map((one) => (
								<tr
									key={`${one.at}-${one.identity}`}
									className="border-border border-b align-top last:border-0"
								>
									<td className="px-4 py-2 text-[12px] text-fg-muted tabular-nums">
										{clock(one.at)}
										<span className="block text-[11px] opacity-70">{day(one.at)}</span>
									</td>

									{/* The name they were showing as, and what kind of mark
									    they were showing it with.

									    Their own name first. A history of a meeting is a
									    list of who was in it, and who somebody was in a
									    meeting is what everybody in the room saw — putting
									    the account name over the top of it answers a
									    question nobody asked and loses the one thing the row
									    is a record of.

									    The account is not thrown away: it goes on the line
									    below, beside the mark, where it belongs — it is who
									    this deployment knows the mark to be rather than what
									    they called themselves, and the two are worth telling
									    apart. It is also the only thing that names anybody on
									    a row written before the typed name was recorded.

									    Where there is neither, the name was not kept. It said
									    "(no name)", which reads as somebody having had none —
									    nobody can join without one, so what is true is that
									    it was not written down. */}
									<td className="px-2 py-2">
										{one.name ? (
											<span className="block truncate text-[12.5px]">{one.name}</span>
										) : one.account ? (
											<span className="block truncate text-[12.5px]">{one.account}</span>
										) : (
											<span className="block truncate text-[12.5px] text-fg-muted italic">
												{t("name not kept then")}
											</span>
										)}

										<span className="readout block truncate text-[11px] text-fg-muted">
											{one.trip ?? one.identity.split("-")[0]}
											{one.kind && (
												<span className="opacity-70">
													{" "}
													{one.kind === "account"
														? t("account")
														: one.kind === "passphrase"
															? t("passphrase")
															: t("guest")}
												</span>
											)}
											{/* Who the deployment knows that mark to be, when it
											    knows and they are showing as something else. */}
											{one.account && one.account !== one.name && (
												<span className="opacity-70"> · {one.account}</span>
											)}
										</span>
									</td>

									{/* Blank for a join from before this was kept, which is
									    not the same as one that came from nothing. */}
									<td className="w-[13rem] px-2 py-2 text-[11.5px] text-fg-muted">
										<Device client={one.client} />
									</td>

									<td className="readout px-2 py-2 text-[12px] text-fg-muted">
										{one.address || "\u2014"}
									</td>

									<td className="px-4 py-2 text-[11.5px] text-fg-muted">
										{one.relay ? <Flagged text={one.relay} /> : "\u2014"}
										{/* Where the meeting was, when that was somewhere
										    else. Said only then: on a call held on the
										    machine somebody dialled, a second identical name
										    is noise. */}
										{one.holding && one.holding !== one.relay && (
											<span className="block opacity-70">
												{t("held on")} <Flagged text={one.holding} />
											</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function Person({
	person,
	canModerate,
	acting,
	relays,
	onPlace,
	onRemove,
	onMute,
}: {
	person: Participant;
	canModerate: boolean;
	acting: boolean;
	relays: Relay[];
	onPlace: (relay: string) => void;
	onRemove: () => void;
	onMute: (track: string) => void;
}) {
	const t = useT();
	const removing = useTwice(onRemove);
	// The words that say a second press will remove them, faded in and out
	// rather than snapped, like everything else that comes and goes here.
	const asking = useLingering(removing.armed, 160);

	return (
		<li className="border-border border-b px-4 py-3 last:border-0">
			<div className="flex items-baseline gap-2">
				<span className="font-medium text-[13px]">{person.name || person.identity}</span>

				{/* The mark, and which kind. An earned one is the same person as
				    last time; an issued one is only a way to tell two people
				    with one name apart for the length of a call. */}
				<span
					className={cn("readout text-[11px]", person.trip.proven ? "text-fg-muted" : "text-fg-muted/50")}
					title={
						person.trip.proven
							? t("Earned from a passphrase")
							: t("Issued for this call, and says nothing about who they are")
					}
				>
					{person.trip.proven ? "·" : ""}
					{person.trip.mark}
				</span>

				{/* Only where somebody is not through yet.
				    ACTIVE is everybody in an ordinary room, so drawing it would
				    be a label on every row saying nothing — and the one person
				    stuck part-way through a handshake looked exactly like the
				    people around them, which is the state an operator is looking
				    at this list to find. */}
				{person.state && person.state !== "ACTIVE" && (
					<span
						className="rounded-full bg-surface-hi px-1.5 py-0.5 text-[10.5px] text-fg-muted"
						title={t("Not through yet: still setting up their connection")}
					>
						{person.state.toLowerCase()}
					</span>
				)}

				<span className="ml-auto text-fg-muted text-xs tabular-nums">
					{since(person.joinedAt)}
				</span>

				{canModerate && relays.length > 0 && (
					<Sending relays={relays} acting={acting} onPlace={onPlace} />
				)}

				{canModerate && (
					// An icon with a name on it, matching every other row on these
					// pages. A word floating at the end of a line reads as part of
					// the line rather than as something to press, which is how a
					// list of people came to look like it could not be acted on.
					<button
						type="button"
						disabled={acting}
						onClick={removing.press}
						onBlur={removing.disarm}
						aria-label={removing.armed ? t("Press again to remove") : t("Remove from the call")}
						title={removing.armed ? t("Press again to remove") : t("Remove from the call")}
						className={cn(
							"flex items-center gap-1.5 rounded-md border border-border p-1.5 text-fg-muted transition-colors duration-150",
							"hover:bg-surface-hi hover:text-danger disabled:opacity-40",
							removing.armed && "border-danger/60 bg-danger/10 text-danger",
						)}
					>
						<UserMinus className="size-3.5" />
						{asking.mounted && (
							<span className={cn("text-[11px]", asking.leaving ? "animate-fade-out" : "animate-fade-in")}>
								{t("Press again to remove")}
							</span>
						)}
					</button>
				)}
			</div>

			{/*
			  * Where this person came from and how they got here.
			  *
			  * None of it is knowable from the media server. It sees each
			  * participant over a signalling socket opened by a relay, so the
			  * address it holds is the relay's and the machine it names is
			  * whichever node was asked. This deployment saw the real address and
			  * chose the machine, once, at the join, and wrote both down — which
			  * is the only record of either.
			  *
			  * Absent for anybody who joined before this existed, and left absent
			  * rather than filled with a dash: a blank says nothing was recorded,
			  * and a dash reads as a value.
			  */}
			{(person.address || person.relay || person.client) && (
				<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
					{/* What they came in with first: of the three, it is the one
					    somebody helping them asks before anything else. */}
					<Device client={person.client} />

					{person.address && <span className="readout">{person.address}</span>}

					{person.relay && (
						<span className="flex items-center gap-1">
							<LogIn className="size-3" />
							<Flagged text={person.relay} />
						</span>
					)}

					{/* Two machines and an arrow, only where there are two. A call
					    entering one relay and being carried by another is the thing
					    an operator most wants to see at a glance, and the thing
					    they cannot see anywhere else. */}
					{person.holding && (
						<span className="flex items-center gap-1">
							<ArrowRight className="size-3" />
							<Flagged text={person.holding} />
							{person.forwarded && (
								<span className="rounded bg-tally/15 px-1.5 py-px text-[10px] text-fg">
									forwarded
								</span>
							)}
						</span>
					)}
				</div>
			)}

			{person.tracks.length > 0 && (
				<ul className="mt-2 flex flex-col gap-1.5">
					{person.tracks.map((track) => (
						<TrackRow
							key={track.sid}
							track={track}
							canModerate={canModerate}
							acting={acting}
							onMute={() => onMute(track.sid)}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

/**
 * One published track, with what it actually settled on.
 *
 * The layers are the point. A publisher asking for 1080p and a subscriber being
 * sent 540p look identical from every other angle, and the difference is the
 * whole of why a shared screen can look soft while every setting says otherwise.
 */
function TrackRow({
	track,
	canModerate,
	acting,
	onMute,
}: {
	track: Track;
	canModerate: boolean;
	acting: boolean;
	onMute: () => void;
}) {
	const t = useT();

	const codec = track.mime.replace(/^(video|audio)\//i, "").toLowerCase();

	return (
		// Two lines rather than one. What it is and how it is encoded is one
		// thought; the layers underneath are another, and together they wanted
		// four hundred and thirty points on a screen with three hundred.
		<li className="rounded-md bg-surface-hi/50 px-2.5 py-1.5">
			<div className="flex items-baseline gap-x-3 text-xs">
				<span className="shrink-0 text-fg-muted">{source(track.source)}</span>
				<span className="readout text-[11px]">{codec || "—"}</span>

				{track.width > 0 && (
					<span className="readout text-[11px] tabular-nums">
						{track.width}×{track.height}
					</span>
				)}

				{track.muted && <span className="text-fg-muted text-[11px]">muted</span>}

				{canModerate && !track.muted && (
					// The same shape as every other action on these pages: an icon
					// that says what it does when pointed at. A bare word at the end
					// of a line of figures reads as another figure.
					<button
						type="button"
						disabled={acting}
						onClick={onMute}
						aria-label={t("Mute this")}
						title={t("Mute this")}
						className={cn(
							"ml-auto shrink-0 rounded p-1 text-fg-muted transition-colors",
							"hover:bg-surface-hi hover:text-fg disabled:opacity-40",
						)}
					>
						<MicOff className="size-3.5" />
					</button>
				)}
			</div>

			{track.layers.length > 0 && (
				<p className="readout mt-0.5 text-[11px] text-fg-muted tabular-nums">
					{track.layers.map((layer) => `${layer.height}p ${bitrate(layer.bitrate)}`).join("  ·  ")}
				</p>
			)}
		</li>
	);
}

/** The server's own names for these are shouted; these are the ones people use. */
function source(name: string): string {
	switch (name) {
		case "CAMERA":
			return "camera";
		case "MICROPHONE":
			return "microphone";
		case "SCREEN_SHARE":
			return "screen";
		case "SCREEN_SHARE_AUDIO":
			return "screen audio";
		default:
			return name.toLowerCase().replace(/_/g, " ");
	}
}


/**
 * Moving a meeting to a different machine.
 *
 * Two presses, and the second one names what it does. A meeting lives on one
 * machine and the media server cannot hand it to another while it runs, so the
 * choice and the disruption are separate: picking a relay settles where the next
 * call under this name goes, and moving it now ends the one in progress so
 * everybody comes back to the machine that was picked.
 *
 * Said in the button rather than in a warning beside it. A control that ends a
 * call must not be pressed by somebody who thought it would not, and the place
 * they are certainly reading is the thing they are about to press.
 */
function Moving({
	relays,
	acting,
	placed,
	onPlace,
	onFree,
}: {
	relays: Relay[];
	acting: boolean;
	placed: boolean;
	onPlace: (relay: string, now: boolean) => void;
	onFree: () => void;
}) {
	const t = useT();

	const [open, setOpen] = useState(false);
	const [wanted, setWanted] = useState("");
	const { mounted, leaving } = useLingering(open, 160);

	return (
		<span className="relative">
			<button
				type="button"
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
					"text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
				)}
			>
				<Move className="size-3" />{t("Move")}</button>

			{mounted && (
				<div
					className={cn(
						"absolute top-full left-0 z-20 mt-1.5 flex w-64 flex-col gap-1.5",
						"rounded-xl border border-border bg-surface-hi p-2 shadow-2xl ring-1 ring-black/40",
						"origin-top",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<select
						value={wanted}
						onChange={(event) => setWanted(event.target.value)}
						className="rounded-md border border-border bg-surface-hi px-2 py-1.5 text-[12px] outline-none"
					>
						<option value="">{t("Choose a machine")}</option>
						{relays.map((relay) => (
							<option key={relay.name} value={relay.name}>
								{relay.label || relay.name}
							</option>
						))}
					</select>

					<button
						type="button"
						disabled={!wanted || acting}
						onClick={() => {
							onPlace(wanted, false);
							setOpen(false);
						}}
						className={cn(
							"rounded-md border border-border px-2 py-1.5 text-left text-[11.5px]",
							"transition-colors hover:bg-surface-hi disabled:opacity-40",
						)}
					>{t("Hold the next call here")}</button>

					<button
						type="button"
						disabled={!wanted || acting}
						onClick={() => {
							onPlace(wanted, true);
							setOpen(false);
						}}
						className={cn(
							"rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-left text-[11.5px]",
							"transition-colors hover:bg-danger/20 disabled:opacity-40",
						)}
					>{t("Move now, ending this call")}</button>

					{/* Only where there is a choice to give back. Offered on a
					    room nobody has placed, it would read as a third way of
					    moving one. */}
					{placed && (
						<button
							type="button"
							disabled={acting}
							onClick={() => {
								onFree();
								setOpen(false);
							}}
							className={cn(
								"rounded-md px-2 py-1.5 text-left text-[11.5px] text-fg-muted",
								"transition-colors hover:bg-surface-hi hover:text-fg disabled:opacity-40",
							)}
						>{t("Choose automatically again")}</button>
					)}
				</div>
			)}
		</span>
	);
}

/**
 * Sending one person in through a different relay.
 *
 * Where somebody enters is theirs — their browser measures and picks — and this
 * takes it over for one join, which is the whole of what an operator can
 * honestly do: a browser holds its connection to the machine it dialled, and
 * nothing in the protocol asks it to move. So they are let go of, and the door
 * they come back through is the one chosen here.
 */
function Sending({
	relays,
	acting,
	onPlace,
}: {
	relays: Relay[];
	acting: boolean;
	onPlace: (relay: string) => void;
}) {
	const t = useT();

	const [open, setOpen] = useState(false);
	const { mounted, leaving } = useLingering(open, 160);

	return (
		<span className="relative">
			<button
				type="button"
				disabled={acting}
				onClick={() => setOpen((was) => !was)}
				aria-label={t("Send in through another relay")}
				title={t("Send in through another relay")}
				className={cn(
					"rounded-md border border-border p-1.5 text-fg-muted transition-colors",
					"hover:bg-surface-hi hover:text-fg disabled:opacity-40",
				)}
			>
				<Move className="size-3.5" />
			</button>

			{mounted && (
				<div
					className={cn(
						"absolute top-full right-0 z-20 mt-1.5 flex w-56 flex-col gap-1.5",
						"rounded-xl border border-border bg-surface-hi p-2 shadow-2xl ring-1 ring-black/40",
						"origin-top",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<p className="px-0.5 text-[10.5px] text-fg-muted leading-snug">{t("They are dropped from the call and come back in through this one.")}</p>

					{relays.map((relay) => (
						<button
							key={relay.name}
							type="button"
							onClick={() => {
								onPlace(relay.name);
								setOpen(false);
							}}
							className="rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-surface-hi"
						>
							<Flagged text={relay.label || relay.name} />
						</button>
					))}
				</div>
			)}
		</span>
	);
}

/**
 * Removing a name from the list this server has seen.
 *
 * Two presses, because it cannot be undone and because it sits in a list people
 * click through: the row it is on opens a history, and a single-press delete
 * beside that is one slip away from taking a name and its history with it.
 *
 * What it is for is the placement. A name carries where an operator said it
 * goes and that now stands until somebody says otherwise, so a name used once
 * for a test keeps a machine assigned to it until it ages out — and until this
 * existed there was no way to be rid of it but waiting. Clearing the placement
 * alone is a different control, on the panel the row opens.
 */
function Forget({
	room,
	acting,
	onForget,
}: {
	room: string;
	acting: boolean;
	onForget: () => void;
}) {
	const t = useT();

	const [asking, setAsking] = useState(false);
	const { mounted, leaving } = useLingering(asking, 160);

	return (
		<span className="-translate-y-1/2 absolute top-1/2 right-2 flex items-center gap-1">
			{mounted ? (
				<span
					className={cn(
						"flex items-center gap-1 rounded-md bg-surface px-1 py-0.5",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<span className="pr-1 text-[11px] text-fg-muted">{t("Forget it?")}</span>

					<button
						type="button"
						disabled={acting}
						onClick={() => {
							setAsking(false);
							onForget();
						}}
						className={cn(
							"rounded-md bg-danger px-2 py-0.5 text-[11px] text-danger-fg",
							"transition-opacity hover:opacity-90 disabled:opacity-40",
						)}
					>{t("Forget")}</button>

					<button
						type="button"
						onClick={() => setAsking(false)}
						className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-surface-hi"
					>{t("Cancel")}</button>
				</span>
			) : (
				/* Quiet until the row is under the pointer, because a column of
				   crosses down a list reads as a list of things to get rid of. */
				<button
					type="button"
					aria-label={t("Forget {room}", { room })}
					onClick={() => setAsking(true)}
					className={cn(
						"rounded-md p-1 text-fg-muted opacity-0 transition-opacity",
						"hover:bg-surface-hi hover:text-fg focus-visible:opacity-100 group-hover:opacity-100",
					)}
				>
					<Trash2 className="size-3.5" />
				</button>
			)}
		</span>
	);
}
