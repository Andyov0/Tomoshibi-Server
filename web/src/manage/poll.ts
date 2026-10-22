import { useCallback, useEffect, useRef, useState } from "react";
import { SignedOut } from "./api";

/**
 * Ask the server the same question every couple of seconds.
 *
 * Polling rather than a stream. The server has nothing that pushes these
 * figures, so a stream would mean building one, and the audience is a handful
 * of people looking at a page occasionally. Two seconds is often enough to
 * watch a call go wrong and rare enough to cost nothing.
 *
 * Paused while the tab is hidden. A management page left open in a background
 * tab for a week is otherwise a request every two seconds for a week, answered
 * by a server that is meant to be carrying a meeting.
 *
 * And not at all while `enabled` is false. The one poll that lives above the
 * sign-in screen ran behind it too, so a page nobody had signed in to asked for
 * figures every five seconds for as long as it stayed open and was refused
 * every time.
 */
export function usePoll<T>(
	ask: () => Promise<T>,
	{
		every = 2000,
		onSignedOut,
		about,
		enabled = true,
	}: { every?: number; onSignedOut?: () => void; about?: string; enabled?: boolean } = {},
) {
	const [value, setValue] = useState<T>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);

	// Held in a ref so that changing the question does not restart the timer,
	// and so the effect does not depend on a function most callers rebuild on
	// every render.
	const current = useRef(ask);
	current.current = ask;

	const signedOut = useRef(onSignedOut);
	signedOut.current = onSignedOut;

	// Each question numbered as it is asked, and the number of the newest one
	// whose answer is on screen. The timer asks one question at a time, but a
	// refresh asked for by hand — the reread after a press — goes beside it, and
	// on a slow link the timer's, asked first, could arrive last and put the
	// list from before the press back on the page: the box flipped back with no
	// message, and the next press on that row was built on it. An answer, or a
	// failure, to a question older than the one shown is dropped.
	const asked = useRef(0);
	const shown = useRef(0);

	const refresh = useCallback(async () => {
		const mine = ++asked.current;

		let answer: Awaited<T>;
		try {
			answer = await current.current();
		} catch (err) {
			if (mine < shown.current) return;
			if (err instanceof SignedOut) {
				signedOut.current?.();
				return;
			}
			shown.current = mine;
			setError(err instanceof Error ? err.message : String(err));
			setLoading(false);
			return;
		}

		// Dropped whole, the end of waiting included: an older answer arriving
		// after the subject changed is no reason to stop saying the new one is
		// on its way.
		if (mine < shown.current) return;
		shown.current = mine;
		setValue(answer);
		setError(undefined);
		setLoading(false);
	}, []);

	// What the question is about, where it is about something.
	//
	// The answer on screen belongs to the last subject, and when the subject
	// changes it is not a stale answer to this question — it is a correct answer
	// to a different one. Clicking a second room showed the first room's people
	// and the first room's history until the next tick, which for the history is
	// twenty seconds: long enough to read it, believe it, and act on it.
	//
	// Passed rather than derived from `ask`. Every caller rebuilds that function
	// on render and the ref above exists precisely so that does not restart
	// anything; keying off its identity would turn a caller who forgot to
	// memoise into a request per render. The subject is a string the caller
	// already has.
	useEffect(() => {
		if (about === undefined) return;

		// Whatever is still out was asked about the last subject.
		shown.current = asked.current + 1;
		setValue(undefined);
		setError(undefined);
		setLoading(true);

		void refresh();
	}, [about, refresh]);

	useEffect(() => {
		if (!enabled) return;

		let live = true;
		let asking = false;
		let timer: number | undefined;

		const tick = async () => {
			// One question at a time. Coming back to the tab asks at once, and
			// used to do it beside whatever the timer had already sent and
			// without cancelling the timer, so two answers raced to be shown
			// and the older could land last.
			if (!live || asking) return;
			asking = true;
			window.clearTimeout(timer);

			try {
				if (!document.hidden) await refresh();
			} finally {
				asking = false;
			}

			// Scheduled after the answer rather than on an interval: a server
			// that has become slow would otherwise be asked again while it is
			// still working on the last one, which is the shape of a stampede.
			if (live) timer = window.setTimeout(tick, every);
		};

		void tick();

		// Asked again the moment somebody comes back, so the first thing they
		// see is current rather than however old the tab is.
		const onVisible = () => {
			if (!document.hidden) void tick();
		};
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			live = false;
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [every, refresh, enabled]);

	return { value, error, loading, refresh };
}
