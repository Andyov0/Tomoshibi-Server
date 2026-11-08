import { RoomEvent } from "livekit-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/*
 * A reload is not somebody leaving and a stranger arriving.
 *
 * A reload keeps the identity, so everybody else sees the same identity go and
 * come back, and was told "Alex left" and "Alex joined" for it (the health
 * check of 2026-10-29), the one thing README says a reload does not look like.
 * The library is stood in for, and so is the room: what matters is what is
 * said and when.
 */

const said: string[] = [];

vi.mock("sonner", () => {
	const raise = (title: unknown) => {
		said.push(String(title));
		return said.length;
	};

	return { toast: Object.assign(raise, { error: raise, success: raise, dismiss: vi.fn() }) };
});

const { BACK_WITHIN, watch } = await import("./notices");

function room() {
	const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

	return {
		on(event: string, handler: (...args: unknown[]) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		off(event: string, handler: (...args: unknown[]) => void) {
			handlers.set(event, (handlers.get(event) ?? []).filter((one) => one !== handler));
		},
		emit(event: string, ...args: unknown[]) {
			for (const handler of handlers.get(event) ?? []) handler(...args);
		},
	};
}

const alex = { identity: "tAbc123|Alex", name: "Alex" };

beforeEach(() => {
	vi.useFakeTimers();
	said.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

it("says nothing when somebody goes and comes straight back", () => {
	const live = room();
	const stop = watch(live as never);

	live.emit(RoomEvent.ParticipantDisconnected, alex);
	vi.advanceTimersByTime(1500);
	live.emit(RoomEvent.ParticipantConnected, alex);
	vi.advanceTimersByTime(BACK_WITHIN * 2);

	expect(said).toEqual([]);
	stop();
});

it("still says a leave that is a leave, once it is clear it is one", () => {
	const live = room();
	const stop = watch(live as never);

	live.emit(RoomEvent.ParticipantDisconnected, alex);
	expect(said).toEqual([]);

	vi.advanceTimersByTime(BACK_WITHIN);
	expect(said).toHaveLength(1);
	expect(said[0]).toContain("Alex");

	// And coming back after that is an arrival, and said.
	live.emit(RoomEvent.ParticipantConnected, alex);
	expect(said).toHaveLength(2);
	stop();
});

it("says an arrival at once", () => {
	const live = room();
	const stop = watch(live as never);

	live.emit(RoomEvent.ParticipantConnected, { identity: "gXyz|Kim", name: "Kim" });
	expect(said).toHaveLength(1);
	stop();
});

it("says nothing more once this page has left the call", () => {
	const live = room();
	const stop = watch(live as never);

	live.emit(RoomEvent.ParticipantDisconnected, alex);
	stop();
	vi.advanceTimersByTime(BACK_WITHIN * 2);

	expect(said).toEqual([]);
});
