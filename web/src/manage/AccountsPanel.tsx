import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/live/notices";
import {
	AtSign,
	Ban,
	KeyRound,
	Loader2,
	Plus,
	ShieldCheck,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Account, type Policy, type Watching, api } from "./api";
import { Box, Fade, Hint, Swap, Working } from "./Boxes";
import { DEFAULTS, PERMISSION_NAMES, PERMISSIONS, type Permission } from "./grants";
import { useOptimistic } from "./pending";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { since, size } from "./units";

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
 * And what each account may use, as six boxes behind a shield on its row. The
 * row itself carries a line of what the account holds, so the question asked
 * most — who has Emby, and what has it cost — is answered without opening
 * anything: Emby is the one grant that spends the deployment's bandwidth, so it
 * is drawn in the signal colour with what the relay has carried for that person
 * beside it.
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
}: {
	/** May make, change and remove accounts. */
	canAccounts: boolean;
	/** May also give and take away Emby. */
	canModerate: boolean;
	onSignedOut: () => void;
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
	const [resetting, setResetting] = useState<string>();
	const [made, setMade] = useState<{ name: string; passphrase: string }>();

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

	// Held on screen while they leave, for the reason RelaysPanel gives: a form
	// or a banner gone between two frames reads as the page redrawing rather
	// than as something being shut.
	const form = useLingering(canAccounts && adding);
	const offer = useLingering(canAccounts && !adding, 160);
	const banner = useLingering(made !== undefined);
	const empty = useLingering(value !== undefined && accounts.length === 0 && !adding);
	const footnote = useLingering(
		accounts.some((one) => one.effective?.emby || (one.embySpent ?? 0) > 0),
	);

	// What the banner said, kept while it fades: the state that decided it is
	// already gone by then, and a banner leaving with no passphrase in it is
	// one that flickers empty on its way out.
	const shown = useRef(made);
	if (made) shown.current = made;

	if (error) return <Failed>{error}</Failed>;

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-3 sm:gap-4">
			<Card
				title={t("Accounts")}
				note={`${accounts.length}`}
				actions={
					offer.mounted && (
						<button
							type="button"
							onClick={() => setAdding(true)}
							className={cn(
								"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi",
								offer.leaving ? "animate-fade-out" : "animate-fade-in",
							)}
						>
							<Plus className="size-3.5" />
							{t("New account")}
						</button>
					)
				}
			>
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
					<div
						className={cn(
							"flex flex-wrap items-center gap-2 border-border border-b bg-tally/10 px-3 py-3 sm:px-4",
							banner.leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<span className="text-[12px] text-fg">
							{t("Give this to {name} now. It is not stored and cannot be shown again.", {
								name: shown.current.name,
							})}
						</span>
						<code className="readout rounded bg-surface-hi px-2 py-1 text-[12.5px] text-fg">
							{shown.current.passphrase}
						</code>
						<button
							type="button"
							onClick={() => setMade(undefined)}
							className="ml-auto rounded-md border border-border p-1 hover:bg-surface-hi"
							aria-label={t("Dismiss")}
						>
							<X className="size-3.5" />
						</button>
					</div>
				)}

				{empty.mounted && (
					<p
						className={cn(
							"px-3 py-4 text-fg-muted text-sm sm:px-4",
							empty.leaving ? "animate-fade-out" : "animate-fade-in",
						)}
					>
						{t("No accounts yet. Somebody without one can still join a room, under whatever name they choose.")}
					</p>
				)}

				<ul>
					{accounts.map((account) => (
						<AccountRow
							key={account.name}
							account={account}
							canAccounts={canAccounts}
							canModerate={canModerate}
							watching={watching}
							policy={policy}
							busy={busy === account.name}
							resetting={resetting === account.name}
							onReset={() => setResetting(account.name)}
							onCancelReset={() => setResetting(undefined)}
							onPassphrase={async (passphrase) => {
								setResetting(undefined);
								if (await act(account.name, () => api.changeAccount(account.name, { passphrase }))) {
									setMade({ name: account.name, passphrase });
								}
							}}
							onBlock={() =>
								act(account.name, () =>
									api.changeAccount(account.name, { blocked: !account.blocked }),
								)
							}
							onDrop={() => act(account.name, () => api.dropAccount(account.name))}
							onSaved={refresh}
						/>
					))}
				</ul>
			</Card>

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("A passphrase is never stored, so nobody can be shown one later — not even you. What you can do is set a new one and pass it on. People sign in at /account to change it themselves and to choose a picture.")}
			</p>

			{/* Said once under the list rather than on every row: the figures are
			    counted in memory by the process relaying the films, and a reader
			    who saw one drop to nothing overnight should be able to find out
			    why without reading the server. */}
			{footnote.mounted && (
				<p
					className={cn(
						"px-1 text-fg-muted text-[11.5px] leading-relaxed",
						footnote.leaving ? "animate-fade-out" : "animate-fade-in",
					)}
				>
					{t("Emby figures count what was relayed since the server last started, and go back to nought when it restarts.")}
				</p>
			)}
		</div>
	);
}

/**
 * One account: who it is, what it holds, and the controls for both.
 *
 * Its own component so each row can hold its own state — the boxes it has
 * ticked and not yet heard back about, and whether its panel is open — rather
 * than the list keeping a map of every row's.
 */
function AccountRow({
	account,
	canAccounts,
	canModerate,
	watching,
	policy,
	busy,
	resetting,
	onReset,
	onCancelReset,
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
	resetting: boolean;
	onReset: () => void;
	onCancelReset: () => void;
	onPassphrase: (passphrase: string) => void;
	onBlock: () => void;
	onDrop: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = useT();

	const [granting, setGranting] = useState(false);

	// Drawn from what the server says the account holds, with any press still
	// in flight laid over it, so the line of badges and the boxes move together
	// and at once.
	const grants = useOptimistic(account.effective, onSaved);

	// As the server reads it: the account as stored holding Emby, whatever is
	// in flight on its boxes.
	const resetLocked = !canModerate && (account.effective?.emby ?? false);

	const panel = useLingering(canAccounts && granting);
	const reset = useLingering(canAccounts && resetting && !resetLocked);

	const toggle = (permission: Permission, on: boolean) =>
		void grants.set(permission, on, (perms) => api.changeAccount(account.name, { perms }));

	return (
		<li
			className={cn(
				"flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b px-3 py-3 transition-colors last:border-0 sm:px-4",
				account.blocked && "bg-danger/5",
			)}
		>
			<Face account={account} />

			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					<span className="truncate text-fg text-sm">{account.name}</span>

					<Fade show={account.blocked ?? false}>
						<span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10.5px] text-danger">
							{t("blocked")}
						</span>
					</Fade>
				</span>

				<span className="readout text-fg-muted text-[12px]">{account.trip}</span>

				{/* Whatever whoever made this account wrote about it.
				    The store has held it, the API has sent it and taken
				    it back, and nothing drew it — so an account was a
				    name and a signature, and "which of the two Chens is
				    this" had no answer anywhere. */}
				<Note account={account} canModerate={canAccounts} onSaved={onSaved} />

				<Scopes account={account} canModerate={canAccounts} onSaved={onSaved} />

				<Held held={grants.held} spent={account.embySpent} blocked={account.blocked ?? false} />
			</div>

			<div className="ml-auto flex items-center gap-3">
				<span className="text-fg-muted text-xs tabular-nums">
					{account.lastSeen ? since(account.lastSeen) : t("never here")}
				</span>

				{canAccounts && (
					<div className="flex items-center gap-1.5">
						<Working on={busy} />

						<button
							type="button"
							onClick={() => setGranting((was) => !was)}
							aria-expanded={granting}
							aria-label={t("Permissions")}
							title={t("Permissions")}
							className={cn(
								"rounded-md border border-border p-1.5 text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
								granting && "bg-surface-hi text-fg",
							)}
						>
							<ShieldCheck className="size-3.5" />
						</button>

						{/* Not offered for somebody who holds Emby to an administrator
						    who cannot give it: setting their passphrase is choosing who
						    holds the grant, and the server refuses it for the same
						    reason it refuses the box. Drawn and disabled, with the
						    reason, rather than offered and refused. */}
						<button
							type="button"
							onClick={onReset}
							disabled={resetLocked}
							aria-label={t("Set a new passphrase")}
							title={
								resetLocked
									? t("Only an administrator who can manage everything can give or take away Emby, or set the passphrase of somebody who has it.")
									: t("Set a new passphrase")
							}
							className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-hi hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
						>
							<KeyRound className="size-3.5" />
						</button>

						<button
							type="button"
							disabled={busy}
							onClick={onBlock}
							aria-label={account.blocked ? t("Let back in") : t("Block")}
							title={account.blocked ? t("Let back in") : t("Block")}
							className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-hi hover:text-danger disabled:opacity-40"
						>
							{account.blocked ? <Undo2 className="size-3.5" /> : <Ban className="size-3.5" />}
						</button>

						<button
							type="button"
							disabled={busy}
							onClick={onDrop}
							aria-label={t("Remove")}
							title={t("Remove")}
							className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-hi hover:text-danger disabled:opacity-40"
						>
							<Trash2 className="size-3.5" />
						</button>
					</div>
				)}
			</div>

			{/* Under the row and the width of it. The row wraps, so a full-width
			    child takes a line of its own on every screen, which is where a
			    set of six boxes with sentences under two of them has room. */}
			{panel.mounted && (
				<fieldset
					className={cn(
						"w-full min-w-0 rounded-md border border-border px-3 pt-1 pb-3",
						panel.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<legend className="px-1 text-[11px] text-fg-muted">{t("Permissions")}</legend>

					<Permissions
						held={grants.held}
						saving={grants.saving}
						onToggle={toggle}
						canModerate={canModerate}
						watching={watching}
						policy={policy}
					/>
				</fieldset>
			)}

			{reset.mounted && (
				<div className={cn("w-full", reset.leaving ? "animate-depart" : "animate-arrive")}>
					<NewPassphrase onDone={onPassphrase} onCancel={onCancelReset} />
				</div>
			)}
		</li>
	);
}

/**
 * What an account holds, as a line of badges.
 *
 * Every permission, rather than only the ones held. An account that has lost
 * the music library differs from its neighbours by one word, and a word that is
 * missing from a line of five is a difference nobody sees; struck through, it is
 * one they do. Emby is the exception in both directions: not held is what every
 * account starts as, so it is drawn only where it is held or has cost
 * something, and then in the signal colour, with the figure beside it.
 */
function Held({ held, spent, blocked }: { held: Record<string, boolean>; spent?: number; blocked: boolean }) {
	const t = useT();

	return (
		<span className="flex flex-wrap items-center gap-1 pt-0.5">
			{PERMISSIONS.map((permission) => {
				const on = held[permission] ?? false;

				if (permission === "emby") {
					// Held but unusable without watching together, which the
					// library and every film ask for first, or on an account
					// that is blocked, which the server holds to nothing: struck,
					// like any other grant that does nothing.
					const live = on && (held.watch ?? false) && !blocked;

					return (
						<Fade key={permission} show={on || (spent ?? 0) > 0}>
							{/* Two halves that each keep together, so that on a phone
							    too narrow for the whole the badge breaks between the
							    grant and its figure rather than inside the figure —
							    "relayed since" on one line and "restart" alone under
							    it, which read as a badge that had come apart. */}
							<span
								className={cn(
									"readout inline-flex flex-wrap gap-x-1 rounded bg-tally/15 px-1.5 py-0.5 text-[10.5px] text-tally transition-opacity",
									!live && "opacity-60",
								)}
							>
								<span className="whitespace-nowrap">
									<span className={cn(!live && "line-through")}>{t(PERMISSION_NAMES.emby)}</span>
									{!live && <span className="sr-only"> {t("not allowed")}</span>}
									{" ·"}
								</span>
								<span className="whitespace-nowrap">
									{t("{size} relayed since restart", { size: size(spent ?? 0) })}
								</span>
							</span>
						</Fade>
					);
				}

				return (
					<span
						key={permission}
						className={cn(
							"rounded bg-surface-hi px-1.5 py-0.5 text-[10.5px] text-fg-muted transition-opacity",
							!on && "line-through opacity-50",
						)}
					>
						{t(PERMISSION_NAMES[permission])}
						{!on && <span className="sr-only"> {t("not allowed")}</span>}
					</span>
				);
			})}
		</span>
	);
}

/**
 * The six boxes, for an account that exists and for one being made.
 *
 * Each with what it needs saying beside it, rather than a paragraph above all
 * six: the reason a box is grey belongs next to the box.
 */
function Permissions({
	held,
	saving,
	onToggle,
	canModerate,
	watching,
	policy,
	disabled,
}: {
	held: Record<string, boolean>;
	saving?: (permission: string) => boolean;
	onToggle: (permission: Permission, on: boolean) => void;
	canModerate: boolean;
	watching?: Watching;
	policy?: Policy;
	disabled?: boolean;
}) {
	const t = useT();

	const watch = held.watch ?? false;
	const emby = held.emby ?? false;

	// Ticking Emby needs watching together, since the library and every film
	// ask for that first; unticking it never does, so that a grant left behind
	// by unticking watching can still be taken away.
	const needsWatch = !watch && !emby;

	// Off for the whole deployment: where the file relays nothing, Emby is
	// relayed only while the switch is on. A grant is still worth ticking ahead
	// of turning it on, so the box stays live and says so.
	const switchedOff = watching !== undefined && watching.directOnly && !watching.embyRelay;
	const noGateway = watching !== undefined && !watching.configured;

	return (
		<div className="grid gap-x-6 gap-y-2.5 pt-1 sm:grid-cols-2">
			{PERMISSIONS.map((permission) => {
				const on = held[permission] ?? false;
				const busy = saving?.(permission) ?? false;

				if (permission === "emby") {
					return (
						<Box
							key={permission}
							label={t(PERMISSION_NAMES.emby)}
							tone="tally"
							checked={on}
							saving={busy}
							disabled={disabled || !canModerate || needsWatch}
							onChange={(next) => onToggle(permission, next)}
							// The box with the most to say takes the full width,
							// so its sentences are not a column of three words
							// on a phone.
							className="sm:col-span-2"
						>
							<Hint show={!canModerate}>
								{t("Only an administrator who can manage everything can change this.")}
							</Hint>
							<Hint show={canModerate && needsWatch}>{t("Needs Watch together ticked first.")}</Hint>
							<Hint show={noGateway}>
								{t("This deployment has no watch-together gateway, so this does nothing.")}
							</Hint>
							<Hint show={!noGateway && switchedOff}>
								{t("The Emby relay is switched off for the whole site, so this does nothing until it is turned on under Rooms.")}
							</Hint>
							<Hint>
								{t("Ticked, the films this person picks from Emby are relayed through the CDN to everybody in the room, for as long as each of them watches.")}
							</Hint>
						</Box>
					);
				}

				return (
					<Box
						key={permission}
						label={t(PERMISSION_NAMES[permission])}
						checked={on}
						saving={busy}
						disabled={disabled}
						onChange={(next) => onToggle(permission, next)}
					>
						{permission === "open" && (
							// Under any other policy a passphrase that belongs to
							// no account can open a room too, and this box cannot
							// stop somebody who signs in with one of those. Said,
							// so it is not mistaken for a lock.
							<Hint show={policy !== undefined && policy.openedBy !== "accounts"}>
								{t("Applies fully only while new rooms are set to Accounts only.")}
							</Hint>
						)}
					</Box>
				);
			})}
		</div>
	);
}

/** Somebody's picture, or their initial where they have not chosen one. */
function Face({ account }: { account: { name: string; trip: string; avatar?: boolean } }) {
	if (account.avatar) {
		return (
			<img
				src={`/api/avatar/${encodeURIComponent(account.trip)}`}
				alt=""
				className="size-8 shrink-0 rounded-full object-cover"
			/>
		);
	}

	return (
		<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-hi text-fg-muted text-sm">
			{account.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

/**
 * A new account, and what it may use from the start.
 *
 * The boxes are here as well as on the row because the most common reason to
 * tick one is making the account: somebody being added to watch films with the
 * group is given Emby then, not in a second visit to the row afterwards.
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
		<form
			className="flex flex-col gap-3 border-border border-b px-3 py-3 sm:px-4"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex min-w-32 flex-1 flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Name")}</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={32}
						required
						// biome-ignore lint/a11y/noAutofocus: the form opened because it was asked for
						autoFocus
						className="rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</label>

				<label className="flex min-w-48 flex-[2] flex-col gap-1">
					{/* Generated rather than typed, and shown rather than hidden. It is
					    about to be read out or pasted into a message, and whoever is
					    doing that has to see it. */}
					<span className="text-fg-muted text-[11px]">{t("First passphrase")}</span>
					<input
						value={passphrase}
						onChange={(event) => setPassphrase(event.target.value)}
						minLength={8}
						required
						className="readout rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</label>
			</div>

			<fieldset className="min-w-0 rounded-md border border-border px-3 pt-1 pb-3">
				<legend className="px-1 text-[11px] text-fg-muted">{t("Permissions")}</legend>

				<Permissions
					held={perms}
					onToggle={(permission, on) => setPerms((was) => ({ ...was, [permission]: on }))}
					canModerate={canModerate}
					watching={watching}
					policy={policy}
					disabled={saving}
				/>
			</fieldset>

			<div className="flex flex-wrap gap-2">
				<button
					type="submit"
					disabled={saving || !name.trim() || passphrase.length < 8}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
					{t("Create")}
				</button>

				<button
					type="button"
					onClick={onCancel}
					className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi"
				>
					{t("Cancel")}
				</button>
			</div>
		</form>
	);
}

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
			className="flex w-full flex-wrap items-center gap-2 pt-1"
			onSubmit={(event) => {
				event.preventDefault();
				onDone(passphrase);
			}}
		>
			<input
				value={passphrase}
				onChange={(event) => setPassphrase(event.target.value)}
				minLength={8}
				// biome-ignore lint/a11y/noAutofocus: the field appeared because it was asked for
				autoFocus
				className="readout min-w-48 flex-1 rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
			/>

			<button
				type="submit"
				disabled={passphrase.length < 8}
				className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
			>
				{t("Set it")}
			</button>

			<button
				type="button"
				onClick={onCancel}
				className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi"
			>
				{t("Cancel")}
			</button>
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
					"max-w-full truncate rounded-sm text-left text-[11.5px]",
					account.note ? "text-fg-muted" : "text-fg-muted/50 italic",
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
					if (event.key === "Escape") {
						setSaid(account.note ?? "");
						setEditing(false);
					}
				}}
				aria-label={t("Note")}
				maxLength={200}
				className={cn(
					"w-full rounded-md border border-border bg-surface-hi px-2 py-1",
					"text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40",
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
				<span key={scope} className="readout rounded bg-surface-hi px-1.5 py-0.5 text-[10.5px] text-fg-muted">
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
						"flex items-center gap-1 rounded-sm text-[11px]",
						held.length > 0 ? "p-0.5 text-fg-muted" : "text-fg-muted/50 italic",
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
					"readout w-full rounded-md border border-border bg-surface-hi px-2 py-1",
					"text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40",
				)}
			/>
		</Swap>
	);
}
