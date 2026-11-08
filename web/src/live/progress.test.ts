import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AFTER_PRESS_MS, SETTLE_MS, arrived, begin, forgetProgress, hush, waiting, watchRequests } from "./progress";

/*
 * What the bar along the top of the page counts as somebody waiting.
 *
 * The page asks its server for things in the background as well as for
 * somebody: the lobby looks at the fleet every minute, the management pages
 * read their figures every few seconds, a call talks to its server for as long
 * as it lasts. Counted, any of those would move the bar while nobody had asked
 * for anything, and a bar that moves on its own is soon read as saying nothing.
 * What is guarded here is that the page's arrival is counted, chains and all;
 * that afterwards only the answer to a press is; that only this origin's own
 * requests are, so measuring the relays does not hold the bar for as long as
 * the slowest one takes to time out; and that a call says nothing at all.
 */

let clock = 0;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	clock = 10_000;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
	forgetProgress();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A page whose requests are answered when a test says so. */
function page() {
	const waitingOn: Array<{ answer: () => void; fail: () => void }> = [];
	const asked = vi.fn(
		() =>
			new Promise<Response>((resolve, reject) => {
				waitingOn.push({ answer: () => resolve(new Response("")), fail: () => reject(new TypeError("offline")) });
			}),
	);
	const target = Object.assign(new EventTarget(), { fetch: asked }) as unknown as typeof globalThis;
	watchRequests(target);

	return {
		ask: (address: string) => {
			void target.fetch(address).catch(() => {});
		},
		press: (event: Event = new Event("pointerdown")) => target.dispatchEvent(event),
		/** Answers the oldest request still waiting, and lets its answer land. */
		answer: async (how: "answer" | "fail" = "answer") => {
			waitingOn.shift()?.[how]();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

/** Lets the page settle after its last request, which is when it has arrived. */
function settle() {
	vi.advanceTimersByTime(SETTLE_MS);
}

describe("progress", () => {
	it("counts what the page asks this origin as it arrives, and nothing it asks elsewhere", async () => {
		const p = page();
		p.ask("/api/deployment");
		p.ask("https://relay.example.com/measure");
		arrived();

		expect(waiting()).toBe(true);
		await p.answer();
		settle();
		expect(waiting(), "a relay being measured held the bar").toBe(false);
	});

	it("keeps counting through a chain, and takes the page as arrived only once nothing follows", async () => {
		const p = page();
		p.ask("/api/account/session");
		arrived();
		await p.answer();

		// Asked from the first answer, a moment after it, with nothing
		// outstanding in between.
		vi.advanceTimersByTime(SETTLE_MS / 2);
		p.ask("/api/deployment");
		expect(waiting(), "the second question of a chain went uncounted").toBe(true);
		await p.answer();
		settle();
		expect(waiting()).toBe(false);

		// The lobby's look at the fleet a minute later, on a timer.
		clock += 60_000;
		p.ask("/api/relays");
		expect(waiting(), "a poll on a timer moved the bar").toBe(false);
	});

	it("counts the answer to a press, and not a request made long after it", async () => {
		const p = page();
		arrived();
		settle();

		p.press();
		clock += AFTER_PRESS_MS / 2;
		p.ask("/api/rooms/standup/join");
		expect(waiting()).toBe(true);
		await p.answer();
		settle();
		expect(waiting()).toBe(false);

		clock += AFTER_PRESS_MS;
		p.ask("/api/arrangements");
		expect(waiting()).toBe(false);
	});

	it("takes Enter for a press, and typing for none", async () => {
		const p = page();
		arrived();
		settle();

		p.press(new KeyboardEvent("keydown", { key: "a" }));
		p.ask("/api/x");
		expect(waiting(), "a letter typed into a field counted as a press").toBe(false);

		p.press(new KeyboardEvent("keydown", { key: "Enter" }));
		p.ask("/api/x");
		expect(waiting()).toBe(true);
	});

	it("says nothing while hushed, and says it again once lifted", () => {
		const p = page();
		p.ask("/api/deployment");

		const lift = hush();
		expect(waiting(), "a call showed the bar").toBe(false);
		lift();
		lift();
		expect(waiting()).toBe(true);
	});

	it("ends a request that failed as surely as one answered", async () => {
		const p = page();
		arrived();
		p.ask("/api/deployment");
		await p.answer("fail");
		settle();
		expect(waiting()).toBe(false);
	});

	it("counts one wait once however many times it is ended", () => {
		const one = begin();
		const two = begin();
		one();
		one();
		settle();
		expect(waiting(), "ending one twice ended the other").toBe(true);
		two();
		settle();
		expect(waiting()).toBe(false);
	});
});
