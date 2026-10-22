import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { Refused } from "@/live/api";
import { download, fileNameFor, icsFor } from "@/live/calendar";
import { locale } from "@/live/i18n";
import { type Arrangement, arrange, arrangements, cancel, linkFor, whenSaid } from "@/live/meeting";
import { type Relay } from "@/live/relays";
import { ServerList } from "@/components/room/ServerPicker";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import { CalendarClock, CalendarPlus, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Arranging a meeting, from the lobby.
 *
 * A card that opens. Closed it is one line, like the two forms above it; open
 * it is the whole question — which name, which day, what time, which machine —
 * laid out with room to answer each. The first version put all of it on one
 * row beside a native date field, and on a screen wide enough for the lobby
 * the name field was squeezed to the width of a cursor while the date field
 * read "dd/mm/yyyy, --:-- --". It looked like a form somebody had given up on.
 *
 * ## Why the picker is drawn here
 *
 * The rule in this codebase is to prefer the platform's control over one of
 * its own, and the date field is the exception that proves it. The platform's
 * control for a date and a time is the one thing in the browser that looks
 * different on every browser and good on none of them, cannot be styled, and
 * asks for a year and a month for a meeting that is next Tuesday. What is
 * needed is smaller than what it offers: a day in the next sixty, and a time
 * to the quarter hour. That is a grid and two lists, and both are drawn with
 * the same pieces the rest of the lobby is drawn with.
 *
 * The hour and the minute stay platform selects. A list of twenty-four is a
 * list, and the platform draws lists well.
 */
/**
 * How far ahead the server lets a meeting be arranged. The grid offers the same
 * sixty days, but by whole days: the sixtieth day is on offer all day, and the
 * server's bound is sixty days from this minute, so a time late on that day is
 * refused there and has to be refused here first, with a reason.
 */
const AHEAD_MS = 60 * 24 * 60 * 60_000;

/** How often the card checks the clock while it is open. Every half minute is
 * enough to notice the chosen minute pass; the page becoming visible again
 * checks at once. */
const TICK_MS = 30_000;

export function Schedule({
	servers,
	server,
	onServer,
	onOpenChange,
	onSignedOut,
	canArrange = true,
}: {
	servers: Relay[];
	server: string;
	onServer: (relay: string) => void;
	/** Said so the lobby can put its own server list away while this is open:
	 * the list is the same list, and two of it on one screen is a mistake. */
	onOpenChange: (open: boolean) => void;
	/** The way back to signing in, for a session that has lapsed. */
	onSignedOut?: () => void;
	/**
	 * Whether this account may arrange a meeting, as the account page was told
	 * (Me.can). Without it the card still lists and cancels what was arranged
	 * before the permission was taken away — the server still allows both —
	 * and says why there is nothing to fill in, rather than offering a form
	 * whose every press would be refused. It authorises nothing: the server
	 * asks for itself, and a refusal it sends anyway has a sentence below.
	 */
	canArrange?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);

	useEffect(() => onOpenChange(open), [open, onOpenChange]);
	const { mounted, leaving } = useLingering(open);

	// One reading of the clock for both halves of the starting time, so a form
	// opened on the stroke of a quarter hour does not get the hour from one
	// side of it and the minute from the other.
	const [first] = useState(nextQuarter);
	const [planning, setPlanning] = useState("");
	const [day, setDay] = useState<Date>();
	const [hour, setHour] = useState(first.getHours());
	const [minute, setMinute] = useState(first.getMinutes());
	const [arranging, setArranging] = useState(false);
	const [copied, setCopied] = useState<string>();
	// The meeting whose link is shown in a box to be copied by hand, because
	// copying it for them did not work.
	const [showing, setShowing] = useState<string>();

	/*
	 * The clock, while the card is open.
	 *
	 * Whether the chosen time has gone was worked out when the card last drew
	 * itself, and the button used that answer. A form left open across the
	 * chosen minute went on offering it, and the server's hour of grace let it
	 * through. So the card keeps time: every half minute, and the moment the
	 * page is looked at again after being in another tab, which is when a form
	 * is most likely to have been left.
	 */
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!open) return;

		const tick = () => setNow(Date.now());
		const timer = window.setInterval(tick, TICK_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") tick();
		};

		tick();
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [open]);

	/*
	 * The list, in four states rather than one.
	 *
	 * It was read once and a failure was swallowed, so a person whose request
	 * failed saw the same empty card as one who had never arranged anything —
	 * and had nothing to press. Now it says which it is: still reading, read
	 * and empty, read and full, or could not be read, with a way to ask again.
	 * A read that fails while there is already a list keeps the list and says
	 * the refresh did not take, rather than emptying it.
	 *
	 * Every read carries a number, and only the latest is allowed to land. The
	 * list is also changed directly by arranging and cancelling, and a read
	 * that started before either of those must not undo them when it comes
	 * back late — so those bump the number too.
	 */
	const [list, setList] = useState<{
		status: "loading" | "ready" | "failed" | "signed out";
		items: Arrangement[];
	}>({ status: "loading", items: [] });
	const reads = useRef(0);

	const refresh = useCallback(async () => {
		const mine = ++reads.current;

		setList((was) => ({ ...was, status: "loading" }));

		try {
			const items = await arrangements();
			if (mine !== reads.current) return;

			setList({ status: "ready", items });
		} catch (whatever) {
			if (mine !== reads.current) return;

			const lapsed = whatever instanceof Refused && (whatever.reason === "not_signed_in" || whatever.message === "401");
			setList((was) => ({ ...was, status: lapsed ? "signed out" : "failed" }));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Opened again: read again. A list read when the page loaded is stale by
	// the time the card is opened an hour later, and a read that failed then
	// deserves one more try unasked. One read on opening, not one every few
	// seconds: nothing here changes behind the person's back.
	const opened = useRef(false);
	useEffect(() => {
		if (!open) return;
		if (!opened.current) {
			opened.current = true;
			return;
		}
		void refresh();
	}, [open, refresh]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(undefined), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	// The instant being arranged, or nothing until a day is chosen.
	const at = useMemo(() => {
		if (!day) return undefined;
		const d = new Date(day);
		d.setHours(hour, minute, 0, 0);
		return d;
	}, [day, hour, minute]);

	const past = at !== undefined && at.getTime() < now;
	const tooFar = at !== undefined && at.getTime() > now + AHEAD_MS;

	const plan = async () => {
		if (arranging || !at) return;

		// Read again here, not taken from the last render: this is the answer
		// that decides whether anything is sent.
		const moment = Date.now();
		setNow(moment);
		if (at.getTime() < moment || at.getTime() > moment + AHEAD_MS) return;

		const room = validRoomName(normaliseRoomName(planning)) ? normaliseRoomName(planning) : generateRoomName();

		setArranging(true);

		let made: Arrangement;

		try {
			made = await arrange(room, at, server);
		} catch (whatever) {
			actionFailed(explainArranging(whatever, t));
			setArranging(false);
			return;
		}

		reads.current++;
		setList((was) => ({ status: "ready", items: [...was.items, made].sort((a, b) => a.at.localeCompare(b.at)) }));
		setPlanning("");
		setDay(undefined);
		setArranging(false);

		// Straight onto the clipboard, because the link is the whole point and
		// the next thing anybody does with it is paste it somewhere. Outside the
		// try above, on purpose: the meeting exists now whatever the clipboard
		// does, and a copy that failed used to be reported as the arranging
		// having failed — which invited making it again.
		await offer(made);
	};

	/** Copy a meeting's link, or show it to be copied by hand. */
	const offer = async (one: Arrangement) => {
		if (await copyText(linkFor(one))) {
			setCopied(one.id);
			setShowing(undefined);
			return;
		}

		setShowing(one.id);
		actionFailed(t("Could not copy the link. Copy it from the box."));
	};

	const drop = async (one: Arrangement) => {
		try {
			await cancel(one.id);
			reads.current++;
			setList((was) => ({ ...was, items: was.items.filter((m) => m.id !== one.id) }));
		} catch (whatever) {
			actionFailed(explainArranging(whatever, t));
		}
	};

	const mine = list.items;

	return (
		<section
			className={cn(
				"animate-rise [animation-delay:180ms]",
				"flex flex-col rounded-xl border border-border bg-surface",
			)}
		>
			<button
				type="button"
				onClick={() => setOpen((was) => !was)}
				aria-expanded={open}
				className="flex w-full items-center gap-3.5 p-4 text-left"
			>
				<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-hi text-fg-muted">
					<CalendarClock className="size-5" />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="font-medium text-[14px]">{t("Schedule a meeting")}</span>
					<span className="text-[12px] text-fg-muted leading-snug">
						{t("Pick a time and hand out the link before it starts.")}
					</span>
				</span>
				<ChevronDown
					className={cn("size-4 shrink-0 text-fg-muted transition-transform duration-200", open && "rotate-180")}
				/>
			</button>

			{mounted && (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void plan();
					}}
					className={cn("flex flex-col gap-4 px-4 pb-4", leaving ? "animate-depart" : "animate-arrive")}
				>
					{!canArrange && (
						<p className="text-[12.5px] text-fg-muted leading-snug">
							{t("Arranging meetings has not been opened to you.")}
						</p>
					)}

					{canArrange && (
						<>
							<label className="flex flex-col gap-1.5">
								<span className="text-[11px] text-fg-muted">{t("Room name")}</span>
								<Input
									value={planning}
									onChange={(event) => setPlanning(event.target.value)}
									placeholder={t("Room name")}
									aria-label={t("Name for the new room")}
									maxLength={64}
									className="bg-surface-hi"
								/>
								<span className="text-[11.5px] text-fg-muted leading-snug">
									{t("Name it yourself, or leave it blank for one nobody has used.")}
								</span>
							</label>

							<div className="flex flex-col gap-1.5">
								<span className="text-[11px] text-fg-muted">{t("Day")}</span>
								<DayGrid value={day} onChange={setDay} />
							</div>

							<div className="flex flex-col gap-1.5">
								<span className="text-[11px] text-fg-muted">{t("Time")}</span>
								<div className="flex items-center gap-2">
									<Clock value={hour} onChange={setHour} count={24} label={t("Hour")} />
									<span className="text-fg-muted">:</span>
									<Clock value={minute} onChange={setMinute} count={60} step={15} label={t("Minute")} />
								</div>
							</div>

							{/* The same list the lobby shows for starting and joining, brought
							    in here so the machine is chosen where the meeting is arranged
							    rather than somewhere below it. */}
							{servers.length > 1 && <ServerList relays={servers} value={server} onChange={onServer} />}

							<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
								<span className="min-w-0 text-[12.5px] text-fg-muted leading-snug">
									{at
										? past
											? t("That time has already gone.")
											: tooFar
												? t("That is more than sixty days away.")
												: t("Arranged for {when}", { when: whenSaid(at.toISOString()) })
										: t("Choose a day.")}
								</span>
								<Button type="submit" variant="primary" disabled={!at || past || tooFar || arranging} className="shrink-0">
									{arranging ? <Loader2 className="size-4 animate-spin" /> : t("Arrange")}
								</Button>
							</div>
						</>
					)}

					{list.status === "signed out" && (
						<div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
							<span className="text-[12.5px] text-fg-muted">{t("Your session has expired. Sign in again.")}</span>
							{onSignedOut && (
								<Button type="button" variant="secondary" size="sm" onClick={onSignedOut}>
									{t("Sign in")}
								</Button>
							)}
						</div>
					)}

					{list.status === "failed" && (
						<div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
							<span className="text-[12.5px] text-fg-muted">{t("Could not load your meetings.")}</span>
							<Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
								{t("Try again")}
							</Button>
						</div>
					)}

					{list.status === "loading" && mine.length === 0 && (
						<div className="flex items-center gap-2 px-1 text-[12.5px] text-fg-muted">
							<Loader2 className="size-3.5 animate-spin" />
						</div>
					)}

					{/* Not beside the sentence that says arranging was not opened to
					    them: that already says why there is nothing here. */}
					{canArrange && list.status === "ready" && mine.length === 0 && (
						<p className="px-1 text-[12.5px] text-fg-muted">{t("No meetings arranged yet.")}</p>
					)}

					{mine.length > 0 && (
						<ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
							{mine.map((one) => (
								<li key={one.id} className="flex flex-col gap-2 px-3 py-2">
									<div className="flex items-center gap-2">
										<span className="flex min-w-0 flex-1 flex-col">
											{one.ended ? (
												<span className="readout truncate text-[13px] text-fg-muted">{one.room}</span>
											) : (
												<a
													href={linkFor(one)}
													aria-label={t("Open {room}", { room: one.room })}
													className="readout truncate text-[13px] underline-offset-2 hover:underline focus-visible:underline"
												>
													{one.room}
												</a>
											)}
											<span className="truncate text-[11.5px] text-fg-muted">
												{whenSaid(one.at)}
												{one.ended ? ` · ${t("Over")}` : one.started ? ` · ${t("Under way")}` : ""}
											</span>
										</span>

										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8"
											aria-label={copied === one.id ? t("Link copied") : t("Copy link")}
											onClick={() => void offer(one)}
										>
											{copied === one.id ? <Check className="size-4 text-tally" /> : <Copy className="size-4" />}
										</Button>

										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8"
											aria-label={t("Add to calendar")}
											onClick={() => download(fileNameFor(one), icsFor(one, linkFor(one)))}
										>
											<CalendarPlus className="size-4" />
										</Button>

										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8 text-fg-muted"
											aria-label={t("Cancel meeting")}
											onClick={() => void drop(one)}
										>
											<X className="size-4" />
										</Button>
									</div>

									{/* Only where copying did not work. The link is a
									    line of noise in a list that is otherwise names
									    and times, so it is not shown until it has to be. */}
									{showing === one.id && (
										<Input
											readOnly
											value={linkFor(one)}
											aria-label={t("Meeting link")}
											onFocus={(event) => event.currentTarget.select()}
											className="readout h-9 bg-surface-hi text-[12px]"
										/>
									)}
								</li>
							))}
						</ul>
					)}
				</form>
			)}
		</section>
	);
}

/** How far ahead a day may be chosen. The server's bound, so the grid never
 * offers what the server would refuse. */
const DAYS_AHEAD = 60;

/**
 * A month of days to choose from, limited to the next sixty.
 *
 * Weeks start on Monday, which is how every calendar this deployment's people
 * grew up with is printed. Days outside the window are drawn and disabled
 * rather than hidden, so the grid keeps its shape from one month to the next.
 */
function DayGrid({ value, onChange }: { value?: Date; onChange: (day: Date) => void }) {
	const t = useT();
	const today = startOfDay(new Date());
	const last = new Date(today);
	last.setDate(last.getDate() + DAYS_AHEAD);

	const [shown, setShown] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

	const monthSaid = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }).format(shown);
	const weekdays = useMemo(() => {
		const f = new Intl.DateTimeFormat(locale(), { weekday: "narrow" });
		// A known Monday.
		return Array.from({ length: 7 }, (_, n) => f.format(new Date(2024, 0, 1 + n)));
	}, []);

	// The cells: leading blanks so the first falls on its weekday, then the
	// month's days.
	const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
	const lead = (first.getDay() + 6) % 7;
	const count = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();

	const earlier = new Date(shown.getFullYear(), shown.getMonth() - 1, 1);
	const later = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);
	const canGoBack = earlier >= new Date(today.getFullYear(), today.getMonth(), 1);
	const canGoOn = later <= last;

	return (
		<div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-border bg-surface-hi p-2">
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={() => setShown(earlier)}
					disabled={!canGoBack}
					aria-label={t("Previous month")}
					className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-surface disabled:opacity-30"
				>
					<ChevronLeft className="size-4" />
				</button>
				<span className="truncate text-[12.5px] font-medium">{monthSaid}</span>
				<button
					type="button"
					onClick={() => setShown(later)}
					disabled={!canGoOn}
					aria-label={t("Next month")}
					className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-surface disabled:opacity-30"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>

			<div className="grid grid-cols-7 gap-0.5 text-center">
				{weekdays.map((w, n) => (
					<span key={String(n)} className="py-1 text-[10.5px] text-fg-muted">
						{w}
					</span>
				))}

				{Array.from({ length: lead }, (_, n) => (
					<span key={`lead-${String(n)}`} />
				))}

				{Array.from({ length: count }, (_, n) => {
					const d = new Date(shown.getFullYear(), shown.getMonth(), n + 1);
					const offered = d >= today && d <= last;
					const chosen = value !== undefined && sameDay(d, value);
					const isToday = sameDay(d, today);

					return (
						<button
							key={String(n)}
							type="button"
							disabled={!offered}
							onClick={() => onChange(d)}
							aria-pressed={chosen}
							aria-label={new Intl.DateTimeFormat(locale(), { dateStyle: "full" }).format(d)}
							className={cn(
								"h-9 rounded-md text-[12.5px] transition-colors",
								offered ? "hover:bg-surface" : "opacity-30",
								chosen && "bg-fg text-bg hover:bg-fg",
								isToday && !chosen && "ring-1 ring-fg/40",
							)}
						>
							{n + 1}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** One of the two halves of a time. A platform select, which draws a list of
 * twenty-four well and needs no styling to be read. */
function Clock({
	value,
	onChange,
	count,
	step = 1,
	label,
}: {
	value: number;
	onChange: (n: number) => void;
	count: number;
	step?: number;
	label: string;
}) {
	return (
		<select
			value={value}
			onChange={(event) => onChange(Number(event.target.value))}
			aria-label={label}
			className={cn(
				"h-10 w-24 rounded-lg border border-border bg-surface-hi px-2 text-sm text-fg",
				"outline-none transition-colors focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
			)}
		>
			{Array.from({ length: Math.ceil(count / step) }, (_, n) => n * step).map((n) => (
				<option key={n} value={n}>
					{String(n).padStart(2, "0")}
				</option>
			))}
		</select>
	);
}

/**
 * Put text on the clipboard, and say whether it got there.
 *
 * Three ways this fails and they arrive differently: no clipboard at all on a
 * page that is not secure, a call that throws, and a call that answers with a
 * refusal. All three used to be ignored, and the first was worse than
 * ignored — it threw inside the arranging's own try, and the meeting that had
 * just been made was reported as not made.
 */
async function copyText(text: string): Promise<boolean> {
	try {
		const clipboard = navigator.clipboard;
		if (!clipboard || typeof clipboard.writeText !== "function") return false;

		await clipboard.writeText(text);

		return true;
	} catch {
		return false;
	}
}

function nextQuarter(): Date {
	const d = new Date();
	d.setSeconds(0, 0);
	d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
	return d;
}

function startOfDay(d: Date): Date {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s;
}

function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Sentences for what the server may answer. The codes stay on the wire. */
function explainArranging(whatever: unknown, t: ReturnType<typeof useT>): string {
	const reason = whatever instanceof Refused ? whatever.reason : "";

	switch (reason) {
		case "room_already_arranged":
			return t("That room already has a meeting arranged.");
		case "bad_time":
			return t("That time is not one a meeting can be arranged for.");
		case "meetings_need_invites":
			return t("Meetings here ask for an account, so a link cannot let anybody in.");
		case "not_yours":
			return t("That is somebody else's room.");
		case "too_many_meetings":
			return t("You have as many meetings arranged as you can have.");
		case "invalid_room":
			return t("Room names can only use lowercase letters, numbers and dashes.");
		case "scoped_room":
			return t("A room held under a scope cannot be arranged ahead. Send a link with a time on it instead.");
		case "relay_not_allowed":
			return t("Access denied. That server is for administrators.");
		case "not_signed_in":
			return t("Your session has expired. Sign in again.");
		// The permission taken away while the lobby was open: the form was
		// offered by what the page was told when it loaded. Trying again can
		// never work, which is what the sentence below would have invited.
		case "not_allowed":
			return t("Arranging meetings has not been opened to you.");
		default:
			return t("Something went wrong. Try again.");
	}
}
