import { useT } from "@/hooks/useT";
import { Button } from "@/components/ui/button";
import { Flagged } from "@/components/room/Flag";
import { useLingering } from "@/hooks/useLingering";
import { useReorder } from "@/hooks/useReorder";
import { cn } from "@/lib/utils";
import { say } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Copy,
	Eye,
	EyeOff,
	GripVertical,
	Loader2,
	Plus,
	RotateCw,
	Terminal,
	Trash2,
} from "lucide-react";
import { type PointerEvent as Pointing, useCallback, useEffect, useMemo, useState } from "react";
import { type Relay, api } from "./api";
import { Box, Hint } from "./Boxes";
import { Group, Section, field, quiet, quietIcon } from "./Grouped";
import { reason } from "./health";
import { usePoll } from "./poll";
import { Sheet } from "./Sheet";
import { Failed } from "./Shell";

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
 *
 * Redrawn (2026-10-29) as one group of rows, each saying first whether the
 * machine answered and what it is for, with everything that can be changed
 * about it in a sheet the row opens. It was a card per relay with seven
 * bordered controls on every row and a form that unfolded under it, so the
 * page was mostly controls for the one question it is opened to answer. Adding
 * a machine is a sheet of numbered steps, because it is one: run a line on the
 * new machine, open what it says, and watch it arrive here. The first step is
 * making the one-time token the machine enrols with.
 */
export function RelaysPanel({
	canRelays,
	canEnrol = false,
	onSignedOut,
}: {
	/** May add, edit, order and remove relays, and hand out the install line. */
	canRelays: boolean;
	/**
	 * May mint the token a new machine enrols with, which buys the deployment's
	 * key pair, its redis password and the certificate's key: moderate's, not
	 * the relays capability's.
	 */
	canEnrol?: boolean;
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

	const [adding, setAdding] = useState<"script" | "address">();
	const [opened, setOpened] = useState<string>();
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

	const move = (index: number, by: number) =>
		act(relays[index]?.name ?? "", () => {
			const order = relays.map((one) => one.name);
			const to = index + by;
			const moved = order[index];
			if (moved === undefined || to < 0 || to >= order.length) return Promise.resolve();

			order.splice(index, 1);
			order.splice(to, 0, moved);

			return api.reorderRelays(order);
		});

	const down = relays.filter((relay) => relay.enabled && !relay.reachable).length;

	if (error) return <Failed>{error}</Failed>;

	return (
		<div className="mx-auto flex max-w-[1180px] flex-col gap-6">
			<header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="font-semibold text-[22px] leading-tight tracking-[-0.01em]">{t("Relays")}</h1>
					<p className="max-w-[60ch] text-[13.5px] text-fg-muted">
						{t("Where calls are held. This machine serves the page and carries no media.")}
					</p>
				</div>

				{canModerate && (
					<div className="ml-auto flex flex-wrap items-center gap-2">
						{/* Two ways in, because they are different situations. A machine
						    somebody is holding gets the script; one that is already
						    running somewhere gets its address typed in. */}
						<Button variant="primary" size="sm" onClick={() => setAdding("script")}>
							<Terminal />
							{t("Add a machine")}
						</Button>
						<Button variant="secondary" size="sm" onClick={() => setAdding("address")}>
							<Plus />
							{t("Add by address")}
						</Button>
					</div>
				)}
			</header>

			<Section
				title={t("In service")}
				note={
					value === undefined
						? undefined
						: down > 0
							? t("{down} of {count} relays are not answering", { down, count: relays.length })
							: t("{count} configured", { count: relays.length })
				}
			>
				<Group>
					{value !== undefined && relays.length === 0 && (
						<p className="animate-fade-in px-4 py-5 text-fg-muted text-[13.5px]">
							{t("No relays yet. Calls cannot be held until one is added.")}
						</p>
					)}

					{/* Its own container, because the rows are measured through it
					    and nothing else may be among its children. */}
					<div ref={reorder.list}>
						{relays.map((relay, index) => {
							const lifted = reorder.carrying === index;
							const offset = reorder.shift(index);

							return (
								<div
									key={relay.name}
									style={offset ? { transform: `translateY(${offset}px)` } : undefined}
									className={cn(
										"relative bg-surface duration-200 ease-settle",
										"before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border first:before:hidden",
										index === 0 && "rounded-t-[14px]",
										index === relays.length - 1 && "rounded-b-[14px]",
										// The rows standing aside slide; the row under the pointer
										// follows it exactly, and so transitions nothing.
										lifted || reorder.carrying === undefined
											? "transition-[box-shadow]"
											: "transition-[transform,box-shadow]",
										lifted && "z-10 rounded-[14px] shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
									)}
								>
									<RelayRow
										relay={relay}
										canModerate={canModerate}
										busy={busy === relay.name}
										lifted={lifted}
										onTake={reorder.take(index)}
										onMove={(by) => move(index, by)}
										onRecheck={() => recheck(relay.name)}
										onOpen={() => setOpened(relay.name)}
									/>
								</div>
							);
						})}
					</div>
				</Group>
				<p className="px-1 text-[12px] text-fg-muted leading-relaxed">
					{t("Clients are offered these in this order, nearest first among the ones that answer. Drag a row by its handle, or use the arrow keys on it, to change the order.")}
				</p>
			</Section>

			{relays.map((relay, index) => (
				<Sheet
					key={relay.name}
					open={opened === relay.name}
					title={t("Relay")}
					label={say(relay.label || relay.name)}
					onClose={() => setOpened(undefined)}
				>
					<RelayDetail
						relay={relay}
						canModerate={canModerate}
						busy={busy === relay.name}
						first={index === 0}
						last={index === relays.length - 1}
						onMove={(by) => move(index, by)}
						onRecheck={() => recheck(relay.name)}
						onToggle={() => act(relay.name, () => api.editRelay(relay.name, { enabled: !relay.enabled }))}
						onDrop={() => {
							setOpened(undefined);
							void act(relay.name, () => api.dropRelay(relay.name));
						}}
						onEdit={(change) => act(relay.name, () => api.editRelay(relay.name, change))}
					/>
				</Sheet>
			))}

			<Sheet open={adding === "script"} title={t("Add a machine")} onClose={() => setAdding(undefined)}>
				<AddByScript open={adding === "script"} canEnrol={canEnrol} onDone={() => setAdding(undefined)} />
			</Sheet>

			<Sheet open={adding === "address"} title={t("Add by address")} onClose={() => setAdding(undefined)}>
				<AddRelay
					onDone={async () => {
						setAdding(undefined);
						await refresh();
					}}
					onCancel={() => setAdding(undefined)}
				/>
			</Sheet>
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

/** A relay's light, on the same bands the client's own picker uses. */
function light(relay: Relay): string {
	if (!relay.reachable) return "bg-danger";
	if (!relay.enabled) return "bg-fg-muted/50";

	const ms = relay.latencyMs ?? 0;
	return ms <= 150 ? "bg-good" : ms <= 400 ? "bg-tally" : "bg-danger";
}

/**
 * What a relay is for, as the short words a row carries.
 *
 * Only the ones that make it unlike an ordinary relay; an ordinary relay carries
 * none, so a row with a word on it is a row worth reading.
 */
function Roles({ relay }: { relay: Relay }) {
	const t = useT();

	const words: { text: string; tone?: "tally" | "danger" }[] = [];
	if (!relay.enabled) words.push({ text: t("Not taking new calls"), tone: "tally" });
	// Offered to nobody, and the only sign otherwise would be that nobody lands
	// there: a relay that signals through another while no relay signalling for
	// itself answers (sent by servers that know it).
	if (relay.unavailable === "no_signalling") words.push({ text: t("Offered to nobody"), tone: "danger" });
	// A relay that signals through another is one no TLS reaches, and a client
	// measures a relay with no probe address by opening TLS to it. The server
	// refuses that combination now; one saved before it did is named here.
	if (relay.signalVia && !relay.probe) words.push({ text: t("Needs a probe address"), tone: "danger" });
	if (relay.fallback) words.push({ text: t("Keep in reserve") });
	if (relay.adminOnly) words.push({ text: t("Administrators only") });
	if (relay.owners?.length) words.push({ text: t("Only for {names}", { names: relay.owners.join(", ") }) });
	if (relay.forwards) words.push({ text: t("Forwards other rooms") });
	if (relay.bridge) words.push({ text: t("Bridge") });
	if (relay.signalVia) words.push({ text: t("Signals through {relay}", { relay: relay.signalVia }) });

	if (words.length === 0) return null;

	return (
		<span className="flex flex-wrap gap-1">
			{words.map((word) => (
				<span
					key={word.text}
					className={cn(
						"rounded-full px-2 py-px text-[11.5px]",
						word.tone === "tally"
							? "bg-tally/15 text-tally-ink"
							: word.tone === "danger"
								? "bg-danger/15 text-danger-ink day:bg-danger/8"
								: "bg-surface-hi text-fg-muted",
					)}
				>
					{word.text}
				</span>
			))}
		</span>
	);
}

/** What the relay said when it was last asked, in a sentence. */
function Answer({ relay }: { relay: Relay }) {
	const t = useT();

	return (
		<span className="flex items-center gap-2 text-[12.5px] text-fg-muted">
			<span className={cn("size-2 shrink-0 rounded-full transition-colors", light(relay))} aria-hidden />
			{relay.reachable ? (
				t("Answered in {ms} ms", { ms: relay.latencyMs ?? 0 })
			) : (
				<span className="flex min-w-0 flex-col">
					<span className="text-danger-ink">{relay.detail ? reason(relay.detail) : t("Did not answer")}</span>
					{/* The machine's own words under the plain ones, on the row and
					    not only in its sheet, as the row said them before the
					    redesign: they are the difference between a refused
					    connection and an expired certificate. */}
					{relay.detail && (
						<span className="readout truncate text-[11.5px]" title={relay.detail}>
							{relay.detail}
						</span>
					)}
				</span>
			)}
		</span>
	);
}

function RelayRow({
	relay,
	canModerate,
	busy,
	lifted,
	onTake,
	onMove,
	onRecheck,
	onOpen,
}: {
	relay: Relay;
	canModerate: boolean;
	busy: boolean;
	lifted: boolean;
	onTake: (event: Pointing<HTMLElement>) => void;
	onMove: (by: number) => void;
	onRecheck: () => void;
	onOpen: () => void;
}) {
	const t = useT();

	return (
		<div className="flex items-start gap-2 py-3 pr-2 pl-2 sm:pr-3">
			{/* What the row is dragged by. A handle rather than the whole row: the
			    row opens the relay, and a press that might be the start of a drag
			    cannot also be a press on the thing underneath it. Arrow keys as
			    well as a pointer, so the keyboard did not lose ordering the
			    moment dragging arrived. */}
			{canModerate ? (
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
						// nothing but touch-action can say so.
						quietIcon,
						"touch-none",
						lifted ? "cursor-grabbing text-fg" : "cursor-grab",
					)}
				>
					<GripVertical />
				</button>
			) : (
				<span className="w-2" />
			)}

			<div className="relative flex min-w-0 flex-1 flex-col gap-1 pt-1">
				{/* The whole of this part opens the relay, through one button
				    stretched over it. */}
				<button
					type="button"
					onClick={onOpen}
					aria-haspopup="dialog"
					className={cn(
						"min-w-0 truncate text-left text-[14.5px] outline-none",
						"after:absolute after:inset-0 after:rounded-[10px] focus-visible:after:ring-2 focus-visible:after:ring-fg/70",
					)}
				>
					<Flagged text={say(relay.label || relay.name)} />
					{relay.label && <span className="readout ml-2 text-[12px] text-fg-muted">{relay.name}</span>}
					{relay.region && <span className="ml-2 text-[12px] text-fg-muted">{say(relay.region)}</span>}
				</button>
				<span className="readout truncate text-[12px] text-fg-muted">{relay.url}</span>
				<Answer relay={relay} />
				<Roles relay={relay} />
			</div>

			{/* First on the right, because it is about the line beside it. The
			    sheet changes the relay; this only asks it again. */}
			<button
				type="button"
				onClick={onRecheck}
				disabled={busy}
				aria-label={t("Measure again")}
				title={t("Measure again")}
				className={cn(quietIcon, "relative z-10 mt-0.5")}
			>
				<RotateCw className={cn(busy && "animate-spin")} />
			</button>

			<ChevronRight className="mt-2 size-4 shrink-0 text-fg-muted" aria-hidden />
		</div>
	);
}

/** Everything about one relay, in its sheet. */
function RelayDetail({
	relay,
	canModerate,
	busy,
	first,
	last,
	onMove,
	onRecheck,
	onToggle,
	onDrop,
	onEdit,
}: {
	relay: Relay;
	canModerate: boolean;
	busy: boolean;
	first: boolean;
	last: boolean;
	onMove: (by: number) => void;
	onRecheck: () => void;
	onToggle: () => void;
	onDrop: () => void;
	onEdit: (change: Change) => void;
}) {
	const t = useT();

	const [confirming, setConfirming] = useState(false);
	const removal = useLingering(confirming, 160);

	return (
		<div className="flex flex-col gap-7">
			<div className="flex flex-col gap-1.5">
				<p className="font-semibold text-[22px] leading-tight">
					<Flagged text={say(relay.label || relay.name)} />
				</p>
				<p className="readout break-all text-[12.5px] text-fg-muted">{relay.url}</p>
				<Answer relay={relay} />
				<Roles relay={relay} />
				{/* The two states a row can only name, said in full where there is
				    room: a relay offered to nobody, and one clients would measure by
				    opening TLS to it. */}
				{relay.unavailable === "no_signalling" && (
					<p className="text-[12.5px] text-danger-ink leading-relaxed">
						{t("Offered to nobody: no relay that signals for itself is answering to carry its signalling, and clients never connect to it directly.")}
					</p>
				)}
				{relay.signalVia && !relay.probe && (
					<p className="text-[12.5px] text-danger-ink leading-relaxed">
						{t("Signals through another relay and has no probe address, so clients measure it by opening TLS to it. Set where it is measured.")}
					</p>
				)}
				<div className="mt-1 flex flex-wrap gap-2">
					<Button variant="secondary" size="sm" onClick={onRecheck} disabled={busy}>
						<RotateCw className={cn(busy && "animate-spin")} />
						{t("Measure again")}
					</Button>
				</div>
			</div>

			{canModerate && (
				<Section title={t("Taking calls")}>
					<Group>
						<div className="flex flex-col gap-2 px-4 py-3">
							<Box
								label={t("Send calls here")}
								checked={relay.enabled}
								disabled={busy}
								saving={busy}
								onChange={onToggle}
							/>
							<p className="pl-7 text-[12px] text-fg-muted leading-relaxed">
								{t("Calls already on this relay keep running; this only stops new ones being sent there.")}
							</p>
						</div>
						<div className="flex items-center gap-2 border-border border-t px-4 py-2.5">
							<span className="mr-auto text-[13.5px]">{t("Order")}</span>
							<button type="button" disabled={busy || first} onClick={() => onMove(-1)} className={quiet}>
								<ChevronUp />
								{t("Move up")}
							</button>
							<button type="button" disabled={busy || last} onClick={() => onMove(1)} className={quiet}>
								<ChevronDown />
								{t("Move down")}
							</button>
						</div>
					</Group>
				</Section>
			)}

			{canModerate && <Settings relay={relay} busy={busy} onSave={onEdit} />}

			{canModerate && (
				<Section title={t("Remove relay")}>
					<Group>
						<div className="flex flex-col gap-2 px-4 py-3">
							<p className="text-[12.5px] text-fg-muted leading-relaxed">
								{t("Removing forgets the machine here. Calls on it keep running until they end, and nobody is sent there again.")}
							</p>
							{removal.mounted ? (
								<div className={cn("flex flex-wrap items-center gap-2", removal.leaving ? "animate-fade-out" : "animate-fade-in")}>
									{/* Named rather than a bare tick, because removing a relay and
									    disabling one are a keystroke apart and only one of them is
									    reversible by somebody who did not write the address down. */}
									<Button variant="danger" size="sm" onClick={onDrop} disabled={busy}>
										<Trash2 />
										{t("Remove")}
									</Button>
									<Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
										{t("Cancel")}
									</Button>
								</div>
							) : (
								<Button
									variant="secondary"
									size="sm"
									className="self-start text-danger-ink"
									onClick={() => setConfirming(true)}
									disabled={busy}
								>
									<Trash2 />
									{t("Remove relay")}
								</Button>
							)}
						</div>
					</Group>
				</Section>
			)}
		</div>
	);
}

type Change = {
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
	lat?: number;
	lon?: number;
};

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
 * The words are saved together rather than field by field, because they are
 * usually changed together — a machine that moved has a new address and often
 * a new name — and because a form that saves on every keystroke is one that
 * saves halfway through a word. The switches save as they are pressed.
 */
function Settings({
	relay,
	busy,
	onSave,
}: {
	relay: Relay;
	busy: boolean;
	onSave: (change: Change) => void;
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
		<>
			<Section title={t("What it is called")}>
				<Group>
					<Field label={t("Name")} hint={t("How this deployment refers to it")}>
						<input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} className={cn(field, "readout")} />
					</Field>

					<Field label={t("Shown to people as")} hint={t("Left empty, the name is used")}>
						<input
							value={label}
							onChange={(event) => setLabel(event.target.value)}
							placeholder={relay.name}
							maxLength={64}
							className={field}
						/>
					</Field>

					<Field label={t("Region")} hint={t("Groups the picker. A slash nests: Oversea/Asia")}>
						<input value={region} onChange={(event) => setRegion(event.target.value)} maxLength={64} className={field} />
					</Field>

					<Field label={t("Where it is")} hint={t("Latitude, longitude. Puts it on the globe and lets the fleet judge distance")}>
						<input
							value={place}
							onChange={(event) => setPlace(event.target.value)}
							placeholder="22.32, 114.17"
							className={cn(field, "readout")}
						/>
					</Field>
				</Group>
			</Section>

			<Section title={t("How it is reached")}>
				<Group>
					<Field label={t("Address")} hint={t("What a browser dials")}>
						<input
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="wss://host:port"
							className={cn(field, "readout")}
						/>
					</Field>

					<Field label={t("Measured at")} hint={t("host:port where it answers STUN. Empty means time the socket instead")}>
						<input
							value={probe}
							onChange={(event) => setProbe(event.target.value)}
							placeholder="host:39218"
							className={cn(field, "readout")}
						/>
					</Field>

					<Field label={t("Forwards through")} hint={t("host:port of its TURN server. Empty means it cannot carry a call it is not holding")}>
						<input
							value={turn}
							onChange={(event) => setTurn(event.target.value)}
							placeholder="host:39219"
							className={cn(field, "readout")}
						/>
					</Field>

					{/* For a machine no TLS handshake reaches: its media stays here
					    and the signalling goes through the relay named. */}
					<Field label={t("Signals through")} hint={t("A relay name, for a machine no TLS reaches. Its media stays here")}>
						<input
							value={via}
							onChange={(event) => setVia(event.target.value)}
							placeholder={t("None")}
							className={cn(field, "readout")}
						/>
					</Field>

					<Field label={t("Never forwards with")} hint={t("Relay names, comma separated. Applies in both directions")}>
						<input
							value={apart}
							onChange={(event) => setApart(event.target.value)}
							placeholder={t("None")}
							className={cn(field, "readout")}
						/>
					</Field>

					<div className="flex justify-end border-border border-t px-4 py-3">
						<Button
							variant="primary"
							size="sm"
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
						>
							{busy && <Loader2 className="animate-spin" />}
							{t("Save")}
						</Button>
					</div>
				</Group>
			</Section>

			<Section title={t("What it is for")}>
				<Group>
					<div className="flex flex-col gap-1 px-4 py-3">
						<Box
							label={t("Keep in reserve")}
							checked={relay.fallback ?? false}
							disabled={busy}
							onChange={(on) => onSave({ fallback: on })}
						/>

						{/* For a fleet with machines on both sides of a border. Somebody
						    who lands on a pair that carries nothing between them is sent
						    here instead of to the machine they picked — which is the one
						    way their call can go, rather than a direct connection across
						    the thing every relay here exists to avoid. */}
						<Box
							label={t("Stands in for pairs that cannot reach each other")}
							checked={relay.bridge ?? false}
							disabled={busy}
							onChange={(on) => onSave({ bridge: on })}
						/>

						{/* Its own switch, and deliberately not tied to any other. A
						    meeting lives on one machine, so somebody joining a room that
						    is already running has their media go past the relay they
						    picked unless this relay forwards it on. That costs the relay
						    two bytes for every one it carries, which is why it is a
						    decision and not a consequence. Whoever pays the bill
						    decides, per machine. */}
						<Box
							label={t("Forwards other rooms")}
							checked={relay.forwards ?? false}
							disabled={busy}
							onChange={(on) => onSave({ forwards: on })}
						/>

						{/* Distinct from taking it out of service, and from keeping it
						    in reserve: those are about when to use it, this is about who
						    may. Refused at the join as well as hidden from the list. */}
						<Box
							label={t("Administrators only")}
							checked={relay.adminOnly ?? false}
							disabled={busy || ((relay.owners?.length ?? 0) > 0 && !relay.adminOnly)}
							onChange={(on) => onSave({ adminOnly: on })}
						>
							{/* Somebody's own cannot also be kept for administrators,
							    and the server refuses it; said here so the box does not
							    look broken. */}
							<Hint show={(relay.owners?.length ?? 0) > 0}>
								{t("Only for {names}, which is set on their accounts, so it cannot also be kept for administrators.", { names: (relay.owners ?? []).join(", ") })}
							</Hint>
						</Box>
					</div>
				</Group>
			</Section>
		</>
	);
}

/** One field in a group: the label above, the hint under it. */
function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
	return (
		<label className="relative flex flex-col gap-1.5 px-4 py-3 before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border first:before:hidden">
			<span className="text-[12.5px] text-fg-muted">{label}</span>
			{children}
			<span className="text-[12px] text-fg-muted leading-relaxed">{hint}</span>
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
			className="flex flex-col gap-5"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<p className="text-[13.5px] text-fg-muted leading-relaxed">
				{t("The address a browser dials. It must begin ws:// or wss://, and the relay must be running with role: relay.")}
			</p>

			<Group>
				<Field label={t("Name")} hint={t("How this deployment refers to it")}>
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder="tokyo" required className={cn(field, "readout")} />
				</Field>
				<Field label={t("Address")} hint={t("What a browser dials")}>
					<input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="wss://tokyo.example.com"
						required
						className={cn(field, "readout")}
					/>
				</Field>
				<Field label={t("Region (optional)")} hint={t("Groups the picker. A slash nests: Oversea/Asia")}>
					<input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="jp" className={field} />
				</Field>
			</Group>

			<div className="flex gap-2">
				<Button type="submit" variant="primary" size="sm" disabled={saving || !name.trim() || !url.trim()}>
					{saving && <Loader2 className="animate-spin" />}
					{t("Add relay")}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					{t("Cancel")}
				</Button>
			</div>
		</form>
	);
}

/**
 * The one line, laid out to be copied rather than read.
 *
 * Wrapped rather than scrolled sideways: a command that runs off the edge gets
 * copied in half by anybody selecting it by hand, and the half that goes missing
 * is the end, which is where the secret is. Drawn with that last word hidden
 * until asked for, because the line is read on a screen somebody else may be
 * looking at, and copied whole whether it is shown or not.
 */
function Command({ command, secret }: { command: string; secret?: boolean }) {
	const t = useT();

	const [copied, setCopied] = useState(false);
	const [shown, setShown] = useState(false);

	const words = command.split(" ");
	const drawn =
		secret && !shown ? (words.length > 1 ? [...words.slice(0, -1), "••••••••"].join(" ") : "••••••••") : command;

	return (
		<div className="flex flex-col gap-2">
			<pre className="readout overflow-x-auto whitespace-pre-wrap break-all rounded-[12px] border border-border bg-bg p-3 text-[12.5px] leading-relaxed">
				<code>{drawn}</code>
			</pre>

			<div className="flex flex-wrap gap-2">
				<Button
					variant="secondary"
					size="sm"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(command);
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						} catch {
							actionFailed(t("Could not copy. Select the text and copy it."));
						}
					}}
				>
					{copied ? <Check /> : <Copy />}
					{copied ? t("Copied") : t("Copy")}
				</Button>
				{secret && (
					<button type="button" onClick={() => setShown((was) => !was)} aria-pressed={shown} className={quiet}>
						{shown ? <EyeOff /> : <Eye />}
						{shown ? t("Hide the secret") : t("Show the secret")}
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * Bringing a new machine up as a relay, as the steps it is.
 *
 * Shown rather than run: this is somebody else's machine, and the only thing
 * this server can do about it is hand over the instructions. What comes back
 * afterwards is the relay appearing in the list, which is how anybody knows it
 * worked.
 *
 * The first step is the token. What a machine enrols with is minted here for
 * its one prefix, works once and for half an hour, and is pasted into the
 * script when it asks — never typed into the command, which is what a shell
 * keeps. The long-lived secret this replaced sat in the history of every relay
 * ever brought up. Only an administrator who can manage everything mints one,
 * because what it buys is the deployment's key pair; anybody else with the
 * relays is told so, and still sees the line and what it runs.
 */
function AddByScript({ open, canEnrol, onDone }: { open: boolean; canEnrol: boolean; onDone: () => void }) {
	const t = useT();

	const [ready, setReady] = useState<{ script: string; command: string; domain?: string; port?: number }>();
	const [refused, setRefused] = useState(false);
	const [reading, setReading] = useState(false);
	const [minted, setMinted] = useState<{ token: string; command: string; expires: string }>();
	const script = useLingering(reading, 180);

	useEffect(() => {
		if (!open) return;

		let live = true;
		setMinted(undefined);

		void (async () => {
			try {
				// Both, in one press. The command is what gets used and the
				// script is what makes it readable before it is run as root.
				const [text, line] = await Promise.all([api.relayScript(), api.relayCommand()]);
				if (live) setReady({ script: text, command: line.command, domain: line.domain, port: line.port });
			} catch {
				if (live) setRefused(true);
			}
		})();

		return () => {
			live = false;
		};
	}, [open]);

	if (refused) {
		return (
			<p className="text-[13.5px] text-fg-muted leading-relaxed">
				{t("This deployment cannot bring up relays from a script.")}{" "}
				{t("Set meet.enrol in the configuration file to turn it on, or add a running relay by its address.")}
			</p>
		);
	}

	if (!ready) return <span className="block h-40" aria-hidden />;

	return (
		<div className="flex animate-fade-in flex-col gap-6">
			<Step number={1} title={t("Make a token")}>
				{canEnrol ? (
					<MintToken onMinted={setMinted} />
				) : (
					<p className="text-[13px] text-fg-muted leading-relaxed">
						{t("The machine needs a token to enrol, and only an administrator who can manage everything can make one.")}
					</p>
				)}
				{minted && (
					<div className="flex animate-arrive flex-col gap-2">
						<p className="text-[13px] text-fg-muted leading-relaxed">
							{t("Paste this when the script asks for the token. It works once, for this machine, until {time}.", {
								time: new Date(minted.expires).toLocaleTimeString(),
							})}
						</p>
						<Command command={minted.token} secret />
					</div>
				)}
			</Step>

			<Step number={2} title={t("Run this on the new machine as root")}>
				<p className="text-[13px] text-fg-muted leading-relaxed">
					{t("Replace <prefix> with the name it should answer to. It does the rest: fetches the binary, takes this deployment's certificate and credentials, points a name at the machine, and starts the relay.")}
				</p>
				<Command command={minted ? minted.command : ready.command} />
			</Step>

			{/* What the machine will be called and what has to be open on it. The
			    server has always sent both, and an operator who ran the line
			    found out which port to open by a call failing. A provider's
			    security group is not something to be discovering afterwards. */}
			<Step number={3} title={t("Open its ports")}>
				<p className="text-[13px] text-fg-muted leading-relaxed">
					{ready.domain && (
						<>
							{t("It becomes")} <span className="readout text-fg">{`<prefix>.${ready.domain}`}</span>
							{". "}
						</>
					)}
					{ready.port ? (
						<>
							{t("Open these on the machine:")} <span className="readout text-fg">{`tcp/${ready.port}`}</span>
							{t(", and the UDP media port.")}
						</>
					) : null}
				</p>
			</Step>

			<Step number={4} title={t("Wait for it to appear in the list")}>
				<p className="text-[13px] text-fg-muted leading-relaxed">
					{t("The machine adds itself when the script finishes. Its row turns green once this node can reach it.")}
				</p>
			</Step>

			<div className="flex flex-col gap-2">
				<button
					type="button"
					aria-expanded={reading}
					onClick={() => setReading((was) => !was)}
					className={cn(quiet, "-ml-2.5 h-auto min-h-8 justify-start self-start py-1.5 text-left")}
				>
					<ChevronDown className={cn("transition-transform duration-200", reading && "rotate-180")} />
					{t("What that runs, in full. Worth reading before running anything as root.")}
				</button>
				{script.mounted && (
					<pre
						className={cn(
							"readout max-h-80 overflow-auto rounded-[12px] border border-border bg-bg p-3 text-[11.5px] leading-relaxed",
							script.leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<code>{ready.script}</code>
					</pre>
				)}
			</div>

			{minted && (
				<p className="animate-arrive rounded-[12px] bg-tally/10 px-3.5 py-2.5 text-[12.5px] text-tally-ink leading-relaxed">
					{t("Until it is used, this token is the key to this deployment. Do not put it anywhere it will be kept.")}
				</p>
			)}

			<Button variant="secondary" size="sm" className="self-start" onClick={onDone}>
				{t("Done")}
			</Button>
		</div>
	);
}

/**
 * A token for one machine, made here and pasted there.
 *
 * Taking over a name already in use is decided here, by somebody signed in,
 * rather than by the machine: a takeover moves a live relay's name to whatever
 * address the machine reports, and the machine asking is the one party whose
 * word on that is worth nothing. So the box says what it does, and is asked
 * again before the token is made.
 */
function MintToken({ onMinted }: { onMinted: (minted: { token: string; command: string; expires: string }) => void }) {
	const t = useT();

	const [prefix, setPrefix] = useState("");
	const [replace, setReplace] = useState(false);
	const [from, setFrom] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				if (busy || !prefix.trim()) return;

				if (
					replace &&
					!window.confirm(
						t("This token lets the new machine take over {name}: its name will point at the new machine, and calls dialled to it will land there. Make it?", {
							name: prefix.trim(),
						}),
					)
				) {
					return;
				}

				setBusy(true);

				try {
					const made = await api.mintEnrolment({
						prefix: prefix.trim().toLowerCase(),
						replace,
						from: from.trim() || undefined,
					});
					onMinted({ token: made.token, command: made.command, expires: made.grant.expires });
				} catch (err) {
					actionFailed(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<Group>
				<label className="flex flex-col gap-1.5 px-4 py-3">
					<span className="text-[12.5px] text-fg-muted">{t("Prefix")}</span>
					<input
						value={prefix}
						onChange={(event) => setPrefix(event.target.value)}
						placeholder="tokyo"
						autoComplete="off"
						spellCheck={false}
						className={cn(field, "readout")}
					/>
				</label>
				<label className="relative flex flex-col gap-1.5 px-4 py-3 before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border">
					<span className="text-[12.5px] text-fg-muted">{t("Only from this address (optional)")}</span>
					<input
						value={from}
						onChange={(event) => setFrom(event.target.value)}
						placeholder="203.0.113.10"
						autoComplete="off"
						spellCheck={false}
						className={cn(field, "readout")}
					/>
				</label>
				<div className="relative px-4 py-2 before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border">
					<Box label={t("Takes over the relay already called this")} checked={replace} onChange={setReplace} />
				</div>
			</Group>

			<Button type="submit" variant="primary" size="sm" className="self-start" disabled={busy || !prefix.trim()}>
				{busy && <Loader2 className="animate-spin" />}
				{t("Make a token")}
			</Button>
		</form>
	);
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
	return (
		<section className="flex gap-3">
			<span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-hi font-medium text-[12.5px] tabular-nums">
				{number}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
				<h3 className="font-medium text-[14px]">{title}</h3>
				{children}
			</div>
		</section>
	);
}

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
