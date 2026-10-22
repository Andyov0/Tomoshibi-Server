import { renderHook } from "@testing-library/react";
import type { Participant } from "livekit-client";
import { describe, expect, it } from "vitest";
import { useSpeakingOrder } from "./useSpeakingOrder";

/*
 * Somebody talking from the second page is somebody nobody can see, and this is
 * what brings them forward. It did, one change too late: who had spoken was
 * written down after the render that sorted by it, so the person who started
 * talking moved only when the roster next changed, which was usually them
 * stopping.
 */

function person(identity: string, isSpeaking = false): Participant {
	return { identity, isSpeaking } as Participant;
}

const order = (people: Participant[]) => people.map((p) => p.identity);

describe("useSpeakingOrder", () => {
	it("brings somebody forward in the render where they start talking", () => {
		const { result, rerender } = renderHook(({ people }) => useSpeakingOrder(people, true), {
			initialProps: { people: [person("a"), person("b"), person("c")] },
		});
		expect(order(result.current)).toEqual(["a", "b", "c"]);

		rerender({ people: [person("a"), person("b"), person("c", true)] });
		expect(order(result.current)).toEqual(["c", "a", "b"]);
	});

	it("keeps them there through a pause", () => {
		const { result, rerender } = renderHook(({ people }) => useSpeakingOrder(people, true), {
			initialProps: { people: [person("a"), person("b", true)] },
		});
		rerender({ people: [person("a"), person("b")] });

		expect(order(result.current)).toEqual(["b", "a"]);
	});

	it("leaves a room that fits on one page alone", () => {
		const { result } = renderHook(() => useSpeakingOrder([person("a"), person("b", true)], false));

		expect(order(result.current)).toEqual(["a", "b"]);
	});
});
