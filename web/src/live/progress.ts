import { useSyncExternalStore } from "react";

/*
 * Whether the page is waiting on its server for somebody, for the thin bar
 * along the top of the page (components/TopProgress.tsx), which the owner
 * asked for.
 *
 * What counts is the hard part, because a page that asks its server for
 * things in the background as well would otherwise have a bar that comes and
 * goes on its own: the lobby looks at the fleet every minute, the management
 * pages read their figures every few seconds, and a meeting talks to the
 * server for as long as it lasts. A bar that moved while nobody had asked for
 * anything would say the page was busy with something they could not see, and
 * would soon be read as saying nothing at all.
 *
 * So a request counts when somebody is waiting for it, and two things say so.
 * Everything this origin is asked while the page is first loading, until the
 * first moment nothing is outstanding: that is the page arriving. And, after
 * that, a request made within a second of a press, a key that presses, a form
 * sent or the address changing: that is the press being answered. A poll on a
 * timer is neither, and goes unseen. Only this origin's own requests count;
 * measuring the relays reaches each of them, has a spinner of its own beside
 * the servers, and would hold the bar for as long as the slowest relay took
 * to time out.
 *
 * Not in a call, or at the door waiting to be let in, where the bar would sit
 * over the pictures and the server is asked things all the time (hush).
 *
 * The page's arrival is counted from before the script exists, by a bar drawn
 * from the document itself (vite.config.ts bootProgress), which the component
 * takes over from where it got to.
 */

/** How long after a press a request still counts as that press's answer. */
export const AFTER_PRESS_MS = 1000;

/**
 * How long nothing has to be outstanding before the wait is over. A page asks
 * in chains: the lobby asks who is signed in and then, from the answer, for
 * the notice; the moment between the two has nothing outstanding, and ending
 * there ran the bar to its end and back again, and took the page as arrived
 * before its second question, which then went uncounted.
 */
export const SETTLE_MS = 120;

let outstanding = 0;
let settling: ReturnType<typeof setTimeout> | undefined;
let arrival: (() => void) | undefined;
let hushed = 0;
let arriving = true;
let pressedAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();

function told(): void {
	for (const listener of listeners) listener();
}

/**
 * Counts one thing being waited for until the function it returns is called,
 * which may be called more than once and counts once.
 */
export function begin(): () => void {
	const was = phase();
	clearTimeout(settling);
	settling = undefined;
	outstanding += 1;
	if (was !== "waiting") told();

	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		outstanding -= 1;
		if (outstanding > 0) return;

		told();
		settling = setTimeout(() => {
			settling = undefined;
			// The page has arrived the first time nothing is outstanding;
			// what is asked after that is asked of a page already there.
			arriving = false;
			told();
		}, SETTLE_MS);
	};
}

/**
 * Puts the bar away until the function it returns is called: in a call and at
 * the door, where the page asks its server things all the time and a bar over
 * the pictures would say nothing anybody is waiting for.
 */
export function hush(): () => void {
	hushed += 1;
	if (hushed === 1) told();

	let lifted = false;
	return () => {
		if (lifted) return;
		lifted = true;
		hushed -= 1;
		if (hushed === 0) told();
	};
}

/**
 * Where the wait is: something outstanding; nothing, but only for less than
 * SETTLE_MS, so perhaps the middle of a chain; or over. Kept apart because the
 * bar treats the middle two differently: a wait is shown once it has gone on
 * long enough, and the moment after a quick answer is not more of it, or every
 * answer quicker than the bar waits to show would have shown it anyway, late.
 */
export type Phase = "waiting" | "settling" | "idle";

export function phase(): Phase {
	if (hushed > 0) return "idle";
	if (outstanding > 0) return "waiting";
	return settling === undefined ? "idle" : "settling";
}

/** Whether somebody is waiting on the server now, or may be in a moment. */
export function waiting(): boolean {
	return phase() !== "idle";
}

/** That somebody has just pressed something, whose answer is worth a bar. */
export function pressed(at: number = performance.now()): void {
	pressedAt = at;
}

function addressOf(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/** Whether a request made now is one somebody is waiting for. */
export function counts(input: RequestInfo | URL, now: number = performance.now()): boolean {
	if (!arriving && now - pressedAt > AFTER_PRESS_MS) return false;

	try {
		return new URL(addressOf(input), location.href).origin === location.origin;
	} catch {
		return false;
	}
}

/**
 * Counts this page's requests from now on, as `counts` decides, and hears the
 * presses that make a request worth counting. Once, from a page's entry
 * point, before anything asks its server for anything.
 *
 * Wrapping fetch rather than asking each caller to say whether it is being
 * waited for: the callers are dozens, and most of them answer both a press and
 * a timer through the same function (the management pages' first reading of a
 * panel and every reading after it are one call), so only the moment it was
 * made from can tell them apart.
 */
export function watchRequests(target: typeof globalThis = globalThis): void {
	// The page itself, counted from here until it has drawn and made its first
	// requests (arrived), so that a page whose first drawing asks nothing still
	// has a moment where nothing is outstanding and stops counting everything.
	arrival = begin();

	const asked = target.fetch.bind(target);

	target.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		if (!counts(input)) return asked(input, init);
		const end = begin();
		return asked(input, init).finally(end);
	};

	const press = () => pressed();
	const key = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") pressed();
	};
	// Captured, so that a press is heard before whatever it presses makes its
	// request, including a handler that stops the event going further. The
	// click as well as the pointer: Enter on a button and a script's click()
	// are clicks with no pointer before them.
	target.addEventListener("pointerdown", press, true);
	target.addEventListener("click", press, true);
	target.addEventListener("keydown", key, true);
	target.addEventListener("submit", press, true);
	target.addEventListener("hashchange", press);
	target.addEventListener("popstate", press);
}

/**
 * That the page has drawn for the first time and made the requests its first
 * drawing makes; from the bar's own first effect, which runs after every
 * effect of the page drawn before it.
 */
export function arrived(): void {
	arrival?.();
	arrival = undefined;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Where the wait is, for the bar to draw. */
export function useWaitPhase(): Phase {
	return useSyncExternalStore(subscribe, phase, phase);
}

/** For tests: back to a page that has just begun to load. */
export function forgetProgress(): void {
	clearTimeout(settling);
	settling = undefined;
	arrival = undefined;
	outstanding = 0;
	hushed = 0;
	arriving = true;
	pressedAt = Number.NEGATIVE_INFINITY;
	told();
}
