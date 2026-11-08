import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/live/notices";
import { LockOpen, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Lockout, type Lockouts, api } from "./api";
import { Swap } from "./Boxes";
import { DeviceLine } from "./Device";
import { Group, Note, quiet, Section, usePresence } from "./Grouped";
import { useTwice } from "./twice";
import { clock } from "./units";

/**
 * Who is shut out of signing in, and the way to let them back in.
 *
 * The server shuts out an address and a device together after more than ten
 * failed sign-ins in five minutes, for half an hour, at the account sign-in
 * and this page's own (internal/lockout). The owner asked for that instead of
 * a human check, and for the way back in to be here (2026-11-01): the person
 * most likely to be shut out is somebody of his own who forgot a passphrase
 * on a phone, and the person they ask is him.
 *
 * At the top of the accounts page, because that is where somebody goes about
 * somebody who cannot get in, and with a count on the accounts tab while any
 * are in force, so a lockout is noticed from whatever page is open. Each row
 * says what was shut out in the words the rest of the panel uses — the
 * address, the device as a join's is read, the user agent as sent on the
 * device for whatever the reading missed — when the failures were and how
 * many, and how long is left, counted down. Lifting is a press made twice,
 * as removing somebody from a call is, because the rows reorder as the list
 * is polled and one press is all that stands between a stray finger and a
 * door reopened to whoever was guessing.
 *
 * Every administrator sees the list; only moderate lifts, which the server
 * enforces and the page says rather than offering a button that is refused.
 */
export function LockoutsSection({
	reading,
	canModerate,
	onChanged,
}: {
	/** The server's answer, undefined until it has given one. */
	reading?: Lockouts;
	canModerate: boolean;
	onChanged: () => Promise<unknown>;
}) {
	const t = useT();

	// Lifted here and not yet gone from the poll, so a row leaves on the
	// press that lifted it rather than at the next reading.
	//
	// Held by the lockout and not by its key. The key is the caller's, an
	// address and a device, and the same caller shut out again after a lift
	// is a new lockout under the same key: held by key, it was hidden from
	// this page until the page was reloaded, its row missing, the heading's
	// count one short and, were it the only one, "nobody is shut out" said
	// above it, while the rail's count, read from the server, said otherwise.
	// That is what happens when somebody is let back in and gets their
	// passphrase wrong again on the same phone. Never emptied: a lockout once
	// lifted is not listed again, and a reading that arrives late from before
	// the lift must not bring its row back.
	const [lifted, setLifted] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState<string>();

	const held = reading?.lockouts ?? NONE;
	const now = useNow(held.length > 0);

	// A lockout past its end leaves on its own, at the second it ends, rather
	// than at the poll after.
	//
	// The list is made again only when what it holds changes, and not on
	// every second's redraw. usePresence watches the list it is given by
	// identity, and handed a new one on every render while a row was leaving
	// it set state on every render: the page redrew itself without end, which
	// the first test of a lift found as a test that never finished.
	const ended = held
		.filter((one) => Date.parse(one.until) <= now)
		.map((one) => one.key)
		.join(" ");
	const live = useMemo(() => {
		const over = new Set(ended.split(" "));
		return held.filter((one) => !over.has(one.key) && !lifted.has(lockoutId(one)));
	}, [held, lifted, ended]);
	const rows = usePresence(live, lockoutId);

	const shown = useLingering(reading !== undefined, 180);
	const empty = useLingering(reading !== undefined && live.length === 0, 160);

	const lift = useCallback(
		async (one: Lockout | undefined) => {
			if (busy) return;
			setBusy(one ? lockoutId(one) : "*");

			try {
				if (one) {
					await api.liftLockout(one.key);
					setLifted((was) => new Set(was).add(lockoutId(one)));
				} else {
					await api.liftLockouts();
					setLifted((was) => new Set([...was, ...held.map(lockoutId)]));
				}
				await onChanged();
			} catch (err) {
				actionFailed(err instanceof Error ? err.message : String(err));
				// Asked again whatever went wrong: one that ended by itself is
				// refused as gone, and the reading drops it.
				void onChanged();
			} finally {
				setBusy(undefined);
			}
		},
		[busy, held, onChanged],
	);

	if (!shown.mounted || !reading) return null;

	const windowMinutes = Math.round(reading.windowSeconds / 60);
	const forMinutes = Math.round(reading.forSeconds / 60);

	return (
		<div className={shown.leaving ? "animate-depart" : "animate-arrive"}>
			<Section
				id="lockouts"
				title={
					<span className="flex items-center gap-2">
						{t("Sign-in lockouts")}
						<Count count={live.length} />
					</span>
				}
				actions={canModerate && <LiftAll show={live.length > 1} busy={busy === "*"} onLift={() => lift(undefined)} />}
			>
				<Group>
					{empty.mounted && (
						<p className={cn("px-4 py-4 text-fg-muted text-[13.5px]", empty.leaving ? "animate-fade-out" : "animate-fade-in")}>
							{t("Nobody is shut out of signing in.")}
						</p>
					)}

					<ul aria-label={t("Sign-in lockouts")}>
						{rows.map(({ item, leaving }) => (
							<Row
								key={lockoutId(item)}
								lockout={item}
								now={now}
								leaving={leaving}
								canModerate={canModerate}
								busy={busy === lockoutId(item)}
								onLift={() => lift(item)}
							/>
						))}
					</ul>
				</Group>

				<div className="flex flex-col gap-1 px-1">
					<Note>
						{t(
							"More than {failures} failed sign-ins within {window} minutes from one address and device shut them out of signing in, on the web and in the apps, for {minutes} minutes.",
							{ failures: reading.failures, window: windowMinutes, minutes: forMinutes },
						)}
					</Note>
					<Note show={!canModerate && live.length > 0}>
						{t("Only an administrator who can manage everything can lift a lockout.")}
					</Note>
				</div>
			</Section>
		</div>
	);
}

function Row({
	lockout,
	now,
	leaving,
	canModerate,
	busy,
	onLift,
}: {
	lockout: Lockout;
	now: number;
	leaving: boolean;
	canModerate: boolean;
	busy: boolean;
	onLift: () => void;
}) {
	const t = useT();

	const lifting = useTwice(onLift);

	const from = clock(lockout.first);
	const to = clock(lockout.last);

	// Laid out on a grid rather than in columns, so the details have the
	// row's whole width on a phone. With the countdown and the button in a
	// column of their own beside them, a 320-pixel screen left the details a
	// hundred pixels: the device ran under the button and an IPv6 network
	// broke in the middle of its prefix. On a phone the button is under the
	// details; from a tablet up it sits beside them.
	return (
		<li
			aria-label={lockout.address}
			className={cn(
				"relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-4 py-3",
				"before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-border first:before:hidden",
				leaving ? "animate-depart" : "animate-fade-in",
			)}
		>
			<p className="flex min-w-0 items-center gap-2">
				<ShieldAlert aria-hidden className="size-4 shrink-0 text-danger-ink" />
				<span className="readout break-all font-medium text-[14px]">{lockout.address}</span>
			</p>

			<span className="whitespace-nowrap pt-px text-right text-[13px] text-danger-ink tabular-nums" aria-live="off">
				{t("{time} left", { time: left(lockout.until, now) })}
			</span>

			<div className="flex min-w-0 flex-col gap-1 pl-6 max-sm:col-span-2">
				{/* The address itself as well, where what was shut out is the
				    network it is in. */}
				{lockout.seen && lockout.seen !== lockout.address && (
					<span className="readout break-all text-fg-muted text-[12px]">{lockout.seen}</span>
				)}
				{lockout.client && <DeviceLine client={lockout.client} className="text-[12.5px] text-fg-muted" />}

				<p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-fg-muted">
					<span className="whitespace-nowrap">{t("{count} failed sign-ins", { count: lockout.failures })}</span>
					<span>{doors(t, lockout.doors)}</span>
				</p>
				<p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-fg-muted tabular-nums">
					<span className="whitespace-nowrap">
						{from === to ? t("Failed at {time}", { time: from }) : t("Failed from {from} to {to}", { from, to })}
					</span>
					<span className="whitespace-nowrap">{t("Shut out until {time}", { time: clock(lockout.until) })}</span>
				</p>
			</div>

			{canModerate && (
				<div className="flex items-start justify-end max-sm:col-span-2">
					<button
						type="button"
						disabled={busy || leaving}
						onClick={lifting.press}
						onBlur={lifting.disarm}
						aria-label={lifting.armed ? t("Press again to lift") : t("Lift")}
						className={cn(
							quiet,
							"bg-surface-hi text-fg hover:bg-surface-hi-hover active:bg-surface-hi-press",
							lifting.armed && "bg-danger/10 text-danger-ink hover:bg-danger/15 active:bg-danger/20",
						)}
					>
						<LockOpen />
						<Swap showing={lifting.armed ? 1 : 0} className="text-[12.5px]">
							{[t("Lift"), t("Press again to lift")]}
						</Swap>
					</button>
				</div>
			)}
		</li>
	);
}

/** Lifting every lockout at once, offered once there is more than one. */
function LiftAll({ show, busy, onLift }: { show: boolean; busy: boolean; onLift: () => void }) {
	const t = useT();

	const { mounted, leaving } = useLingering(show, 160);
	const lifting = useTwice(onLift);

	if (!mounted) return null;

	return (
		<button
			type="button"
			disabled={busy || leaving}
			onClick={lifting.press}
			onBlur={lifting.disarm}
			className={cn(
				quiet,
				leaving ? "animate-fade-out" : "animate-fade-in",
				lifting.armed && "bg-danger/10 text-danger-ink hover:bg-danger/15",
			)}
		>
			{/* As wide as the longer of the two from the start, on a phone.
			    The press that arms it swaps in a label three times the
			    length, and in the heading's row on a phone that took a line
			    of its own the moment it was armed, pushing the list down
			    under the finger about to press again. Held at that width
			    throughout, it is on the line it needs before anybody
			    presses. The icon travels with each label and both sit at
			    the end, so the unarmed press reads as it did, flush right
			    with the lifts below it, rather than as an icon across a gap
			    from its word. From a tablet up there is room for the longer
			    label beside the heading and nothing is held. */}
			<span className="grid justify-items-end">
				<span aria-hidden className="invisible col-start-1 row-start-1 hidden items-center gap-1.5 max-sm:inline-flex">
					<LockOpen />
					{t("Press again to lift all")}
				</span>
				<Swap showing={lifting.armed ? 1 : 0} className="col-start-1 row-start-1">
					{[
						<span key="lift" className="inline-flex items-center gap-1.5">
							<LockOpen />
							{t("Lift all")}
						</span>,
						<span key="again" className="inline-flex items-center gap-1.5">
							<LockOpen />
							{t("Press again to lift all")}
						</span>,
					]}
				</Swap>
			</span>
		</button>
	);
}

/** How many are in force, beside the heading, coming and going with them. */
function Count({ count }: { count: number }) {
	// The last count held while it fades, so it does not read 0 on its way out.
	const [held, setHeld] = useState(count);
	useEffect(() => {
		if (count > 0) setHeld(count);
	}, [count]);

	const { mounted, leaving } = useLingering(count > 0, 160);
	if (!mounted) return null;

	return (
		<span
			className={cn(
				"rounded-full bg-danger px-1.5 py-px font-semibold text-[11.5px] text-danger-fg tabular-nums leading-[1.35]",
				leaving ? "animate-fade-out" : "animate-fade-in",
			)}
		>
			{count > 0 ? count : held}
		</span>
	);
}

const NONE: Lockout[] = [];

/**
 * One lockout, as against the caller it shut out: its key, which is the
 * caller's and comes back if they are shut out again, and when it began,
 * which does not.
 */
function lockoutId(one: Lockout): string {
	return `${one.key}@${one.since}`;
}

/** Which sign-ins a lockout's failures were at, in the reader's words. Also the log page's. */
export function doors(t: ReturnType<typeof useT>, said: string[]): string {
	const account = said.includes("account");
	const management = said.includes("management");

	if (account && management) return t("At both sign-ins");
	if (management) return t("At the management sign-in");

	return t("At the account sign-in");
}

/** What is left of a lockout, as minutes and seconds. */
export function left(until: string, now: number): string {
	const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
	const minutes = Math.floor(seconds / 60);

	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The time, every second while there is something to count down, and not at
 * all otherwise: a page left open on the accounts for a week with nobody shut
 * out should not be redrawn every second of it.
 */
function useNow(ticking: boolean): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!ticking) return;

		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);

		return () => window.clearInterval(timer);
	}, [ticking]);

	return now;
}
