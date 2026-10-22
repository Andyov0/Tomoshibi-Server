import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTwice } from "./twice";

/*
 * Removing somebody ends their meeting, and the row it sits on moves under the
 * pointer every time the list is polled. One press is a question; only the
 * second is the answer, and a question nobody answers is forgotten.
 */

afterEach(() => {
	vi.useRealTimers();
});

it("does nothing on the first press and acts on the second", () => {
	const remove = vi.fn();
	const { result } = renderHook(() => useTwice(remove));

	act(() => result.current.press());
	expect(remove).not.toHaveBeenCalled();
	expect(result.current.armed).toBe(true);

	act(() => result.current.press());
	expect(remove).toHaveBeenCalledTimes(1);
	expect(result.current.armed).toBe(false);
});

it("forgets a first press nobody followed up", () => {
	vi.useFakeTimers();
	const remove = vi.fn();
	const { result } = renderHook(() => useTwice(remove));

	act(() => result.current.press());
	act(() => {
		vi.advanceTimersByTime(4001);
	});
	expect(result.current.armed).toBe(false);

	act(() => result.current.press());
	expect(remove).not.toHaveBeenCalled();
});
