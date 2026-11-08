import { Button } from "@/components/ui/button";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/live/notices";
import { AtSign, Ban, Check, ChevronRight, Copy, KeyRound, Loader2, Minus, Plus, Server, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type Account, type Lockouts, type Policy, type Watching, api } from "./api";
import { described, DeviceLine } from "./Device";
import { Box, Fade, Hint, Swap, Tick, Working } from "./Boxes";
import { DEFAULTS, PERMISSION_NAMES, PERMISSIONS, type Permission } from "./grants";
import { Group, Initial, Row, Section } from "./Grouped";
import { LockoutsSection } from "./Lockouts";
import { ago } from "./health";
import { useOptimistic } from "./pending";
import { usePoll } from "./poll";
import { Sheet } from "./Sheet";
import { Failed } from "./Shell";
import { size } from "./units";
import { locale } from "@/live/i18n";

/**
 * The accounts an administrator hands out.
 *
 * Until this existed there were two kinds of person here: administrators, and
 * whoever anybody said they were. That is the right model for an anonymous
 * meeting link and the wrong one for a group who all come back — there was no
 * way to give somebody a name that was theirs without making them an
 * administrator of the whole deployment.
 *
 * An account is a name and a first passphrase. The passphrase becomes a
 * signature the moment it is typed and is not stored, which has one consequence
 * worth saying on the page rather than only in a comment: nobody can be shown
 * somebody's passphrase later, because there is none to show. What an
 * administrator can do is set a new one, which is the useful half of that
 * request and the only half that was ever safe.
 *
 * Drawn as a table of who may use what, because that is the question the owner
 * asked the page to answer (2026-10-12): who may use the Emby library, so the
 * CDN is not drained, and the same for the rest. Each account is a row and
 * each permission a column of boxes, so "who has Emby" is one glance down one
 * column and giving it is one press, without opening anything. It was six
 * boxes behind a shield on each row, with a line of badges per row saying the
 * same thing a second way. Everything else about an account — its devices,
 * its note and groups, a new passphrase, blocking, removing — is in a sheet
 * the row opens, where there is room to say what each thing does.
 *
 * On a phone the columns do not fit, so a row says what is unusual about the
 * account instead — Emby held, a default taken away — and the boxes are in the
 * sheet.
 *
 * Two capabilities meet here. Making and changing accounts is the accounts
 * capability's; the Emby box is moderate's alone, because ticking it is a
 * decision to spend money on somebody's say-so, and the server refuses it to
 * anybody less. The box is drawn disabled, with the reason, rather than offered
 * and then refused.
 */
export function AccountsPanel({
	canAccounts,
	canModerate,
	onSignedOut,
	lockouts,
	onLockoutsChanged,
}: {
	/** May make, change and remove accounts. */
	canAccounts: boolean;
	/** May also give and take away Emby, and lift a sign-in lockout. */
	canModerate: boolean;
	onSignedOut: () => void;
	/**
	 * Who is shut out of signing in, polled above this panel because the
	 * count is on the tab whichever panel is open (Manage.tsx). Absent until
	 * the server has answered, and from a server too old to say.
	 */
	lockouts?: Lockouts;
	onLockoutsChanged?: () => Promise<unknown>;
}) {
	const t = useT();

	const { value, error, refresh } = usePoll(api.accounts, { every: 30_000, onSignedOut });

	// The two site-wide facts the boxes are explained against: whether the
	// Emby relay is switched on at all, and whether new rooms are opened by
	// accounts. Read here rather than handed down from the panel that changes
	// them, because the two are seldom open together and a box explained by a
	// fact somebody changed five minutes ago in another tab is explained wrongly.
	// Slowly, and a failure is silence: these add a sentence, and a page that
	// cannot read the settings can still tick a box.
	const { value: watching } = usePoll(api.settings, { every: 60_000, onSignedOut });
	const { value: policy } = usePoll(api.policy, { every: 60_000, onSignedOut });

	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [made, setMade] = useState<{ name: string; passphrase: string }>();
	const [opened, setOpened] = useState<string>();

	// Whether it took, for the one caller that has something to show only if
	// it did: a new passphrase. The banner used to follow the request whatever
	// it answered, so a reset the server refused still said "give this to them
	// now" about a passphrase that opened nothing.
	const act = useCallback(
		async (name: string, run: () => Promise<unknown>): Promise<boolean> => {
			if (busy) return false;

			setBusy(name);

			try {
				await run();
				await refresh();
				return true;
			} catch (err) {
				actionFailed(err instanceof Error ? err.message : String(err));
				return false;
			} finally {
				setBusy(undefined);
			}
		},
		[busy, refresh],
	);

	const accounts = value ?? [];

	// Held on screen while they leave: a form or a banner gone between two
	// frames reads as the page redrawing rather than as something being shut.
	const form = useLingering(canAccounts && adding);
	const banner = useLingering(made !== undefined);
	const empty = useLingering(value !== undefined && accounts.length === 0 && !adding);
	const footnote = useLingering(accounts.some((one) => one.effective?.emby || (one.embySpent ?? 0) > 0));

	// What the banner said, kept while it fades: the state that decided it is
	// already gone by then, and a banner leaving with no passphrase in it is
	// one that flickers empty on its way out.
	const shown = useRef(made);
	if (made) shown.current = made;

	const switchedOff = watching !== undefined && watching.directOnly && !watching.embyRelay;
	const noGateway = watching !== undefined && !watching.configured;

	if (error) return <Failed>{error}</Failed>;

	return (
		<div className="mx-auto flex max-w-[1180px] flex-col gap-6">
			<header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
				<div className="flex min-w-0 items-baseline gap-2.5">
					<h1 className="font-semibold text-[22px] leading-tight tracking-[-0.01em]">{t("Accounts")}</h1>
					{value !== undefined && <span className="text-fg-muted text-[15px] tabular-nums">{accounts.length}</span>}
				</div>

				{canAccounts && (
					<Button variant="primary" size="sm" className="ml-auto" disabled={adding} onClick={() => setAdding(true)}>
						<Plus />
						{t("New account")}
					</Button>
				)}
			</header>

			{form.mounted && (
				<div className={form.leaving ? "animate-depart" : "animate-arrive"}>
					<NewAccount
						canModerate={canModerate}
						watching={watching}
						policy={policy}
						onDone={async (name, passphrase) => {
							setAdding(false);
							setMade({ name, passphrase });
							await refresh();
						}}
						onCancel={() => setAdding(false)}
					/>
				</div>
			)}

			{/*
			  * Shown once, here, and never again — because it is never stored.
			  * Whoever made the account is the only person who can pass it on,
			  * and they have to do it now.
			  */}
			{banner.mounted && shown.current && (
				<div className={banner.leaving ? "animate-depart" : "animate-arrive"}>
					<Made made={shown.current} onDismiss={() => setMade(undefined)} />
				</div>
			)}

			<LockoutsSection reading={lockouts} canModerate={canModerate} onChanged={onLockoutsChanged ?? noop} />

			<Section
				title={t("Who may use what")}
				note={
					noGateway
						? t("This deployment has no watch-together gateway, so Emby does nothing.")
						: switchedOff
							? t("The Emby relay is switched off for the whole site.")
							: undefined
				}
			>
				<Group>
					{empty.mounted && (
						<p className={cn("px-4 py-5 text-fg-muted text-[13.5px]", empty.leaving ? "animate-fade-out" : "animate-fade-in")}>
							{t("No accounts yet. Somebody without one can still join a room, under whatever name they choose.")}
						</p>
					)}

					{accounts.length > 0 && <Columns />}

					<ul aria-label={t("Accounts")}>
						{accounts.map((account) => (
							<AccountRow
								key={account.name}
								account={account}
								canAccounts={canAccounts}
								canModerate={canModerate}
								watching={watching}
								policy={policy}
								busy={busy === account.name}
								open={opened === account.name}
								onOpen={() => setOpened(account.name)}
								onClose={() => setOpened((was) => (was === account.name ? undefined : was))}
								onPassphrase={async (passphrase) => {
									if (await act(account.name, () => api.changeAccount(account.name, { passphrase }))) {
										setMade({ name: account.name, passphrase });
										return true;
									}
									return false;
								}}
								onBlock={() => act(account.name, () => api.changeAccount(account.name, { blocked: !account.blocked }))}
								onDrop={async () => {
									if (await act(account.name, () => api.dropAccount(account.name))) setOpened(undefined);
								}}
								onSaved={refresh}
							/>
						))}
					</ul>
				</Group>
			</Section>

			<div className="flex flex-col gap-1.5 px-1">
				<p className="text-fg-muted text-[12px] leading-relaxed">
					{t("A passphrase is never stored, so nobody can be shown one later — not even you. What you can do is set a new one and pass it on. People sign in at /account to change it themselves and to choose a picture.")}
				</p>

				{/* Said once under the list rather than on every row: the figures are
				    counted in memory by the process relaying the films, and a reader
				    who saw one drop to nothing overnight should be able to find out
				    why without reading the server. */}
				{footnote.mounted && (
					<p className={cn("text-fg-muted text-[12px] leading-relaxed", footnote.leaving ? "animate-fade-out" : "animate-fade-in")}>
						{t("Emby figures count what was relayed since the server last started, and go back to nought when it restarts.")}
					</p>
				)}
			</div>
		</div>
	);
}

const noop = async () => {};

/**
 * The grid every row lays itself out on, wide enough for the six columns of
 * boxes. Below it a row is a line of its own and the boxes are in the sheet.
 */
const GRID = "lg:grid lg:grid-cols-[minmax(0,1fr)_8.5rem_7.5rem_repeat(6,4.5rem)_1.5rem] lg:items-center lg:gap-x-2";

/** The headings over the columns, on a screen wide enough to have them. */
function Columns() {
	const t = useT();

	return (
		<div aria-hidden className={cn("hidden border-border border-b px-4 py-2 text-fg-muted text-[12px]", GRID)}>
			<span>{t("Account")}</span>
			<span>{t("Devices")}</span>
			<span>{t("Last in a room")}</span>
			{PERMISSIONS.map((permission) => (
				<span
					key={permission}
					className={cn("text-center leading-tight", permission === "emby" && "font-medium text-tally-ink")}
				>
					{t(PERMISSION_NAMES[permission])}
				</span>
			))}
			<span />
		</div>
	);
}

/**
 * One account: who it is, what it may use, and the way into the rest.
 *
 * Its own component so each row can hold its own state — the boxes it has
 * ticked and not yet heard back about — rather than the list keeping a map of
 * every row's. The sheet the row opens is drawn from here too, so a box
 * pressed in the sheet and the same box in the row are one box: they share
 * the press in flight, and neither waits for the other to hear back.
 */
function AccountRow({
	account,
	canAccounts,
	canModerate,
	watching,
	policy,
	busy,
	open,
	onOpen,
	onClose,
	onPassphrase,
	onBlock,
	onDrop,
	onSaved,
}: {
	account: Account;
	canAccounts: boolean;
	canModerate: boolean;
	watching?: Watching;
	policy?: Policy;
	busy: boolean;
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onPassphrase: (passphrase: string) => Promise<boolean>;
	onBlock: () => void;
	onDrop: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = useT();

	// Drawn from what the server says the account holds, with any press still
	// in flight laid over it, so the row and the sheet move together and at
	// once.
	const grants = useOptimistic(account.effective, onSaved);

	const toggle = (permission: Permission, on: boolean) =>
		void grants.set(permission, on, (perms) => api.changeAccount(account.name, { perms }));

	const why = useId();
	const missing = PERMISSIONS.filter((one) => one !== "emby" && DEFAULTS[one] && !(grants.held[one] ?? false));

	return (
		<li
			className={cn(
				"relative px-4 py-3 transition-colors",
				"before:absolute before:top-0 before:right-0 before:left-[60px] before:h-px before:bg-border first:before:hidden",
				"hover:bg-wash",
				open && "bg-wash",
				GRID,
			)}
		>
			<div className="flex min-w-0 items-center gap-3">
				<Face account={account} />

				<div className="min-w-0 flex-1">
					<p className="flex items-center gap-2">
						{/* The whole row opens the sheet, through this one button
						    stretched over it; the boxes sit above the stretch, so a
						    press on a box is a press on the box. */}
						<button
							type="button"
							onClick={onOpen}
							aria-haspopup="dialog"
							aria-expanded={open}
							className={cn(
								"min-w-0 truncate text-left text-[14.5px] outline-none",
								"after:absolute after:inset-0 after:rounded-none focus-visible:after:ring-2 focus-visible:after:ring-fg/70 focus-visible:after:ring-inset",
							)}
						>
							{account.name}
						</button>

						<Fade show={account.blocked ?? false}>
							{/* A paler tint by day: the red's ink on the night's fifteen
							    per cent of the lighter red was 4.2 to one, measured, for
							    words ten and a half pixels tall. */}
							<span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] text-danger-ink day:bg-danger/8">
								{t("blocked")}
							</span>
						</Fade>
					</p>

					{/* The signature and the groups on the row itself, as they were
					    before the redesign put them in the sheet: the signature is
					    what a person reads off somebody's name in a call to find
					    them here, and the groups are what lets them into a room. */}
					<p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-muted">
						<span className="readout">{account.trip}</span>
						{(account.scopes ?? []).map((scope) => (
							<span key={scope} className="readout rounded-full bg-surface-hi px-2 text-[11.5px] text-fg">
								@{scope}
							</span>
						))}
						{/* And their own relays, since having one changes every call
						    they make: they are offered nothing else. */}
						{(account.relays ?? []).map((relay) => (
							<span key={relay} className="flex items-center gap-1 rounded-full bg-surface-hi px-2 text-[11.5px] text-fg">
								<Server className="size-3 text-fg-muted" aria-hidden />
								{relay}
							</span>
						))}
					</p>

					{account.note && <p className="truncate text-fg-muted text-[12.5px]">{account.note}</p>}

					{/* A phone has no columns, so the row says when and from what
					    here instead, and what is unusual about what it may use. */}
					<p className="flex flex-wrap items-center gap-x-2 text-fg-muted text-[12.5px] lg:hidden">
						<Icons account={account} />
						<span>{account.lastSeen ? ago(account.lastSeen) : t("never here")}</span>
					</p>

					<Spent held={grants.held} spent={account.embySpent} blocked={account.blocked ?? false} />

					{missing.length > 0 && (
						<p className="text-fg-muted text-[12.5px] lg:hidden">
							{t("Without {list}", {
								list: new Intl.ListFormat(locale(), { type: "conjunction" }).format(missing.map((one) => t(PERMISSION_NAMES[one]))),
							})}
						</p>
					)}
				</div>

				<ChevronRight className="size-4 shrink-0 text-fg-muted lg:hidden" aria-hidden />
			</div>

			<span className="hidden min-w-0 lg:flex">
				<Icons account={account} />
			</span>

			<span className="hidden text-fg-muted text-[12.5px] tabular-nums lg:block">
				{account.lastSeen ? ago(account.lastSeen) : t("never here")}
			</span>

			{PERMISSIONS.map((permission) => (
				<span key={permission} className="relative z-10 hidden h-11 items-center justify-center lg:flex">
					{canAccounts ? (
						<CellBox
							permission={permission}
							held={grants.held}
							saving={grants.saving(permission)}
							canModerate={canModerate}
							onToggle={toggle}
							why={why}
						/>
					) : (
						<Mark permission={permission} on={grants.held[permission] ?? false} />
					)}
				</span>
			))}

			<ChevronRight className="hidden size-4 text-fg-muted lg:block" aria-hidden />

			<Sheet open={open} title={t("Account")} label={account.name} onClose={onClose}>
				<Detail
					account={account}
					grants={grants}
					onToggle={toggle}
					canAccounts={canAccounts}
					canModerate={canModerate}
					watching={watching}
					policy={policy}
					busy={busy}
					onPassphrase={onPassphrase}
					onBlock={onBlock}
					onDrop={onDrop}
					onSaved={onSaved}
				/>
			</Sheet>
		</li>
	);
}

/**
 * One box in the table, with what keeps it from being pressed said beside it
 * for whoever cannot see that it is grey.
 */
function CellBox({
	permission,
	held,
	saving,
	canModerate,
	onToggle,
	why,
}: {
	permission: Permission;
	held: Record<string, boolean>;
	saving: boolean;
	canModerate: boolean;
	onToggle: (permission: Permission, on: boolean) => void;
	why: string;
}) {
	const t = useT();

	const on = held[permission] ?? false;

	if (permission !== "emby") {
		return <Tick label={t(PERMISSION_NAMES[permission])} checked={on} saving={saving} onChange={(next) => onToggle(permission, next)} />;
	}

	// Ticking Emby needs watching together, since the library and every film
	// ask for that first; unticking it never does, so that a grant left behind
	// by unticking watching can still be taken away.
	const needsWatch = !(held.watch ?? false) && !on;
	const reason = !canModerate
		? t("Only an administrator who can manage everything can change this.")
		: needsWatch
			? t("Needs Watch together ticked first.")
			: undefined;

	return (
		<>
			<Tick
				label={t(PERMISSION_NAMES.emby)}
				tone="tally"
				checked={on}
				saving={saving}
				disabled={reason !== undefined}
				describedBy={reason ? `${why}-emby` : undefined}
				onChange={(next) => onToggle(permission, next)}
			/>
			{reason && (
				<span id={`${why}-emby`} className="sr-only">
					{reason}
				</span>
			)}
			{reason && <span className="absolute inset-0" title={reason} aria-hidden />}
		</>
	);
}

/** What an administrator who may only look sees in a box's place. */
function Mark({ permission, on }: { permission: Permission; on: boolean }) {
	const t = useT();

	const name = t(PERMISSION_NAMES[permission]);

	return (
		<span role="img" aria-label={on ? name : `${name}, ${t("not allowed")}`} className={on ? (permission === "emby" ? "text-tally-ink" : "text-fg") : "text-fg-muted/60 day:text-fg-muted"}>
			{on ? <Check className="size-4" strokeWidth={2.5} /> : <Minus className="size-4" />}
		</span>
	);
}

/**
 * Emby, where it is held or has cost something, with what it has cost.
 *
 * The one grant drawn on the row whatever the screen, because it is the one
 * that spends the deployment's money and the figure beside it is the answer to
 * the question the box was asked for. Struck where it is held and does
 * nothing — without watching together, which the library asks for first, or
 * on an account that is blocked, which the server holds to nothing.
 */
function Spent({ held, spent, blocked }: { held: Record<string, boolean>; spent?: number; blocked: boolean }) {
	const t = useT();

	const on = held.emby ?? false;
	const live = on && (held.watch ?? false) && !blocked;

	return (
		<Fade show={on || (spent ?? 0) > 0}>
			<span
				className={cn(
					"mt-1 inline-flex flex-wrap items-center gap-x-1.5 rounded-full bg-tally/15 px-2 py-0.5 text-[11.5px] text-tally-ink transition-opacity",
					!live && "opacity-60",
				)}
			>
				<span className={cn("whitespace-nowrap font-medium", !live && "line-through")}>{t(PERMISSION_NAMES.emby)}</span>
				{!live && <span className="sr-only"> {t("not allowed")}</span>}
				<span className="whitespace-nowrap">{t("{size} relayed since restart", { size: size(spent ?? 0) })}</span>
			</span>
		</Fade>
	);
}

/** The devices an account has joined from, as icons, named when pointed at. */
function Icons({ account }: { account: Account }) {
	const t = useT();

	const devices = account.devices ?? [];
	if (devices.length === 0) return <span className="text-fg-muted text-[12.5px] max-lg:hidden">—</span>;

	return (
		<span className="flex items-center gap-1.5 text-fg-muted">
			{devices.slice(0, 4).map((one) => {
				const { label, details, Icon } = described(one.client, t);
				const name = [label, ...details].join(", ");

				return (
					<span key={`${one.client.kind}${label}${details.join()}`} title={name}>
						<Icon className="size-4" aria-label={name} />
					</span>
				);
			})}
			{devices.length > 4 && <span className="text-[12px]">+{devices.length - 4}</span>}
		</span>
	);
}

/** Somebody's picture, or their initial where they have not chosen one. */
function Face({ account, size: big }: { account: { name: string; trip: string; avatar?: boolean }; size?: "lg" }) {
	if (account.avatar) {
		return (
			<img
				src={`/api/avatar/${encodeURIComponent(account.trip)}`}
				alt=""
				className={cn("shrink-0 rounded-full object-cover", big ? "size-14" : "size-8")}
			/>
		);
	}

	return <Initial name={account.name} size={big === "lg" ? "lg" : "md"} />;
}

/**
 * Everything about one account, in its sheet.
 *
 * In the order it is asked about: who this is, what they may use, what they
 * use, what has been written about them, and then the things that change
 * their way in — last, and apart, because those are the presses that lock
 * somebody out.
 */
function Detail({
	account,
	grants,
	onToggle,
	canAccounts,
	canModerate,
	watching,
	policy,
	busy,
	onPassphrase,
	onBlock,
	onDrop,
	onSaved,
}: {
	account: Account;
	grants: ReturnType<typeof useOptimistic>;
	onToggle: (permission: Permission, on: boolean) => void;
	canAccounts: boolean;
	canModerate: boolean;
	watching?: Watching;
	policy?: Policy;
	busy: boolean;
	onPassphrase: (passphrase: string) => Promise<boolean>;
	onBlock: () => void;
	onDrop: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = useT();

	const devices = account.devices ?? [];

	return (
		<div className="flex flex-col gap-7">
			<div className="flex items-center gap-4">
				<Face account={account} size="lg" />
				<div className="min-w-0">
					<p className="flex items-center gap-2">
						<span className="truncate font-semibold text-[22px] leading-tight">{account.name}</span>
						<Fade show={account.blocked ?? false}>
							<span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11.5px] text-danger-ink day:bg-danger/8">{t("blocked")}</span>
						</Fade>
					</p>
					<p className="readout text-fg-muted text-[12.5px]">{account.trip}</p>
					<p className="text-fg-muted text-[12.5px]">
						{account.lastSeen ? t("Last in a room {when}", { when: ago(account.lastSeen) }) : t("never here")}
						{account.created && (
							<span className="block">{t("Made on {date}", {
									date: new Date(account.created).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" }),
								})}</span>
						)}
					</p>
				</div>
			</div>

			<Section title={t("What they may use")}>
				<Group>
					<Permissions
						held={grants.held}
						saving={grants.saving}
						onToggle={onToggle}
						canEdit={canAccounts}
						canModerate={canModerate}
						watching={watching}
						policy={policy}
						spent={account.embySpent}
					/>
				</Group>
			</Section>

			<Section title={t("Devices")}>
				<Group>
					{devices.length === 0 && (
						<p className="px-4 py-4 text-fg-muted text-[13px]">{t("Nothing recorded yet.")}</p>
					)}
					{devices.map((one) => (
						<Row key={`${one.client.kind}${one.client.browser ?? ""}${one.client.device ?? ""}${one.client.system ?? ""}`}>
							<div className="flex flex-col gap-0.5 px-4 py-3 text-fg-muted text-[13px]">
								<DeviceLine client={one.client} className="text-[13.5px]" />
								<span className="text-[12.5px]">{t("Last used {when} in {room}", { when: ago(one.at), room: one.room })}</span>
							</div>
						</Row>
					))}
				</Group>
				<p className="px-1 text-fg-muted text-[12px] leading-relaxed">
					{t("Read from the rooms' histories, so it goes back as far as they do, and only to joins made since the server began keeping what people join from.")}
				</p>
			</Section>

			<Section title={t("Note and groups")}>
				<Group>
					<Row>
						<div className="flex flex-col gap-1 px-4 py-3">
							<span className="text-fg-muted text-[12px]">{t("Note")}</span>
							<Note account={account} canModerate={canAccounts} onSaved={onSaved} />
						</div>
					</Row>
					<Row>
						<div className="flex flex-col gap-1 px-4 py-3">
							<span className="text-fg-muted text-[12px]">{t("Scopes")}</span>
							<Scopes account={account} canModerate={canAccounts} onSaved={onSaved} />
						</div>
					</Row>
				</Group>
			</Section>

			<Section title={t("Their own relays")}>
				<Group>
					<Row>
						<div className="px-4 py-3">
							<OwnRelays account={account} canEdit={canAccounts} onSaved={onSaved} />
						</div>
					</Row>
				</Group>
				<p className="px-1 text-fg-muted text-[12px] leading-relaxed">
					{t("A machine somebody provided for themselves. Given one, they are offered only their own relays, and cannot join while none of them is answering; they still reach meetings held anywhere else, if their relay forwards other rooms. Nobody else is offered it, though administrators may use it.")}
				</p>
			</Section>

			{canAccounts && (
				<Access
					account={account}
					canModerate={canModerate}
					busy={busy}
					onPassphrase={onPassphrase}
					onBlock={onBlock}
					onDrop={onDrop}
				/>
			)}
		</div>
	);
}

/**
 * The six boxes, each with what it does said under it and, where it cannot do
 * it, why.
 */
function Permissions({
	held,
	saving,
	onToggle,
	canEdit = true,
	canModerate,
	watching,
	policy,
	spent,
	disabled,
}: {
	held: Record<string, boolean>;
	saving?: (permission: string) => boolean;
	onToggle: (permission: Permission, on: boolean) => void;
	canEdit?: boolean;
	canModerate: boolean;
	watching?: Watching;
	policy?: Policy;
	spent?: number;
	disabled?: boolean;
}) {
	const t = useT();

	const watch = held.watch ?? false;
	const emby = held.emby ?? false;

	// Ticking Emby needs watching together; unticking it never does, so that a
	// grant left behind by unticking watching can still be taken away.
	const needsWatch = !watch && !emby;

	// Off for the whole deployment: where the file relays nothing, Emby is
	// relayed only while the switch is on. A grant is still worth ticking ahead
	// of turning it on, so the box stays live and says so.
	const switchedOff = watching !== undefined && watching.directOnly && !watching.embyRelay;
	const noGateway = watching !== undefined && !watching.configured;

	const what: Record<Permission, string> = {
		watch: t("Start watching a video together in a call."),
		emby: t("Ticked, the films this person picks from Emby are relayed through the CDN to everybody in the room, for as long as each of them watches."),
		music: t("Open the music library and play from it in a call."),
		arrange: t("Arrange a meeting for later, with a time and a link."),
		invite: t("Make links that let a guest into the rooms of their groups."),
		open: t("Open a room under a name nobody has used yet."),
	};

	return (
		<>
			{PERMISSIONS.map((permission) => {
				const on = held[permission] ?? false;
				const busy = saving?.(permission) ?? false;
				const locked = permission === "emby" && (!canModerate || needsWatch);

				return (
					<Row key={permission} inset={48}>
						<label className={cn("flex items-start gap-3.5 px-4 py-3", canEdit && !disabled && !locked && "cursor-pointer")}>
							<span className="pt-0.5">
								{canEdit ? (
									<Tick
										label={t(PERMISSION_NAMES[permission])}
										tone={permission === "emby" ? "tally" : undefined}
										checked={on}
										saving={busy}
										disabled={disabled || locked}
										onChange={(next) => onToggle(permission, next)}
									/>
								) : (
									<Mark permission={permission} on={on} />
								)}
							</span>

							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className={cn("flex items-center gap-2 text-[14px]", permission === "emby" && "font-medium text-tally-ink")}>
									{t(PERMISSION_NAMES[permission])}
									<Working on={busy} />
								</span>
								<span className="text-fg-muted text-[12.5px] leading-relaxed">{what[permission]}</span>

								{permission === "emby" && (
									<>
										<Line show={!canModerate}>{t("Only an administrator who can manage everything can change this.")}</Line>
										<Line show={canModerate && needsWatch}>{t("Needs Watch together ticked first.")}</Line>
										<Line show={noGateway}>{t("This deployment has no watch-together gateway, so this does nothing.")}</Line>
										<Line show={!noGateway && switchedOff}>
											{t("The Emby relay is switched off for the whole site, so this does nothing until it is turned on under Rooms.")}
										</Line>
										<Line show={(spent ?? 0) > 0} tone="tally">
											{t("{size} relayed since restart", { size: size(spent ?? 0) })}
										</Line>
									</>
								)}

								{permission === "open" && (
									// Under any other policy a passphrase that belongs to
									// no account can open a room too, and this box cannot
									// stop somebody who signs in with one of those. Said,
									// so it is not mistaken for a lock.
									<Line show={policy !== undefined && policy.openedBy !== "accounts"}>
										{t("Applies fully only while new rooms are set to Accounts only.")}
									</Line>
								)}
							</span>
						</label>
					</Row>
				);
			})}
		</>
	);
}

/** A line under a box, there while it applies. */
function Line({ show, tone, children }: { show: boolean; tone?: "tally"; children: React.ReactNode }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return (
		<span
			className={cn(
				"text-[12.5px] leading-relaxed",
				tone === "tally" ? "text-tally-ink" : "text-fg",
				leaving ? "animate-fade-out" : "animate-fade-in",
			)}
		>
			{children}
		</span>
	);
}

/**
 * The presses that change somebody's way in: a new passphrase, blocking, and
 * removing. Apart from the rest and last, and removing asks first, because it
 * cannot be taken back: it was one press on a bin icon in a row of four.
 */
function Access({
	account,
	canModerate,
	busy,
	onPassphrase,
	onBlock,
	onDrop,
}: {
	account: Account;
	canModerate: boolean;
	busy: boolean;
	onPassphrase: (passphrase: string) => Promise<boolean>;
	onBlock: () => void;
	onDrop: () => void;
}) {
	const t = useT();

	const [resetting, setResetting] = useState(false);
	const [dropping, setDropping] = useState(false);

	// As the server reads it: the account as stored holding Emby. Setting the
	// passphrase of somebody who holds it is choosing who holds the grant, and
	// the server refuses it for the same reason it refuses the box. Drawn and
	// disabled, with the reason, rather than offered and refused.
	const resetLocked = !canModerate && (account.effective?.emby ?? false);

	const reset = useLingering(resetting && !resetLocked);
	const confirm = useLingering(dropping);

	return (
		<Section title={t("Passphrase and access")}>
			<Group>
				<Row>
					<Action
						icon={KeyRound}
						label={t("Set a new passphrase")}
						disabled={resetLocked || busy}
						title={
							resetLocked
								? t("Only an administrator who can manage everything can give or take away Emby, or set the passphrase of somebody who has it.")
								: t("Set a new passphrase")
						}
						onClick={() => setResetting((was) => !was)}
						expanded={resetting}
					/>
					{reset.mounted && (
						<div className={cn("px-4 pb-3", reset.leaving ? "animate-depart" : "animate-arrive")}>
							<NewPassphrase
								onDone={async (passphrase) => {
									if (await onPassphrase(passphrase)) setResetting(false);
								}}
								onCancel={() => setResetting(false)}
							/>
						</div>
					)}
				</Row>

				<Row>
					<Action
						icon={account.blocked ? Undo2 : Ban}
						label={account.blocked ? t("Let back in") : t("Block")}
						note={account.blocked ? undefined : t("They stay listed, and cannot sign in or join until let back in.")}
						danger={!account.blocked}
						disabled={busy}
						onClick={onBlock}
					/>
				</Row>

				<Row>
					<Action icon={Trash2} label={t("Remove")} danger disabled={busy} onClick={() => setDropping(true)} expanded={dropping} />
					{confirm.mounted && (
						<div className={cn("flex flex-wrap items-center gap-2 px-4 pb-3", confirm.leaving ? "animate-depart" : "animate-arrive")}>
							<span className="mr-auto text-[13px]">{t("Remove {name}? This cannot be undone.", { name: account.name })}</span>
							<Button variant="danger" size="sm" disabled={busy} onClick={onDrop}>
								{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
								{t("Remove")}
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setDropping(false)}>
								{t("Cancel")}
							</Button>
						</div>
					)}
				</Row>
			</Group>
		</Section>
	);
}

/** A row that is a press. */
function Action({
	icon: Icon,
	label,
	note,
	danger,
	disabled,
	title,
	expanded,
	onClick,
}: {
	icon: typeof KeyRound;
	label: string;
	note?: string;
	danger?: boolean;
	disabled?: boolean;
	title?: string;
	expanded?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={label}
			aria-expanded={expanded}
			className={cn(
				"flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors",
				"hover:bg-wash active:bg-wash-press disabled:opacity-40 disabled:hover:bg-transparent",
				"focus-visible:bg-wash focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-inset",
				danger ? "text-danger-ink" : "text-fg",
			)}
		>
			<Icon className="size-4 shrink-0" />
			<span className="flex min-w-0 flex-col">
				<span className="text-[14px]">{label}</span>
				{note && <span className="text-fg-muted text-[12.5px]">{note}</span>}
			</span>
		</button>
	);
}

/** The passphrase just made, to be passed on now, and a way to copy it. */
function Made({ made, onDismiss }: { made: { name: string; passphrase: string }; onDismiss: () => void }) {
	const t = useT();

	const [copied, setCopied] = useState(false);

	return (
		<div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-tally/40 bg-tally/10 px-4 py-3">
			<KeyRound className="size-4 shrink-0 text-tally-ink" />
			<span className="min-w-0 flex-1 text-[13.5px]">
				{t("Give this to {name} now. It is not stored and cannot be shown again.", { name: made.name })}
			</span>
			<code className="readout rounded-[8px] bg-surface px-2.5 py-1 text-[13px]">{made.passphrase}</code>
			<Button
				variant="secondary"
				size="sm"
				onClick={() => {
					void navigator.clipboard
						?.writeText(made.passphrase)
						.then(() => setCopied(true))
						.catch(() => {});
				}}
			>
				{copied ? <Check /> : <Copy />}
				{copied ? t("Copied") : t("Copy")}
			</Button>
			<Button variant="ghost" size="icon" onClick={onDismiss} aria-label={t("Dismiss")}>
				<X />
			</Button>
		</div>
	);
}

/**
 * A new account, and what it may use from the start.
 *
 * The boxes are here as well as in the table because the most common reason to
 * tick one is making the account: somebody being added to watch films with the
 * group is given Emby then, not in a second visit afterwards.
 */
function NewAccount({
	canModerate,
	watching,
	policy,
	onDone,
	onCancel,
}: {
	canModerate: boolean;
	watching?: Watching;
	policy?: Policy;
	onDone: (name: string, passphrase: string) => void;
	onCancel: () => void;
}) {
	const t = useT();

	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState(() => suggest());
	const [perms, setPerms] = useState<Record<string, boolean>>(() => ({ ...DEFAULTS }));
	const [saving, setSaving] = useState(false);

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			// The whole set, as the row sends it, so the account is made holding
			// exactly what the boxes showed rather than the server's defaults
			// with whatever this page happened to change laid over them.
			await api.addAccount(name.trim(), passphrase, perms);
			onDone(name.trim(), passphrase);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Section title={t("New account")}>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<Group>
					<div className="flex flex-wrap gap-3 px-4 py-4">
						<label className="flex min-w-36 flex-1 flex-col gap-1.5">
							<span className="text-fg-muted text-[12px]">{t("Name")}</span>
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={32}
								required
								// biome-ignore lint/a11y/noAutofocus: the form opened because it was asked for
								autoFocus
								className={field}
							/>
						</label>

						<label className="flex min-w-52 flex-[2] flex-col gap-1.5">
							{/* Generated rather than typed, and shown rather than hidden. It is
							    about to be read out or pasted into a message, and whoever is
							    doing that has to see it. */}
							<span className="text-fg-muted text-[12px]">{t("First passphrase")}</span>
							<input
								value={passphrase}
								onChange={(event) => setPassphrase(event.target.value)}
								minLength={8}
								required
								className={cn(field, "readout")}
							/>
						</label>
					</div>
				</Group>

				<Group>
					<Permissions
						held={perms}
						onToggle={(permission, on) => setPerms((was) => ({ ...was, [permission]: on }))}
						canModerate={canModerate}
						watching={watching}
						policy={policy}
						disabled={saving}
					/>
				</Group>

				<div className="flex flex-wrap gap-2 px-1">
					<Button type="submit" variant="primary" size="sm" disabled={saving || !name.trim() || passphrase.length < 8}>
						{saving ? <Loader2 className="animate-spin" /> : <Plus />}
						{t("Create")}
					</Button>

					<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
						{t("Cancel")}
					</Button>
				</div>
			</form>
		</Section>
	);
}

/** A field, at the button's height, sixteen pixels under a finger so Safari does not zoom. */
const field = cn(
	"h-9 rounded-[10px] border border-border bg-bg px-3 text-[14px] outline-none transition-colors",
	"pointer-coarse:h-11 pointer-coarse:text-base",
	"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30",
);

function NewPassphrase({
	onDone,
	onCancel,
}: {
	onDone: (passphrase: string) => void;
	onCancel: () => void;
}) {
	const t = useT();

	const [passphrase, setPassphrase] = useState(() => suggest());

	return (
		<form
			className="flex w-full flex-wrap items-center gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				onDone(passphrase);
			}}
		>
			<input
				value={passphrase}
				onChange={(event) => setPassphrase(event.target.value)}
				minLength={8}
				aria-label={t("Set a new passphrase")}
				// biome-ignore lint/a11y/noAutofocus: the field appeared because it was asked for
				autoFocus
				className={cn(field, "readout min-w-48 flex-1")}
			/>

			<Button type="submit" variant="primary" size="sm" disabled={passphrase.length < 8}>
				{t("Set it")}
			</Button>

			<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
				{t("Cancel")}
			</Button>
		</form>
	);
}

/**
 * A passphrase nobody has to invent.
 *
 * Offered filled in because the alternative is somebody typing the name of the
 * deployment twice, and because this one is going to be sent in a message and
 * then changed — it needs to be unguessable and readable aloud, not memorable.
 */
function suggest(): string {
	const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
	const raw = crypto.getRandomValues(new Uint8Array(16));

	return Array.from(raw, (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * A line about an account, for whoever has to recognise it later.
 *
 * A name and a signature say who somebody is to the deployment and nothing
 * about who they are to the person running it. Empty on nearly every account
 * and drawn as a place to write rather than as a field, so a list of accounts
 * nobody has annotated looks like a list of accounts.
 */
function Note({
	account,
	canModerate,
	onSaved,
}: { account: Account; canModerate: boolean; onSaved: () => Promise<void> | void }) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [said, setSaid] = useState(account.note ?? "");
	const [saving, setSaving] = useState(false);
	const busy = useRef(false);

	// Reloaded when the record changes underneath, which this page polls for.
	// Without it, saving a note on one account and then editing another shows
	// the first one's text.
	useEffect(() => setSaid(account.note ?? ""), [account.note]);

	if (!canModerate) {
		return account.note ? (
			<span className="truncate text-fg-muted text-[11.5px]">{account.note}</span>
		) : null;
	}

	// Once per edit. The field stays on screen, and focused, while it fades
	// out, so the blur that follows Escape or a save would otherwise save again
	// — the first after Escape being the very change Escape was pressed to
	// abandon. Read from a ref rather than from the render, because a field
	// disabled while it saves can be blurred by the browser in the same commit
	// that disables it.
	const save = async () => {
		if (!editing || busy.current) return;

		busy.current = true;
		setSaving(true);
		try {
			await api.changeAccount(account.name, { note: said.trim() });
			await onSaved();
			setEditing(false);
		} catch (err) {
			// The sentence the API layer already made from the server's code,
			// which is what every other failure on this page reports. Writing one
			// here would be a second place for the same message to drift.
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			busy.current = false;
			setSaving(false);
		}
	};

	// The line and the field that edits it are one thing in two states, and
	// each leaves as the other arrives (see Swap): the field used to fade in
	// over a line that had gone between two frames.
	return (
		<Swap showing={editing ? 1 : 0}>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className={cn(
					"max-w-full truncate rounded-sm text-left text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/70",
					account.note ? "text-fg" : "text-fg-muted",
					"hover:text-fg",
				)}
			>
				{account.note || t("Add a note")}
			</button>

			<input
				// biome-ignore lint/a11y/noAutofocus: opened by a press, and the press is the request to type
				autoFocus
				value={said}
				disabled={saving}
				onChange={(event) => setSaid(event.target.value)}
				onBlur={() => void save()}
				onKeyDown={(event) => {
					if (!editing) return;
					if (event.key === "Enter") void save();
					// Away without saving, which a field opened by a misclick needs.
					// Kept from the sheet around it, which closes on Escape too:
					// the press is for the field, and closing the sheet with it
					// would take the account away along with the edit.
					if (event.key === "Escape") {
						event.preventDefault();
						setSaid(account.note ?? "");
						setEditing(false);
					}
				}}
				aria-label={t("Note")}
				maxLength={200}
				className={cn(
					"h-9 w-full rounded-[10px] border border-border bg-bg px-3 pointer-coarse:h-11",
					"text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40 pointer-coarse:text-base",
				)}
			/>
		</Swap>
	);
}

/**
 * The groups somebody belongs to, each a key to every room held under it.
 *
 * Drawn the way a room names them, after an `@`, so the label on the account
 * and the end of the room name read as the same thing — which they are: a member
 * of `acme` is somebody who may say `standup@acme`.
 *
 * Edited as one line of text rather than a field per tag, because a list of
 * three is typed faster than it is assembled, and the server tidies what was
 * typed into what the door will read: lowercased, trimmed, and each one once.
 * A tag it cannot read refuses the whole change rather than vanishing from it,
 * since a tag that quietly did not save is somebody who believes they let a
 * person in and did not.
 */
function Scopes({
	account,
	canModerate,
	onSaved,
}: { account: Account; canModerate: boolean; onSaved: () => Promise<void> | void }) {
	const t = useT();
	const held = account.scopes ?? [];
	const [editing, setEditing] = useState(false);
	const [said, setSaid] = useState(held.join(", "));
	const [saving, setSaving] = useState(false);
	const busy = useRef(false);

	// Reloaded when the record changes underneath, for the reason the note is.
	const joined = held.join(", ");
	useEffect(() => setSaid(joined), [joined]);

	if (!canModerate && held.length === 0) return null;

	// Once per edit, for the reason the note's is.
	const save = async () => {
		if (!editing || busy.current) return;

		busy.current = true;
		setSaving(true);
		try {
			await api.changeAccount(account.name, {
				scopes: said
					.split(/[\s,]+/)
					.map((one) => one.replace(/^@/, ""))
					.filter(Boolean),
			});
			await onSaved();
			setEditing(false);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			busy.current = false;
			setSaving(false);
		}
	};

	const tags = (
		<span className="flex flex-wrap items-center gap-1">
			{held.map((scope) => (
				<span key={scope} className="readout rounded-full bg-surface-hi px-2 py-0.5 text-[12px] text-fg">
					@{scope}
				</span>
			))}

			{canModerate && (
				<button
					type="button"
					onClick={() => setEditing(true)}
					aria-label={t("Scopes")}
					title={t("Scopes")}
					className={cn(
						"flex items-center gap-1 rounded-sm text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/70",
						held.length > 0 ? "p-0.5 text-fg-muted" : "text-fg-muted",
						"hover:text-fg",
					)}
				>
					<AtSign className="size-3" />
					{held.length === 0 && t("Add to a scope")}
				</button>
			)}
		</span>
	);

	// Only somebody who may edit them ever sees the field, so for anybody else
	// the tags stand alone and nothing swaps.
	if (!canModerate) return tags;

	return (
		<Swap showing={editing ? 1 : 0}>
			{tags}

			<input
				// biome-ignore lint/a11y/noAutofocus: opened by a press, and the press is the request to type
				autoFocus
				value={said}
				disabled={saving}
				onChange={(event) => setSaid(event.target.value)}
				onBlur={() => void save()}
				onKeyDown={(event) => {
					if (!editing) return;
					if (event.key === "Enter") void save();
					if (event.key === "Escape") {
						event.preventDefault();
						setSaid(joined);
						setEditing(false);
					}
				}}
				aria-label={t("Scopes")}
				// Not translated: these are names a room is held under, which are
				// lowercase ASCII in every language, so an example in any other
				// script would be an example of something the server refuses.
				placeholder="acme, team-b"
				maxLength={400}
				className={cn(
					"readout h-9 w-full rounded-[10px] border border-border bg-bg px-3 pointer-coarse:h-11",
					"text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40 pointer-coarse:text-base",
				)}
			/>
		</Swap>
	);
}

/**
 * The relays somebody has of their own: machines they provided for themselves,
 * offered to them and nobody else (store/own.go on the server).
 *
 * A box per relay rather than a line of text, unlike the scopes, because these
 * are names this deployment already has: a typed one that matched nothing would
 * only be refused. A relay kept for administrators is left off, since it cannot
 * be anybody's own, unless this account somehow holds one already, which is
 * then shown so it can be taken away.
 *
 * The list is read when the sheet opens and not before. It is the relay page's
 * own list, which asks every relay whether it is answering, and the accounts
 * page redraws every half minute whether or not anybody is looking at a sheet.
 */
function OwnRelays({
	account,
	canEdit,
	onSaved,
}: { account: Account; canEdit: boolean; onSaved: () => Promise<void> | void }) {
	const t = useT();
	const { value, error } = usePoll(api.relays, { every: 60_000 });
	const held = account.relays ?? [];
	const [saving, setSaving] = useState<string>();
	const busy = useRef(false);

	const relays = (value?.relays ?? []).filter((one) => !one.adminOnly || held.includes(one.name));

	// Once at a time, for the reason a note is saved once: two presses in
	// flight would each send the list as it stood before the other.
	const toggle = async (name: string, on: boolean) => {
		if (busy.current) return;

		busy.current = true;
		setSaving(name);
		try {
			await api.changeAccount(account.name, {
				relays: on ? [...held, name] : held.filter((one) => one !== name),
			});
			await onSaved();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			busy.current = false;
			setSaving(undefined);
		}
	};

	if (error) return <p className="text-fg-muted text-[13px]">{t("Something went wrong. Try again.")}</p>;
	if (value === undefined) {
		return (
			<Loader2
				className="size-4 animate-spin text-fg-muted"
				aria-label={t("Loading {title}", { title: t("Their own relays") })}
			/>
		);
	}
	if (relays.length === 0) return <p className="text-fg-muted text-[13px]">{t("This deployment keeps no relay list.")}</p>;

	return (
		<div className="flex flex-col gap-0.5">
			{relays.map((relay) => {
				const others = (relay.owners ?? []).filter((one) => one.toLowerCase() !== account.name.toLowerCase());

				return (
					<Box
						key={relay.name}
						label={relay.label || relay.name}
						checked={held.includes(relay.name)}
						disabled={!canEdit || saving !== undefined}
						saving={saving === relay.name}
						onChange={(on) => void toggle(relay.name, on)}
					>
						<Hint show={others.length > 0}>{t("Also {names}'s own", { names: others.join(", ") })}</Hint>
						<Hint show={held.includes(relay.name) && !relay.forwards}>
							{t("Does not forward other rooms, so they can only join meetings held on it.")}
						</Hint>
						<Hint show={!relay.enabled}>{t("Not taking new calls")}</Hint>
					</Box>
				);
			})}
		</div>
	);
}
