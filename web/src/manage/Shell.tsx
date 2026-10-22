import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Flagged } from "@/components/room/Flag";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { Activity, LayoutGrid, ScrollText, Server, Users, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import type { Phrase } from "@/live/i18n";
import type { Who } from "./api";
import { rate } from "./units";

/** The panels, in the order somebody works through them. */
// Six, not seven. The audit panel was removed rather than fixed: everything it
// showed goes to the process log, which survives a restart and is readable with
// the service down — and a page behind the management sign-in is readable only
// when the thing it reports on is already answering.
export const PANELS = ["Now", "Rooms", "Accounts", "Relays", "Admins", "Runtime"] as const;

/**
 * What each panel is called on screen.
 *
 * Separate from PANELS because those are also the address — `?panel=rooms` is
 * what somebody bookmarks and what Manage.tsx reads back — so translating the
 * list itself would translate the URL. This was drawn straight from the list
 * for a long time, which left a reader in Chinese with a column of six English
 * words down the side of an otherwise translated page.
 */
export const PANEL_NAMES: Record<Panel, Phrase> = {
	Now: "Now",
	Rooms: "Rooms",
	Accounts: "Accounts",
	Relays: "Relays",
	Admins: "Admins",
	Runtime: "Runtime",
};
export type Panel = (typeof PANELS)[number];

const ICONS: Record<Panel, typeof Activity> = {
	Now: Activity,
	Rooms: LayoutGrid,
	Accounts: UsersRound,
	Relays: Server,
	Admins: Users,
	Runtime: ScrollText,
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
	children,
}: {
	who: Who;
	panel: Panel;
	onPanel: (panel: Panel) => void;
	onSignOut: () => void;
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

			<nav
				className={cn(
					"hidden shrink-0 flex-col gap-1 border-border border-r p-3 lg:flex lg:w-48",
					// Its own height, and its own scroll if the list ever outgrows
					// it. Whatever the panel beside it is doing, the rail is the
					// same rail.
					"lg:h-dvh lg:overflow-y-auto",
				)}
			>
				<span className="px-2 pt-1 pb-3 font-semibold text-sm">{t("Management")}</span>

				{PANELS.map((one) => (
					<Rail key={one} panel={one} current={panel} onPanel={onPanel} />
				))}

				<div className="mt-auto flex flex-col gap-3 pt-3">
					<Load load={load} />
					<LanguagePicker />
					<div className="flex items-center gap-2">
						<span className="readout truncate text-fg-muted text-[11px]">
							{who.name ? `${who.name} · ` : ""}
							{who.trip}
						</span>
						<Button variant="ghost" size="sm" onClick={onSignOut} className="ml-auto shrink-0">
							{t("Sign out")}
						</Button>
					</div>
				</div>
			</nav>

			{/* The one thing that scrolls. */}
			<main className="min-w-0 flex-1 overflow-y-auto p-3 pb-20 sm:p-5 lg:pb-5">{children}</main>

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
					<Tab key={one} panel={one} current={panel} onPanel={onPanel} />
				))}
			</nav>
		</div>
	);
}

function Rail({
	panel,
	current,
	onPanel,
}: {
	panel: Panel;
	current: Panel;
	onPanel: (panel: Panel) => void;
}) {
	const t = useT();

	const Icon = ICONS[panel];

	return (
		<button
			type="button"
			onClick={() => onPanel(panel)}
			aria-current={panel === current ? "page" : undefined}
			className={cn(
				"flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
				panel === current ? "bg-surface-hi text-fg" : "text-fg-muted hover:bg-surface hover:text-fg",
			)}
		>
			<Icon className="size-4 shrink-0" />
			{t(PANEL_NAMES[panel])}
		</button>
	);
}

function Tab({
	panel,
	current,
	onPanel,
}: {
	panel: Panel;
	current: Panel;
	onPanel: (panel: Panel) => void;
}) {
	const t = useT();

	const Icon = ICONS[panel];

	return (
		<button
			type="button"
			onClick={() => onPanel(panel)}
			aria-current={panel === current ? "page" : undefined}
			className={cn(
				"flex flex-col items-center gap-1 py-2 text-[10px] transition-colors",
				panel === current ? "text-tally" : "text-fg-muted",
			)}
		>
			<Icon className="size-4" />
			{t(PANEL_NAMES[panel])}
		</button>
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
				"z-20 flex shrink-0 items-baseline gap-2 border-border border-b bg-surface px-3 py-2 lg:hidden",
				"pt-[max(0.5rem,env(safe-area-inset-top))]",
			)}
		>
			<span className="readout font-semibold text-[15px] text-tally tabular-nums">
				{load ? rate(load.out) : "—"}
			</span>
			<span className="mr-auto text-fg-muted text-[11px]">
				{load ? `${load.rooms} · ${load.clients}` : t("Management")}
			</span>

			<LanguagePicker />

			<Button variant="ghost" size="sm" onClick={onSignOut} className="shrink-0">
				{t("Sign out")}
			</Button>
		</header>
	);
}

/** The same reading at the foot of the rail, where there is room to say more. */
function Load({ load }: { load?: { out: number; rooms: number; clients: number } }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-0.5 border-border border-t pt-3">
			<span className="readout font-semibold text-[15px] text-tally tabular-nums">
				{load ? rate(load.out) : "—"}
			</span>
			<span className="text-fg-muted text-[11px]">uplink</span>
			{load && (
				<span className="text-fg-muted text-[11px]">
					{t("{rooms} rooms · {people} people", {
						rooms: load.rooms,
						people: load.clients,
					})}
				</span>
			)}
		</div>
	);
}

/** A titled block, which every panel is made of. */
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
		<section className={cn("rounded-lg border border-border bg-surface", className)}>
			<header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-border border-b px-3 py-2.5 sm:px-4">
				{/* A relay's label arrives here with a flag in it, and on Windows
				    there is no glyph for one. */}
				<h2 className="font-medium text-[13px]">
					<Flagged text={title} />
				</h2>
				{note && <p className="text-fg-muted text-xs">{note}</p>}
				{actions && <div className="ml-auto">{actions}</div>}
			</header>
			{children}
		</section>
	);
}

/** Nothing to show, said in a way that distinguishes empty from broken. */
export function Empty({ children }: { children: ReactNode }) {
	return <p className="px-4 py-6 text-center text-fg-muted text-xs">{children}</p>;
}

/** Something went wrong, kept out of the way of the figures. */
export function Failed({ children }: { children: ReactNode }) {
	return (
		<p className="border-danger/40 border-b bg-danger/10 px-4 py-2 text-danger text-xs">
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
