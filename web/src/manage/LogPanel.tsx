import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { locale } from "@/live/i18n";
import { cn } from "@/lib/utils";
import { ChevronDown, Pause, Play, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Client, type LogLine, type Policy, SignedOut, api } from "./api";
import { DeviceLine } from "./Device";
import { Group, Row, Section } from "./Grouped";
import { doors } from "./Lockouts";
import { words } from "./OpeningCard";
import { usePoll } from "./poll";
import { Failed } from "./Shell";
import { clock } from "./units";

/**
 * What the server has been saying, on a page.
 *
 * The owner asked for the audit and runtime pages to go and one log to take
 * their place, more readable, because "when things go wrong the admin panel
 * won't even open" (2026-08-20). So this asks the server for one thing, the
 * lines it keeps in memory (internal/logring), and that answer depends on
 * nothing else: not the store, not the media servers, not a relay. While any
 * of those is failing the page still opens, and the lines saying which one are
 * at the top of it.
 *
 * Newest first, because the question is what just happened. Filtered to the
 * lines that are problems with one press, since an ordinary day is mostly
 * people joining rooms; and to what administrators did with another, since
 * that record was the audit page's whole reason to exist. The settings the
 * process is running with, which the runtime page showed, are at the foot and
 * shut until asked for: they change when somebody restarts the server, and
 * they are read about once in a deployment's life.
 */
export function LogPanel({ onSignedOut }: { onSignedOut: () => void }) {
	const t = useT();

	const [lines, setLines] = useState<LogLine[]>([]);
	const [missed, setMissed] = useState(false);
	const [error, setError] = useState<string>();
	const [paused, setPaused] = useState(false);
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const [asked, setAsked] = useState(false);

	// The last line held, read from a ref by the timer so that changing it does
	// not restart the timer.
	const last = useRef(0);
	const signedOut = useRef(onSignedOut);
	signedOut.current = onSignedOut;

	const ask = useCallback(async () => {
		try {
			const reading = await api.log(last.current);

			if (reading.lines.length > 0) {
				last.current = reading.lines[reading.lines.length - 1]?.seq ?? last.current;
				setLines((held) => [...held, ...reading.lines].slice(-KEPT));
			}
			if (reading.missed) setMissed(true);
			setError(undefined);
		} catch (err) {
			if (err instanceof SignedOut) {
				signedOut.current();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setAsked(true);
		}
	}, []);

	// Every few seconds while following, and not at all while paused or while
	// the tab is hidden: a log left open in a background tab for a week is a
	// request every few seconds for a week.
	useEffect(() => {
		if (paused) return;

		let live = true;
		let timer: number | undefined;

		const tick = async () => {
			if (!live) return;
			if (!document.hidden) await ask();
			if (live) timer = window.setTimeout(tick, 3_000);
		};

		void tick();

		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [paused, ask]);

	const shown = useMemo(() => {
		const wanted = query.trim().toLowerCase();

		return lines
			.filter((line) => {
				if (filter === "problems" && line.level !== "warn" && line.level !== "error") return false;
				if (filter === "actions" && !acted(line)) return false;
				if (!wanted) return true;

				return (
					line.message.toLowerCase().includes(wanted) ||
					(line.attrs ?? []).some((attr) => `${attr.key} ${attr.value}`.toLowerCase().includes(wanted))
				);
			})
			.reverse()
			.slice(0, SHOWN);
	}, [lines, filter, query]);

	const problems = lines.filter((line) => line.level === "warn" || line.level === "error").length;

	return (
		<div className="mx-auto flex max-w-[1180px] flex-col gap-6">
			<header className="flex flex-col gap-1.5 px-1">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<h1 className="font-semibold text-[22px] leading-tight tracking-[-0.01em]">{t("Log")}</h1>

					{/* Amber while following, because the page is taking lines as they
					    happen; grey once paused. */}
					<span className={cn("flex items-center gap-2 text-[13px]", paused ? "text-fg-muted" : "text-tally-ink")}>
						<span className={cn("size-2 rounded-full transition-colors", paused ? "bg-fg-muted/50" : "bg-tally")} />
						{paused ? t("Paused") : t("Following")}
					</span>

					<button
						type="button"
						onClick={() => setPaused((was) => !was)}
						className={cn(
							"pressable ml-auto flex h-8 items-center gap-1.5 rounded-[10px] bg-surface-hi px-3 text-[13px] outline-none",
							"hover:bg-surface-hi-hover active:bg-surface-hi-press focus-visible:ring-2 focus-visible:ring-fg/70 pointer-coarse:h-11",
						)}
					>
						{paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
						{paused ? t("Follow") : t("Pause")}
					</button>
				</div>
				<p className="max-w-[72ch] text-fg-muted text-[13px] leading-relaxed">
					{t("Lines this server has written since it started, newest first, read from its memory, so this page opens even while the store or the relays are failing.")}
				</p>
			</header>

			{error && <Failed>{t("Could not read the log: {reason}", { reason: error })}</Failed>}

			<Section
				title={t("Lines")}
				note={problems > 0 ? t("{count} warnings and errors", { count: problems }) : undefined}
			>
				<div className="flex flex-wrap items-center gap-2">
					<div role="radiogroup" aria-label={t("Show")} className="flex shrink-0 gap-0.5 rounded-[10px] bg-surface-hi p-0.5">
						{FILTERS.map((one) => (
							<button
								key={one.key}
								type="button"
								role="radio"
								aria-checked={filter === one.key}
								onClick={() => setFilter(one.key)}
								className={cn(
									"pressable h-7 whitespace-nowrap rounded-[8px] px-2.5 text-[12.5px] outline-none pointer-coarse:h-9",
									"focus-visible:ring-2 focus-visible:ring-fg/70",
									filter === one.key
										? "bg-surface-hi-press font-medium text-fg day:bg-surface day:shadow-[0_1px_2px_rgb(0_0_0/0.12)]"
										: "text-fg-muted hover:text-fg",
								)}
							>
								{t(one.label)}
							</button>
						))}
					</div>

					<label className="relative ml-auto flex min-w-[12rem] flex-1 sm:max-w-xs">
						<Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-fg-muted" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("Search the log")}
							aria-label={t("Search the log")}
							className={cn(
								"h-9 w-full rounded-[10px] border border-border bg-surface pr-3 pl-9 text-[14px] outline-none",
								"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30 pointer-coarse:h-11 pointer-coarse:text-base",
							)}
						/>
					</label>
				</div>

				<Group>
					{!asked && <span className="block h-24" aria-hidden />}
					{asked && shown.length === 0 && (
						<p className="animate-fade-in px-4 py-5 text-fg-muted text-[13.5px]">
							{lines.length === 0 ? t("Nothing logged yet.") : t("Nothing matches.")}
						</p>
					)}

					{shown.map((line, index) => {
						const newDay = index === 0 || dayOf(line.at) !== dayOf(shown[index - 1]?.at ?? "");

						return (
							<div key={line.seq}>
								{newDay && (
									<div className="border-border border-b bg-surface-hi/50 px-4 py-1.5 text-fg-muted text-[12px] first:rounded-t-[14px] day:bg-bg/60">
										{dayOf(line.at)}
									</div>
								)}
								<Row inset={16}>
									<Entry line={line} />
								</Row>
							</div>
						);
					})}

					{missed && (
						<p className="border-border border-t px-4 py-3 text-fg-muted text-[12.5px]">
							{t("Older lines are no longer held here. The full log is the server's process log.")}
						</p>
					)}
				</Group>
			</Section>

			<Settings onSignedOut={onSignedOut} />
		</div>
	);
}

/** How many lines the page holds, and how many it draws at once. */
const KEPT = 2000;
const SHOWN = 400;

const FILTERS = [
	{ key: "all", label: "Everything" },
	{ key: "problems", label: "Problems" },
	{ key: "actions", label: "Administrator actions" },
] as const;

type Filter = (typeof FILTERS)[number]["key"];

/** Whether a line is the record of something an administrator did (internal/admin/audit.go). */
function acted(line: LogLine): boolean {
	return line.message === "an administrative action was taken" || line.message === "an administrative action was refused";
}

/**
 * The message a sign-in lockout is written under as it begins
 * (internal/admin/lockouts.go, LockedOut). Matched exactly, as the
 * administrators' actions are.
 */
const LOCKED_OUT = "a caller was shut out of signing in";

function dayOf(iso: string): string {
	return new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric", weekday: "short" });
}

/**
 * One line.
 *
 * The time, the level as a word where it is not ordinary, the message as the
 * server wrote it, and what it said about it. An administrator's action is read
 * out as who did what to what, which is the sentence the audit page used to
 * say, rather than as six key and value pairs.
 */
function Entry({ line }: { line: LogLine }) {
	const t = useT();

	const attrs = line.attrs ?? [];
	const by = Object.fromEntries(attrs.map((attr) => [attr.key, attr.value]));
	const action = acted(line);

	if (line.message === LOCKED_OUT) return <LockedOut line={line} by={by} />;

	const rest = action ? attrs.filter((attr) => !["action", "name", "target", "trip"].includes(attr.key)) : attrs;

	return (
		<div className="flex gap-3 px-4 py-2.5">
			<span className="w-[4.5rem] shrink-0 pt-px text-fg-muted text-[12.5px] tabular-nums">
				{new Date(line.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
			</span>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
					{line.level === "error" && <Level tone="danger">{t("error")}</Level>}
					{line.level === "warn" && <Level tone="tally">{t("warning")}</Level>}
					{action && <Level tone="quiet">{t("Administrator")}</Level>}

					{action ? (
						<span className="min-w-0 break-words">
							<span className="font-medium">{by.name || by.trip}</span> {by.action}
							{by.target && <span className="readout"> {by.target}</span>}
							{line.message === "an administrative action was refused" && (
								<span className="text-danger-ink"> {t("refused")}</span>
							)}
						</span>
					) : (
						<span className={cn("min-w-0 break-words", line.level === "debug" && "text-fg-muted")}>{line.message}</span>
					)}
				</p>

				{rest.length > 0 && (
					<p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-fg-muted">
						{rest.map((attr) => (
							<span key={attr.key} className="min-w-0 break-all">
								<span>{attr.key}</span> <span className="readout text-fg">{attr.value}</span>
							</span>
						))}
					</p>
				)}
			</div>
		</div>
	);
}

/**
 * A sign-in lockout as it began, said in the reader's words from the parts
 * the server wrote: the address, when it ends in the reader's own time, how
 * many failures and at which sign-in, and the device. It used to arrive as an
 * administrator's action that nobody took, under that tag, with a dash for a
 * name and its particulars as a sentence of English with a UTC timestamp.
 * The lockouts in force are on the accounts page, which is where they are
 * lifted; this is the record that one began.
 */
function LockedOut({ line, by }: { line: LogLine; by: Record<string, string> }) {
	const t = useT();

	const failures = Number.parseInt(by.failures ?? "", 10);
	const client = clientOf(by);

	return (
		<div className="flex gap-3 px-4 py-2.5">
			<span className="w-[4.5rem] shrink-0 pt-px text-fg-muted text-[12.5px] tabular-nums">
				{new Date(line.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
			</span>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
					<Level tone="tally">{t("warning")}</Level>
					<Level tone="quiet">{t("Sign-in lockout")}</Level>
					<span className="min-w-0 break-words">
						<span className="readout font-medium">{by.address}</span>{" "}
						{by.until && <span className="tabular-nums">{t("Shut out until {time}", { time: clock(by.until) })}</span>}
					</span>
				</p>

				<p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-fg-muted">
					{by.seen && <span className="readout min-w-0 break-all">{by.seen}</span>}
					{Number.isFinite(failures) && (
						<span className="whitespace-nowrap">{t("{count} failed sign-ins", { count: failures })}</span>
					)}
					{by.doors && <span>{doors(t, by.doors.split(","))}</span>}
					{client ? (
						<DeviceLine client={client} className="min-w-0" />
					) : (
						by.device && <span className="readout min-w-0 break-words text-fg">{by.device}</span>
					)}
				</p>
			</div>
		</div>
	);
}

/**
 * The device a lockout was written with, in the parts the accounts page's list
 * is given (internal/admin/lockouts.go, clientParts), so the two pages name the
 * same phone the same way. Nothing for a line without them — one written
 * before they were, or for a caller whose device was never read — which then
 * shows the server's own words, as every lockout used to.
 */
function clientOf(by: Record<string, string>): Client | undefined {
	const kind = by["client.kind"];
	if (!kind) return undefined;

	const client: Client = { kind };
	for (const key of ["app", "browser", "system", "device"] as const) {
		const value = by[`client.${key}`];
		if (value) client[key] = value;
	}

	return client;
}

function Level({ tone, children }: { tone: "danger" | "tally" | "quiet"; children: string }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-2 py-px text-[11.5px] font-medium",
				tone === "danger" && "bg-danger/15 text-danger-ink day:bg-danger/8",
				tone === "tally" && "bg-tally/15 text-tally-ink",
				tone === "quiet" && "bg-surface-hi text-fg-muted",
			)}
		>
			{children}
		</span>
	);
}

/**
 * What the process is running with, which the runtime page showed.
 *
 * What it resolved to, not what the file says. More than one afternoon has gone
 * into working out whether a setting took effect — reading the source of the
 * thing that consumes it to find out that one field is quietly overwritten by
 * another. The process knows. It may as well answer.
 *
 * Shut until asked for, and only asked for then, so the log page asks the
 * server for the log and nothing else on opening. The API key is here and the
 * secret is not: the key names which credential is in use, which is the
 * question anybody has; the secret signs tokens for every room on this
 * deployment, and no page is a reason to put that on a screen.
 */
function Settings({ onSignedOut }: { onSignedOut: () => void }) {
	const t = useT();

	const [open, setOpen] = useState(false);
	const body = useLingering(open, 180);

	return (
		<Section
			title={t("Settings this server is running with")}
			actions={
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((was) => !was)}
					className={cn(
						"pressable flex h-8 items-center gap-1 rounded-[10px] px-2.5 text-[13px] text-fg-muted outline-none",
						"hover:bg-wash hover:text-fg focus-visible:ring-2 focus-visible:ring-fg/70 pointer-coarse:h-11",
					)}
				>
					{open ? t("Hide") : t("Show")}
					<ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} />
				</button>
			}
		>
			{body.mounted && (
				<div className={body.leaving ? "animate-depart" : "animate-arrive"}>
					<Running onSignedOut={onSignedOut} />
				</div>
			)}
		</Section>
	);
}

function Running({ onSignedOut }: { onSignedOut: () => void }) {
	const t = useT();

	// Once a minute. This changes when somebody restarts the server, and not
	// otherwise.
	const { value, error } = usePoll(api.runtime, { every: 60_000, onSignedOut });

	return (
		<div className="flex flex-col gap-5">
			{error && <Failed>{error}</Failed>}

			<Block title={t("Application")}>
				<Rows values={value?.meet} />
			</Block>

			<Block title={t("Media")} note={t("What clients are told to dial")}>
				<Rows values={value?.rtc} />
			</Block>

			<Block title={t("Rooms")} note={t("Who can start one")}>
				<Opening policy={value?.rooms} />
			</Block>

			<Block title={t("Codecs")}>
				<p className="readout px-4 py-3 text-[12.5px] text-fg-muted">{value?.codecs.join(", ") ?? "—"}</p>
			</Block>

			<Block title={t("Credentials")} note={t("The secret is never shown")}>
				<Rows values={value?.credentials} />
			</Block>
		</div>
	);
}

function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<p className="px-1 text-[13px]">
				<span className="font-medium">{title}</span>
				{note && <span className="ml-2 text-fg-muted">{note}</span>}
			</p>
			<Group>{children}</Group>
		</div>
	);
}

/**
 * The one setting on this server that a configuration file no longer decides.
 *
 * Given three lines rather than one because the interesting readings are the
 * disagreements. A file edited after first run is obeyed by nothing and looks
 * exactly like a file that is; a policy naming administrators on a deployment
 * that has none is a rule nothing can satisfy and looks exactly like a rule in
 * force. Both are silent, and this exists for the settings whose real value is
 * not the one somebody wrote down.
 */
function Opening({ policy }: { policy?: Policy }) {
	if (!policy) return <p className="px-4 py-3 text-fg-muted text-[13px]">—</p>;

	return (
		<Rows
			values={{
				"in effect": words(policy.openedBy),
				chosen: words(policy.chosen),
				configured: words(policy.configured),
			}}
		/>
	);
}

function Rows({ values }: { values?: Record<string, unknown> }) {
	if (!values) return <p className="px-4 py-3 text-fg-muted text-[13px]">—</p>;

	return (
		// Name above value while narrow, beside it once there is room. A label
		// column of nine rems leaves under two hundred points for a value on a
		// phone, and the values here are addresses and lists.
		<dl className="grid sm:grid-cols-[minmax(9rem,auto)_1fr]">
			{Object.entries(values).map(([name, value], index) => (
				<div
					key={name}
					className={cn(
						"grid gap-0.5 px-4 py-2.5 sm:col-span-2 sm:grid-cols-subgrid sm:gap-4",
						index > 0 && "border-border border-t",
					)}
				>
					<dt className="text-fg-muted text-[12.5px]">{name}</dt>
					<dd className="readout min-w-0 break-words text-[12.5px] tabular-nums">{show(value)}</dd>
				</div>
			))}
		</dl>
	);
}

function show(value: unknown): string {
	if (value === "" || value === null || value === undefined) return "—";
	if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
	if (typeof value === "boolean") return value ? "true" : "false";

	// A setting that is a group of settings, which meet.watch is: whether there
	// is a gateway, whether the file relays nothing, and whether the switch in
	// the store relays Emby anyway. One line of name and value pairs, in the
	// file's own words, because String() of an object is "[object Object]" and
	// that is what this row said the first time it was sent.
	if (typeof value === "object") {
		const pairs = Object.entries(value as Record<string, unknown>);

		return pairs.length === 0 ? "—" : pairs.map(([name, one]) => `${name} ${show(one)}`).join(", ");
	}

	return String(value);
}
