import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Flagged } from "@/components/room/Flag";
import { Button } from "@/components/ui/button";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { Activity, LayoutGrid, ScrollText, Server, Smartphone, Users, UsersRound } from "lucide-react";
import { type ReactNode, useRef } from "react";
import type { Phrase } from "@/live/i18n";
import type { Who } from "./api";
import { rate } from "./units";

/** The panels, in the order somebody works through them. */
// Seven. The last is the log, which replaced the runtime page and the audit
// page before it (2026-10-29): the owner asked for the two to become one log
// that reads plainly and still opens when something else on the server is
// failing (LogPanel.tsx). Called Log in the address now; an address saying
// #runtime, bookmarked before, still opens it (Manage.tsx). The fifth is what
// the apps are told between releases (AppsPanel.tsx), after the relays because
// both are about the machines and the apps people call from.
export const PANELS = ["Now", "Rooms", "Accounts", "Relays", "Apps", "Admins", "Log"] as const;

/**
 * What each panel is called on screen.
 *
 * Separate from PANELS because those are also the address — `#rooms` is what
 * somebody bookmarks and what Manage.tsx reads back — so translating the list
 * itself would translate the URL. This was drawn straight from the list for a
 * long time, which left a reader in Chinese with a column of six English words
 * down the side of an otherwise translated page.
 */
export const PANEL_NAMES: Record<Panel, Phrase> = {
	Now: "Now",
	Rooms: "Rooms",
	Accounts: "Accounts",
	Relays: "Relays",
	Apps: "Apps",
	Admins: "Admins",
	Log: "Log",
};
export type Panel = (typeof PANELS)[number];

const ICONS: Record<Panel, typeof Activity> = {
	Now: Activity,
	Rooms: LayoutGrid,
	Accounts: UsersRound,
	Relays: Server,
	Apps: Smartphone,
	Admins: Users,
	Log: ScrollText,
};

/**
 * The frame the management pages sit in.
 *
 * A rail down the side on a laptop and a row along the bottom on a phone —
 * the same list, moved to the edge a thumb reaches. It was a header until the
 * panels outgrew it: five fit across the top and the sixth would not, and every
 * page underneath was paying a band of height for a list nobody reads twice.
 *
 * The uplink goes with it. On the rail it sits at the foot; where the foot is
 * taken by navigation it moves to the top and stays there while the page
 * scrolls. Losing it when leaving this panel was the strongest argument for
 * moving the navigation at all, so it would be a poor trade to lose it anyway.
 *
 * Translated, like the rest. This said "English only, and not by omission" for
 * a long time, while four of its panels held a hundred and eighty-eight
 * translated phrases and the other four held none — which is the state the
 * comment was arguing against, arrived at by drift rather than by decision.
 *
 * The argument it made was that these pages are technical nouns and a
 * half-translated one reads worse than an untranslated one. The first half is
 * true of some of it and not of the sentences that matter: the ones somebody
 * reads at two in the morning when a relay has stopped answering. The second
 * half was an argument for finishing rather than for stopping.
 */
export function Shell({
	who,
	panel,
	onPanel,
	onSignOut,
	load,
	badges,
	children,
}: {
	who: Who;
	panel: Panel;
	onPanel: (panel: Panel) => void;
	onSignOut: () => void;
	/**
	 * A count on a panel's entry, for something there that wants looking at
	 * whichever panel is open: the sign-in lockouts, on the accounts.
	 */
	badges?: Partial<Record<Panel, number>>;
	/** What is going out right now, so it is legible from every panel. */
	load?: { out: number; rooms: number; clients: number };
	children: ReactNode;
}) {
	const t = useT();

	return (
		// The page is the height of the window and the panel scrolls inside it,
		// rather than the whole document scrolling. A rail is a flex item, and a
		// flex item stretches: left to itself it grew to the height of whatever
		// Runtime happened to be showing, which put its own foot — the uplink,
		// the signature, the way out — somewhere below the fold of a page nobody
		// was scrolling to read.
		<div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg lg:flex-row">
			{/* Pinned across the top on a phone, where the foot is taken. */}
			<Crown load={load} onSignOut={onSignOut} />

			{/* The sidebar, drawn as the platform's own are: the page's ground,
			    a hairline from the content, and the chosen row held down in the
			    raised grey rather than lit. The amber is kept for what is
			    happening, and which page is open is not that. */}
			<nav
				className={cn(
					"hidden shrink-0 flex-col gap-0.5 border-border border-r px-3 pt-4 pb-3 lg:flex lg:w-[220px]",
					// Its own height, and its own scroll if the list ever outgrows
					// it. Whatever the panel beside it is doing, the rail is the
					// same rail.
					"lg:h-dvh lg:overflow-y-auto",
				)}
			>
				<span className="flex items-center gap-2.5 px-2 pb-4">
					<img src="/favicon.svg" alt="" className="size-6 rounded-[6px]" />
					<span className="font-semibold text-[15px]">{t("Management")}</span>
				</span>

				{PANELS.map((one) => (
					<Rail key={one} panel={one} current={panel} onPanel={onPanel} badge={badges?.[one] ?? 0} />
				))}

				<div className="mt-auto flex flex-col gap-3 pt-4">
					<Load load={load} />
					<LanguagePicker />
					<div className="flex items-center gap-2 border-border border-t pt-3">
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px]">{who.name || t("Administrator")}</span>
							<span className="readout block truncate text-fg-muted text-[11px]">{who.trip}</span>
						</span>
						<Button variant="ghost" size="sm" onClick={onSignOut} className="shrink-0">
							{t("Sign out")}
						</Button>
					</div>
				</div>
			</nav>

			{/* The one thing that scrolls. Sixteen pixels a side on a phone, which
			    is the gutter every other screen of the product keeps. */}
			<main className="min-w-0 flex-1 overflow-y-auto px-4 pt-4 pb-24 sm:px-6 sm:pt-6 lg:px-8 lg:pt-7 lg:pb-10">
				{children}
			</main>

			{/* The rail, moved to the one edge a thumb reaches without the hand
			    changing grip.

			    One column per panel, counted from PANELS rather than written
			    down. It was written down once, as five, and then two panels were
			    added: the row wrapped, the second line held two tabs against the
			    left edge, and the bottom of every panel disappeared underneath a
			    bar the page still reserved one row of space for. */}
			<nav
				className={cn(
					"fixed inset-x-0 bottom-0 z-20 grid border-border border-t bg-surface lg:hidden",
					"pb-[env(safe-area-inset-bottom)]",
				)}
				style={{ gridTemplateColumns: `repeat(${PANELS.length}, minmax(0, 1fr))` }}
			>
				{PANELS.map((one) => (
					<Tab key={one} panel={one} current={panel} onPanel={onPanel} badge={badges?.[one] ?? 0} />
				))}
			</nav>
		</div>
	);
}

function Rail({
	panel,
	current,
	onPanel,
	badge,
}: {
	panel: Panel;
	current: Panel;
	onPanel: (panel: Panel) => void;
	badge: number;
}) {
	const t = useT();

	const Icon = ICONS[panel];
	const here = panel === current;

	return (
		<button
			type="button"
			onClick={() => onPanel(panel)}
			aria-current={here ? "page" : undefined}
			aria-description={badge > 0 ? t("{count} shut out of signing in", { count: badge }) : undefined}
			className={cn(
				"pressable flex h-8 items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13.5px] outline-none",
				"focus-visible:ring-2 focus-visible:ring-fg/70",
				here ? "bg-surface-hi font-medium text-fg" : "text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-press",
			)}
		>
			<Icon className="size-4 shrink-0" />
			{t(PANEL_NAMES[panel])}
			<Badge count={badge} className="ml-auto" />
		</button>
	);
}

function Tab({
	panel,
	current,
	onPanel,
	badge,
}: {
	panel: Panel;
	current: Panel;
	onPanel: (panel: Panel) => void;
	badge: number;
}) {
	const t = useT();

	const Icon = ICONS[panel];
	const here = panel === current;

	return (
		<button
			type="button"
			onClick={() => onPanel(panel)}
			aria-current={here ? "page" : undefined}
			aria-description={badge > 0 ? t("{count} shut out of signing in", { count: badge }) : undefined}
			className={cn(
				"flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 pt-1.5 pb-1 text-[10px] outline-none",
				"focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-inset",
				here ? "font-medium text-fg" : "text-fg-muted",
			)}
		>
			{/* The chosen tab's icon sits in a held-down pill, as the system's
			    own bars now draw it, rather than taking the amber. */}
			<span
				className={cn(
					"relative flex h-7 w-11 items-center justify-center rounded-full transition-colors duration-200",
					here && "bg-surface-hi",
				)}
			>
				<Icon className="size-[18px]" />
				<Badge count={badge} className="-top-1 absolute right-0" />
			</span>
			<span className="max-w-full truncate px-0.5">{t(PANEL_NAMES[panel])}</span>
		</button>
	);
}

/**
 * A count on a panel's entry, in the red the platforms give one, fading in
 * and out with what it counts. The last count is held while it fades, so it
 * does not read nought on its way out.
 */
function Badge({ count, className }: { count: number; className?: string }) {
	const last = useRef(count);
	if (count > 0) last.current = count;

	const { mounted, leaving } = useLingering(count > 0, 160);
	if (!mounted) return null;

	return (
		<span
			aria-hidden
			className={cn(
				"min-w-[18px] rounded-full bg-danger px-1 text-center font-semibold text-[11px] text-danger-fg tabular-nums leading-[18px]",
				leaving ? "animate-fade-out" : "animate-fade-in",
				className,
			)}
		>
			{last.current}
		</span>
	);
}

/** The reading that must survive leaving the panel it belongs to. */
function Crown({
	load,
	onSignOut,
}: {
	load?: { out: number; rooms: number; clients: number };
	onSignOut: () => void;
}) {
	const t = useT();

	return (
		<header
			className={cn(
				"z-20 flex shrink-0 items-center gap-2 border-border border-b bg-surface px-4 py-1.5 lg:hidden",
				"pt-[max(0.375rem,env(safe-area-inset-top))]",
			)}
		>
			<Live on={(load?.out ?? 0) > 0} />
			<span className="whitespace-nowrap font-semibold text-[15px] tabular-nums">{load ? rate(load.out) : "—"}</span>
			{/* The figure is what this bar is for; the count goes first when a
			    narrow phone has no room for both. */}
			<span className="mr-auto min-w-0 truncate text-fg-muted text-[12px] max-[359px]:invisible">
				{load ? together(t, load.rooms, load.clients) : t("Management")}
			</span>

			<LanguagePicker />

			<Button variant="ghost" size="sm" onClick={onSignOut} className="shrink-0">
				{t("Sign out")}
			</Button>
		</header>
	);
}

/**
 * The same reading at the foot of the rail, where there is room to say more.
 *
 * Named. It was a figure in the amber over the English word "uplink", which
 * was the one untranslated word on a Chinese page and the one figure on it
 * nobody had been told the meaning of.
 */
function Load({ load }: { load?: { out: number; rooms: number; clients: number } }) {
	const t = useT();

	return (
		<div className="flex flex-col gap-0.5 px-2">
			<span className="text-fg-muted text-[12px]">{t("Uplink now")}</span>
			<span className="flex items-center gap-2">
				<Live on={(load?.out ?? 0) > 0} />
				<span className="font-semibold text-[17px] tabular-nums">{load ? rate(load.out) : "—"}</span>
			</span>
			{load && <span className="text-fg-muted text-[12px]">{together(t, load.rooms, load.clients)}</span>}
		</div>
	);
}

/**
 * The one amber on the frame: lit while something is going out, which is to
 * say while somebody is in a call. Still, not pulsing; the figure beside it is
 * what moves.
 */
export function Live({ on, className }: { on: boolean; className?: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"size-2 shrink-0 rounded-full transition-colors duration-300",
				on ? "bg-tally" : "bg-fg-muted/40",
				className,
			)}
		/>
	);
}

/** How many rooms and people, as one phrase that reads in every language. */
export function together(t: ReturnType<typeof useT>, rooms: number, people: number): string {
	if (rooms === 0) return t("Nobody in a call");

	return t("{rooms} rooms, {people} people", { rooms, people });
}

/**
 * A titled block, which every panel is made of.
 *
 * Drawn as the redrawn pages' groups are (Grouped.tsx): the heading outside, in
 * sentence case, and the rows on a group of their own below it, with no border
 * by day and a hairline at night. It was a bordered card with its title in a
 * bar across the top, the same frame on every block of every page, which is the
 * dashboard-kit look the owner called crude. Changing it here changes every
 * panel at once, which is the point of every panel being made of it.
 */
export function Card({
	title,
	note,
	children,
	className,
	actions,
}: {
	title: string;
	note?: string;
	children: ReactNode;
	className?: string;
	actions?: ReactNode;
}) {
	return (
		<section className={cn("flex min-w-0 flex-col gap-2", className)}>
			<header className="flex min-h-7 flex-wrap items-end gap-x-3 gap-y-1 px-1">
				{/* A relay's label arrives here with a flag in it, and on Windows
				    there is no glyph for one. */}
				<h2 className="font-semibold text-[15px]">
					<Flagged text={title} />
				</h2>
				{note && <p className="pb-px text-fg-muted text-[13px]">{note}</p>}
				{actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
			</header>
			<div className="min-w-0 rounded-[14px] border border-border bg-surface day:border-transparent">{children}</div>
		</section>
	);
}

/** Nothing to show, said in a way that distinguishes empty from broken. */
export function Empty({ children }: { children: ReactNode }) {
	return <p className="px-4 py-5 text-fg-muted text-[13.5px]">{children}</p>;
}

/** Something went wrong, kept out of the way of the figures. */
export function Failed({ children }: { children: ReactNode }) {
	return (
		<p className="animate-fade-in rounded-[12px] bg-danger/10 px-4 py-2.5 text-[13px] text-danger-ink day:bg-danger/8">
			{children}
		</p>
	);
}

/**
 * A panel that has been asked and has not answered yet.
 *
 * Drawn while a question is in flight rather than leaving the last answer on
 * screen: clicking a second room used to show the first room's people and the
 * first room's history until the next tick, which for a history polled every
 * twenty seconds is long enough to read it and believe it.
 *
 * A shape rather than a spinner. What arrives is a list, so what waits is a
 * list — three bars where three rows will be, which keeps the panel the size it
 * is about to be and does not make the page jump when the answer lands.
 *
 * It arrives with the same animation everything else here does, and it is worth
 * saying why it is not instant: a request that comes back in forty milliseconds
 * would otherwise flash a skeleton and remove it, which reads as a glitch. The
 * delay on the first bar is longer than a fast answer takes, so a fast answer
 * never draws this at all.
 */
export function Waiting({ rows = 3 }: { rows?: number }) {
	return (
		<div className="flex flex-col gap-2 px-4 py-3" aria-hidden>
			{Array.from({ length: rows }, (_, at) => (
				<span
					key={at}
					className="animate-arrive h-3 rounded bg-surface-hi"
					style={{
						width: `${72 - at * 14}%`,
						animationDelay: `${120 + at * 60}ms`,
					}}
				/>
			))}
		</div>
	);
}
