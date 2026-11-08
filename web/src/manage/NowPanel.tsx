import { Flagged } from "@/components/room/Flag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { Phrased, useT } from "@/hooks/useT";
import { say } from "@/live/i18n";
import { cn } from "@/lib/utils";
import { Mic, MicOff, ScreenShare, Video, VideoOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LiveRoom, type NodeReading, type Now, type Participant, type Point, api } from "./api";
import { DeviceLine } from "./Device";
import { Group, Initial, Row, Section, usePresence } from "./Grouped";
import { ago, certificate, lasted, reason, type Verdict, verdict } from "./health";
import { usePoll } from "./poll";
import { Failed, Live } from "./Shell";
import { Trend } from "./Trend";
import { bitrate, count, linkBits, moment, rate, size, typed, width } from "./units";

/**
 * What is happening on the deployment now, and how it got here.
 *
 * Asked for twice by the owner and not delivered either time: the page "still
 * lacks detail", and the figures under the chart were "ugly and hard to
 * understand" (2026-08-29). It was a plot, two cards of four numbers each under
 * headings like "Tracks" and "Asked for again", and a table of eleven columns
 * per relay. Every figure was true; none of them said whether anything was
 * wrong, and nothing on it said who was in a call.
 *
 * So it reads top to bottom as the questions are asked. A sentence first —
 * how many people are in calls, and whether the machines are well — because
 * that is the whole of what somebody opening this at two in the morning wants
 * to know before anything else. Then who is in which room, on which machine,
 * from which device. Then each machine, as a verdict in a word with the figures
 * that decided it beside it. The uplink's history comes last, because it
 * answers a slower question.
 *
 * The live reading is polled a floor above and handed down, because it also
 * belongs in the rail, where it is legible from every other panel; the rooms
 * are polled there too, so the rail and this page count the same people. The
 * trend and each room's people are polled here, because they are only ever
 * looked at here.
 */
export function NowPanel({
	now,
	live,
	onSignedOut,
}: {
	now?: Now;
	/** The meetings in progress, from the rooms poll above; absent until it answers. */
	live?: LiveRoom[];
	onSignedOut: () => void;
}) {
	// The moment the live reading last changed, so the page can say how old it
	// is: a control node that has stopped answering leaves the last figures on
	// screen, and without a time beside them they are believed.
	const [fresh, setFresh] = useState(() => Date.now());
	useEffect(() => {
		if (now) setFresh(Date.now());
	}, [now]);

	// Redrawn every few seconds even when nothing new arrives, so "just now"
	// becomes "a minute ago" on a page whose server has gone quiet.
	const [, tick] = useState(0);
	useEffect(() => {
		const timer = window.setInterval(() => tick((n) => n + 1), 5_000);
		return () => window.clearInterval(timer);
	}, []);

	// Whose signature each is, so a person in a call who signed in with an
	// account is said to be that account rather than "a passphrase": the
	// media server knows only that the mark was earned, and the accounts list
	// is what says by whom. Slowly, because accounts are made by hand.
	const { value: accounts } = usePoll(api.accounts, { every: 60_000, onSignedOut });
	const named = new Map((accounts ?? []).map((one) => [one.trip, one.name]));

	return (
		<div className="mx-auto flex max-w-[1180px] flex-col gap-7 sm:gap-8">
			<Summary now={now} live={live} fresh={fresh} />

			<div className="grid items-start gap-7 sm:gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<Calls live={live} named={named} onSignedOut={onSignedOut} />
				<Machines now={now} />
			</div>

			<Uplink now={now} onSignedOut={onSignedOut} />
		</div>
	);
}

/**
 * The page in a sentence, and the machines in another.
 *
 * Counted from the rooms rather than from the relays' own counters where the
 * rooms have answered. The two disagree on a fleet, and the relays are the
 * ones that are wrong for this purpose: somebody whose media is carried
 * through one relay to the one holding the room is a connection on both, so
 * five people in two rooms were summed to seven.
 */
function Summary({ now, live, fresh }: { now?: Now; live?: LiveRoom[]; fresh: number }) {
	const t = useT();

	const rooms = live ? live.length : (now?.rooms ?? 0);
	const people = live ? live.reduce((sum, one) => sum + one.participants, 0) : (now?.clients ?? 0);

	let headline: string;
	if (!now && !live) headline = " ";
	else if (rooms === 0 || people === 0) headline = t("Nobody is in a call right now");
	else if (people === 1) headline = t("One person is in a call");
	else if (rooms === 1) headline = t("{people} people are in one room", { people });
	else headline = t("{people} people are in {rooms} rooms", { people, rooms });

	const nodes = now?.nodes ?? [];
	const verdicts = nodes.map(verdict);
	const down = verdicts.filter((one) => one === "down").length;
	const busy = verdicts.filter((one) => one === "busy").length;

	let machines: { tone: Verdict; text: string } | undefined;
	if (now?.fleet) {
		if (nodes.length === 0) machines = { tone: "down", text: t("No relays are configured, so this node has nowhere to send a call.") };
		else if (down > 0) machines = { tone: "down", text: t("{down} of {count} relays are not answering", { down, count: nodes.length }) };
		else if (busy > 0) machines = { tone: "busy", text: t("All {count} relays are answering, and {busy} of them are busy", { count: nodes.length, busy }) };
		else if (nodes.length === 1) machines = { tone: "ok", text: t("The relay is answering and has room to spare") };
		else machines = { tone: "ok", text: t("All {count} relays are answering and have room to spare", { count: nodes.length }) };
	} else if (now) {
		const load = now.cpu.load;
		machines =
			load > 0.8
				? { tone: "busy", text: t("This server holds the calls itself, and it is busy") }
				: { tone: "ok", text: t("This server holds the calls itself, and has room to spare") };
	}

	const stale = Date.now() - fresh > 20_000;

	return (
		<header className="flex flex-wrap items-end gap-x-6 gap-y-2 px-1">
			<div className="flex min-w-0 flex-col gap-1.5">
				<h1 className="font-semibold text-[22px] leading-tight tracking-[-0.01em]">{headline}</h1>
				{machines && (
					<p key={machines.text} className="flex animate-fade-in items-center gap-2 text-[14px]">
						<Light verdict={machines.tone} />
						<span className={tone(machines.tone)}>{machines.text}</span>
					</p>
				)}
			</div>

			{/* How old the figures are. Amber once they have stopped arriving,
			    which is something happening that somebody should notice. */}
			<p className={cn("ml-auto pb-0.5 text-[12.5px] tabular-nums", stale ? "text-tally-ink" : "text-fg-muted")}>
				{t("Updated {when}", { when: ago(new Date(fresh).toISOString()) })}
			</p>
		</header>
	);
}

/** The ink a verdict is written in: quiet when well, amber when busy, red when down. */
function tone(verdict: Verdict): string {
	return verdict === "down" ? "text-danger-ink" : verdict === "busy" ? "text-tally-ink" : "text-fg-muted";
}

/**
 * A machine's light. The one place a second colour appears, because a light
 * says one of three things and people already know which colour means which.
 */
function Light({ verdict }: { verdict: Verdict }) {
	return (
		<span
			aria-hidden
			className={cn(
				"size-2 shrink-0 rounded-full transition-colors duration-300",
				verdict === "down" ? "bg-danger" : verdict === "busy" ? "bg-tally" : "bg-good",
			)}
		/>
	);
}

/** How many rooms are drawn in full here; the rest are counted, and the Rooms page has them all. */
const ROOMS_SHOWN = 8;

/**
 * Who is in which room, on which machine, and from what.
 *
 * The question the page could not answer. The rooms page can, one room at a
 * time, by opening each; this is all of them at once, without a press, which
 * is what "what is going on" means.
 */
function Calls({ live, named, onSignedOut }: { live?: LiveRoom[]; named: Map<string, string>; onSignedOut: () => void }) {
	const t = useT();

	// Oldest meeting first, so a page redrawn every five seconds keeps its
	// order and a meeting that has just started joins the foot of it.
	const ordered = [...(live ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
	const rooms = usePresence(ordered.slice(0, ROOMS_SHOWN), (one) => one.name);
	const more = ordered.length - ROOMS_SHOWN;

	const empty = useLingering(live !== undefined && ordered.length === 0, 160);

	return (
		<Section title={t("In calls")} note={live && ordered.length > 0 ? t("{count} rooms", { count: ordered.length }) : undefined}>
			{empty.mounted && (
				<Group className={empty.leaving ? "animate-fade-out" : "animate-fade-in"}>
					<p className="px-4 py-5 text-fg-muted text-[13.5px]">
						{t("No meeting is in progress. Rooms appear here as soon as somebody joins one.")}
					</p>
				</Group>
			)}

			<div className="flex flex-col gap-3">
				{rooms.map(({ item, leaving }) => (
					<Meeting key={item.name} room={item} named={named} leaving={leaving} onSignedOut={onSignedOut} />
				))}
			</div>

			{more > 0 && <p className="px-1 text-fg-muted text-[12.5px]">{t("{count} more rooms are on the Rooms page.", { count: more })}</p>}
		</Section>
	);
}

/** One meeting: its name, where it is held, for how long, and everybody in it. */
function Meeting({
	room,
	named,
	leaving,
	onSignedOut,
}: {
	room: LiveRoom;
	named: Map<string, string>;
	leaving: boolean;
	onSignedOut: () => void;
}) {
	const t = useT();

	const ask = useCallback(() => api.participants(room.name), [room.name]);
	const { value } = usePoll(ask, { every: 5_000, onSignedOut, enabled: !leaving });

	// Somebody screen-sharing first, then in the order they arrived: the
	// person presenting is the one an operator is usually asked about.
	const everybody = [...(value ?? [])].sort(
		(a, b) => Number(sharing(b)) - Number(sharing(a)) || a.joinedAt.localeCompare(b.joinedAt) || a.identity.localeCompare(b.identity),
	);
	const people = usePresence(everybody, (one) => one.identity);

	return (
		<Group className={leaving ? "animate-depart" : "animate-arrive"}>
			<div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
				<Live on />
				<div className="min-w-0 flex-1">
					<p className="flex items-baseline gap-2">
						<span className="readout truncate font-semibold text-[15px]">{room.name}</span>
						<span className="shrink-0 text-fg-muted text-[13px]">{t("{count} people", { count: room.participants })}</span>
					</p>
					<p className="text-fg-muted text-[12.5px]">
						{room.relay ? (
							<Phrased
								phrase="On {relay} for {time}"
								values={{ relay: <Flagged text={say(room.relay)} />, time: lasted(room.createdAt) }}
							/>
						) : (
							t("Going for {time}", { time: lasted(room.createdAt) })
						)}
					</p>
				</div>
			</div>

			{people.map(({ item, leaving: going }) => (
				<Row key={item.identity} inset={60} leaving={going}>
					<Person one={item} relay={room.relay} account={named.get(item.trip.mark)} />
				</Row>
			))}

			{value === undefined && (
				<Row inset={16}>
					<span className="block h-[52px] animate-fade-in" aria-hidden />
				</Row>
			)}
		</Group>
	);
}

function sharing(one: Participant): boolean {
	return one.tracks.some((track) => track.source === "SCREEN_SHARE" && !track.muted);
}

/** One person in a call. */
function Person({ one, relay, account }: { one: Participant; relay?: string; account?: string }) {
	const t = useT();

	// The account by name where the name they typed is not it, since that is
	// the one an operator would look up.
	const kind =
		account !== undefined
			? account === one.name
				? t("account")
				: `${t("account")} ${account}`
			: one.trip.account
				? t("account")
				: one.trip.proven
					? t("passphrase")
					: t("guest");
	const mic = one.tracks.find((track) => track.source === "MICROPHONE");
	const camera = one.tracks.find((track) => track.source === "CAMERA");
	const speaking = mic && !mic.muted;
	const seeing = camera && !camera.muted;

	// The machine they came in by, only where it is not the room's own: then
	// their media is carried from one to the other, which is the first thing
	// to suspect when one person in a room has a bad call and the rest do not.
	const through = one.relay && relay && one.relay !== relay ? one.relay : undefined;

	return (
		<div className="flex min-h-[52px] items-center gap-3 px-4 py-2">
			<Initial name={one.name || one.identity} guest={!one.trip.proven} />

			<div className="min-w-0 flex-1">
				<p className="flex items-baseline gap-2">
					<span className="truncate text-[14px]" title={one.identity}>
						{one.name || t("No name")}
					</span>
					<span className="shrink-0 text-fg-muted text-[12px]">{kind}</span>
					<span className="readout hidden shrink-0 text-[11.5px] text-fg-muted sm:inline">{one.trip.mark}</span>
				</p>
				<div className="flex flex-wrap items-center gap-x-3 text-fg-muted text-[12.5px]">
					{one.client ? <DeviceLine client={one.client} /> : <span>{t("Device not recorded")}</span>}
					{through && (
						<span className="whitespace-nowrap">
							<Phrased phrase="came in through {relay}" values={{ relay: <Flagged text={say(through)} /> }} />
						</span>
					)}
				</div>
			</div>

			<span className="flex shrink-0 items-center gap-1.5 text-fg-muted">
				{sharing(one) && (
					<span title={t("Sharing their screen")} className="text-tally-ink">
						<ScreenShare className="size-4" aria-label={t("Sharing their screen")} />
					</span>
				)}
				<span title={speaking ? t("Microphone on") : t("Microphone off")}>
					{speaking ? (
						<Mic className="size-4" aria-label={t("Microphone on")} />
					) : (
						<MicOff className="size-4 opacity-60" aria-label={t("Microphone off")} />
					)}
				</span>
				<span title={seeing ? t("Camera on") : t("Camera off")}>
					{seeing ? (
						<Video className="size-4" aria-label={t("Camera on")} />
					) : (
						<VideoOff className="size-4 opacity-60" aria-label={t("Camera off")} />
					)}
				</span>
			</span>

			<span className="w-16 shrink-0 text-right text-fg-muted text-[12px] tabular-nums max-[400px]:hidden">
				{lasted(one.joinedAt)}
			</span>
		</div>
	);
}

/**
 * The machines: the relays on a control node, or this server on a deployment
 * that holds its own calls.
 *
 * Written as a branch rather than as one group with blanks in it, because the
 * earlier version was the latter and read `node.id` on a control node, where
 * there is no node. That took the whole page to a blank screen the moment
 * somebody opened it.
 */
function Machines({ now }: { now?: Now }) {
	const t = useT();

	if (now && !now.fleet) {
		const self: NodeReading = {
			name: now.node?.id ?? "",
			url: "",
			reachable: true,
			node: now.node?.id ?? "",
			ip: now.node?.ip ?? "",
			rooms: now.rooms,
			clients: now.clients,
			tracksIn: now.tracks.in,
			tracksOut: now.tracks.out,
			outPerSec: now.bytes.outPerSec,
			inPerSec: now.bytes.inPerSec,
			bytesIn: now.bytes.in,
			bytesOut: now.bytes.out,
			cpus: now.cpu.count,
			load: now.cpu.load,
			nackPerSec: now.packets.nackPerSec,
			startedAt: now.since,
			certExpires: now.certExpires,
		};

		return (
			<Section title={t("This server")}>
				<Group>
					<Machine one={self} />
				</Group>
			</Section>
		);
	}

	const nodes = now?.nodes ?? [];

	return (
		<Section title={t("Relays")} note={nodes.length > 0 ? t("{count} configured", { count: nodes.length }) : undefined}>
			<Group>
				{now === undefined && <span className="block h-24" aria-hidden />}
				{now && nodes.length === 0 && (
					<p className="px-4 py-5 text-fg-muted text-[13.5px]">{t("No relays are configured, so this node has nowhere to send a call.")}</p>
				)}
				{regions(nodes, t("Elsewhere")).map((region) => (
					<div key={region.name}>
						{/* A heading per region, in the order the relays are listed,
						    as the table before the redesign had them: the mainland
						    relays and the overseas ones are different jobs, and the
						    question is usually about one of the two. Drawn only where
						    there is more than one region to tell apart. */}
						{region.many && (
							<p className="flex items-baseline gap-2 border-border border-b bg-surface-hi/50 px-4 py-1.5 text-[12.5px] text-fg-muted first:rounded-t-[14px] day:bg-bg/60">
								<span className="font-medium text-fg">{say(region.name)}</span>
								<span className="tabular-nums">{region.nodes.length}</span>
							</p>
						)}
						{region.nodes.map((one) => (
							<Row key={one.url} inset={16}>
								<Machine one={one} />
							</Row>
						))}
					</div>
				))}
			</Group>
			<p className="px-1 text-fg-muted text-[12px] leading-relaxed">
				{t("Answered in is one round trip from this node to the relay, not what a caller sees. Busy is a processor past 80%, the line past two thirds, or a network asking for many packets again.")}
			</p>
		</Section>
	);
}

/**
 * The last time each relay answered, kept for as long as the page is open.
 *
 * The control node asks every relay each time it is asked, so a relay that
 * answered was heard from just now; what the page can add is when one that has
 * stopped answering was last heard from — the difference between a machine
 * that went quiet a minute ago and one that has been gone since before the page
 * was opened. Module-level rather than state, so that it survives leaving the
 * page and coming back.
 */
const heard = new Map<string, number>();

/** The relays by region, in the order they are listed, and whether there is more than one region. */
function regions(nodes: NodeReading[], elsewhere: string): { name: string; nodes: NodeReading[]; many: boolean }[] {
	const out: { name: string; nodes: NodeReading[]; many: boolean }[] = [];
	for (const one of nodes) {
		const where = one.region || elsewhere;
		const already = out.find((region) => region.name === where);
		if (already) already.nodes.push(one);
		else out.push({ name: where, nodes: [one], many: false });
	}
	for (const region of out) region.many = out.length > 1;
	return out;
}

/**
 * One machine: its light, its name, its verdict, and every figure behind it.
 *
 * The verdict first, in a word, and then all of what the relay reported, each
 * under its own name with its unit: the redesign kept five of the old table's
 * eleven columns and the owner noticed (2026-11-01, "it doesn't show as much
 * detail as before"). Rooms, tracks in and out, what it receives as well as
 * what it sends, the packets asked for again whatever their number, and what
 * it has carried since it started are back, beside the node it runs as.
 */
function Machine({ one }: { one: NodeReading }) {
	const t = useT();

	const state = verdict(one);
	if (one.reachable && one.url) heard.set(one.url, Date.now());
	const last = one.url ? heard.get(one.url) : undefined;

	const cert = certificate(one.certExpires);
	const load = Math.max(0, Math.min(1, one.load ?? 0));
	const nack = one.nackPerSec ?? 0;

	const word = state === "down" ? t("Not answering") : state === "busy" ? t("Busy") : t("Healthy");

	return (
		<div className="flex flex-col gap-2 px-4 py-3">
			<div className="flex items-start gap-3">
				<span className="pt-[7px]">
					<Light verdict={state} />
				</span>
				<div className="min-w-0 flex-1">
					<p className="truncate text-[14.5px]">
						{one.label ? <Flagged text={say(one.label)} /> : one.name}
					</p>
					<p className="flex flex-wrap gap-x-2 text-fg-muted text-[12px]">
						{one.label && <span className="readout">{one.name}</span>}
						{one.region && <span>{say(one.region)}</span>}
						{one.ip && <span className="readout">{one.ip}</span>}
					</p>
				</div>
				<span className={cn("shrink-0 pt-px font-medium text-[13.5px]", state === "ok" ? "text-good-ink" : tone(state))}>{word}</span>
			</div>

			{state === "down" ? (
				<div className="flex flex-col gap-1 pl-5">
					<p className="text-[13px]">{reason(one.detail)}</p>
					<p className="text-fg-muted text-[12px]">
						{last ? t("Last answered {when}", { when: ago(new Date(last).toISOString()) }) : t("Has not answered since this page was opened")}
					</p>
					{one.detail && (
						<p className="readout truncate text-[11px] text-fg-muted" title={one.detail}>
							{one.detail}
						</p>
					)}
				</div>
			) : (
				<dl className="grid grid-cols-2 gap-x-4 gap-y-2 pl-5 sm:grid-cols-3">
					<Fact label={t("Processor")}>
						<span className="flex flex-wrap items-center gap-x-2">
							<span className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-hi">
								<span
									className={cn(
										"block h-full rounded-full transition-[width] duration-500",
										load > 0.8 ? "bg-danger" : load > 0.5 ? "bg-tally" : "bg-good",
									)}
									style={{ width: `${Math.max(load * 100, load > 0 ? 4 : 0)}%` }}
								/>
							</span>
							<span className={cn(load > 0.8 && "text-tally-ink")}>{`${Math.round(load * 100)}%`}</span>
							{one.cpus > 0 && <span className="text-fg-muted text-[12px]">{t("{count} cores", { count: one.cpus })}</span>}
						</span>
					</Fact>
					<Fact label={t("Rooms")}>{count(one.rooms ?? 0)}</Fact>
					<Fact label={t("Carrying")}>
						{t("{count} people", { count: one.clients ?? 0 })}
					</Fact>
					<Fact label={t("Tracks")}>{t("{in} in, {out} out", { in: one.tracksIn ?? 0, out: one.tracksOut ?? 0 })}</Fact>
					<Fact label={t("Sending")}>{rate(one.outPerSec ?? 0)}</Fact>
					<Fact label={t("Receiving")}>{rate(one.inPerSec ?? 0)}</Fact>
					{/* Sent only where it is above nought, so a relay that answered
					    inside the millisecond says so rather than saying nothing. */}
					{one.url && <Fact label={t("Answered in")}>{one.tookMs ? `${one.tookMs} ms` : "<1 ms"}</Fact>}
					{/* Always, with its number: coloured only where it is worth
					    reading, since a handful a second is an ordinary network and a
					    hundred is one that is failing. It was drawn only above five,
					    which left the figure out on the relays where it was low —
					    and low is a reading too. */}
					<Fact label={t("Packets asked for again")}>
						<span className={nack > 50 ? "text-danger-ink" : nack > 5 ? "text-tally-ink" : undefined}>
							{nack > 0 ? t("{count} a second", { count: nack.toFixed(1) }) : "—"}
						</span>
					</Fact>
					{one.startedAt && <Fact label={t("Running for")}>{lasted(one.startedAt)}</Fact>}
					{/* Named in full rather than as two numbers under one word, which
					    is what it was before the redesign: "27 kB / 23 kB" could not
					    say which was which. */}
					<Fact label={t("Since it started")}>
						{t("{out} out, {in} in", { out: size(one.bytesOut ?? 0), in: size(one.bytesIn ?? 0) })}
					</Fact>
					{/* The media server's own name for the machine, which is what its
					    log calls it; not again where it is the name above. */}
					{one.node && one.node !== one.name && (
						<Fact label={t("Node")}>
							<span className="readout text-[12px]">{one.node}</span>
						</Fact>
					)}
					<Fact label={t("Certificate")}>
						{cert ? (
							<span className={cert.tone === "urgent" ? "text-danger-ink" : cert.tone === "soon" ? "text-tally-ink" : undefined}>
								{cert.text}
							</span>
						) : (
							<span className="text-fg-muted" title={t("This relay does not report its certificate: it may be older, or behind a proxy that holds the certificate itself.")}>
								{t("not reported")}
							</span>
						)}
					</Fact>
				</dl>
			)}
		</div>
	);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col">
			<dt className="text-fg-muted text-[11.5px]">{label}</dt>
			<dd className="min-w-0 break-words text-[13px] tabular-nums">{children}</dd>
		</div>
	);
}

/**
 * The uplink over whatever stretch of time was asked for.
 *
 * The plot is kept, and it is the point of this part: a single reading says
 * whether the line is busy now, an hour of them says whether the evening was
 * climbing, and six months says whether this is what the line has always done.
 * How far back to look is a choice rather than a constant, because ten minutes
 * is somebody watching a call go wrong and a month is somebody deciding whether
 * to pay for more bandwidth.
 */
function Uplink({ now, onSignedOut }: { now?: Now; onSignedOut: () => void }) {
	const t = useT();

	const [span, setSpan] = useState<Span>("1h");
	const [range, setRange] = useState<{ from: string; to: string }>();
	const [choosing, setChoosing] = useState(false);
	const [hovered, setHovered] = useState<number | null>(null);

	const ask = useCallback(
		() => api.history(span, span === "custom" ? range : undefined),
		[span, range],
	);

	// Six months of buckets do not move every five seconds. The fine spans are
	// asked for at the rate the server samples at, and the coarse ones at a rate
	// that keeps the last bucket honest without sending a hundred kilobytes of
	// half a year twelve times a minute to a page nobody is looking at.
	const brisk = span === "10m" || span === "1h";

	const {
		value: trend,
		error,
		refresh,
	} = usePoll(ask, { every: brisk ? 5_000 : 30_000, onSignedOut });

	// The poll holds its question in a ref, so that changing it does not restart
	// the timer — and the other half of that bargain is that a new question is
	// not asked until the next tick, which on a coarse span is half a minute of
	// looking at the range somebody has just left. Skipped on the first render,
	// where the poll is already about to ask.
	const asked = useRef(false);
	useEffect(() => {
		if (!asked.current) {
			asked.current = true;
			return;
		}

		void refresh();
	}, [refresh, span, range]);

	const points = trend?.points ?? [];
	const step = trend?.step ?? 5;

	// Kept so the readout has something to draw while it is leaving. The pointer
	// is already gone by then, and a readout that empties before it fades is a
	// flicker rather than an exit.
	const last = useRef<Point>();
	const point = hovered === null ? undefined : points[hovered];
	if (point) last.current = point;

	const reading = useLingering(point !== undefined, 160);
	const idle = useLingering(point === undefined, 160);

	const out = now?.bytes.outPerSec ?? 0;
	const share = Math.min(1, (out * 8) / linkBits());

	return (
		<Section title={t("Uplink")} note={t("one point every {step}", { step: width(step) })}>
			{error && <Failed>{error}</Failed>}

			<Group>
				<div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-4 pt-4">
					<div className="flex min-w-0 flex-col gap-1">
						<span className="text-fg-muted text-[12px]">{t("Going out now")}</span>
						<span className="font-semibold text-[22px] leading-none tabular-nums">{rate(out)}</span>
					</div>

					{/* How full the line is, as a bar and the sentence it means. The
					    line's real size, not the words "1 Gbps": the share has always
					    been worked out against what the deployment says it carries. */}
					<div className="flex min-w-[10rem] flex-1 flex-col gap-1.5 pb-0.5">
						<div
							className="h-1.5 overflow-hidden rounded-full bg-surface-hi"
							role="meter"
							aria-valuenow={Math.round(share * 100)}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-label={t("Link usage")}
						>
							<div
								className={cn(
									"h-full rounded-full transition-[width,background-color] duration-500",
									share > 0.9 ? "bg-danger" : share > 0.66 ? "bg-tally" : "bg-fg-muted",
								)}
								style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }}
							/>
						</div>
						<span className="text-fg-muted text-[12px]">
							{t("{percent}% of {link}", { percent: Math.round(share * 100), link: bitrate(linkBits()) })}
						</span>
					</div>
				</div>

				<Spans
					span={span}
					choosing={choosing}
					onSpan={(next) => {
						setSpan(next);
						setChoosing(false);
					}}
					onChoose={() => setChoosing((open) => !open)}
				/>

				<Custom
					open={choosing}
					onShow={(chosen) => {
						setRange(chosen);
						setSpan("custom");
						setChoosing(false);
					}}
				/>

				<div className="px-2 pt-3 pb-1">
					{/*
					  * Fed rather than rebuilt when the span changes, so the range
					  * swaps under a canvas that stays where it is. Rebuilding it
					  * flashes a blank plot between one question and the next,
					  * which reads as the page having broken rather than as a
					  * different question being answered.
					  */}
					<Trend points={points} onHover={setHovered} />
				</div>

				{/*
				  * One line, whichever of the two things is in it.
				  *
				  * The height is reserved because the alternative is a group that
				  * grows by a line whenever the pointer crosses the chart, taking
				  * everything below it on the page with it. So the two cross over
				  * in place: one leaves as the other arrives, and nothing moves.
				  */}
				<div className="relative mb-3 h-6 overflow-hidden px-4">
					{idle.mounted && (
						<div
							className={cn(
								"absolute inset-x-4 inset-y-0 flex items-center gap-x-4",
								idle.leaving ? "animate-depart" : "animate-arrive",
							)}
						>
							<Key colour="bg-tally" label={t("out")} />
							<Key colour="bg-fg-muted" label={t("in")} />
							<Key colour="bg-tally/30" label={t("peak")} />
							<span className="ml-auto text-fg-muted text-[11.5px]">
								{points.length > 0
									? t("{count} points", { count: points.length })
									: t("nothing recorded")}
							</span>
						</div>
					)}

					{reading.mounted && last.current && (
						<Reading point={last.current} step={step} leaving={reading.leaving} />
					)}
				</div>

				{/* What the counters have carried, said as a sentence rather than
				    as two figures under the headings "Total out" and "Total in",
				    which did not say since when or from where. */}
				{now && <Totals now={now} />}
			</Group>

			<p className="px-1 text-fg-muted text-[12px] leading-relaxed">
				{t(
					"A point is the mean over its own bucket and the band behind the line is the highest single reading inside it, which is where a burst shows. Totals are since this process started. The trend outlives a restart: fine detail recently, coarser the further back it goes, out to six months.",
				)}
			</p>
		</Section>
	);
}

/**
 * The figures for the whole deployment, which were the Load and Since restart
 * cards before the redesign and which it reduced to one sentence about bytes.
 *
 * Summed across the relays that answered, on a control node, so they are what
 * the media servers count: a person whose media is carried from one relay to
 * another is a connection on both, which is why the connections here can be
 * more than the people the page counts from the rooms above. Both are true and
 * both are said. The rates are means over a window the server names, and the
 * window is said with them, because a rate that does not say what it is
 * averaged over is read as the wrong one.
 */
function Totals({ now }: { now: Now }) {
	const t = useT();

	const load = Math.max(0, Math.min(1, now.cpu.load));
	const nack = now.packets.nackPerSec;

	return (
		<div className="flex flex-col gap-2 border-border border-t px-4 py-3">
			<p className="text-[12.5px] text-fg-muted">
				{now.fleet ? t("Totals across the relays that answered") : t("Totals for this server")}
			</p>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
				<Fact label={t("Rooms")}>{count(now.rooms)}</Fact>
				<Fact label={t("Connections")}>{count(now.clients)}</Fact>
				<Fact label={t("Tracks")}>{t("{in} in, {out} out", { in: now.tracks.in, out: now.tracks.out })}</Fact>
				<Fact label={t("Processor")}>
					<span className={cn(load > 0.8 && "text-tally-ink")}>
						{`${Math.round(load * 100)}%`} <span className="text-fg-muted text-[12px]">{t("{count} cores", { count: now.cpu.count })}</span>
					</span>
				</Fact>
				<Fact label={t("Packets asked for again")}>
					<span className={nack > 50 ? "text-danger-ink" : nack > 5 ? "text-tally-ink" : undefined}>
						{t("{count} a second", { count: nack.toFixed(1) })}
					</span>
				</Fact>
				<Fact label={t("Sending")}>{rate(now.bytes.outPerSec)}</Fact>
				<Fact label={t("Receiving")}>{rate(now.bytes.inPerSec)}</Fact>
				<Fact label={now.fleet ? t("Since each relay started") : t("Since it started")}>
					{t("{out} out, {in} in", { out: size(now.bytes.out), in: size(now.bytes.in) })}
				</Fact>
				<Fact label={now.fleet ? t("This node running for") : t("Running for")}>{lasted(now.since)}</Fact>
				{now.bytes.window > 0 && <Fact label={t("Rates averaged over")}>{width(now.bytes.window)}</Fact>}
			</dl>
		</div>
	);
}

/**
 * How far back the chart looks.
 *
 * The list is the deployment owner's, in their order: longest first, because
 * somebody who opens this to answer a question about last month starts from the
 * left. What they asked for had both "one day" and "24 hours" in it, which are
 * the same length of time, so there is one button for them rather than two that
 * do the same thing.
 *
 * The keys are the server's vocabulary and the labels are this page's. Sending
 * a number of seconds instead would put the definition of a month in two places
 * and make disagreeing about it silent.
 */
const SPANS = [
	{ key: "6mo", label: "6 months" },
	{ key: "3mo", label: "3 months" },
	{ key: "1mo", label: "1 month" },
	{ key: "1w", label: "1 week" },
	{ key: "24h", label: "24 hours" },
	{ key: "1h", label: "1 hour" },
	{ key: "10m", label: "10 minutes" },
] as const;

type Span = (typeof SPANS)[number]["key"] | "custom";

/**
 * The row of them, drawn as the platform's segmented control: a track in the
 * raised grey with the chosen segment standing on it in the group's own colour.
 *
 * The named spans are a radio group, because that is what they are: one of them
 * is true at a time, and a screen reader told so can say which. Custom sits
 * beside the group rather than inside it — it opens a pair of fields rather
 * than choosing anything, and a radio that is not one is worse than no role at
 * all to somebody who cannot see the row.
 *
 * It scrolls sideways on a phone rather than wrapping: eight segments in two
 * rows read as two controls.
 */
function Spans({
	span,
	choosing,
	onSpan,
	onChoose,
}: {
	span: Span;
	choosing: boolean;
	onSpan: (span: Span) => void;
	onChoose: () => void;
}) {
	const t = useT();

	// The chosen segment in view when the row is narrower than it: on a phone
	// the hour, which is where the page opens, sat just past the right edge,
	// so the control looked as if nothing in it was chosen. Scrolled within
	// the row only, never the page.
	const row = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = row.current;
		const chosen = element?.querySelector<HTMLElement>('[aria-checked="true"]');
		if (!element || !chosen) return;

		const right = chosen.offsetLeft + chosen.offsetWidth + 16;
		if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
	}, [span]);

	return (
		<div ref={row} className="relative flex items-center gap-2 overflow-x-auto px-4 pt-4 [scrollbar-width:none]">
			<div
				role="radiogroup"
				aria-label={t("How far back")}
				className="flex shrink-0 gap-0.5 rounded-[10px] bg-surface-hi p-0.5"
			>
				{SPANS.map((one) => (
					<button
						key={one.key}
						type="button"
						role="radio"
						aria-checked={span === one.key}
						onClick={() => onSpan(one.key)}
						className={segment(span === one.key)}
					>
						{t(one.label)}
					</button>
				))}
			</div>

			<button
				type="button"
				aria-expanded={choosing}
				onClick={onChoose}
				className={cn(
					"pressable h-8 shrink-0 rounded-[10px] px-3 text-[12.5px] outline-none pointer-coarse:h-9",
					"focus-visible:ring-2 focus-visible:ring-fg/70",
					span === "custom" || choosing ? "bg-surface-hi text-fg" : "text-fg-muted hover:bg-wash hover:text-fg",
				)}
			>
				{t("Custom")}
			</button>
		</div>
	);
}

/** One segment, chosen or not. */
function segment(chosen: boolean): string {
	return cn(
		"pressable h-7 whitespace-nowrap rounded-[8px] px-2.5 text-[12.5px] outline-none pointer-coarse:h-8",
		"focus-visible:ring-2 focus-visible:ring-fg/70",
		chosen
			? "bg-surface-hi-press font-medium text-fg day:bg-surface day:shadow-[0_1px_2px_rgb(0_0_0/0.12)]"
			: "text-fg-muted hover:text-fg",
	);
}

/**
 * A window that has already passed.
 *
 * Every named span above ends at this instant, which is what makes them cheap
 * to say and useless for last Tuesday evening. This is the only way to ask
 * about a stretch of time that is over.
 *
 * The browser draws the pickers. A date and time field is a thing every
 * platform already has, with a keyboard behaviour, a locale and an accessibility
 * story none of which this application could reproduce and all of which it would
 * get subtly wrong — the same reason the password manager holds the passphrases.
 *
 * It is sent as an instant rather than as the text that was typed: the fields
 * are in whoever is reading's own timezone and the server keeps UTC, and a
 * range that quietly shifted by the offset between them would draw a perfectly
 * plausible chart of the wrong eight hours.
 */
function Custom({
	open,
	onShow,
}: {
	open: boolean;
	onShow: (range: { from: string; to: string }) => void;
}) {
	const t = useT();

	const { mounted, leaving } = useLingering(open, 160);

	const [from, setFrom] = useState(() => typed(new Date(Date.now() - 24 * 3600 * 1000)));
	const [to, setTo] = useState(() => typed(new Date()));

	if (!mounted) return null;

	const backwards = !(new Date(from).getTime() < new Date(to).getTime());

	return (
		<div
			className={cn(
				"flex flex-wrap items-end gap-2 px-4 pt-3",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			<Field label={t("From")} value={from} onChange={setFrom} />
			<Field label={t("To")} value={to} onChange={setTo} />

			<Button
				variant="secondary"
				size="sm"
				disabled={backwards}
				onClick={() =>
					onShow({
						from: new Date(from).toISOString(),
						to: new Date(to).toISOString(),
					})
				}
			>
				{t("Show")}
			</Button>
		</div>
	);
}

function Field({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-fg-muted text-[11.5px]">{label}</span>
			<Input
				type="datetime-local"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				className="h-8 w-auto text-[12.5px]"
			/>
		</label>
	);
}

/**
 * What the pointer is over.
 *
 * The numbers are the answer, and every one of them is a figure this page
 * already shows for the present moment — the same vocabulary, at a different
 * time. The peaks are said beside the means rather than instead of them,
 * because on a coarse span they are the two halves of the answer: what the
 * hour cost, and how close the worst minute of it came.
 */
function Reading({ point, step, leaving }: { point: Point; step: number; leaving: boolean }) {
	const t = useT();

	return (
		<div
			className={cn(
				"absolute inset-x-4 inset-y-0 flex flex-nowrap items-center gap-x-3",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			<span className="shrink-0 text-fg text-[11.5px] tabular-nums">{moment(point.at, step)}</span>

			<Was label={t("out")} value={rate(point.out)} peak={rate(point.outPeak)} />
			<Was label={t("in")} value={rate(point.in)} peak={rate(point.inPeak)} />
			<Was label={t("rooms")} value={count(point.rooms)} />
			<Was label={t("people")} value={count(point.clients)} />
			<Was label={t("asked for again")} value={`${point.nack.toFixed(1)}/s`} peak={`${point.nackPeak.toFixed(1)}/s`} />
		</div>
	);
}

function Was({ label, value, peak }: { label: string; value: string; peak?: string }) {
	const t = useT();

	return (
		<span className="flex min-w-0 shrink items-baseline gap-1 truncate text-[11.5px]">
			<span className="text-fg-muted">{label}</span>
			<span className="text-fg tabular-nums">{value}</span>
			{/* The peak only where it says something the mean does not. */}
			{peak && peak !== value && (
				<span className="text-fg-muted/70 day:text-fg-muted tabular-nums">
					{t("peak")} {peak}
				</span>
			)}
		</span>
	);
}

function Key({ colour, label }: { colour: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5 text-fg-muted text-[11.5px]">
			<span className={cn("h-0.5 w-3.5 rounded-full", colour)} />
			{label}
		</span>
	);
}
