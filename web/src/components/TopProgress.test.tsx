import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTLE_MS, begin, forgetProgress, hush } from "@/live/progress";
import { BOOT_ID, SHOW_AFTER_MS, TopProgress } from "./TopProgress";

/*
 * The bar along the top of the page, which the owner asked for. What would go
 * wrong quietly is what it shows and when: a quick answer flashing a line
 * across the page, a wait that never runs to its end and fades, a bar over a
 * call, and two bars, or none, as the component takes over from the one the
 * document drew before the script arrived. When it counts something as a wait
 * is live/progress.test.ts.
 */

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	cleanup();
	act(() => forgetProgress());
	vi.useRealTimers();
	document.getElementById(BOOT_ID)?.remove();
});

function drawn() {
	const view = render(<TopProgress />);
	const bar = () => view.container.querySelector("[data-progress]") as HTMLElement;
	const shown = () => bar().dataset.progress === "shown";
	const at = () => Number(/scaleX\(([\d.]+)\)/.exec(bar().style.transform)?.[1]);
	return { bar, shown, at };
}

function pass(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

describe("TopProgress", () => {
	it("shows nothing for a wait shorter than it waits to show one", () => {
		const { shown } = drawn();
		let end = () => {};
		act(() => {
			end = begin();
		});

		pass(SHOW_AFTER_MS - 50);
		expect(shown(), "a quick answer flashed the bar").toBe(false);
		act(() => end());
		pass(2000);
		expect(shown()).toBe(false);
	});

	it("shows a longer wait creeping on, then runs it to the end and fades", () => {
		const { shown, at } = drawn();
		let end = () => {};
		act(() => {
			end = begin();
		});

		pass(SHOW_AFTER_MS + 10);
		expect(shown()).toBe(true);
		const early = at();

		pass(3000);
		expect(at()).toBeGreaterThan(early);
		expect(at(), "it claimed to be finished before the answer came").toBeLessThan(0.9);

		act(() => end());
		pass(SETTLE_MS);
		expect(at(), "it faded without reaching the end").toBe(1);
		expect(shown()).toBe(true);

		pass(1000);
		expect(shown(), "it never went away").toBe(false);
	});

	it("shows a chain of quick questions once the chain has taken long enough", () => {
		const { shown } = drawn();
		let end = () => {};
		act(() => {
			end = begin();
		});
		pass(SHOW_AFTER_MS - 50);
		act(() => end());
		pass(SETTLE_MS / 2);
		expect(shown()).toBe(false);

		// The next question in the chain, asked from the first answer.
		act(() => {
			begin();
		});
		pass(10);
		expect(shown(), "a long wait made of short ones was never shown").toBe(true);
	});

	it("is not drawn over a call", () => {
		const { shown } = drawn();
		act(() => {
			begin();
			hush();
		});
		pass(1000);
		expect(shown()).toBe(false);
	});

	it("takes over the bar the document drew, from where it had got to", () => {
		const boot = document.createElement("div");
		boot.id = BOOT_ID;
		boot.style.transform = "scaleX(0.4)";
		boot.style.opacity = "1";
		document.body.prepend(boot);
		// The page's own arrival, counted from before anything is drawn.
		act(() => {
			begin();
		});

		const { shown, at, bar } = drawn();
		expect(document.getElementById(BOOT_ID), "two bars on the page").toBeNull();
		expect(shown(), "no bar for a moment between the two").toBe(true);
		expect(at()).toBeCloseTo(0.4);
		expect(bar().style.transition, "it slid from nothing to where the other had been").toBe("");

		// And carries on from there rather than starting again.
		pass(1000);
		expect(shown()).toBe(true);
		expect(at()).toBeGreaterThan(0.4);
	});

	it("runs the document's bar to its end when nothing is left to wait for", () => {
		const boot = document.createElement("div");
		boot.id = BOOT_ID;
		boot.style.transform = "scaleX(0.4)";
		boot.style.opacity = "1";
		document.body.prepend(boot);

		const { shown, at } = drawn();
		expect(at(), "the page's bar vanished rather than finishing").toBe(1);
		expect(shown()).toBe(true);
		pass(1000);
		expect(shown()).toBe(false);
	});
});
