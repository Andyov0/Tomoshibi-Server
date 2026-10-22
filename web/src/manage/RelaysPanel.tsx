import { useT } from "@/hooks/useT";
import { useLingering } from "@/hooks/useLingering";
import { useReorder } from "@/hooks/useReorder";
import { cn } from "@/lib/utils";
import { say } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import {
	Check,
	ChevronDown,
	ChevronUp,
	Copy,
	GripVertical,
	Loader2,
	Plus,
	RotateCw,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import { type PointerEvent as Pointing, useCallback, useEffect, useMemo, useState } from "react";
import { type Relay, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * The media servers this deployment holds calls on.
 *
 * Adding one is a page rather than a line in a configuration file because of
 * when it happens: a relay is added the moment a machine is brought up, and
 * editing a file and restarting to record that would drop every call the
 * control node is holding — for an operation that changes nothing at all about
 * the calls already in progress somewhere else.
 *
 * Each row carries whether the relay answered, measured from the control node
 * when this page was drawn. That is deliberately not the same measurement a
 * client makes before joining: this says whether the machine is up, and the
 * client's says whether it is near them. A relay can be perfectly healthy here
 * and the wrong choice for somebody on another continent, and a row that
 * conflated the two would send an operator looking for a fault that is not one.
 */
export function RelaysPanel({
	canRelays,
	onSignedOut,
}: {
	/** May add, edit, order and remove relays, and hand out the install line. */
	canRelays: boolean;
	onSignedOut: () => void;
}) {
	const t = useT();

	// The acts on the fleet, under the name every component below has always
	// used for them. They were moderate's until the acting half was cut along
	// what it acts on, and the relays went to their own capability.
	const canModerate = canRelays;

	// Often enough that a relay going down is noticed while somebody is
	// watching, rarely enough that the control node is not measuring every
	// relay continuously for a page nobody has open.
	const { value, error, refresh } = usePoll(api.relays, { every: 15_000, onSignedOut });

	const [adding, setAdding] = useState(false);
	const [script, setScript] = useState<string>();
	const [command, setCommand] = useState<string>();
	// What the new machine will be called, and what has to be reachable on it.
	// Both come back with the command and neither was drawn.
	const [enrolDomain, setEnrolDomain] = useState<string>();
	const [enrolPort, setEnrolPort] = useState<number>();
	const [busy, setBusy] = useState<string>();

	/**
	 * The order somebody has just dragged the list into, held until the server
	 * has been told and has said it back.
	 *
	 * Without it a drop reads as two jumps. The row lands, the transforms come
	 * off, and the list underneath is still the one the server last sent — so
	 * the row snaps back to where it was picked up and moves again a moment
	 * later when the save returns, to describe a move that already happened on
	 * screen.
	 */
	const [arranged, setArranged] = useState<string[]>();

	/**
	 * What a single relay answered when its own row was asked.
	 *
	 * Dropped as soon as the whole list is read again, because reading the list
	 * measures every relay: keeping this would be showing the older of two
	 * answers to the same question, on the row somebody is most likely watching.
	 */
	const [readings, setReadings] = useState<Record<string, Relay>>({});

	// The list arriving is the event here, not something the effect reads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the poll is the trigger, not the input
	useEffect(() => {
		setReadings((held) => (Object.keys(held).length === 0 ? held : {}));
	}, [value]);

	const relays = useMemo(() => {
		const list = arrange(value?.relays ?? [], arranged);

		return list.map((relay) => readings[relay.name] ?? relay);
	}, [value, arranged, readings]);

	const act = useCallback(
		async (name: string, run: () => Promise<unknown>) => {
			if (busy) return;

			setBusy(name);

			try {
				await run();
				await refresh();
			} catch (err) {
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(undefined);
			}
		},
		[busy, refresh],
	);

	/**
	 * Save an order once, when the row is let go of.
	 *
	 * Not through [act]: that marks the row busy and disables everything on it,
	 * which for a move somebody can already see the result of would be a row
	 * that greys out for no reason they could name. What it does share is the
	 * refresh, because the order is the server's to hold and this page's copy
	 * of it is a guess until it comes back.
	 */
	const settle = useCallback(
		async (order: string[]) => {
			setArranged(order);

			try {
				await api.reorderRelays(order);
				await refresh();
			} catch (err) {
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				// Only if it is still this drag's order. A second drag begun
				// before the first came back owns the list now, and clearing it
				// here would show the older order until the second save returned.
				setArranged((held) => (held === order ? undefined : held));
			}
		},
		[refresh],
	);

	const reorder = useReorder({ order: relays.map((relay) => relay.name), onSettle: settle });

	/**
	 * Measure one relay, because one row asked.
	 *
	 * This used to re-read the whole list, which measured all of them: pressing
	 * the button on the machine somebody had just restarted dialled every other
	 * machine as well, and the spinner on the row stopped when the slowest relay
	 * in the fleet answered rather than when this one did. On a fleet with
	 * anything genuinely down, that is the full timeout, every press, on a row
	 * that has nothing to do with the relay that is down.
	 */
	const recheck = useCallback(
		async (name: string) => {
			if (busy) return;

			setBusy(name);

			try {
				const reading = await api.checkRelay(name);
				setReadings((held) => ({ ...held, [name]: reading }));
			} catch (err) {
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(undefined);
			}
		},
		[busy],
	);

	if (error) return <Failed>{error}</Failed>;

	return (
		<div className="flex flex-col gap-4">
			<Card
				title={t("Relays")}
				note={t("Where calls are held. This machine serves the page and carries no media.")}
				actions={
					canModerate &&
					!adding &&
					script === undefined && (
						<div className="flex items-center gap-2">
							{/* Two ways in, because they are different situations. A machine
							    somebody is holding gets the script; one that is already
							    running somewhere gets its address typed in. */}
							<button
								type="button"
								onClick={async () => {
									try {
										// Both, in one press. The command is what gets
										// used and the script is what makes it readable
										// before it is run as root.
										const [text, ready] = await Promise.all([
											api.relayScript(),
											api.relayCommand(),
										]);
										setCommand(ready.command);
										setEnrolDomain(ready.domain);
										setEnrolPort(ready.port);
										setScript(text);
									} catch {
										actionFailed(t("This deployment cannot bring up relays from a script."));
									}
								}}
								className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi"
							>
								<Terminal className="size-3.5" />
								{t("Add a machine")}
							</button>

							<button
								type="button"
								onClick={() => setAdding(true)}
								className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi"
							>
								<Plus className="size-3.5" />
								{t("Add by address")}
							</button>
						</div>
					)
				}
			>
				{script !== undefined ? (
					<AddByScript
						script={script}
						command={command}
						domain={enrolDomain}
						port={enrolPort}
						onDone={() => {
							setScript(undefined);
							setCommand(undefined);
						}}
					/>
				) : adding ? (
					<AddRelay
						onDone={async () => {
							setAdding(false);
							await refresh();
						}}
						onCancel={() => setAdding(false)}
					/>
				) : relays.length === 0 ? (
					<p className="px-4 py-6 text-center text-fg-muted text-xs">
						{t("No relays yet. Calls cannot be held until one is added.")}
					</p>
				) : null}
			</Card>

			{/* Its own container, because the rows are measured through it and the
			    card above is not one of them. The spacing is the same as the
			    column it sits in, so nothing about the page moved to gain a
			    handle on the list. */}
			<div ref={reorder.list} className="flex flex-col gap-4">
				{relays.map((relay, index) => {
					const lifted = reorder.carrying === index;
					const offset = reorder.shift(index);

					return (
						<div
							key={relay.name}
							style={offset ? { transform: `translateY(${offset}px)` } : undefined}
							className={cn(
								"relative duration-200 ease-settle",
								// The rows standing aside slide; the row under the pointer
								// follows it exactly, and so transitions nothing. At the drop
								// neither does: the list reorders and the offsets come off in
								// the same frame, and a row easing out of an offset it no
								// longer has would be animating away from where it landed.
								lifted || reorder.carrying === undefined
									? "transition-[box-shadow]"
									: "transition-[transform,box-shadow]",
								// Written out rather than assembled from a size and a
								// colour: the palette here is nearly black, and the
								// default shadow is a tenth of an opacity that lands
								// on it as nothing at all.
								lifted && "z-10 shadow-[0_10px_30px_rgba(0,0,0,0.45)]",
							)}
						>
							<RelayRow
								// Which arrows to draw. The list is what the server sent, in
								// the order it sent it, so an end is an end.
								first={index === 0}
								last={index === relays.length - 1}
								onMove={(by) =>
									act(relay.name, () => {
										const order = relays.map((one) => one.name);
										const to = index + by;
										const moved = order[index];
										if (moved === undefined || to < 0 || to >= order.length)
											return Promise.resolve();

										order.splice(index, 1);
										order.splice(to, 0, moved);

										return api.reorderRelays(order);
									})
								}
								onTake={reorder.take(index)}
								lifted={lifted}
								relay={relay}
								canModerate={canModerate}
								busy={busy === relay.name}
								onToggle={() =>
									act(relay.name, () => api.editRelay(relay.name, { enabled: !relay.enabled }))
								}
								onDrop={() => act(relay.name, () => api.dropRelay(relay.name))}
								onEdit={(change) => act(relay.name, () => api.editRelay(relay.name, change))}
								onRecheck={() => recheck(relay.name)}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/**
 * The relays in the order somebody dragged them into, where that order still
 * describes this list.
 *
 * A relay added or removed while a save was in the air leaves an order naming
 * machines that have gone or missing one that has arrived, and laying the list
 * out from it would hide the new relay entirely — a row that is not drawn is a
 * machine nobody can turn off. The server's own order is the safe answer to
 * fall back to, and it is at most one poll away.
 */
function arrange(relays: Relay[], order?: string[]): Relay[] {
	if (!order) return relays;

	const by = new Map(relays.map((relay) => [relay.name, relay]));
	const chosen = order.map((name) => by.get(name)).filter((relay) => relay !== undefined);

	return chosen.length === relays.length ? chosen : relays;
}

function RelayRow({
	relay,
	canModerate,
	busy,
	onToggle,
	onDrop,
	onEdit,
	onMove,
	onTake,
	lifted,
	onRecheck,
	first,
	last,
}: {
	relay: Relay;
	canModerate: boolean;
	busy: boolean;
	onMove: (by: number) => void;
	/** Picks the row up. */
	onTake: (event: Pointing<HTMLElement>) => void;
	/** Whether this is the row being carried. */
	lifted: boolean;
	onRecheck: () => void;
	first: boolean;
	last: boolean;
	onToggle: () => void;
	onDrop: () => void;
	onEdit: (change: {
		name?: string;
		url?: string;
		region?: string;
		label?: string;
		fallback?: boolean;
	}) => void;
}) {
	const t = useT();

	const [confirming, setConfirming] = useState(false);

	// Shut by default. The settings are four fields and two switches and they
	// are read perhaps once in a machine's life, against a row that is looked at
	// whenever anybody wonders whether a relay is up — so leaving them open made
	// the page mostly forms and hid the one line anybody came for.
	const [showing, setShowing] = useState(false);

	// Held on screen while they leave. Rendered as `showing && ...` the form was
	// simply gone on the frame after the press, and a row that has just grown by
	// six fields collapsing between two frames reads as the page having redrawn
	// rather than as a panel being shut.
	const settings = useLingering(showing);
	const removal = useLingering(confirming);

	return (
		<Card title={say(relay.label || relay.name)} note={relay.label ? relay.name : relay.region}>
			<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
				{/* What the row is dragged by.
				    A handle rather than the whole row: the row is mostly buttons
				    and an address somebody selects to copy, and a press that might
				    be the start of a drag cannot also be a press on the thing
				    underneath it — one of the two has to lose, and on this row both
				    are things people do daily.

				    Arrow keys as well as a pointer. The buttons beside it are the
				    older way and stay, but a handle that only answers to a mouse is
				    a feature the keyboard lost the moment dragging arrived. */}
				{canModerate && (
					<button
						type="button"
						onPointerDown={onTake}
						onKeyDown={(event) => {
							if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

							// Or the panel scrolls under a row somebody is moving.
							event.preventDefault();
							onMove(event.key === "ArrowUp" ? -1 : 1);
						}}
						disabled={busy}
						aria-label={t("Drag to reorder")}
						title={t("Drag to reorder")}
						className={cn(
							// A finger on this must move the row and not the page, and
							// nothing but touch-action can say so: preventing the
							// default on a pointer event is too late, because by then
							// the browser has already decided the gesture is a scroll.
							"-ml-1.5 shrink-0 touch-none rounded-md p-1 text-fg-muted transition-colors",
							"hover:bg-surface-hi hover:text-fg disabled:opacity-40",
							lifted ? "cursor-grabbing text-fg" : "cursor-grab",
						)}
					>
						<GripVertical className="size-4" />
					</button>
				)}

				{/* First, because it is about the line it sits beside: the address
				    and what it answered in. The buttons on the right change the
				    relay; this one only asks it again. */}
				<button
					type="button"
					onClick={onRecheck}
					disabled={busy}
					aria-label={t("Measure again")}
					title={t("Measure again")}
					className="shrink-0 rounded-md border border-border p-1.5 text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg disabled:opacity-40"
				>
					<RotateCw className={cn("size-3.5", busy && "animate-spin")} />
				</button>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate readout text-[12px]">{relay.url}</span>

						{relay.fallback && (
							<span className="shrink-0 rounded bg-fg/10 px-1.5 py-0.5 text-[10.5px] text-fg-muted">
								{t("Keep in reserve")}
							</span>
						)}

						{relay.adminOnly && (
							<span className="shrink-0 rounded bg-fg/10 px-1.5 py-0.5 text-[10.5px] text-fg-muted">
								{t("Administrators only")}
							</span>
						)}

						{!relay.enabled && (
							<span className="shrink-0 rounded bg-tally/15 px-1.5 py-0.5 text-[11px] text-tally">
								{t("Not taking new calls")}
							</span>
						)}
					</div>

					{/*
					  * A light before the sentence, on the same bands the client's
					  * own picker uses. The dot that used to be here was painted a
					  * colour this palette does not have, so on every reachable
					  * relay it was an eight-pixel hole beside the address — which
					  * is what anybody would read it as.
					  */}
					<p className="mt-1 flex items-center gap-2 text-fg-muted text-xs">
						<span
							className={cn(
								"size-2 shrink-0 rounded-full",
								!relay.reachable
									? "bg-danger"
									: (relay.latencyMs ?? 0) <= 150
										? "bg-good"
										: (relay.latencyMs ?? 0) <= 400
											? "bg-tally"
											: "bg-danger",
							)}
							aria-hidden
						/>

						{relay.reachable
							? t("Answered in {ms} ms", { ms: relay.latencyMs ?? 0 })
							: relay.detail
								? t("Did not answer: {reason}", { reason: relay.detail })
								: t("Did not answer")}
					</p>
				</div>

				{canModerate && (
					<div className="flex shrink-0 items-center gap-2">

						{/* Order is not something this server can work out. Alphabetical
						    puts a reserve above the relay holding every call, and by-date
						    puts whichever machine was rebuilt last at the bottom. */}
						<div className="flex items-center">
							<button
								type="button"
								disabled={busy || first}
								onClick={() => onMove(-1)}
								aria-label={t("Move up")}
								className="rounded-l-md border border-border p-1.5 hover:bg-surface-hi disabled:opacity-30"
							>
								<ChevronUp className="size-3.5" />
							</button>
							<button
								type="button"
								disabled={busy || last}
								onClick={() => onMove(1)}
								aria-label={t("Move down")}
								className="-ml-px rounded-r-md border border-border p-1.5 hover:bg-surface-hi disabled:opacity-30"
							>
								<ChevronDown className="size-3.5" />
							</button>
						</div>

						<button
							type="button"
							onClick={onToggle}
							disabled={busy}
							className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi disabled:opacity-50"
						>
							{relay.enabled ? t("Stop sending here") : t("Send calls here")}
						</button>

						<button
							type="button"
							onClick={() => setShowing(!showing)}
							aria-expanded={showing}
							aria-label={t("Settings")}
							title={t("Settings")}
							className={cn(
								"rounded-md border border-border p-1.5 text-fg-muted transition-colors",
								"hover:bg-surface-hi hover:text-fg",
								showing && "bg-surface-hi text-fg",
							)}
						>
							<ChevronDown
								className={cn("size-3.5 transition-transform duration-200", showing && "rotate-180")}
							/>
						</button>

						{confirming ? (
							<div className="flex items-center gap-1">
								{/* Named rather than a bare tick, because removing a relay and
								    disabling one are a keystroke apart and only one of them is
								    reversible by somebody who did not write the address down. */}
								<button
									type="button"
									onClick={() => {
										setConfirming(false);
										onDrop();
									}}
									disabled={busy}
									className="flex items-center gap-1 rounded-md bg-danger px-2.5 py-1 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
								>
									<Check className="size-4" />
									{t("Remove")}
								</button>
								<button
									type="button"
									onClick={() => setConfirming(false)}
									className="rounded-md border border-border p-1.5 hover:bg-surface-hi"
									aria-label={t("Cancel")}
								>
									<X className="size-4" />
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setConfirming(true)}
								disabled={busy}
								className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-hi hover:text-danger disabled:opacity-50"
								aria-label={t("Remove relay")}
							>
								<Trash2 className="size-4" />
							</button>
						)}
					</div>
				)}
			</div>

			{canModerate && settings.mounted && (
				<div className={settings.leaving ? "animate-depart" : "animate-arrive"}>
					<Settings relay={relay} busy={busy} onSave={(change) => onEdit(change)} />
				</div>
			)}

			{removal.mounted && (
				<p
					className={cn(
						"px-4 pb-3 text-fg-muted text-xs",
						removal.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					{t(
						"Calls already on this relay keep running; this only stops new ones being sent there.",
					)}
				</p>
			)}
		</Card>
	);
}

/**
 * Everything about this relay that can be changed.
 *
 * All of it, including the name and the address. Neither used to be editable and
 * both needed to be: an address changes when a machine moves or its port does,
 * and a name is whatever somebody typed at a prompt on the night the machine was
 * built — usually before anybody knew what it would end up being for.
 *
 * The name is still the key, and changing it still costs something: a client
 * that measured the old one sends it at the next join and is quietly ignored,
 * falling back to wherever the room already is. That is one join with a wasted
 * measurement, which is a great deal cheaper than a deployment stuck with the
 * word "sh" forever.
 *
 * Saved together rather than field by field, because they are usually changed
 * together — a machine that moved has a new address and often a new name — and
 * because a form that saves on every keystroke is one that saves halfway
 * through a word.
 */
function Settings({
	relay,
	busy,
	onSave,
}: {
	relay: Relay;
	busy: boolean;
	onSave: (change: {
		name?: string;
		url?: string;
		region?: string;
		label?: string;
		probe?: string;
		turn?: string;
		forwards?: boolean;
		apart?: string[];
		bridge?: boolean;
		signalVia?: string;
		fallback?: boolean;
		adminOnly?: boolean;
	}) => void;
}) {
	const t = useT();

	const [name, setName] = useState(relay.name);
	const [url, setUrl] = useState(relay.url);
	const [region, setRegion] = useState(relay.region ?? "");
	const [label, setLabel] = useState(relay.label ?? "");
	const [probe, setProbe] = useState(relay.probe ?? "");
	const [turn, setTurn] = useState(relay.turn ?? "");
	const [apart, setApart] = useState((relay.apart ?? []).join(", "));
	const [via, setVia] = useState(relay.signalVia ?? "");

	// One field for two numbers, because they are one answer to one question and
	// nobody has a latitude without a longitude. Kept as the text somebody typed
	// until it is saved: parsing on every keystroke turns "51.5, -" into a
	// longitude of nothing and moves the machine to the meridian while they are
	// still typing.
	const [place, setPlace] = useState(placeOf(relay));

	// Reloaded when the relay changes underneath this form.
	//
	// It did not, and that lost work. The fields are filled once when the row is
	// drawn and this page polls every fifteen seconds, so a relay whose address
	// was changed elsewhere left a form still holding the old one — and saving a
	// rename wrote that old address back over the new one, silently, as a side
	// effect of editing a different field. Which is exactly how two relays ended
	// up pointing at hostnames again after being moved to their addresses.
	//
	// Keyed on what is saved rather than on the whole record, so a poll that
	// changed only the measured latency does not throw away half-typed text.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the record is the key, not the effect's input
	useEffect(() => {
		setName(relay.name);
		setUrl(relay.url);
		setRegion(relay.region ?? "");
		setLabel(relay.label ?? "");
		setProbe(relay.probe ?? "");
		setTurn(relay.turn ?? "");
		setApart((relay.apart ?? []).join(", "));
		setVia(relay.signalVia ?? "");
		setPlace(placeOf(relay));
	}, [
		relay.name,
		relay.url,
		relay.region,
		relay.label,
		relay.probe,
		relay.turn,
		relay.apart,
		relay.signalVia,
		relay.lat,
		relay.lon,
	]);

	const dirty =
		name !== relay.name ||
		url !== relay.url ||
		region !== (relay.region ?? "") ||
		label !== (relay.label ?? "") ||
		probe !== (relay.probe ?? "") ||
		turn !== (relay.turn ?? "") ||
		apart !== (relay.apart ?? []).join(", ") ||
		via !== (relay.signalVia ?? "") ||
		place !== placeOf(relay);

	return (
		<div className="flex flex-col gap-3 border-border border-t px-4 py-3">
			<div className="flex flex-wrap gap-3">
				<Field label={t("Name")} hint={t("How this deployment refers to it")}>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={64}
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Shown to people as")} hint={t("Left empty, the name is used")}>
					<input
						value={label}
						onChange={(event) => setLabel(event.target.value)}
						placeholder={relay.name}
						maxLength={64}
						className="w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>
			</div>

			<div className="flex flex-wrap gap-3">
				<Field label={t("Address")} hint={t("What a browser dials")} wide>
					<input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="wss://host:port"
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Measured at")} hint={t("host:port where it answers STUN. Empty means time the socket instead")}>
					<input
						value={probe}
						onChange={(event) => setProbe(event.target.value)}
						placeholder="host:39218"
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Forwards through")} hint={t("host:port of its TURN server. Empty means it cannot carry a call it is not holding")}>
					<input
						value={turn}
						onChange={(event) => setTurn(event.target.value)}
						placeholder="host:39219"
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Never forwards with")} hint={t("Relay names, comma separated. Applies in both directions")}>
					<input
						value={apart}
						onChange={(event) => setApart(event.target.value)}
						placeholder={t("None")}
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				{/* For a machine no TLS handshake reaches: its media stays here
				    and the signalling goes through the relay named. */}
				<Field
					label={t("Signals through")}
					hint={t("A relay name, for a machine no TLS reaches. Its media stays here")}
				>
					<input
						value={via}
						onChange={(event) => setVia(event.target.value)}
						placeholder={t("None")}
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field
					label={t("Where it is")}
					hint={t("Latitude, longitude. Puts it on the globe and lets the fleet judge distance")}
				>
					<input
						value={place}
						onChange={(event) => setPlace(event.target.value)}
						placeholder="22.32, 114.17"
						className="readout w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Region")} hint={t("Groups the picker. A slash nests: Oversea/Asia")}>
					<input
						value={region}
						onChange={(event) => setRegion(event.target.value)}
						maxLength={64}
						className="w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>
			</div>

			<div className="flex flex-wrap items-center gap-4">
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={relay.fallback ?? false}
						disabled={busy}
						onChange={(event) => onSave({ fallback: event.target.checked })}
						className="size-3.5 accent-tally"
					/>
					{t("Keep in reserve")}
				</label>

				{/* For a fleet with machines on both sides of a border. Somebody
				    who lands on a pair that carries nothing between them is sent
				    here instead of to the machine they picked — which is the one
				    way their call can go, rather than a direct connection across
				    the thing every relay here exists to avoid. */}
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={relay.bridge ?? false}
						disabled={busy}
						onChange={(event) => onSave({ bridge: event.target.checked })}
						className="size-3.5 accent-tally"
					/>
					{t("Stands in for pairs that cannot reach each other")}
				</label>

				{/* Its own switch, and deliberately not tied to any other.
				    A meeting lives on one machine, so somebody joining a room that
				    is already running has their media go past the relay they picked
				    unless this relay forwards it on. That costs the relay two bytes
				    for every one it carries, which is why it is a decision and not
				    a consequence: a machine reserved for administrators can still
				    be the right place to forward through, and a machine anybody may
				    use can be one whose bandwidth is too expensive to spend twice.
				    Whoever pays the bill decides, per machine. */}
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={relay.forwards ?? false}
						disabled={busy}
						onChange={(event) => onSave({ forwards: event.target.checked })}
						className="size-3.5 accent-tally"
					/>
					{t("Forwards other rooms")}
				</label>

				{/* Distinct from taking it out of service, and from keeping it in
				    reserve: those are about when to use it, this is about who may.
				    Refused at the join as well as hidden from the list, or somebody
				    who read the name off a colleague's screen could ask for it. */}
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={relay.adminOnly ?? false}
						disabled={busy}
						onChange={(event) => onSave({ adminOnly: event.target.checked })}
						className="size-3.5 accent-tally"
					/>
					{t("Administrators only")}
				</label>

				<button
					type="button"
					disabled={busy || !dirty}
					onClick={() =>
						onSave({
							name,
							url,
							region,
							label,
							probe,
							turn,
							apart: apart
								.split(",")
								.map((one) => one.trim())
								.filter(Boolean),
							signalVia: via.trim(),
							...degrees(place),
						})
					}
					className="ml-auto rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{t("Save")}
				</button>
			</div>
		</div>
	);
}

function Field({
	label,
	hint,
	wide,
	children,
}: {
	label: string;
	hint: string;
	wide?: boolean;
	children: React.ReactNode;
}) {
	return (
		<label className={cn("flex flex-col gap-1", wide ? "min-w-64 flex-[2]" : "min-w-40 flex-1")}>
			<span className="text-fg-muted text-[11px]">{label}</span>
			{children}
			<span className="text-fg-muted/70 text-[10.5px]">{hint}</span>
		</label>
	);
}

function AddRelay({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
	const t = useT();

	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [region, setRegion] = useState("");
	const [saving, setSaving] = useState(false);

	const submit = useCallback(async () => {
		if (saving) return;

		setSaving(true);

		try {
			await api.addRelay({
				name: name.trim(),
				url: url.trim(),
				region: region.trim() || undefined,
			});
			onDone();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [name, url, region, saving, onDone]);

	return (
		<form
			className="flex flex-col gap-3 px-4 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="grid gap-3 sm:grid-cols-3">
				<label className="flex flex-col gap-1">
					<span className="text-fg-muted text-xs">{t("Name")}</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="tokyo"
						required
						className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm"
					/>
				</label>

				<label className="flex flex-col gap-1 sm:col-span-2">
					<span className="text-fg-muted text-xs">{t("Address")}</span>
					<input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="wss://tokyo.example.com"
						required
						className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm"
					/>
				</label>
			</div>

			<label className="flex flex-col gap-1">
				<span className="text-fg-muted text-xs">{t("Region (optional)")}</span>
				<input
					value={region}
					onChange={(event) => setRegion(event.target.value)}
					placeholder="jp"
					className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm sm:max-w-48"
				/>
			</label>

			<p className="text-fg-muted text-xs">
				{t("The address a browser dials. It must begin ws:// or wss://, and the relay must be running with role: relay.")}
			</p>

			<div className="flex gap-2">
				<button
					type="submit"
					disabled={saving || !name.trim() || !url.trim()}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi disabled:opacity-50"
				>
					{saving && <Loader2 className="size-4 animate-spin" />}
					{t("Add relay")}
				</button>

				<button
					type="button"
					onClick={onCancel}
					className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi"
				>
					{t("Cancel")}
				</button>
			</div>
		</form>
	);
}

/**
 * The one line, laid out to be copied rather than read.
 *
 * Wrapped rather than scrolled sideways: a command that runs off the edge gets
 * copied in half by anybody selecting it by hand, and the half that goes missing
 * is the end, which is where the secret is.
 */
function Command({ command }: { command: string }) {
	const t = useT();

	const [copied, setCopied] = useState(false);

	return (
		<div className="relative">
			<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-hi p-3 pr-20 text-[11.5px] leading-relaxed">
				<code>{command}</code>
			</pre>

			<button
				type="button"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(command);
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					} catch {
						actionFailed(t("Could not copy. Select the text and copy it."));
					}
				}}
				className="absolute top-2 right-2 flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] hover:bg-surface-hi"
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
				{copied ? t("Copied") : t("Copy")}
			</button>
		</div>
	);
}

/**
 * The script that brings a machine up as a relay.
 *
 * Shown rather than run: this is somebody else's machine, and the only thing
 * this server can do about it is hand over the instructions. What comes back
 * afterwards is the relay appearing in the list above, which is how anybody
 * knows it worked.
 *
 * The warning is not decoration. The script carries the enrolment secret, and
 * that secret buys the credential every relay in this deployment signs with.
 */
function AddByScript({
	script,
	command,
	domain,
	port,
	onDone,
}: { script: string; command?: string; domain?: string; port?: number; onDone: () => void }) {
	const t = useT();

	const [copied, setCopied] = useState(false);

	return (
		<div className="flex flex-col gap-3 px-4 py-3">
			<p className="text-fg-muted text-xs">
				{t("Run this on the new machine as root. Replace <prefix> with the name it should answer to. It does the rest: fetches the binary, takes this deployment's certificate and credentials, points a name at the machine, and starts the relay.")}
			</p>

			{command && <Command command={command} />}

			{/* What the machine will be called and what has to be open on it.
			    The server has always sent both and this drew neither, so an
			    operator ran the line and then found out which name it had taken
			    by reading the DNS, and which port to open by a call failing. A
			    provider's security group is not something to be discovering
			    afterwards. */}
			{(domain || port) && (
				<p className="text-fg-muted text-xs leading-relaxed">
					{domain && (
						<>
							{t("It becomes")} <span className="readout text-fg">{`<prefix>.${domain}`}</span>
							{". "}
						</>
					)}
					{port ? (
						<>
							{t("Open these on the machine:")}{" "}
							<span className="readout text-fg">{`tcp/${port}`}</span>
							{t(", and the UDP media port.")}
						</>
					) : null}
				</p>
			)}

			<p className="text-fg-muted text-xs">
				{t("What that runs, in full. Worth reading before running anything as root.")}
			</p>

			<div className="relative">
				<pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-hi p-3 text-[11px] leading-relaxed">
					<code>{script}</code>
				</pre>

				<button
					type="button"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(script);
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						} catch {
							actionFailed(t("Could not copy. Select the text and copy it."));
						}
					}}
					className="absolute top-2 right-2 flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] hover:bg-surface-hi"
				>
					{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
					{copied ? t("Copied") : t("Copy")}
				</button>
			</div>

			<p className="rounded-md border border-tally/40 bg-tally/10 px-3 py-2 text-[11px] text-tally">
				{t("This script carries the key to this deployment. Anybody who has it can add a relay, so do not put it anywhere it will be kept.")}
			</p>

			<div>
				<button
					type="button"
					onClick={onDone}
					className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi"
				>
					{t("Done")}
				</button>
			</div>
		</div>
	);
}

/** A relay's place, as the field shows it. */
function placeOf(relay: Relay): string {
	if (relay.lat === undefined || relay.lon === undefined) return "";

	return `${relay.lat}, ${relay.lon}`;
}

/**
 * What to send for a place somebody typed.
 *
 * Nothing at all where it cannot be read, rather than zeroes: nought and nought
 * is a point in the Atlantic, and a relay drawn confidently in the sea looks
 * exactly as authoritative as the ones that are right. An empty field is how a
 * machine is taken off the globe, so that has to reach the server as a pair of
 * zeroes, which is what the store treats as unplaced.
 */
function degrees(said: string): { lat?: number; lon?: number } {
	const trimmed = said.trim();
	if (trimmed === "") return { lat: 0, lon: 0 };

	const parts = trimmed.split(",");
	if (parts.length !== 2) return {};

	const lat = Number(parts[0]);
	const lon = Number(parts[1]);

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return {};
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return {};

	return { lat, lon };
}
