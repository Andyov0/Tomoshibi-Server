import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { LOCALE_NAMES, type Locale, type Phrase } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { Button } from "@/components/ui/button";
import { AppWindow, ChevronDown, ChevronUp, Computer, Loader2, Monitor, Plus, Smartphone, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type AppNotice, type AppSwitch, api, type NoticeSlot } from "./api";
import { Tick } from "./Boxes";
import { Group, Row, Section, quietIcon } from "./Grouped";
import { Note } from "./OpeningCard";
import { usePoll } from "./poll";
import { Card, Empty, Failed, Waiting } from "./Shell";
import { moment, size, typed } from "./units";

/**
 * What the apps are told between their releases: the lobby's notice and which
 * of their features are off.
 *
 * Both are sections of remote.json in the apps' directory, which the apps ask
 * for and keep (internal/remote has the file's argument). The other two
 * sections, the apps' phrases and a handful of numbers, are edited in the file
 * by whoever looks after it and are not on this page: a translation is read
 * beside its dictionary, and the numbers are settings nobody should be moving
 * from a phone at two in the morning.
 *
 * Its own panel rather than a card on the rooms page beside the other
 * deployment-wide switches, because it is about a different audience. Those
 * decide what happens to calls in a browser; these decide what every app on
 * every platform shows, and someone looking for "why has screen sharing gone
 * on my phone" should find the answer under the apps.
 *
 * The server checks every press regardless of what is offered here; the
 * settings capability decides what is offered, and the rest is read only.
 */
export function AppsPanel({
	canSettings,
	onSignedOut,
}: {
	canSettings: boolean;
	onSignedOut: () => void;
}) {
	const t = useT();

	return (
		<div className="mx-auto flex max-w-[56rem] flex-col gap-7">
			<header className="flex flex-col gap-1 px-1">
				<h1 className="font-semibold text-[22px] leading-tight tracking-[-0.01em]">{t("Apps")}</h1>
				<p className="max-w-[64ch] text-[13.5px] text-fg-muted">
					{t("Which version each app is handed, and what the apps are told between releases: a notice in their lobby and features turned off.")}
				</p>
			</header>

			<Versions onSignedOut={onSignedOut} />
			<NoticeCard kind="signin" canSettings={canSettings} onSignedOut={onSignedOut} />
			<NoticeCard kind="lobby" canSettings={canSettings} onSignedOut={onSignedOut} />
			<SwitchesCard canSettings={canSettings} onSignedOut={onSignedOut} />
		</div>
	);
}

/** The languages a notice is written in, in the order the apps' owner lists them. */
const LANGUAGES = ["zh-Hans", "zh-Hant", "ja", "en"] as const satisfies readonly Locale[];
type Language = (typeof LANGUAGES)[number];

/** As internal/remote holds a notice to: characters, not bytes. */
const NOTICE_LENGTH = 500;

type Words = Record<Language, string>;

const NO_WORDS: Words = { "zh-Hans": "", "zh-Hant": "", ja: "", en: "" };

/**
 * The id a notice is published under: the moment, in UTC, to the second.
 *
 * Not the day and a count, which is what the example in the file's description
 * reads like. A count has to be worked out from the notice before, and after
 * a notice is taken down there is no notice before: the next one published
 * that day would be given the id of the one taken down, and everybody who had
 * closed that one would never be shown it. A moment cannot come round again.
 */
export function noticeId(at: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");

	return (
		`${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-` +
		`${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
	);
}

/** How long a piece of text is as the server counts it, which is by code point. */
function characters(text: string): number {
	return [...text].length;
}

/**
 * The lobby's notice.
 *
 * The form is filled from the notice in the file when one arrives, so that
 * correcting a word is editing what is there rather than typing it out again;
 * and it is filled only when the notice changes, and never over something being
 * typed. It was tempting to fill it on every poll, which is what the relay
 * settings once did and lost somebody's half-typed address to.
 *
 * Every publish is a new notice with a new id, an edit included. An app that
 * was closed on the old words is shown the new ones, which is what an edit is
 * for; republishing the same words to somebody who already read them is the
 * smaller cost.
 */
/*
 * One card for each notice, the same form for both: the sign-in page's, for
 * people not signed in, first, as the sign-in comes first; then the lobby's,
 * for people signed in. They were one until the owner saw the lobby's on the
 * sign-in page and asked for them to be set apart.
 */
function NoticeCard({
	kind,
	canSettings,
	onSignedOut,
}: { kind: NoticeSlot; canSettings: boolean; onSignedOut: () => void }) {
	const t = useT();

	// Twice a minute. A notice changes when somebody presses publish, usually
	// on this page, and the press reads it back at once.
	const read = useCallback(() => api.notice(kind), [kind]);
	const { value, error, refresh } = usePoll(read, { every: 30_000, onSignedOut });

	const failure = useRef(error);
	if (error) failure.current = error;

	const [words, setWords] = useState<Words>(NO_WORDS);
	const [level, setLevel] = useState<AppNotice["level"]>("info");
	const [until, setUntil] = useState("");
	const [busy, setBusy] = useState<"publish" | "down">();

	const form = JSON.stringify({ words, level, until });

	// Which notice the form was last filled from, and the form as it was then,
	// so that a notice arriving from elsewhere does not overwrite one being
	// written here.
	const filled = useRef<{ id: string | null; form: string }>(undefined);

	// The reading arriving is the event, not something the effect reads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the poll is the trigger, not the input
	useEffect(() => {
		if (!value) return;

		const notice = value.notice;

		if (!notice) {
			filled.current ??= { id: null, form };
			return;
		}

		if (filled.current?.id === notice.id) return;
		if (filled.current && filled.current.form !== form) return;

		const next = {
			words: Object.fromEntries(LANGUAGES.map((one) => [one, notice.text[one] ?? ""])) as Words,
			level: notice.level,
			until: notice.until ? typed(new Date(notice.until)) : "",
		};

		setWords(next.words);
		setLevel(next.level);
		setUntil(next.until);

		filled.current = { id: notice.id, form: JSON.stringify(next) };
	}, [value]);

	const said = LANGUAGES.filter((one) => words[one].trim() !== "");
	const ended = until !== "" && new Date(until).getTime() <= Date.now();
	const locked = !canSettings || busy !== undefined;

	const publish = useCallback(async () => {
		const notice: AppNotice = {
			id: noticeId(new Date()),
			level,
			text: Object.fromEntries(said.map((one) => [one, words[one].trim()])),
		};

		if (until) notice.until = new Date(until).toISOString();

		setBusy("publish");

		try {
			await api.publishNotice(kind, notice);
			filled.current = { id: notice.id, form };
			await refresh();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	}, [form, kind, level, refresh, said, until, words]);

	const takeDown = useCallback(async () => {
		setBusy("down");

		try {
			await api.takeDownNotice(kind);
			await refresh();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	}, [kind, refresh]);

	// The notice on screen kept while it leaves, which by then the reading no
	// longer holds.
	const shown = useRef(value?.notice ?? undefined);
	if (value?.notice) shown.current = value.notice;

	const offer = useLingering(canSettings && value?.notice != null);

	return (
		<Card
			title={kind === "lobby" ? t("Lobby notice") : t("Sign-in page notice")}
			note={
				kind === "lobby"
					? t("For people signed in: shown at the top of the lobby, until its end or until it is taken down")
					: t("For people not signed in: shown at the top of the sign-in page, until its end or until it is taken down")
			}
		>
			<Said show={error !== undefined}>
				<Failed>{failure.current}</Failed>
			</Said>

			<Said show={value === undefined && error === undefined}>
				<Waiting rows={2} />
			</Said>

			<Said show={value?.notice != null}>
				{shown.current && <Current notice={shown.current} showing={value?.showing ?? false} />}
			</Said>

			<Said show={value !== undefined && value.notice === null}>
				<Empty>{t("No notice is being shown.")}</Empty>
			</Said>

			<div className="flex flex-col gap-4 border-border border-t px-4 py-4">
				<div className="grid gap-3 sm:grid-cols-2">
					{LANGUAGES.map((one) => (
						<label key={one} className="flex flex-col gap-1">
							<span className="text-[12.5px] text-fg-muted">{LOCALE_NAMES[one]}</span>
							<textarea
								value={words[one]}
								lang={one}
								// Named on its own, since the label around it holds the
								// count as well as the language.
								aria-label={LOCALE_NAMES[one]}
								rows={3}
								// UTF-16 units, which are never fewer than the
								// characters the server counts, so nothing the
								// field takes is refused for its length.
								maxLength={NOTICE_LENGTH}
								disabled={locked}
								onChange={(event) => {
									const next = event.target.value;
									setWords((held) => ({ ...held, [one]: next }));
								}}
								className={cn(
									"w-full resize-y rounded-[10px] border border-border bg-bg px-3 py-2 text-[14px] leading-relaxed",
									"outline-none focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30 disabled:opacity-50 pointer-coarse:text-base",
								)}
							/>
							<span className="self-end text-[11.5px] text-fg-muted tabular-nums">
								{characters(words[one])}/{NOTICE_LENGTH}
							</span>
						</label>
					))}
				</div>

				<div className="flex flex-wrap items-end gap-x-5 gap-y-3">
					<div className="flex flex-col gap-1">
						<span className="text-[12.5px] text-fg-muted">{t("Level")}</span>
						<Pair
							label={t("Level")}
							chosen={level === "warning" ? 1 : 0}
							choices={[t("Normal"), t("Warning")]}
							disabled={locked}
							onChoose={(at) => setLevel(at === 1 ? "warning" : "info")}
						/>
					</div>

					<label className="flex flex-col gap-1">
						<span className="text-[12.5px] text-fg-muted">{t("Until")}</span>
						<input
							type="datetime-local"
							value={until}
							disabled={locked}
							onChange={(event) => setUntil(event.target.value)}
							className="h-9 rounded-[10px] border border-border bg-bg px-3 text-[13.5px] outline-none focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30 disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:text-base"
						/>
					</label>

					<p className="pb-2 text-[12px] text-fg-muted">{t("Left empty, it shows until it is taken down.")}</p>
				</div>

				<Said show={ended}>
					<Note kind="warn">{t("That time has already gone.")}</Note>
				</Said>

				<Note kind="quiet">
					{t("Fill in at least one language. Each publish is a new notice, so somebody who closed the last one is shown this one.")}
				</Note>

				{canSettings ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="primary"
							size="sm"
							disabled={locked || said.length === 0 || ended}
							onClick={() => void publish()}
						>
							<Spinning show={busy === "publish"} />
							{t("Publish")}
						</Button>

						{offer.mounted && (
							<Button
								variant="secondary"
								size="sm"
								disabled={locked}
								onClick={() => void takeDown()}
								className={cn("text-danger-ink", offer.leaving ? "animate-fade-out" : "animate-fade-in")}
							>
								<Spinning show={busy === "down"} />
								{t("Take down")}
							</Button>
						)}
					</div>
				) : (
					<Note kind="quiet">{t("You can view this but not change it.")}</Note>
				)}
			</div>
		</Card>
	);
}

/** The notice in the file, as the apps are shown it. */
function Current({ notice, showing }: { notice: AppNotice; showing: boolean }) {
	const t = useT();

	return (
		// Keyed by the notice, so that one notice replaced by another arrives
		// rather than having its words change underneath somebody reading them.
		<div key={notice.id} className="flex animate-fade-in flex-col gap-2.5 px-4 py-4">
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				{/* Lit while the apps are showing it, which is the notice being
				    live in the sense the amber means; grey once it has ended. */}
				<span className={cn("size-2 rounded-full", showing ? "bg-tally" : "bg-fg-muted/50")} aria-hidden />
				<span className={cn("text-[13.5px]", showing ? "text-fg" : "text-fg-muted")}>
					{showing ? t("This is being shown now.") : t("This has ended, and is no longer shown.")}
				</span>
				<span
					className={cn(
						"rounded-full px-2 py-px text-[11.5px]",
						notice.level === "warning" ? "bg-tally/15 text-tally-ink" : "bg-surface-hi text-fg-muted",
					)}
				>
					{t(notice.level === "warning" ? "Warning" : "Normal")}
				</span>
				<span className="readout ml-auto text-[11.5px] text-fg-muted">{notice.id}</span>
			</div>

			<p className="text-[12.5px] text-fg-muted">
				{notice.until
					? t("Until {time}", { time: moment(notice.until, 3600) })
					: t("Until it is taken down")}
			</p>

			<dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(6rem,auto)_1fr]">
				{LANGUAGES.filter((one) => notice.text[one]).map((one) => (
					<div key={one} className="contents">
						<dt className="text-[12.5px] text-fg-muted sm:pt-0.5">{LOCALE_NAMES[one]}</dt>
						<dd lang={one} className="whitespace-pre-wrap text-[14px] leading-relaxed">
							{notice.text[one]}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

/** The features a switch is offered for here. The file may name others, which are kept. */
export const FEATURES = ["screen-share", "background-blur", "watch-together", "music", "app-updates"] as const;
type Feature = (typeof FEATURES)[number];

const FEATURE_NAMES: Record<Feature, Phrase> = {
	"screen-share": "Screen sharing",
	"background-blur": "Background blur",
	"watch-together": "Watch together",
	music: "Music",
	"app-updates": "In-app updates",
};

/**
 * The platforms a rule may name, as the server reads the apps' user agents.
 * Their own names in every language, as the language picker's are.
 *
 * The file may say ios for both of Apple's phones and tablets; it is drawn here
 * as both ticked, and saved as both.
 */
const PLATFORMS = [
	{ key: "mac", name: "Mac" },
	{ key: "iphone", name: "iPhone" },
	{ key: "ipad", name: "iPad" },
	{ key: "android", name: "Android" },
	{ key: "windows", name: "Windows" },
	{ key: "linux", name: "Linux" },
] as const;

/** What a rule's from and below may be, as internal/remote holds them to. */
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;

/**
 * Whether a is a later version than b, by the rule the server compares them by
 * (internal/app/apps.go, newerVersion): dotted parts in order, as numbers where
 * both are, as text where either is not, and a longer form the later.
 *
 * Here only to say that a range holds no version before anybody saves it; what
 * the apps are told is worked out by the server alone.
 */
export function newer(a: string, b: string): boolean {
	const as = a.split(".");
	const bs = b.split(".");

	for (let at = 0; at < as.length && at < bs.length; at++) {
		const x = as[at] ?? "";
		const y = bs[at] ?? "";
		if (x === y) continue;

		if (/^[+-]?\d+$/.test(x) && /^[+-]?\d+$/.test(y)) return Number(x) > Number(y);

		return x > y;
	}

	return as.length > bs.length;
}

/** A rule as it is compared and saved: its platforms in the page's order, ios as both, and nothing empty. */
function tidy(rule: AppSwitch): AppSwitch {
	const kept: AppSwitch = { feature: rule.feature.trim(), off: rule.off };

	const platforms = expand(rule.platforms);
	if (platforms.length > 0) kept.platforms = platforms;

	const from = rule.from?.trim();
	if (from) kept.from = from;

	const below = rule.below?.trim();
	if (below) kept.below = below;

	const note = rule.note?.trim();
	if (note) kept.note = note;

	return kept;
}

function expand(platforms?: string[]): string[] {
	const named = new Set<string>();

	for (const one of platforms ?? []) {
		if (one === "ios") {
			named.add("iphone");
			named.add("ipad");
		} else {
			named.add(one);
		}
	}

	return PLATFORMS.map((one) => one.key).filter((key) => named.has(key));
}

/** A rule on the page, with a key of its own so that moving it moves it. */
interface Row {
	key: number;
	rule: AppSwitch;
	leaving: boolean;
}

/**
 * The feature switches, edited as one list and saved as one.
 *
 * Whole, because the order is what decides between two rules for one feature,
 * and a page that saved rules one at a time would be choosing an order nobody
 * looked at. Nothing goes to the server until Save, so a rule half written,
 * turning a feature off for every platform because no box is ticked yet, never
 * reaches an app.
 *
 * The list from the server replaces the one here only while nothing has been
 * changed here. When it moves underneath an edit, which is another
 * administrator saving, that is said rather than either list quietly winning.
 */
function SwitchesCard({ canSettings, onSignedOut }: { canSettings: boolean; onSignedOut: () => void }) {
	const t = useT();

	const { value, error, refresh } = usePoll(api.switches, { every: 30_000, onSignedOut });

	const failure = useRef(error);
	if (error) failure.current = error;

	const [rows, setRows] = useState<Row[]>();
	// The server's list the rows were drawn from, tidied, as text.
	const [base, setBase] = useState<string>();
	const [moved, setMoved] = useState(false);
	const [saving, setSaving] = useState(false);

	const counter = useRef(0);
	const fresh = useCallback(
		(list: AppSwitch[]): Row[] =>
			list.map((rule) => ({
				key: counter.current++,
				rule: { ...rule, platforms: expand(rule.platforms) },
				leaving: false,
			})),
		[],
	);

	const live = (rows ?? []).filter((row) => !row.leaving);
	const draft = JSON.stringify(live.map((row) => tidy(row.rule)));
	const dirty = rows !== undefined && draft !== base;

	// The reading arriving is the event, not something the effect reads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the poll is the trigger, not the input
	useEffect(() => {
		if (!value) return;

		const said = JSON.stringify(value.switches.map(tidy));

		if (rows === undefined || !dirty) {
			// Not drawn again when nothing changed, which would bring every
			// row in again on every poll.
			if (said !== base) {
				setRows(fresh(value.switches));
				setBase(said);
			}
			setMoved(false);
			return;
		}

		setMoved(said !== base);
	}, [value]);

	const change = useCallback((key: number, patch: Partial<AppSwitch>) => {
		setRows((held) => held?.map((row) => (row.key === key ? { ...row, rule: { ...row.rule, ...patch } } : row)));
	}, []);

	const remove = useCallback((key: number) => {
		setRows((held) => held?.map((row) => (row.key === key ? { ...row, leaving: true } : row)));

		// Gone once it has left, by the same clock the leaving animation runs on.
		window.setTimeout(() => setRows((held) => held?.filter((row) => row.key !== key)), 180);
	}, []);

	const move = useCallback((key: number, by: -1 | 1) => {
		setRows((held) => {
			if (!held) return held;

			const order = held.filter((row) => !row.leaving);
			const at = order.findIndex((row) => row.key === key);
			const to = at + by;
			if (at < 0 || to < 0 || to >= order.length) return held;

			const moving = order[at];
			const other = order[to];
			if (!moving || !other) return held;

			order[at] = other;
			order[to] = moving;

			return [...order, ...held.filter((row) => row.leaving)];
		});
	}, []);

	const add = useCallback(() => {
		setRows((held) => [
			...(held ?? []),
			{ key: counter.current++, rule: { feature: "screen-share", off: true, platforms: [] }, leaving: false },
		]);
	}, []);

	const discard = useCallback(() => {
		if (!value) return;

		setRows(fresh(value.switches));
		setBase(JSON.stringify(value.switches.map(tidy)));
		setMoved(false);
	}, [fresh, value]);

	const invalid = live.some(
		(row) => !versionOrNothing(row.rule.from) || !versionOrNothing(row.rule.below),
	);

	const save = useCallback(async () => {
		setSaving(true);

		try {
			const answer = await api.setSwitches(live.map((row) => tidy(row.rule)));
			const said = JSON.stringify(answer.switches.map(tidy));

			// Kept as drawn where the server wrote what was sent, which it
			// does; drawn again from its answer where it did not, so that what
			// is on screen is what the apps are told.
			if (said !== draft) setRows(fresh(answer.switches));

			setBase(said);
			setMoved(false);
			await refresh();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [draft, fresh, live, refresh]);

	const locked = !canSettings || saving;
	const unread = value?.unread ?? 0;

	return (
		<Card
			title={t("Feature switches")}
			note={t("Features turned off in the apps, by platform and version")}
			actions={
				canSettings && (
					<Button variant="secondary" size="sm" onClick={add} disabled={locked || rows === undefined}>
						<Plus />
						{t("Add a rule")}
					</Button>
				)
			}
		>
			<Said show={error !== undefined}>
				<Failed>{failure.current}</Failed>
			</Said>

			<Said show={rows === undefined && error === undefined}>
				<Waiting />
			</Said>

			<Said show={rows !== undefined && live.length === 0}>
				<Empty>{t("No rules, so every feature is on.")}</Empty>
			</Said>

			<div>
				{(rows ?? []).map((row) => {
					const at = live.indexOf(row);

					return (
						<SwitchRow
							key={row.key}
							rule={row.rule}
							leaving={row.leaving}
							first={at === 0}
							last={at === live.length - 1}
							disabled={locked}
							onChange={(patch) => change(row.key, patch)}
							onMove={(by) => move(row.key, by)}
							onRemove={() => remove(row.key)}
						/>
					);
				})}
			</div>

			<div className="flex flex-col gap-3 border-border border-t px-4 py-4">
				<Said show={unread > 0}>
					<Note kind="warn">
						{t("Some switches in the file could not be read and are not shown here. Saving replaces them with this list.")}
					</Note>
				</Said>

				<Said show={moved}>
					<Note kind="warn">
						{t("These were changed elsewhere since you began. Saving replaces that change with this list; discarding shows it.")}
					</Note>
				</Said>

				<Note kind="quiet">
					{t("A later rule overrides an earlier one for the same feature, so a narrower rule further down can turn a feature back on. With no platform ticked, a rule is for every platform.")}
				</Note>

				{canSettings ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="primary" size="sm" disabled={locked || !dirty || invalid} onClick={() => void save()}>
							<Spinning show={saving} />
							{t("Save")}
						</Button>

						<Button variant="ghost" size="sm" disabled={locked || !dirty} onClick={discard}>
							{t("Discard changes")}
						</Button>
					</div>
				) : (
					<Note kind="quiet">{t("You can view this but not change it.")}</Note>
				)}
			</div>
		</Card>
	);
}

function versionOrNothing(said?: string): boolean {
	const trimmed = said?.trim() ?? "";

	return trimmed === "" || VERSION.test(trimmed);
}

/** One rule, every part of it editable where it is. */
function SwitchRow({
	rule,
	leaving,
	first,
	last,
	disabled,
	onChange,
	onMove,
	onRemove,
}: {
	rule: AppSwitch;
	leaving: boolean;
	first: boolean;
	last: boolean;
	disabled: boolean;
	onChange: (patch: Partial<AppSwitch>) => void;
	onMove: (by: -1 | 1) => void;
	onRemove: () => void;
}) {
	const t = useT();

	const known = (FEATURES as readonly string[]).includes(rule.feature);
	const ticked = new Set(rule.platforms ?? []);

	const from = rule.from?.trim() ?? "";
	const below = rule.below?.trim() ?? "";
	const fromBad = !versionOrNothing(from);
	const belowBad = !versionOrNothing(below);

	// A range nothing is inside: from at or past below. The server would keep
	// it and it would hold for no app, which is a rule that looks like it is
	// doing something.
	const nothing = from !== "" && below !== "" && !fromBad && !belowBad && !newer(below, from);

	const field = cn(
		"readout h-9 w-full rounded-[10px] border border-border bg-bg px-3 text-[13px] outline-none",
		"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30 disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:text-base",
	);

	return (
		<div
			className={cn(
				"flex flex-col gap-3 border-border border-t px-4 py-4 first:border-t-0",
				leaving ? "pointer-events-none animate-depart" : "animate-arrive",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<select
					value={rule.feature}
					disabled={disabled}
					aria-label={t("Feature")}
					onChange={(event) => onChange({ feature: event.target.value })}
					className={cn(
						"h-9 rounded-[10px] border border-border bg-bg px-2.5 font-medium text-[14px] text-fg pointer-coarse:h-11",
						"outline-none transition-colors hover:border-fg/20",
						"focus-visible:ring-2 focus-visible:ring-fg/40 disabled:opacity-40",
					)}
				>
					{FEATURES.map((one) => (
						<option key={one} value={one}>
							{t(FEATURE_NAMES[one])}
						</option>
					))}
					{/* One the file names and this page does not, kept as it is
					    so that saving does not quietly turn it into another. */}
					{!known && <option value={rule.feature}>{rule.feature}</option>}
				</select>

				<Pair
					label={known ? t(FEATURE_NAMES[rule.feature as Feature]) : rule.feature}
					chosen={rule.off ? 0 : 1}
					choices={[t("Off"), t("On")]}
					disabled={disabled}
					onChoose={(at) => onChange({ off: at === 0 })}
				/>

				<span className="ml-auto flex items-center gap-1">
					<button
						type="button"
						disabled={disabled || first}
						onClick={() => onMove(-1)}
						aria-label={t("Move up")}
						className={quietIcon}
					>
						<ChevronUp />
					</button>
					<button
						type="button"
						disabled={disabled || last}
						onClick={() => onMove(1)}
						aria-label={t("Move down")}
						className={quietIcon}
					>
						<ChevronDown />
					</button>
					<button
						type="button"
						disabled={disabled}
						onClick={onRemove}
						aria-label={t("Remove rule")}
						className={cn(quietIcon, "hover:text-danger-ink")}
					>
						<Trash2 />
					</button>
				</span>
			</div>

			<div role="group" aria-label={t("Platforms")} className="flex flex-wrap items-center gap-x-5 gap-y-1">
				{PLATFORMS.map((one) => (
					<label
						key={one.key}
						className={cn("flex min-h-8 items-center gap-2.5 text-[13.5px] pointer-coarse:min-h-11", disabled ? "opacity-60" : "cursor-pointer")}
					>
						<Tick
							label={one.name}
							checked={ticked.has(one.key)}
							disabled={disabled}
							onChange={(on) => {
								const next = new Set(ticked);
								if (on) next.add(one.key);
								else next.delete(one.key);
								onChange({ platforms: PLATFORMS.map((p) => p.key).filter((key) => next.has(key)) });
							}}
						/>
						{one.name}
					</label>
				))}
			</div>

			<div className="grid grid-cols-2 gap-3 sm:grid-cols-[9rem_9rem_1fr]">
				<label className="flex flex-col gap-1">
					<span className="text-[12.5px] text-fg-muted">{t("From version")}</span>
					<input
						value={rule.from ?? ""}
						disabled={disabled}
						// Not an example version, which drawn in grey in an empty
						// field read as a bound the rule did not have.
						placeholder={t("Any version")}
						aria-invalid={fromBad || undefined}
						onChange={(event) => onChange({ from: event.target.value })}
						className={cn(field, fromBad && "border-tally")}
					/>
				</label>

				<label className="flex flex-col gap-1">
					<span className="text-[12.5px] text-fg-muted">{t("Below version")}</span>
					<input
						value={rule.below ?? ""}
						disabled={disabled}
						placeholder={t("Any version")}
						aria-invalid={belowBad || undefined}
						onChange={(event) => onChange({ below: event.target.value })}
						className={cn(field, belowBad && "border-tally")}
					/>
				</label>

				<label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
					<span className="text-[12.5px] text-fg-muted">{t("Note")}</span>
					<input
						value={rule.note ?? ""}
						disabled={disabled}
						maxLength={500}
						placeholder={t("Why, for whoever reads this next")}
						onChange={(event) => onChange({ note: event.target.value })}
						className={cn(field, "font-sans")}
					/>
				</label>
			</div>

			<Said show={fromBad || belowBad}>
				<Note kind="warn">{t("That is not a version.")}</Note>
			</Said>

			<Said show={nothing}>
				<Note kind="warn">{t("No version is from {from} and below {below}, so this rule holds for no app.", { from, below })}</Note>
			</Said>
		</div>
	);
}

/**
 * Two answers to one question, side by side: a notice's level, a rule's off or
 * on. Radios rather than a checkbox, because "on" unticked does not say that
 * the rule turns the feature off, and that is what most of these rules do.
 */
function Pair({
	label,
	chosen,
	choices,
	disabled,
	onChoose,
}: {
	label: string;
	chosen: 0 | 1;
	choices: [string, string];
	disabled: boolean;
	onChoose: (at: 0 | 1) => void;
}) {
	return (
		<div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-[10px] bg-surface-hi p-0.5">
			{choices.map((choice, at) => (
				<button
					key={choice}
					type="button"
					role="radio"
					aria-checked={chosen === at}
					disabled={disabled}
					onClick={() => onChoose(at as 0 | 1)}
					className={cn(
						"pressable h-7 rounded-[8px] px-3 text-[13px] outline-none pointer-coarse:h-9",
						"focus-visible:ring-2 focus-visible:ring-fg/70",
						chosen === at
							? "bg-surface-hi-press font-medium text-fg day:bg-surface day:shadow-[0_1px_2px_rgb(0_0_0/0.12)]"
							: "text-fg-muted hover:text-fg",
						disabled && "cursor-not-allowed opacity-60",
					)}
				>
					{choice}
				</button>
			))}
		</div>
	);
}

/** A spinner inside a button, which comes and goes with the request it is for. */
function Spinning({ show }: { show: boolean }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return (
		<span className={cn("inline-flex", leaving ? "animate-fade-out" : "animate-fade-in")}>
			<Loader2 className="size-4 animate-spin" />
		</span>
	);
}

/** Something that is there while it is true, and fades either way. */
function Said({ show, children }: { show: boolean; children: ReactNode }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return <div className={cn(leaving ? "animate-fade-out" : "animate-fade-in")}>{children}</div>;
}

/** The platforms in the order the download page lists them, with what each is called. */
const SHELVES: { key: string; name: Phrase; Icon: typeof Smartphone; note?: Phrase }[] = [
	{ key: "mac", name: "Mac app", Icon: AppWindow },
	{ key: "windows", name: "Windows app", Icon: Monitor },
	{ key: "android", name: "Android app", Icon: Smartphone },
	{ key: "linux-x86_64", name: "Linux app (x86-64)", Icon: Computer },
	{ key: "linux-aarch64", name: "Linux app (ARM64)", Icon: Computer },
	{ key: "ios", name: "iPhone app", Icon: Smartphone, note: "Installed through TestFlight, so this is what it is told is newest." },
];

/**
 * Which version of each app is being handed out.
 *
 * The question asked first about the apps and the one this page could not
 * answer: it said what the apps are told between releases and not which
 * release they are on. Read from the same manifest and the same checks the
 * download page uses, so a build whose file is still being copied in is shown
 * as not offered rather than as the current version.
 */
function Versions({ onSignedOut }: { onSignedOut: () => void }) {
	const t = useT();

	// Rarely: a build is copied in by hand, a few times a month.
	const { value, error } = usePoll(api.apps, { every: 60_000, onSignedOut });

	const by = new Map((value?.platforms ?? []).map((one) => [one.platform, one]));

	return (
		<Section
			title={t("Versions handed out")}
			note={value && !value.configured ? t("This deployment has no apps directory (meet.apps.mac_dir), so there is nowhere to keep this.") : undefined}
		>
			{error && <Failed>{error}</Failed>}
			<Group>
				{value === undefined && <span className="block h-24" aria-hidden />}
				{value?.configured &&
					SHELVES.map((shelf) => {
						const one = by.get(shelf.key);

						return (
							<Row key={shelf.key} inset={48}>
								<div className="flex items-center gap-3.5 px-4 py-3">
									<shelf.Icon className="size-[18px] shrink-0 text-fg-muted" />
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="text-[14px]">{t(shelf.name)}</span>
										{shelf.note && <span className="text-[12px] text-fg-muted">{t(shelf.note)}</span>}
									</div>
									{one?.available ? (
										<span className="flex flex-col items-end">
											<span className="readout text-[14px]">{one.version}</span>
											{one.size ? <span className="text-[12px] text-fg-muted tabular-nums">{size(one.size)}</span> : null}
										</span>
									) : (
										<span className="text-[13px] text-fg-muted">{t("Not offered")}</span>
									)}
								</div>
							</Row>
						);
					})}
			</Group>
		</Section>
	);
}
