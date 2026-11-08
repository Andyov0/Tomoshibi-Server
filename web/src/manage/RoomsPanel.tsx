import { useT } from "@/hooks/useT";
import { Flagged } from "@/components/room/Flag";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLingering } from "@/hooks/useLingering";
import { say } from "@/live/i18n";
import {
	ArrowRight,
	ChevronLeft,
	ChevronRight,
	DoorClosed,
	LogIn,
	Mic,
	MicOff,
	Move,
	Pin,
	Trash2,
	UserMinus,
	Video,
} from "lucide-react";
import { useCallback, useState } from "react";
import { type Participant, type Relay, type Track, type Visit, api } from "./api";
import { actionFailed } from "@/live/notices";
import { DeviceLine } from "./Device";
import { Choice, Group, Initial, Popover, Row, Section, field, quiet, quietIcon, usePresence } from "./Grouped";
import { lasted } from "./health";
import { JoiningCard, OpeningCard } from "./OpeningCard";
import { usePoll } from "./poll";
import { Live, Failed, Waiting } from "./Shell";
import { useTwice } from "./twice";
import { bitrate, clock, day } from "./units";
import { WatchCard } from "./WatchCard";

/**
 * The rooms, and whoever is in the one selected.
 *
 * The right-hand side is the panel that earns this whole surface. What the
 * media server negotiated with each publisher — the codec, the resolution it
 * settled on, the layers underneath it and what each is allowed to spend — was
 * known here all along and visible nowhere. Working out whether a shared screen
 * was actually being sent at full resolution previously meant reading the
 * client's source and reasoning about it.
 *
 * Redrawn with the rest of the management pages (2026-10-29) as groups of rows
 * rather than bordered cards: the meetings in progress, then the names this
 * server remembers, then the rules about who may open and enter a room; and
 * beside them the room chosen — who is in it now, from what device, through
 * which machine, sending what, and everybody who has been in it before. On a
 * screen too narrow for both the list and the room, the room replaces the list
 * and has a way back, rather than being pushed below a list nobody scrolls past.
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

	const rooms = usePresence(live, (one) => one.name);

	return (
		<div className="mx-auto flex max-w-[1180px] flex-col gap-6">
			<header className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1", open && "max-xl:hidden")}>
				<h1 className="font-semibold text-[22px] leading-tight tracking-[-0.01em]">{t("Rooms")}</h1>
				{value && (
					<span className="text-[14px] text-fg-muted">
						{live.length === 0 ? t("No calls right now.") : t("{count} rooms", { count: live.length })}
					</span>
				)}
			</header>

			{error && <Failed>{error}</Failed>}

			<div className="grid items-start gap-6 xl:grid-cols-[22rem_minmax(0,1fr)] xl:gap-8">
				<div className={cn("flex min-w-0 flex-col gap-6", open && "max-xl:hidden")}>
					<Section title={t("In progress")} note={live.length > 0 ? t("{count} people", { count: live.reduce((sum, one) => sum + one.participants, 0) }) : undefined}>
						<Group>
							{value && live.length === 0 && rooms.length === 0 && (
								<p className="animate-fade-in px-4 py-5 text-fg-muted text-[13.5px]">
									{value.liveUnavailable
										? t("The media servers did not answer, so what is happening now is unknown. What this server has written down is below.")
										: t("No calls right now.")}
								</p>
							)}

							{rooms.map(({ item: one, leaving }) => (
								<Row key={one.name} inset={44} leaving={leaving}>
									<button
										type="button"
										onClick={() => setSelected(one.name)}
										aria-current={one.name === open ? "true" : undefined}
										className={cn(
											"flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors",
											"hover:bg-wash active:bg-wash-press focus-visible:bg-wash",
											one.name === open && "bg-surface-hi hover:bg-surface-hi",
										)}
									>
										<Live on />
										<span className="min-w-0 flex-1">
											<span className="readout block truncate font-medium text-[14px]">{one.name}</span>
											<span className="flex flex-wrap items-center gap-x-2.5 text-[12.5px] text-fg-muted">
												{/* Which machine the meeting is actually on. Not asked of
												    the media server, which reports a room from whichever
												    node answered. A placement does not expire and is not
												    spent by being obeyed, so it is drawn: a pin nobody
												    remembers making is a room that ignores every later
												    choice with nothing to say why. */}
												{one.relay && (
													<span className="flex items-center gap-1">
														{one.placed && <Pin className="size-3 shrink-0" aria-label={t("Placed here")} />}
														<Flagged text={say(one.relay)} />
													</span>
												)}
												{/* How many are in it, and how many of those are
												    sending anything, where the two differ: eight with
												    none sending is eight people whose media never
												    started, which is the room an operator is looking for. */}
												<span>
													{t("{count} people", { count: one.participants })}
													{one.publishers !== undefined && one.publishers !== one.participants && (
														<> {t("{count} sending", { count: one.publishers })}</>
													)}
												</span>
												<span>{lasted(one.createdAt)}</span>
											</span>
										</span>
										<ChevronRight className="size-4 shrink-0 text-fg-muted" />
									</button>
								</Row>
							))}
						</Group>
					</Section>

					<Section title={t("Known")} note={t("Rooms this server has seen")}>
						<Group>
							{known.length === 0 ? (
								<p className="px-4 py-5 text-fg-muted text-[13.5px]">{t("None yet.")}</p>
							) : (
								<ul className="max-h-[26rem] overflow-y-auto">
									{known.map((one) => (
										<li
											key={one.name}
											className="group relative before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border first:before:hidden"
										>
											{/* Opens the same panel a live room opens: what an
											    operator asks about a meeting is asked after it has
											    ended. The forget control sits beside the row rather
											    than inside it, because a button inside a button is
											    not a thing. */}
											<button
												type="button"
												onClick={() => setSelected(one.name)}
												aria-current={one.name === open ? "true" : undefined}
												className={cn(
													"flex w-full items-center gap-2 py-2.5 pr-12 pl-4 text-left outline-none transition-colors",
													"hover:bg-wash focus-visible:bg-wash",
													one.name === open && "bg-surface-hi hover:bg-surface-hi",
												)}
											>
												<span className="readout min-w-0 truncate text-[13.5px]">{one.name}</span>

												{one.placed && one.relay && (
													<span className="flex shrink-0 items-center gap-1 text-[12px] text-fg-muted">
														<Pin className="size-3 shrink-0" />
														<Flagged text={say(one.relay)} />
													</span>
												)}

												<span className="ml-auto flex shrink-0 flex-col items-end text-[12px] text-fg-muted tabular-nums">
													<span>{day(one.lastSeen)}</span>
													{/* What the server has always sent about a name and no page
													    drew: since when it has been used, and how often. */}
													{one.joins !== undefined && (
														<span className="text-[11.5px]">{t("{count} joins", { count: one.joins })}</span>
													)}
												</span>
											</button>

											{canModerate && (
												<Forget room={one.name} acting={acting} onForget={() => onForget(one.name)} />
											)}
										</li>
									))}
								</ul>
							)}
						</Group>
					</Section>

					{/* Last, and the order is the argument: what is happening, what
					    has happened, and what may happen next. Above the live rooms
					    they would push the reason anybody opened this panel below
					    the fold. */}
					<OpeningCard canSettings={canSettings} onSignedOut={onSignedOut} />
					<JoiningCard canSettings={canSettings} onSignedOut={onSignedOut} />
					<WatchCard canSettings={canSettings} onSignedOut={onSignedOut} />
				</div>

				{open ? (
					<People
						key={open}
						room={open}
						onBack={() => setSelected(undefined)}
						canModerate={canModerate}
						acting={acting}
						relays={relays}
						onSignedOut={onSignedOut}
						live={live.some((one) => one.name === open)}
						// Read off the listing rather than asked for again: the room
						// being looked at is one of the rows behind this panel, and
						// a second request for a boolean already on screen is a
						// second thing that can be out of date with the first.
						placed={live.find((one) => one.name === open)?.placed ?? false}
						relay={live.find((one) => one.name === open)?.relay}
						createdAt={live.find((one) => one.name === open)?.createdAt}
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
					<div className="hidden xl:block">
						<Section title={t("Participants")}>
							<Group>
								<p className="px-4 py-10 text-center text-fg-muted text-[13.5px]">{t("Choose a room.")}</p>
							</Group>
						</Section>
					</div>
				)}
			</div>
		</div>
	);
}

/** One room, opened: who is in it now, and who has been. */
function People({
	room,
	onBack,
	canModerate,
	acting,
	relays,
	onSignedOut,
	onClose,
	live,
	placed,
	relay,
	createdAt,
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
	live: boolean;
	placed: boolean;
	relay?: string;
	createdAt?: string;
	onPlace: (relay: string, now: boolean) => void;
	onFree: () => void;
	onPlacePerson: (identity: string, relay: string) => void;
	onRemove: (identity: string) => void;
	onMute: (identity: string, track: string) => void;
}) {
	const t = useT();

	const ask = useCallback(() => api.participants(room), [room]);
	const { value, error, loading } = usePoll(ask, { onSignedOut, about: room });

	const [ending, setEnding] = useState(false);
	const asking = useLingering(ending, 160);

	const people = value ?? [];
	const present = usePresence(people, (one) => one.identity);

	// Where the meeting is held, as the people in it report it, falling back to
	// the listing's relay: a room just emptied has nobody to ask.
	const held = people.find((one) => one.holding || one.relay)?.holding ?? people[0]?.relay ?? relay;

	return (
		<div className="flex min-w-0 animate-arrive flex-col gap-6">
			<header className="flex flex-col gap-3 px-1">
				<button type="button" onClick={onBack} className={cn(quiet, "-ml-2.5 self-start xl:hidden")}>
					<ChevronLeft />
					{t("Rooms")}
				</button>

				<div className="flex flex-wrap items-end gap-x-4 gap-y-2">
					<div className="flex min-w-0 flex-col gap-1">
						<h1 className="readout break-all font-semibold text-[22px] leading-tight">{room}</h1>
						<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted">
							<span className={cn("flex items-center gap-2", live && "text-tally-ink")}>
								<Live on={live} />
								{live ? t("In progress") : t("Nobody is here.")}
							</span>
							{held && (
								<span className="flex items-center gap-1">
									{placed && <Pin className="size-3" />}
									<Flagged text={say(held)} />
								</span>
							)}
							{live && createdAt && <span>{t("Going for {time}", { time: lasted(createdAt) })}</span>}
						</p>
					</div>

					{canModerate && live && (
						<div className="ml-auto flex flex-wrap items-center gap-2">
							{relays.length > 0 && (
								<Moving relays={relays} acting={acting} placed={placed} onPlace={onPlace} onFree={onFree} />
							)}

							{asking.mounted ? (
								<span className={cn("flex items-center gap-2", asking.leaving ? "animate-fade-out" : "animate-fade-in")}>
									<span className="text-[13px]">{t("Everybody is disconnected.")}</span>
									<Button variant="danger" size="sm" disabled={acting} onClick={onClose}>
										{t("Close it")}
									</Button>
									<Button variant="ghost" size="sm" onClick={() => setEnding(false)}>
										{t("Cancel")}
									</Button>
								</span>
							) : (
								// Away from the moves and quieter than them, because it
								// is the press that cannot be taken back.
								<button type="button" onClick={() => setEnding(true)} className={cn(quiet, "hover:text-danger-ink")}>
									<DoorClosed />
									{t("Close this room")}
								</button>
							)}
						</div>
					)}
				</div>
			</header>

			{error && <Failed>{error}</Failed>}

			{(live || people.length > 0) && (
				<Section title={t("Participants")} note={people.length === 1 ? t("1 person") : t("{count} people", { count: people.length })}>
					<Group>
						{loading ? (
							<Waiting />
						) : present.length === 0 ? (
							<p className="px-4 py-5 text-fg-muted text-[13.5px]">{t("Nobody is here.")}</p>
						) : (
							<ul>
								{present.map(({ item: one, leaving }) => (
									<Person
										key={one.identity}
										leaving={leaving}
										relays={relays}
										onPlace={(to) => onPlacePerson(one.identity, to)}
										person={one}
										canModerate={canModerate}
										acting={acting}
										onRemove={() => onRemove(one.identity)}
										onMute={(track) => onMute(one.identity, track)}
									/>
								))}
							</ul>
						)}
					</Group>
				</Section>
			)}

			<History room={room} onSignedOut={onSignedOut} />
		</div>
	);
}

/**
 * Who has been in this room, newest first.
 *
 * Asked of this server rather than the media server, so it answers for a room
 * nobody is in — which is the room most of these questions are about: what an
 * operator asks after a meeting is who was in it, from where, on what, and
 * through which machine. Polled slowly; a history does not need to be live to
 * the second.
 *
 * Rows rather than a table of five columns. The table ran off a phone sideways
 * and, on a laptop, put the device of each person in its own narrow column two
 * columns from their name.
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
		<Section
			title={t("Who has been here")}
			// And how many there were, where the page is not showing all of
			// them. A list cut at five hundred with nothing said reads as the
			// whole history.
			note={
				visits.length === 0
					? undefined
					: value?.total
						? t("most recent {count} of {total} joins", { count: visits.length, total: value.total })
						: t("{count} joins", { count: visits.length })
			}
		>
			{error && <Failed>{error}</Failed>}

			<Group>
				{loading ? (
					<Waiting rows={4} />
				) : visits.length === 0 ? (
					<p className="px-4 py-5 text-fg-muted text-[13.5px]">{t("Nothing recorded for this name.")}</p>
				) : (
					<ul>
						{visits.map((one) => (
							<Visited key={`${one.at}-${one.identity}`} visit={one} />
						))}
					</ul>
				)}
			</Group>
		</Section>
	);
}

/** One join. */
function Visited({ visit: one }: { visit: Visit }) {
	const t = useT();

	const kind =
		one.kind === "account" ? t("account") : one.kind === "passphrase" ? t("passphrase") : one.kind ? t("guest") : undefined;

	return (
		<li className="relative flex gap-3 px-4 py-3 before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border first:before:hidden">
			<span className="w-[4.75rem] shrink-0 text-[12.5px] text-fg-muted tabular-nums">
				{clock(one.at)}
				<span className="block text-[11.5px]">{day(one.at)}</span>
			</span>

			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{/* Their own name first: who somebody was in a meeting is what
				    everybody in the room saw. The account goes beside the mark,
				    where it is who this deployment knows the mark to be. Where
				    there is neither, the name was not kept — nobody can join
				    without one, so "no name" would be untrue. */}
				<p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
					{one.name ? (
						<span className="font-medium">{one.name}</span>
					) : one.account ? (
						<span className="font-medium">{one.account}</span>
					) : (
						<span className="text-fg-muted">{t("name not kept then")}</span>
					)}
					{kind && <span className="text-[12px] text-fg-muted">{kind}</span>}
					{one.account && one.account !== one.name && <span className="text-[12px] text-fg-muted">{one.account}</span>}
					<span className="readout text-[11.5px] text-fg-muted">{one.trip ?? one.identity.split("-")[0]}</span>
				</p>

				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-fg-muted">
					{one.client && <DeviceLine client={one.client} />}
					{one.address && <span className="readout">{one.address}</span>}
					{one.relay && (
						<span className="flex items-center gap-1">
							<LogIn className="size-3.5" />
							<Flagged text={say(one.relay)} />
						</span>
					)}
					{/* Where the meeting was, when that was somewhere else. On a call
					    held on the machine somebody dialled, a second identical name
					    is noise. */}
					{one.holding && one.holding !== one.relay && (
						<span className="flex items-center gap-1">
							{t("held on")} <Flagged text={say(one.holding)} />
							{/* Whether the media went through the relay they entered
							    by, which the history has kept and no page drew. */}
							{one.forwarded && (
								<span className="rounded-full bg-tally/15 px-2 py-px text-[11px] text-tally-ink">{t("forwarded")}</span>
							)}
						</span>
					)}
				</div>
			</div>
		</li>
	);
}

/** Somebody in the call, what they are sending, and what can be done about them. */
function Person({
	person,
	leaving,
	canModerate,
	acting,
	relays,
	onPlace,
	onRemove,
	onMute,
}: {
	person: Participant;
	leaving: boolean;
	canModerate: boolean;
	acting: boolean;
	relays: Relay[];
	onPlace: (relay: string) => void;
	onRemove: () => void;
	onMute: (track: string) => void;
}) {
	const t = useT();
	const removing = useTwice(onRemove);
	const asking = useLingering(removing.armed, 160);

	return (
		<li
			className={cn(
				"relative px-4 py-3 before:absolute before:top-0 before:right-0 before:left-[60px] before:h-px before:bg-border first:before:hidden",
				leaving ? "animate-depart" : "animate-fade-in",
			)}
		>
			<div className="flex items-start gap-3">
				<Initial name={person.name || person.identity} guest={!person.trip.proven} />

				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<span className="font-medium text-[14px]" title={person.identity}>
							{person.name || person.identity}
						</span>

						{/* The mark, and which kind. An earned one is the same person
						    as last time; an issued one is only a way to tell two
						    people with one name apart for the length of a call. */}
						<span
							className="readout text-[11.5px] text-fg-muted"
							title={
								person.trip.proven
									? t("Earned from a passphrase")
									: t("Issued for this call, and says nothing about who they are")
							}
						>
							{person.trip.mark}
						</span>

						{/* Only where somebody is not through yet. ACTIVE is everybody
						    in an ordinary room, and the one person stuck part-way
						    through a handshake is who this list is read to find. */}
						{person.state && person.state !== "ACTIVE" && (
							<span
								className="rounded-full bg-tally/15 px-2 py-px text-[11.5px] text-tally-ink"
								title={t("Not through yet: still setting up their connection")}
							>
								{person.state.toLowerCase()}
							</span>
						)}

						<span className="ml-auto text-[12px] text-fg-muted tabular-nums max-sm:hidden">{lasted(person.joinedAt)}</span>
					</p>

					{(person.address || person.relay || person.client) && (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-fg-muted">
							{/* How long they have been in, here on a phone, where the
							    line above has no room left for it at its end. */}
							<span className="tabular-nums sm:hidden">{lasted(person.joinedAt)}</span>
							{/* What they came in with first: of the three, it is the one
							    somebody helping them asks before anything else. */}
							{person.client && <DeviceLine client={person.client} />}

							{person.address && <span className="readout">{person.address}</span>}

							{person.relay && (
								<span className="flex items-center gap-1">
									<LogIn className="size-3.5" />
									<Flagged text={say(person.relay)} />
								</span>
							)}

							{/* Two machines and an arrow, only where there are two: a
							    call entering one relay and carried by another is the
							    thing an operator most wants to see at a glance. */}
							{person.holding && (
								<span className="flex items-center gap-1">
									<ArrowRight className="size-3.5" />
									<Flagged text={say(person.holding)} />
									{person.forwarded && (
										<span className="rounded-full bg-tally/15 px-2 py-px text-[11px] text-tally-ink">{t("forwarded")}</span>
									)}
								</span>
							)}
						</div>
					)}

					{person.tracks.length > 0 && (
						<ul className="mt-1.5 flex flex-col gap-1">
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
				</div>

				{canModerate && (
					<div className="flex shrink-0 items-center gap-0.5">
						{relays.length > 0 && <Sending relays={relays} acting={acting} onPlace={onPlace} />}

						<button
							type="button"
							disabled={acting}
							onClick={removing.press}
							onBlur={removing.disarm}
							aria-label={removing.armed ? t("Press again to remove") : t("Remove from the call")}
							title={removing.armed ? t("Press again to remove") : t("Remove from the call")}
							className={cn(
								asking.mounted ? quiet : quietIcon,
								"hover:text-danger-ink",
								removing.armed && "bg-danger/10 text-danger-ink hover:bg-danger/15",
							)}
						>
							<UserMinus />
							{asking.mounted && (
								<span className={cn("text-[12.5px]", asking.leaving ? "animate-fade-out" : "animate-fade-in")}>
									{t("Press again to remove")}
								</span>
							)}
						</button>
					</div>
				)}
			</div>
		</li>
	);
}

/**
 * One track, on a line of its own: what it is, the codec, the size it settled
 * on, whether it is sent in layers, and each layer's height and the rate it is
 * allowed — written out, as the panel before the redesign had them. The
 * redesign made each track a chip and put the layers in a tooltip, which a
 * finger cannot open and which nobody reading the page for the rate a share
 * is being sent at thinks to point at (2026-11-01). A track somebody may mute
 * carries the button for it.
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
	const Icon = track.kind === "AUDIO" ? Mic : Video;

	return (
		<li
			title={track.sid}
			className={cn(
				"flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-[10px] bg-surface-hi/60 py-1 pr-1 pl-2.5 text-[12.5px] day:bg-bg",
				track.muted && "text-fg-muted",
			)}
		>
			<span className="flex items-center gap-1.5 font-medium">
				<Icon className="size-3.5 shrink-0 text-fg-muted" />
				{source(track.source, t)}
			</span>
			<span className="readout text-[11.5px] text-fg-muted">{codec || "—"}</span>
			{track.width > 0 && (
				<span className="readout text-[11.5px] tabular-nums">
					{track.width}×{track.height}
				</span>
			)}
			{track.simulcast && <span className="text-[12px] text-fg-muted">{t("in layers")}</span>}
			{track.layers.length > 0 && (
				<span className="readout text-[11.5px] text-fg-muted tabular-nums">
					{track.layers.map((layer) => `${layer.height}p ${bitrate(layer.bitrate)}`).join(", ")}
				</span>
			)}
			{track.muted && <span className="rounded-full bg-surface-hi px-2 text-[11.5px]">{t("muted")}</span>}

			{canModerate && !track.muted && (
				<button
					type="button"
					disabled={acting}
					onClick={onMute}
					aria-label={t("Mute this")}
					title={t("Mute this")}
					className={cn(
						"ml-auto grid size-7 place-items-center rounded-full text-fg-muted outline-none transition-colors",
						"hover:bg-wash hover:text-fg focus-visible:ring-2 focus-visible:ring-fg/70 disabled:opacity-40",
						"pointer-coarse:size-9",
					)}
				>
					<MicOff className="size-3.5" />
				</button>
			)}
		</li>
	);
}

/** The server's own names for these are shouted; these are the ones people use. */
function source(name: string, t: ReturnType<typeof useT>): string {
	switch (name) {
		case "CAMERA":
			return t("Camera");
		case "MICROPHONE":
			return t("Microphone");
		case "SCREEN_SHARE":
			return t("Screen");
		case "SCREEN_SHARE_AUDIO":
			return t("Screen audio");
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

	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			align="right"
			trigger={
				<Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
					<Move />
					{t("Move")}
				</Button>
			}
		>
			<select value={wanted} onChange={(event) => setWanted(event.target.value)} className={cn(field, "mb-1")}>
				<option value="">{t("Choose a machine")}</option>
				{relays.map((relay) => (
					<option key={relay.name} value={relay.name}>
						{say(relay.label || relay.name)}
					</option>
				))}
			</select>

			<Choice
				disabled={!wanted || acting}
				onClick={() => {
					onPlace(wanted, false);
					setOpen(false);
				}}
			>
				{t("Hold the next call here")}
			</Choice>

			<Choice
				danger
				disabled={!wanted || acting}
				onClick={() => {
					onPlace(wanted, true);
					setOpen(false);
				}}
			>
				{t("Move now, ending this call")}
			</Choice>

			{/* Only where there is a choice to give back. Offered on a room nobody
			    has placed, it would read as a third way of moving one. */}
			{placed && (
				<Choice
					disabled={acting}
					onClick={() => {
						onFree();
						setOpen(false);
					}}
				>
					{t("Choose automatically again")}
				</Choice>
			)}
		</Popover>
	);
}

/** Sending one person in through another relay, which drops them and brings them back there. */
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

	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			align="right"
			className="w-60"
			trigger={
				<button
					type="button"
					disabled={acting}
					onClick={() => setOpen((was) => !was)}
					aria-label={t("Send in through another relay")}
					title={t("Send in through another relay")}
					aria-expanded={open}
					className={quietIcon}
				>
					<Move />
				</button>
			}
		>
			<p className="px-2.5 pt-1 pb-1.5 text-[12px] text-fg-muted leading-snug">
				{t("They are dropped from the call and come back in through this one.")}
			</p>

			{relays.map((relay) => (
				<Choice
					key={relay.name}
					onClick={() => {
						onPlace(relay.name);
						setOpen(false);
					}}
				>
					<Flagged text={say(relay.label || relay.name)} />
				</Choice>
			))}
		</Popover>
	);
}

/** Forgetting a name this server remembers, after asking. */
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
						"flex items-center gap-1.5 rounded-[10px] bg-surface py-0.5 pl-2",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<span className="text-[12.5px] text-fg-muted">{t("Forget it?")}</span>
					<Button
						variant="danger"
						size="sm"
						disabled={acting}
						onClick={() => {
							setAsking(false);
							onForget();
						}}
					>
						{t("Forget")}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
						{t("Cancel")}
					</Button>
				</span>
			) : (
				/* Quiet until the row is under the pointer, because a column of
				   bins down a list reads as a list of things to get rid of. Always
				   there for a finger, which has no hover. */
				<button
					type="button"
					aria-label={t("Forget {room}", { room })}
					onClick={() => setAsking(true)}
					className={cn(
						quietIcon,
						"opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
					)}
				>
					<Trash2 />
				</button>
			)}
		</span>
	);
}

