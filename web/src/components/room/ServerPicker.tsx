import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import { say } from "@/live/i18n";
import { type Relay, timings } from "@/live/relays";
import { Check, ChevronDown, Loader2, RotateCw, Wand2 } from "lucide-react";
import { Flagged } from "@/components/room/Flag";
import { Globe } from "@/components/room/Globe";
import { useLingering } from "@/hooks/useLingering";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Choosing where the call will be held, with what each one costs.
 *
 * A list of place names is not a choice anybody can make. "Shanghai" and
 * "Hong Kong" tell somebody nothing about which will carry their voice better,
 * and the one piece of information that would — how long a packet takes to get
 * there and back — is something this page can measure in a second and is
 * already measuring in order to choose automatically. Withholding it and then
 * asking the person to decide is asking them to guess at the answer it has.
 *
 * So the numbers are here, and they arrive as they are measured rather than all
 * at once: a relay that is down should not hold up the three that answered
 * immediately, and watching them land one at a time is also the clearest
 * possible statement that they are being measured now rather than remembered.
 *
 * Built rather than a native select, and not for the look. A native option can
 * hold one line of text and no marks: no colour for how good a number is, no
 * second line, nothing that arrives after the menu is open. All three are the
 * whole point here.
 */
/**
 * How long the button is held shut after a measurement.
 *
 * Short enough that somebody who genuinely wants a fresh reading is not made to
 * wait, long enough that the button cannot be held down — which would be a
 * burst of connections to every relay, from every browser, aimed at one's own
 * machines.
 */
const COOLDOWN_MS = 5000;

/** How close the sheet may come to the edge of the window, and to its control. */
const MARGIN = 12;
const GAP = 8;

/** How long the spinner turns for, however quickly the answer arrives. */
const SPIN_AT_LEAST_MS = 550;

/**
 * The measuring, which both shapes of this need and neither owns.
 *
 * Taken once and then only on request. It costs one connection to every relay
 * from every browser that asks, and a burst of those to an unregistered host in
 * mainland China is what got a relay's name blacklisted once already — so the
 * limit is on the asking rather than on the network underneath it.
 */
function useMeasuring(relays: Relay[]) {
	const [measured, setMeasured] = useState<Map<string, number | undefined>>();
	const [measuring, setMeasuring] = useState(false);
	const [ready, setReady] = useState(true);
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const measure = useCallback(() => {
		if (!ready) return;

		setReady(false);
		setMeasuring(true);

		// Held for a moment even when the answer comes back at once.
		//
		// A relay that answers in twelve milliseconds makes the spinner appear
		// and vanish inside one frame, so the button reads as not having done
		// anything — and somebody who pressed it and saw nothing presses it
		// again. What is being shown is not how long the work took; it is that
		// the press was received.
		const shown = new Promise((settle) => setTimeout(settle, SPIN_AT_LEAST_MS));

		void Promise.all([timings(relays), shown]).then(([result]) => {
			if (!alive.current) return;

			setMeasured(result);
			setMeasuring(false);
		});

		setTimeout(() => {
			if (alive.current) setReady(true);
		}, COOLDOWN_MS);
	}, [ready, relays]);

	return { measured, measuring, ready, measure };
}

/**
 * Every server at once, as a grid, fastest first.
 *
 * For the lobby, where choosing where the call is held is one of three decisions
 * on the screen rather than a detail behind a control.
 *
 * Three shapes were tried and the first two were wrong in the same way. A
 * dropdown puts a decision behind a press and, at eleven relays, opens a sheet
 * that covers the page it belongs to. The same list left open is a wall of rows
 * that has to scroll, which makes the two things above it — start a meeting,
 * join one — look like the smaller decisions.
 *
 * What somebody actually wants here is one question answered: which of these is
 * quickest from where I am. So they are sorted by that rather than grouped by
 * geography, and drawn as chips small enough that all of them fit without
 * scrolling. The flags carry the geography; a heading for every region cost four
 * more rows to say what the flag already said, and imposed an order nobody was
 * asking for.
 *
 * The order settles once, when the measurements land. Reordering continuously
 * would move a chip out from under a finger already reaching for it.
 */
export function ServerList({
	relays,
	value,
	onChange,
}: {
	relays: Relay[];
	value: string;
	onChange: (name: string) => void;
}) {
	const t = useT();
	const { measured, measuring, ready, measure } = useMeasuring(relays);

	// biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
	useEffect(() => {
		measure();
	}, []);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2 px-1">
				<span className="text-[11px] text-fg-muted">{t("Server")}</span>

				<button
					type="button"
					disabled={!ready || measuring}
					onClick={measure}
					className={cn(
						"flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted",
						"transition-colors hover:bg-surface-hi hover:text-fg disabled:opacity-40",
						"disabled:hover:bg-transparent disabled:hover:text-fg-muted",
					)}
				>
					<RotateCw
						className={cn(
							"size-3 transition-transform duration-300",
							measuring && "animate-spin",
							// Nudged round on the way back to still, so the icon
							// settles rather than snapping to where it started.
							!measuring && !ready && "rotate-180",
						)}
					/>
					{t("Measure again")}
				</button>
			</div>

			{/*
			 * The globe and the menu are the same choice offered two ways, and
			 * neither is the fallback for the other.
			 *
			 * A list answers "which of these is quickest" and says nothing about
			 * where anything is; a globe answers "where are these" and is a poor
			 * way to compare eleven numbers. Somebody arranging a call with people
			 * in three countries wants the first question answered by looking and
			 * the second by reading, and which one they reach for is theirs to
			 * decide rather than ours.
			 */}
			<Globe relays={relays} value={value} measured={measured} onChange={onChange} />

			<ServerPicker relays={relays} value={value} onChange={onChange} plain />
		</div>
	);
}

export function ServerPicker({
	relays,
	value,
	onChange,
	plain = false,
}: {
	relays: Relay[];
	value: string;
	onChange: (name: string) => void;
	/**
	 * Without its own heading, for where something above it already carries one.
	 *
	 * The lobby has the word "Server" and the control for measuring again on one
	 * line above the globe, and a second heading between the two would be the
	 * same word twice with a picture in between.
	 */
	plain?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { measured, measuring, ready, measure } = useMeasuring(relays);

	// Held on screen while it leaves. Rendered as `open && ...` the sheet was
	// simply gone on the frame after a press anywhere else — it opened from the
	// control and closed by vanishing, which reads as the page having redrawn
	// rather than as a menu being dismissed.
	const { mounted, leaving } = useLingering(open, 160);
	// Where the sheet actually goes, in window coordinates.
	//
	// Positioned rather than anchored. Anchored to the control it opens from, a
	// list long enough runs off the top of the window and the rows at the far end
	// cannot be reached at all — which is what eleven relays did. Nothing about
	// being anchored was worth that: what somebody wants is to see the list.
	const [place, setPlace] = useState<{ left: number; width: number; top: number; tall: number }>();
	const frame = useRef<HTMLDivElement>(null);
	const sheet = useRef<HTMLUListElement>(null);

	// Measured when the menu is first opened rather than on load, because it
	// costs a connection to every relay and most people never open this. Not on
	// every open: the numbers do not move that fast, and the button below is
	// there for anybody who thinks they have.
	useEffect(() => {
		if (!open || measured || measuring) return;

		measure();
	}, [open, measured, measuring, measure]);

	/**
	 * Which way the sheet opens: towards whichever side has more room.
	 *
	 * The first version only went upward when the list would not fit below, and
	 * on a desktop it therefore never did — the join card sits in the middle of
	 * a tall window, so there is always technically enough room underneath and
	 * the menu opened downwards over the button somebody had just pressed.
	 *
	 * More room wins now, which on a join screen is nearly always upward:
	 * everything below the control is the control and the button under it.
	 * Simple enough to predict, which is most of what makes a menu feel settled
	 * — one that opens up sometimes and down other times for reasons nobody can
	 * see is worse than one that always picks the wrong side.
	 *
	 * Measured when it opens rather than assumed from where the control sits,
	 * because the answer depends on the window as it is now.
	 */
	useLayoutEffect(() => {
		if (!open) return;

		const settle = () => {
			const box = frame.current?.getBoundingClientRect();
			if (!box) return;

			// The most it may ever be, so a fleet of forty does not become a
			// full-screen wall of text.
			const room = window.innerHeight - MARGIN * 2;
			const tall = Math.min(sheet.current?.scrollHeight ?? room, room, window.innerHeight * 0.7);

			// Above the control, which on a join screen is nearly always where the
			// space is: everything below it is the control and the button under
			// it. Then clamped into the window — and clamping is allowed to cover
			// the control and whatever is beneath it, because a list somebody
			// cannot see all of is worse than a button they cannot see while
			// choosing from it.
			const wanted = box.top - GAP - tall;
			const top = Math.min(Math.max(wanted, MARGIN), window.innerHeight - MARGIN - tall);

			setPlace({ left: box.left, width: box.width, top, tall });
		};

		settle();

		// Recomputed on both, because either moves the control out from under a
		// sheet that is no longer beside anything.
		window.addEventListener("resize", settle);
		window.addEventListener("scroll", settle, true);

		return () => {
			window.removeEventListener("resize", settle);
			window.removeEventListener("scroll", settle, true);
		};
	}, [open]);

	// Closed by anything that is not this. A menu that stays open behind the
	// rest of the page is one somebody has to find their way out of.
	useEffect(() => {
		if (!open) return;

		const away = (event: MouseEvent) => {
			// Both, because the sheet is no longer inside the frame: it is on the
			// document, so a press on one of its own rows is a press outside the
			// control and would close the menu before the row was chosen.
			const on = event.target as Node;

			if (!frame.current?.contains(on) && !sheet.current?.contains(on)) setOpen(false);
		};

		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);

		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);

	const chosen = relays.find((relay) => relay.name === value);

	return (
		<div ref={frame} className="relative flex flex-col gap-1.5">
			{!plain && <span className="text-fg-muted text-xs">{t("Server")}</span>}

			{/*
			  * Drawn as a control rather than as a field. The first version was a
			  * bordered box the same colour as the inputs above it, and nothing
			  * about it said it opened — people read it as somewhere to type. So
			  * it lifts on hover, the chevron sits in a well of its own to say
			  * which end does the opening, and the whole thing presses when it is
			  * open.
			  */}
			<button
				type="button"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className={cn(
					"group flex h-11 items-center gap-2 rounded-lg border bg-surface-hi pr-1.5 pl-3",
					"text-left text-fg text-sm outline-none",
					"transition-[background-color,border-color,box-shadow] duration-150",
					"focus-visible:ring-2 focus-visible:ring-fg/40",
					open
						? "border-fg/25 bg-surface-hi shadow-inner"
						: "border-border hover:border-fg/20 hover:bg-surface-hi hover:shadow-md",
				)}
			>
				<span className="min-w-0 flex-1 truncate">
					{chosen ? <Flagged text={marked(chosen)} /> : t("Automatic")}
				</span>

				{chosen && <Latency ms={measured?.get(chosen.name)} known={measured !== undefined} />}

				<span
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-md",
						"transition-colors duration-150",
						open ? "bg-fg/10" : "group-hover:bg-fg/5",
					)}
				>
					<ChevronDown
						className={cn(
							"size-4 text-fg-muted transition-transform duration-200",
							open && "rotate-180",
						)}
					/>
				</span>
			</button>

			{mounted &&
				createPortal(
					/*
					 * Out of the page and onto the document.
					 *
					 * It is positioned in window coordinates, and inside the page it
					 * was two ancestors away from being positioned against something
					 * else entirely: a transform anywhere above it — left behind by a
					 * page transition, of all things — makes a `fixed` child resolve
					 * against that element and be clipped by its overflow. That is
					 * not a thing anybody looking at a menu that will not scroll
					 * would think to check, and it costs nothing to be out of reach
					 * of it.
					 */
					<ul
						ref={sheet}
						role="listbox"
						style={
							place && {
								left: place.left,
								width: place.width,
								top: place.top,
								maxHeight: place.tall,
							}
						}
						className={cn(
							"fixed z-30 overflow-y-auto overscroll-contain rounded-xl",
							// Hidden until it has been placed. One frame at the wrong
							// coordinates is a flash of a menu somewhere it never was,
							// which is more distracting than the wait it replaces.
							!place && "invisible",
							// A ring as well as a border, and a real shadow. It has to
							// read as a sheet above the page rather than as more page:
							// on a dark interface a one-pixel border alone disappears.
							"border border-fg/15 bg-surface-hi shadow-2xl ring-1 ring-black/40",
							// Arrives from the edge it is anchored to rather than
							// appearing: a menu that fades in from nowhere reads as a
							// page redraw, and one that grows the wrong way reads as a
							// mistake.
							"origin-top",
							leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<Rows
							relays={relays}
							value={value}
							measured={measured}
							measuring={measuring}
							ready={ready}
							onMeasure={measure}
							onChange={onChange}
							onPicked={() => setOpen(false)}
						/>
					</ul>,
					document.body,
				)}
		</div>
	);
}


/**
 * The rows themselves: the header with its remeasure button, the automatic
 * choice, and every relay under the heading for where it is.
 *
 * Its own component because there are two right ways to show this and the
 * difference is only where it sits. On a screen with one thing on it — the
 * lobby, where somebody is deciding what kind of meeting to have — the list
 * belongs open, because it is one of the decisions rather than a detail behind a
 * control. On a screen that is mostly a camera preview it belongs behind one,
 * because it is a detail almost nobody changes.
 *
 * Written once for both. Two copies would drift, and the half that drifts is
 * always the one somebody looks at less.
 */
function Rows({
	relays,
	value,
	measured,
	measuring,
	ready,
	onMeasure,
	onChange,
	onPicked,
}: {
	relays: Relay[];
	value: string;
	measured?: Map<string, number | undefined>;
	measuring: boolean;
	ready: boolean;
	onMeasure: () => void;
	onChange: (name: string) => void;
	onPicked: () => void;
}) {
	const t = useT();

	return (
		<>
			<li className="flex items-center justify-between gap-2 border-fg/10 border-b bg-black/15 px-3 py-2">
				<span className="text-fg-muted text-[10.5px] uppercase tracking-wide">
					{t("Round trip")}
				</span>

				<button
					type="button"
					disabled={!ready || measuring}
					onClick={onMeasure}
					className={cn(
						"flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted",
						"transition-colors hover:bg-surface-hi hover:text-fg disabled:opacity-40",
						"disabled:hover:bg-transparent disabled:hover:text-fg-muted",
					)}
				>
					<RotateCw
						className={cn(
							"size-3 transition-transform duration-300",
							measuring && "animate-spin",
							// Nudged round on the way back to still, so the icon
							// settles rather than snapping to where it started.
							!measuring && !ready && "rotate-180",
						)}
					/>
					{t("Measure again")}
				</button>
			</li>

			<Option
				label={t("Automatic")}
				describes={t("Whichever answers fastest")}
				chosen={value === ""}
				// Marked, because it is not one of the places below it: it
				// is the absence of a choice, and a row that looked exactly
				// like the relays would read as a machine called Automatic.
				icon={<Wand2 className="size-3.5 shrink-0 text-fg-muted" />}
				onPick={() => {
					onChange("");
					onPicked();
				}}
			/>

			{grouped(relays).map((row, index) =>
				row.kind === "heading" ? (
					<Heading key={`h${row.path}`} text={row.text} depth={row.depth} delay={index * 30} />
				) : (
					<Option
						key={row.relay.name}
						label={marked(row.relay)}
						describes={
							row.relay.maintenance
								? t("Not taking calls")
								: row.relay.fallback
									? "[Fallback]"
									: undefined
						}
						chosen={value === row.relay.name}
						// Shown and not selectable. A relay taken down for an
						// hour that vanished from the list would look deleted
						// to whoever used it yesterday.
						disabled={row.relay.maintenance}
						depth={row.depth}
						latency={
							<Latency
								ms={measured?.get(row.relay.name)}
								known={measured !== undefined}
							/>
						}
						// Staggered so the list comes in as a list rather than as
						// one block. Small enough to read as movement and not as
						// waiting.
						delay={index * 30}
						onPick={() => {
							onChange(row.relay.name);
							onPicked();
						}}
					/>
				),
			)}

		</>
	);
}

/**
 * A relay's name with what is unusual about it attached.
 *
 * Only an administrator is ever sent one of these, so the mark is not a warning
 * — it is a reminder that what they are looking at is not on the list everybody
 * else sees, which matters when they are about to send somebody a link and
 * wonder why that person landed elsewhere.
 */
function marked(relay: Relay): string {
	const name = say(relay.label || relay.name);

	return relay.adminOnly ? `${name} [Admin]` : name;
}

/**
 * A row of the menu: either a relay or a heading above a run of them.
 *
 * Flattened into a list rather than nested into a tree, because the menu is a
 * list — a listbox with nested lists inside it is a thing screen readers have to
 * be told how to read, and the nesting here is entirely a matter of two levels
 * of indentation.
 */
type Row =
	| { kind: "heading"; text: string; depth: number; path: string }
	| { kind: "relay"; relay: Relay; depth: number };

/**
 * Group the relays by their region, which is a path.
 *
 * "China Mainland" puts a relay under one heading and "Oversea/Asia" under two.
 * A path rather than a second field, because the field already existed, is
 * already editable, and a deployment that has never touched it goes on reading
 * as exactly the flat list it was.
 *
 * Relays in one group are gathered, wherever they sit in the list. The first
 * version of this followed the list exactly, so a group interrupted by another
 * printed its heading twice with the interloper between — which reads as a bug
 * whatever the reasoning, because the entire promise of a grouped list is that
 * looking in one place finds all of them.
 *
 * What the operator's ordering still decides is the order of the groups, by
 * where each one first appears, and the order within them. So moving a relay to
 * the top moves its group to the top, which is the useful half of following the
 * list and the half that survives gathering.
 */
export function grouped(relays: Relay[]): Row[] {
	const paths = new Map<string, { path: string[]; relays: Relay[] }>();

	for (const relay of relays) {
		const path = (relay.region ?? "")
			.split("/")
			.map((part) => part.trim())
			.filter(Boolean);

		const key = path.join("/");
		const group = paths.get(key);

		if (group) {
			group.relays.push(relay);
			continue;
		}

		// Insertion order is iteration order for a Map, which is what carries
		// the operator's ordering into the groups.
		paths.set(key, { path, relays: [relay] });
	}

	const rows: Row[] = [];
	let open: string[] = [];

	for (const group of paths.values()) {
		// Only the levels that are not already open. Two groups under one parent
		// print the parent once.
		let shared = 0;
		while (
			shared < group.path.length &&
			shared < open.length &&
			group.path[shared] === open[shared]
		) {
			shared += 1;
		}

		for (let depth = shared; depth < group.path.length; depth += 1) {
			const text = group.path[depth];
			if (text === undefined) continue;

			rows.push({
				kind: "heading",
				text,
				depth,
				path: group.path.slice(0, depth + 1).join("/"),
			});
		}

		open = group.path;

		for (const relay of group.relays) {
			rows.push({ kind: "relay", relay, depth: group.path.length });
		}
	}

	return rows;
}

function Heading({ text, depth, delay }: { text: string; depth: number; delay: number }) {
	return (
		<li
			aria-hidden="true"
			style={{ animationDelay: `${delay}ms`, paddingLeft: `${0.75 + depth * 0.75}rem` }}
			className={cn(
				// A band rather than a line of text, so a heading is unmistakably
				// not something to click.
				"animate-arrive bg-black/20 py-1.5 pr-3 font-medium text-[10.5px] text-fg-muted uppercase tracking-wider",
				depth > 0 && "bg-black/10 text-fg-muted/70 normal-case tracking-normal",
			)}
		>
			{say(text)}
		</li>
	);
}

function Option({
	label,
	describes,
	chosen,
	latency,
	icon,
	disabled = false,
	depth = 0,
	delay = 0,
	onPick,
}: {
	label: string;
	describes?: string;
	chosen: boolean;
	latency?: React.ReactNode;
	icon?: React.ReactNode;
	disabled?: boolean;
	depth?: number;
	delay?: number;
	onPick: () => void;
}) {
	return (
		<li role="option" aria-selected={chosen}>
			<button
				type="button"
				onClick={onPick}
				disabled={disabled}
				style={{ animationDelay: `${delay}ms`, paddingLeft: `${0.5 + depth * 0.75}rem` }}
				className={cn(
					"group relative flex w-full animate-arrive items-center gap-2.5 py-3 pr-3 text-left",
					"transition-colors duration-150",
					disabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
					// A line between rows, not around them. Without it the options
					// run together into a paragraph and the gaps between them are
					// invisible on a dark background.
					"after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0",
					"after:h-px after:bg-fg/8 last:after:hidden",
					chosen ? "bg-fg/8" : !disabled && "hover:bg-fg/5",
				)}
			>
				{/* A bar down the edge rather than a tick alone. The tick says which
				    one is chosen to somebody reading; the bar says it to somebody
				    glancing, which is how a menu is read. */}
				<span
					className={cn(
						"absolute inset-y-1 left-0 w-[3px] rounded-r-full transition-all duration-150",
						chosen ? "bg-tally opacity-100" : "bg-fg/30 opacity-0 group-hover:opacity-60",
					)}
				/>

				<Check
					className={cn(
						"size-3.5 shrink-0 text-tally transition-opacity duration-150",
						!chosen && "opacity-0",
					)}
				/>

				{icon}

				<span className="min-w-0 flex-1">
					<span className="block truncate text-fg text-sm">
						<Flagged text={label} />
					</span>
					{describes && (
						<span className="mt-0.5 block truncate text-fg-muted text-[11px]">{describes}</span>
					)}
				</span>

				{latency}
			</button>
		</li>
	);
}

/**
 * How far away a relay is, in the two things somebody reads at once.
 *
 * The number for anybody comparing two of them, and the colour for anybody who
 * only wants to know whether this one is fine. Same bands as the connection
 * light in a call, so that a relay chosen here for showing green does not turn
 * amber the moment the call starts.
 */
function Latency({ ms, known }: { ms: number | undefined; known: boolean }) {
	const t = useT();

	if (!known) {
		return <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-muted/60" />;
	}

	if (ms === undefined) {
		return <span className="shrink-0 text-[11px] text-danger">{t("Timeout")}</span>;
	}

	const colour = ms <= 150 ? "text-good" : ms <= 400 ? "text-tally" : "text-danger";

	return (
		<span
			className={cn(
				"readout shrink-0 animate-arrive tabular-nums text-[11.5px]",
				colour,
			)}
		>
			{Math.round(ms)} ms
		</span>
	);
}
