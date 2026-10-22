import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Tell React it is being tested.
 *
 * Without it, anything wrapped in `act` warns that the environment does not
 * support it — on every call, in every test that changes state from outside a
 * component. The warning is correct and the fix is this flag; leaving it to
 * scroll past would train everybody to ignore the one place React reports a
 * genuine problem.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Take each rendered tree down before the next test puts one up.
 *
 * Testing Library does this on its own when Vitest is run with globals, and this
 * project imports its test functions by name instead, so nothing was doing it.
 * That went unnoticed for as long as every test asked its questions of the
 * container it had just rendered; the first one to ask the document a question
 * found the previous test's menu still open and answered from it.
 *
 * A leak of that shape does not fail honestly. It makes tests pass in one order
 * and fail in another, and the test that breaks is rarely the one at fault.
 */
/**
 * Give the tests a working local storage.
 *
 * Node has its own Web Storage now, and from Node 25 it is there without being
 * asked for. It claims the global before jsdom is built, jsdom's environment
 * leaves an existing global alone, and Node's own is inert unless it was given a
 * file to keep — which nothing here does. What is left is an object that answers
 * to the name and has none of Storage's methods.
 *
 * Nothing announces this. The first sign is a dozen tests failing on
 * `localStorage.clear is not a function` in their setup, which reads like the
 * tests are wrong rather than the environment, and the only other clue is a
 * warning from Node about a flag this project never passed.
 *
 * Installed only when the environment failed, so that a future jsdom which
 * provides a real one is used instead of this. What is written here is the
 * whole of the interface this application uses and the whole of what Storage
 * specifies apart from its quota, which no test is trying to exhaust.
 *
 * Values are stored as strings, which is not a detail to leave out: the browser
 * coerces on the way in, and code that writes a number and reads it back
 * expecting a number is broken in a browser and would pass against a Map.
 */
function installStorage(): void {
	const existing: unknown = globalThis.localStorage;
	if (existing && typeof (existing as Storage).setItem === "function") {
		return;
	}

	const entries = new Map<string, string>();

	const storage: Storage = {
		get length() {
			return entries.size;
		},
		key(index: number) {
			return [...entries.keys()][index] ?? null;
		},
		getItem(key: string) {
			return entries.get(String(key)) ?? null;
		},
		setItem(key: string, value: string) {
			entries.set(String(key), String(value));
		},
		removeItem(key: string) {
			entries.delete(String(key));
		},
		clear() {
			entries.clear();
		},
	};

	// Defined rather than assigned, because the broken one is a getter and an
	// assignment to a property with no setter is silently discarded.
	for (const target of [globalThis, globalThis.window].filter(Boolean)) {
		Object.defineProperty(target, "localStorage", {
			value: storage,
			configurable: true,
			writable: true,
		});
	}
}

installStorage();

/**
 * Give the tests a matchMedia.
 *
 * jsdom does not implement it, and the plotting library reads it at import to
 * work out the device pixel ratio — at import, not at render, so merely
 * importing a panel that draws a chart throws before a single test runs. The
 * whole file is then reported as having no tests, which reads like a collection
 * error in the test rather than a missing browser API.
 *
 * Answers no to everything, which is what a plot needs from it: the fallback
 * path is the ordinary one-pixel-per-pixel case, and nothing here is asserting
 * anything about a high density display.
 */
if (typeof globalThis.matchMedia !== "function") {
	Object.defineProperty(globalThis, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string): MediaQueryList =>
			({
				media: query,
				matches: false,
				onchange: null,
				addEventListener() {},
				removeEventListener() {},
				addListener() {},
				removeListener() {},
				dispatchEvent: () => false,
			}) as unknown as MediaQueryList,
	});
}

/**
 * Give the tests a ResizeObserver.
 *
 * Also absent from jsdom, and also read by anything that draws itself to fit a
 * box — the plot, and the menus that position themselves against a trigger.
 * Absent, the component throws on mount, which fails the test with a reference
 * error naming a browser API and says nothing about the component.
 *
 * Observes nothing and reports nothing. Every test that renders one of these
 * asserts on what was drawn, not on what happened when the box changed size,
 * and a stub that fired would be inventing measurements nobody asked for.
 */
if (typeof globalThis.ResizeObserver !== "function") {
	Object.defineProperty(globalThis, "ResizeObserver", {
		configurable: true,
		writable: true,
		value: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	});
}

afterEach(cleanup);
