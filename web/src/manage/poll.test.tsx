import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "./poll";

/*
 * An answer belongs to the question it was asked about.
 *
 * The question here is rebuilt on every render, so it is held in a ref and
 * changing it deliberately does not restart the timer — otherwise a caller who
 * forgot to memoise would send a request per render. The cost of that is what
 * this is about: when the subject changed, the answer already on screen stayed
 * there until the next tick, and it was not a stale answer to this question but
 * a correct answer to a different one.
 *
 * Clicking a second room showed the first room's people, and its history — and
 * the history is polled every twenty seconds, which is long enough to read,
 * believe and act on.
 */
describe("polling about a subject", () => {
	it("does not show the last subject's answer", async () => {
		const answers: Record<string, string> = { first: "one", second: "two" };

		const { result, rerender } = renderHook(
			({ about }: { about: string }) =>
				usePoll(() => Promise.resolve(answers[about]), { about, every: 60_000 }),
			{ initialProps: { about: "first" } },
		);

		await waitFor(() => expect(result.current.value).toBe("one"));

		await act(async () => {
			rerender({ about: "second" });
		});

		// Never "one". Not "one for a moment and then two", which is what a
		// panel showing the wrong room's people looks like from a chair.
		expect(result.current.value).not.toBe("one");

		await waitFor(() => expect(result.current.value).toBe("two"));
	});

	it("says it is waiting while it asks again", async () => {
		let answer = "one";

		const { result, rerender } = renderHook(
			({ about }: { about: string }) =>
				usePoll(() => Promise.resolve(answer), { about, every: 60_000 }),
			{ initialProps: { about: "first" } },
		);

		await waitFor(() => expect(result.current.loading).toBe(false));

		answer = "two";
		act(() => {
			rerender({ about: "second" });
		});

		// Synchronously, before the promise settles: the panel has to have
		// something to draw in the frame the click lands in, or it draws the
		// previous room.
		expect(result.current.loading).toBe(true);

		await waitFor(() => expect(result.current.value).toBe("two"));
	});
});

/*
 * How often the management pages ask the server anything.
 *
 * Both faults here were invisible from the page. The poll above the sign-in
 * screen went on asking behind it, refused every five seconds for as long as
 * the tab stayed open; and coming back to a tab asked again beside whatever the
 * timer had already sent, so two answers raced and the older could be the one
 * left on screen. Neither drew anything wrong, so what is counted is requests.
 */
describe("how often it asks", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks nothing while it is not enabled, and starts when it is", async () => {
		const ask = vi.fn(async () => 1);

		const { rerender } = renderHook(({ enabled }) => usePoll(ask, { enabled }), {
			initialProps: { enabled: false },
		});
		await act(async () => {});
		expect(ask).not.toHaveBeenCalled();

		rerender({ enabled: true });
		await act(async () => {});
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("does not ask again while the last question is unanswered", async () => {
		let answer: (value: number) => void = () => {};
		const ask = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					answer = resolve;
				}),
		);

		renderHook(() => usePoll(ask));
		expect(ask).toHaveBeenCalledTimes(1);

		// Coming back to the tab while the first question is still out.
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(ask).toHaveBeenCalledTimes(1);

		await act(async () => answer(1));
	});
});

/*
 * An older answer never replaces a newer one.
 *
 * The timer's question and a refresh asked for by hand — after a box was
 * pressed, to read back what the server now holds — can be out together, and
 * on a slow link the timer's, asked first, can arrive last. It used to be shown
 * whenever it arrived, so the list from before the press was the one left on
 * the page: the box flipped back with no message, and the next press on that
 * row was built on it.
 */
describe("answers out of order", () => {
	it("keeps the answer to the later question", async () => {
		const pending: ((value: string) => void)[] = [];
		const ask = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					pending.push(resolve);
				}),
		);

		const { result } = renderHook(() => usePoll(ask, { every: 60_000 }));
		expect(ask).toHaveBeenCalledTimes(1);

		// The press's own reread, asked while the timer's is still out.
		let refreshed: Promise<void> = Promise.resolve();
		act(() => {
			refreshed = result.current.refresh();
		});
		expect(ask).toHaveBeenCalledTimes(2);

		await act(async () => {
			pending[1]?.("after the press");
			await refreshed;
		});
		expect(result.current.value).toBe("after the press");

		// The timer's, asked first, arrives last.
		await act(async () => {
			pending[0]?.("before the press");
		});
		expect(result.current.value).toBe("after the press");
	});

	it("does not show an older question's failure over a newer answer", async () => {
		const pending: { resolve: (value: string) => void; reject: (reason: Error) => void }[] = [];
		const ask = vi.fn(
			() =>
				new Promise<string>((resolve, reject) => {
					pending.push({ resolve, reject });
				}),
		);

		const { result } = renderHook(() => usePoll(ask, { every: 60_000 }));

		let refreshed: Promise<void> = Promise.resolve();
		act(() => {
			refreshed = result.current.refresh();
		});

		await act(async () => {
			pending[1]?.resolve("after the press");
			await refreshed;
		});

		await act(async () => {
			pending[0]?.reject(new Error("the older question failed"));
		});

		expect(result.current.error).toBeUndefined();
		expect(result.current.value).toBe("after the press");
	});
});
