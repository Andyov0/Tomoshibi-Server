import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/live/notices";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Administrator, api } from "./api";
import { Box, Fade, Hint, Swap, Working } from "./Boxes";
import { CAPABILITIES, CAPABILITY_NAMES, type Capability, PERMISSION_NAMES } from "./grants";
import { useOptimistic } from "./pending";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { size } from "./units";

/**
 * Who else may open these pages.
 *
 * Somebody is recognised here by the signature their passphrase produces, and
 * this server is never told the passphrase itself. That is what makes adding
 * somebody safe to do over a chat message: the signature is already public — it
 * prints beside its owner's name in every room they join — so the person being
 * added hands over something everybody they have ever spoken to already has.
 *
 * The list was a section of a configuration file until it was this. The reason
 * it moved is when it changes: somebody joins the team on a Tuesday, and
 * editing a file and restarting to record that would end every call the
 * deployment is holding, for a change that alters nothing about any of them.
 *
 * Everything here that changes the list is moderate's. The finer capabilities —
 * rooms, accounts, relays, settings — do not reach it: somebody trusted to look
 * after the accounts is not thereby trusted to decide who else may, and an
 * administrator who could appoint one with more than they hold would hold it.
 * The same is true of each administrator's Emby grant, which is here rather
 * than on the accounts page because an administrator is not an account.
 */
export function AdminsPanel({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	const t = useT();

	// Slowly. This list changes when somebody joins or leaves a team, which is
	// not a thing that happens while a page is open.
	const { value, error, refresh } = usePoll(api.admins, { every: 60_000, onSignedOut });

	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState<string>();

	const act = useCallback(
		async (trip: string, run: () => Promise<unknown>) => {
			if (busy) return;

			setBusy(trip);

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

	// Appointing anybody is moderate's and nothing finer: see the comment
	// above. A page offering it to the others would offer a form the server
	// refuses on every press.
	const canAppoint = canModerate;

	const form = useLingering(canAppoint && adding);
	const offer = useLingering(canAppoint && !adding, 160);

	if (error) return <Failed>{error}</Failed>;

	const admins = value ?? [];
	const moderators = admins.filter((one) => one.can.includes("moderate")).length;

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-3 sm:gap-4">
			<Card
				title={t("Administrators")}
				note={
					moderators === 1
						? t("One of these can manage everything")
						: `${moderators} ${t("can manage everything")}`
				}
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
							{t("Add somebody")}
						</button>
					)
				}
			>
				{form.mounted && (
					<div className={form.leaving ? "animate-depart" : "animate-arrive"}>
						<AddAdmin
							onDone={async () => {
								setAdding(false);
								await refresh();
							}}
							onCancel={() => setAdding(false)}
						/>
					</div>
				)}

				<ul>
					{admins.map((one) => (
						<Row
							key={one.trip}
							admin={one}
							canAppoint={canAppoint}
							// The last person who can appoint anybody cannot be
							// removed or demoted, and the server refuses it either
							// way. Said here too, so the control is not offered and
							// then refused.
							onlyOwner={moderators === 1 && one.can.includes("moderate")}
							busy={busy === one.trip}
							onRole={(can) => act(one.trip, () => api.changeAdmin(one.trip, { can }))}
							onDrop={() => act(one.trip, () => api.dropAdmin(one.trip))}
							// The name alone. This used to send the role back with
							// it, and the role it had to hand was the one the list
							// spells out — moderate and its four finer capabilities
							// — so renaming a moderator wrote four grants nobody
							// chose into their record.
							onRename={(name) => act(one.trip, () => api.changeAdmin(one.trip, { name }))}
							onSaved={refresh}
						/>
					))}
				</ul>
			</Card>

			<OwnPassphrase />

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("A signature is what a passphrase produces, and it is public: it prints beside its owner's name in every room they join. Ask somebody for theirs rather than for their passphrase, which this server is never told and could not store.")}
			</p>

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("Every administrator can see everything. Only one who can manage everything can appoint administrators or give anybody Emby.")}{" "}
				{t("Emby figures count what was relayed since the server last started, and go back to nought when it restarts.")}
			</p>
		</div>
	);
}

/**
 * The four boxes of a custom role: one column on the narrowest phones, where two
 * cut "Manage accounts" across two lines beside a box centred on neither; two
 * from there; and a row of four once there is room for it.
 */
const CAPABILITY_GRID = "grid grid-cols-1 gap-x-6 gap-y-2.5 pt-1 min-[360px]:grid-cols-2 sm:grid-cols-4";

/** The three things the role control can say. */
type Role = "observe" | "moderate" | "custom";

/**
 * What somebody's grants amount to, as the role control says it.
 *
 * Read from what is written, and moderate asked first — two guards against one
 * fault, either of which would hold alone. A moderator holds all four finer
 * capabilities as well and the list of what they hold spells them out, so read
 * from that list in the other order every moderator would draw as a custom
 * administrator who happened to tick every box, and the first box anybody then
 * unticked would take the roster and the Emby grant away with it. What is
 * written against a moderator is the one word, because the server drops the
 * four beside it.
 */
function roleOf(granted: readonly string[]): Role {
	if (granted.includes("moderate")) return "moderate";
	if (CAPABILITIES.some((one) => granted.includes(one))) return "custom";

	return "observe";
}

function Row({
	admin,
	canAppoint,
	onlyOwner,
	busy,
	onRole,
	onDrop,
	onRename,
	onSaved,
}: {
	admin: Administrator;
	canAppoint: boolean;
	onlyOwner: boolean;
	busy: boolean;
	onRole: (can: string[]) => Promise<void> | void;
	onDrop: () => void;
	onRename: (name: string) => void;
	onSaved: () => Promise<void>;
}) {
	const t = useT();

	const [name, setName] = useState(admin.name);

	// What is written against them. A server older than the page sends no
	// granted, and its can is then observe and perhaps moderate and nothing
	// finer, which reads the same.
	const granted = admin.granted ?? admin.can.filter((one) => one !== "observe");
	const stored = roleOf(granted);

	// Choosing "custom" for somebody who may only look changes nothing yet —
	// no box is ticked, which is what looking means — so the choice is held
	// here until a box is. Held as well once the last box is unticked, so the
	// boxes do not vanish from under the pointer that unticked them.
	const [customising, setCustomising] = useState(stored === "custom");
	useEffect(() => {
		if (stored === "custom") setCustomising(true);
		if (stored === "moderate") setCustomising(false);
	}, [stored]);

	const role: Role = stored === "observe" && customising ? "custom" : stored;

	// Built once per answer rather than once per render. The boxes take a new
	// object as a new answer from the server, and one made on every render
	// would be taken as the server saying again what it said before the last
	// box was accepted.
	const written = granted.join(",");
	const boxes = useMemo(
		() => Object.fromEntries(CAPABILITIES.map((one) => [one, written.split(",").includes(one)])),
		[written],
	);
	const caps = useOptimistic(boxes, onSaved);
	const grants = useOptimistic(admin.effective, onSaved);

	const custom = useLingering(role === "custom");

	const choose = (next: Role) => {
		if (next === "observe") {
			setCustomising(false);
			void onRole([]);
			return;
		}

		if (next === "moderate") {
			setCustomising(false);
			void onRole(["moderate"]);
			return;
		}

		setCustomising(true);

		// From moderate, custom starts with all four ticked: what they could
		// change a moment ago, less the roster and the Emby grant. Starting
		// from nothing would be taking every switch away in one press of a
		// select that looks as though it only opened some boxes.
		if (stored === "moderate") void onRole([...CAPABILITIES]);
	};

	// The boxes pressed, and nothing about the others: the server lays them
	// over the list it holds. Sent as the whole list once, built from what this
	// page last drew, a box pressed here undid whatever another administrator
	// had pressed since the page last asked; and a first attempt at sending
	// less built that list from the press alone, so ticking Relays for
	// somebody who managed the accounts left them managing only the relays.
	const toggleCap = (capability: Capability, on: boolean) =>
		void caps.set(capability, on, (changes) => api.changeAdmin(admin.trip, { caps: changes }));

	const emby = grants.held.emby ?? false;
	const spent = admin.embySpent ?? 0;

	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b px-3 py-3 last:border-0 sm:px-4">
			<div className="flex min-w-0 flex-col gap-1">
				<span className="flex items-center gap-2">
					{canAppoint ? (
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
							onBlur={() => {
								// Saved on leaving the field rather than on every
								// keystroke, which would save halfway through a word.
								if (name.trim() !== admin.name) onRename(name.trim());
							}}
							placeholder={t("Unnamed")}
							maxLength={64}
							// Pulled left by its border and padding, so the name starts
							// where the signature under it does, and the field shows
							// only on hover and focus, around the text.
							className="-ml-[5px] w-32 min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-fg text-sm outline-none hover:border-border focus:border-border focus:bg-surface-hi"
						/>
					) : (
						<span className="truncate text-fg text-sm">{admin.name || t("Unnamed")}</span>
					)}
					{admin.self && (
						<span className="rounded-full border border-border px-1.5 text-[10px] text-fg-muted">
							{t("you")}
						</span>
					)}
				</span>
				<span className="readout text-fg-muted text-[12px]">{admin.trip}</span>

				{/* Their Emby grant, which being an administrator does not carry:
				    every other permission they hold by being one, and this one
				    spends the deployment's bandwidth, so it is given to them as it
				    is to anybody — by somebody who can manage everything, and
				    that includes giving it to oneself. */}
				{canAppoint ? (
					<Box
						label={t("May use the Emby library")}
						tone="tally"
						checked={emby}
						saving={grants.saving("emby")}
						onChange={(on) =>
							void grants.set("emby", on, (perms) => api.changeAdmin(admin.trip, { perms }))
						}
					>
						<Hint show={emby || spent > 0}>
							{t("{size} relayed since restart", { size: size(spent) })}
						</Hint>
					</Box>
				) : (
					<Fade show={emby || spent > 0}>
						<span
							className={cn(
								"readout rounded bg-tally/15 px-1.5 py-0.5 text-[10.5px] text-tally",
								!emby && "opacity-60",
							)}
						>
							<span className={cn(!emby && "line-through")}>{t(PERMISSION_NAMES.emby)}</span>
							{!emby && <span className="sr-only"> {t("not allowed")}</span>}
							{" · "}
							{t("{size} relayed since restart", { size: size(spent) })}
						</span>
					</Fade>
				)}
			</div>

			<div className="ml-auto flex items-center gap-3">
				<Working on={busy} />

				{/*
				  * One control for the role, and boxes only for the custom one.
				  *
				  * Viewing and managing everything are ends of a line rather
				  * than combinations — everybody listed may view, and managing
				  * everything holds every capability and the roster besides —
				  * so a box for each would admit sets that mean nothing and
				  * invite somebody to tick the wrong one. Custom is the one
				  * choice that is a combination, and it opens the four boxes
				  * that make it up.
				  */}
				<select
					value={role}
					disabled={!canAppoint || busy || onlyOwner}
					onChange={(event) => choose(event.target.value as Role)}
					aria-label={t("May")}
					className={cn(
						"rounded-md border border-border bg-surface-hi px-2 py-1 text-[12px] text-fg",
						"outline-none transition-colors hover:border-fg/20",
						"focus-visible:ring-2 focus-visible:ring-fg/40 disabled:opacity-40",
					)}
					title={onlyOwner ? t("The last administrator who can manage everything cannot be removed") : undefined}
				>
					<option value="observe">{t("Can watch")}</option>
					<option value="moderate">{t("Can manage everything")}</option>
					<option value="custom">{t("Custom…")}</option>
				</select>

				{canAppoint && (
					<button
						type="button"
						disabled={busy || onlyOwner}
						onClick={onDrop}
						aria-label={t("Remove")}
						title={onlyOwner ? t("The last administrator who can manage everything cannot be removed") : t("Remove")}
						className={cn(
							"rounded-md border border-border p-1.5",
							onlyOwner ? "opacity-40" : "hover:bg-surface-hi hover:text-danger",
						)}
					>
						<Trash2 className="size-3.5" />
					</button>
				)}
			</div>

			{custom.mounted && (
				<fieldset
					className={cn(
						"w-full min-w-0 rounded-md border border-border px-3 pt-1 pb-3",
						custom.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<legend className="px-1 text-[11px] text-fg-muted">{t("What they may change")}</legend>

					<div className={CAPABILITY_GRID}>
						{CAPABILITIES.map((capability) => (
							<Box
								key={capability}
								label={t(CAPABILITY_NAMES[capability])}
								checked={caps.held[capability] ?? false}
								saving={caps.saving(capability)}
								disabled={!canAppoint || busy}
								onChange={(on) => toggleCap(capability, on)}
							/>
						))}
					</div>
				</fieldset>
			)}
		</li>
	);
}

function AddAdmin({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
	const t = useT();

	const [name, setName] = useState("");
	const [trip, setTrip] = useState("");
	const [role, setRole] = useState<Role>("observe");
	const [picked, setPicked] = useState<Record<string, boolean>>({});
	const [emby, setEmby] = useState(false);
	const [saving, setSaving] = useState(false);

	const custom = useLingering(role === "custom");

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			await api.addAdmin({
				trip: trip.trim().toLowerCase(),
				name: name.trim(),
				can:
					role === "moderate"
						? ["moderate"]
						: role === "custom"
							? CAPABILITIES.filter((one) => picked[one])
							: [],
				perms: { emby },
			});
			onDone();
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
			<div className="flex flex-wrap gap-2">
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("Name")}
					aria-label={t("Name")}
					maxLength={64}
					className="min-w-32 flex-1 rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				/>

				<input
					value={trip}
					onChange={(event) => setTrip(event.target.value)}
					placeholder={t("Signature")}
					aria-label={t("Signature")}
					maxLength={10}
					required
					className="readout min-w-40 flex-1 rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				/>
			</div>

			<label className="flex items-center gap-2 text-[12px] text-fg-muted">
				{t("May")}
				<select
					value={role}
					onChange={(event) => setRole(event.target.value as Role)}
					className="rounded-md border border-border bg-surface-hi px-2 py-1 text-[12px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				>
					<option value="observe">{t("Can watch")}</option>
					<option value="moderate">{t("Can manage everything")}</option>
					<option value="custom">{t("Custom…")}</option>
				</select>
			</label>

			{custom.mounted && (
				<fieldset
					className={cn(
						"min-w-0 rounded-md border border-border px-3 pt-1 pb-3",
						custom.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<legend className="px-1 text-[11px] text-fg-muted">{t("What they may change")}</legend>

					<div className={CAPABILITY_GRID}>
						{CAPABILITIES.map((capability) => (
							<Box
								key={capability}
								label={t(CAPABILITY_NAMES[capability])}
								checked={picked[capability] ?? false}
								disabled={saving}
								onChange={(on) => setPicked((was) => ({ ...was, [capability]: on }))}
							/>
						))}
					</div>
				</fieldset>
			)}

			<Box
				label={t("May use the Emby library")}
				tone="tally"
				checked={emby}
				disabled={saving}
				onChange={setEmby}
			/>

			<div className="flex gap-2">
				<button
					type="submit"
					disabled={saving || trip.trim().length === 0}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
					{t("Add")}
				</button>

				<button
					type="button"
					onClick={onCancel}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi"
				>
					<X className="size-3.5" />
					{t("Cancel")}
				</button>
			</div>
		</form>
	);
}

/**
 * Changing your own passphrase.
 *
 * There is no password on this server to change. The passphrase is never sent
 * here in any form that is kept and never written down — what is stored is the
 * signature it produces — so rotating one means being recognised by a new
 * signature from now on. Which is why the new signature is shown afterwards: it
 * is what prints beside this person's name in every room from then on, and they
 * are the one person who has to know it moved.
 *
 * The current one is asked for even though the session already says who this is.
 * A session proves somebody signed in; this asks whether the person at the
 * keyboard now is that person, and an unattended laptop is exactly where those
 * two differ.
 */
function OwnPassphrase() {
	const t = useT();

	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [saving, setSaving] = useState(false);
	const [changed, setChanged] = useState<string>();

	// The signature last shown, kept for the answer's way out: by then nothing
	// says what it was, and an answer leaving with the signature gone from it
	// flickers half-empty.
	const shownTrip = useRef(changed);
	if (changed) shownTrip.current = changed;

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			const result = await api.changePassphrase(current, next);
			setCurrent("");
			setNext("");
			setChanged(result.trip);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Card title={t("Your passphrase")}>
			<form
				className="flex flex-col gap-3 px-3 py-3 sm:px-4"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div className="flex flex-wrap gap-2">
					<input
						type="password"
						value={current}
						onChange={(event) => setCurrent(event.target.value)}
						placeholder={t("Current passphrase")}
						aria-label={t("Current passphrase")}
						autoComplete="current-password"
						className="min-w-40 flex-1 rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>

					<input
						type="password"
						value={next}
						onChange={(event) => setNext(event.target.value)}
						placeholder={t("New passphrase")}
						aria-label={t("New passphrase")}
						autoComplete="new-password"
						className="min-w-40 flex-1 rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</div>

				<div className="flex items-center gap-3">
					<button
						type="submit"
						disabled={saving || !current || next.length < 8}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-hi disabled:opacity-40"
					>
						<Working on={saving} />
						{t("Change it")}
					</button>

					{/* One line in two states, the answer arriving as the hint leaves.
					    Each used to fade in and simply vanish on its way out. */}
					<Swap showing={changed ? 1 : 0} className="text-[11.5px] text-fg-muted">
						<span>{t("At least eight characters.")}</span>
						<span>
							{t("Done. Your signature is now")}{" "}
							<span className="readout text-fg">{changed ?? shownTrip.current}</span>
						</span>
					</Swap>
				</div>
			</form>
		</Card>
	);
}
