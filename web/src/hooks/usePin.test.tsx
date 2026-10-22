import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Surface } from "@/live/surface";
import { usePin } from "./usePin";

/** A stub: `usePin` only ever reads `id` and `kind`. */
function tile(member: string, kind: "camera" | "screen"): Surface {
	return {
		id: `${member}/${kind}`,
		kind,
		local: false,
		track: { participant: { identity: member } } as Surface["track"],
	};
}

const alice = tile("alice", "camera");
const bob = tile("bob", "camera");
const aliceShare = tile("alice", "screen");
const bobShare = tile("bob", "screen");

describe("usePin", () => {
	it("starts on the grid", () => {
		const { result } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob] },
		});
		expect(result.current.pinned).toBeUndefined();
	});

	it("auto-pins a share when it starts", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob] },
		});

		rerender({ tiles: [alice, bob, aliceShare] });
		expect(result.current.pinned?.id).toBe(aliceShare.id);
	});

	it("releases the stage when that share stops", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob, aliceShare] },
		});
		expect(result.current.pinned?.id).toBe(aliceShare.id);

		rerender({ tiles: [alice, bob] });
		expect(result.current.pinned).toBeUndefined();
	});

	/// The rule that is easy to get wrong: a human pin outranks the automation,
	/// both ways round.
	it("does not auto-pin over a manual pin", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob] },
		});

		act(() => result.current.pin(bob));
		expect(result.current.pinned?.id).toBe(bob.id);

		rerender({ tiles: [alice, bob, aliceShare] });
		expect(result.current.pinned?.id, "a starting share must not steal a manual pin").toBe(bob.id);
	});

	it("does not un-pin a manual pin when a share stops", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob, aliceShare] },
		});
		expect(result.current.pinned?.id).toBe(aliceShare.id);

		// The user takes over, choosing the same tile the automation had picked.
		act(() => result.current.pin(aliceShare));
		rerender({ tiles: [alice, bob, aliceShare] });

		// Now the share ends. The tile is gone, so the pin clears, but via the
		// "pinned tile disappeared" path rather than the auto-release path.
		rerender({ tiles: [alice, bob] });
		expect(result.current.pinned).toBeUndefined();
	});

	it("keeps a manual pin across an unrelated share ending", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob, aliceShare] },
		});

		act(() => result.current.pin(bob));
		rerender({ tiles: [alice, bob] });

		expect(result.current.pinned?.id).toBe(bob.id);
	});

	it("toggles off when the same tile is chosen twice", () => {
		const { result } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob] },
		});

		act(() => result.current.toggle(alice));
		expect(result.current.pinned?.id).toBe(alice.id);

		act(() => result.current.toggle(alice));
		expect(result.current.pinned).toBeUndefined();
	});

	it("drops the pin when the participant leaves", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob] },
		});

		act(() => result.current.pin(bob));
		rerender({ tiles: [alice] });

		expect(result.current.pinned).toBeUndefined();
	});

	/// Two people sharing at once: the first one claims the stage, and the second
	/// must not fight it for the pin.
	it("keeps the first share pinned when a second starts", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob, aliceShare] },
		});
		expect(result.current.pinned?.id).toBe(aliceShare.id);

		rerender({ tiles: [alice, bob, aliceShare, bobShare] });
		expect(result.current.pinned?.id).toBe(aliceShare.id);
	});

	/// And when the pinned one stops, the remaining share should take over rather
	/// than dumping everyone back to the grid.
	it("hands the stage to the remaining share", () => {
		const { result, rerender } = renderHook(({ tiles }) => usePin(tiles), {
			initialProps: { tiles: [alice, bob, aliceShare, bobShare] },
		});
		expect(result.current.pinned?.id).toBe(aliceShare.id);

		rerender({ tiles: [alice, bob, bobShare] });
		expect(result.current.pinned?.id).toBe(bobShare.id);
	});
});
