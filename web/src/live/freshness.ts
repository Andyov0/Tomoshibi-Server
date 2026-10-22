import { deployment } from "./api";

/**
 * Noticing that the page is older than the server it came from.
 *
 * A page is loaded once and kept for as long as its tab is open, and leaving a
 * call and joining again does not load it again. So a deployment reached nobody
 * who already had the page open: a fix to how a shared screen sounds was first
 * reported as not working by somebody whose friend had rejoined -- on the code
 * from before the fix, still in the tab, which the media server's own log showed
 * by the processing the shared sound had been captured with.
 *
 * The build is asked for when the page loads, again every few minutes, and again
 * whenever the tab comes back into view, which is when somebody is about to use
 * it. The first answer is the build this page is; a later, different one means
 * there is a newer page to be had, and that is said once. Nothing reloads by
 * itself: a reload in a call is leaving the call, and that is the person's to
 * choose.
 *
 * An empty build -- a development server, or a server that would not say -- is
 * never compared, so nothing is said about it.
 */

/** How often the build is asked for while the tab stays in view. */
export const EVERY = 5 * 60 * 1000;

/**
 * Compares builds as they arrive, and calls `onNewer` the first time one differs
 * from the first build seen. Separate from the timer so the rule can be tested
 * without one.
 */
export function compare(onNewer: () => void) {
	let first = "";
	let said = false;

	return (build: string) => {
		if (!build || said) return;
		if (!first) {
			first = build;
			return;
		}
		if (build !== first) {
			said = true;
			onNewer();
		}
	};
}

/** Watch for a newer build. Returns a function that stops watching. */
export function watchForNewerBuild(onNewer: () => void): () => void {
	const seen = compare(onNewer);
	const ask = () => {
		void deployment().then((said) => seen(said.build));
	};

	const onVisible = () => {
		if (!document.hidden) ask();
	};

	ask();
	const timer = window.setInterval(() => {
		if (!document.hidden) ask();
	}, EVERY);
	document.addEventListener("visibilitychange", onVisible);

	return () => {
		window.clearInterval(timer);
		document.removeEventListener("visibilitychange", onVisible);
	};
}
