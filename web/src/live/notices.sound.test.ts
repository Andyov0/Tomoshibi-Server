import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What these guard is the one sentence somebody who cannot hear anybody gets.
 *
 * It was held to the same ten seconds as everything else and went while the
 * call was still silent: a person placed on another relay heard nobody, was
 * told so in a corner for ten seconds, and was then left with silence and
 * nothing on the screen to say why. And it could be pushed out of sight: three
 * notices are drawn at once, a fourth pushes the oldest out, and this one is
 * raised when the call comes back, so it is the oldest by the time anybody has
 * joined, left or started sharing.
 *
 * The library is stood in for, because what matters is what it is asked to do:
 * how long the notice lasts, and when it is brought to the front again.
 */

const calls: { id: number; title: unknown; options: Record<string, unknown> }[] = [];
let next = 1;

vi.mock("sonner", () => {
	const raise = (title: unknown, options: Record<string, unknown> = {}) => {
		const id = next++;
		calls.push({ id, title, options });
		return id;
	};

	return {
		toast: Object.assign(raise, { error: raise, success: raise, dismiss: vi.fn() }),
	};
});

const { toast } = await import("sonner");
const { VISIBLE, audioBlocked, deviceFailed } = await import("./notices");

const SAID = "You can't hear anyone yet";
const sound = () => calls.filter((one) => one.title === SAID);

beforeEach(() => {
	calls.length = 0;
	vi.mocked(toast.dismiss).mockClear();
});

describe("the notice that sound is held back", () => {
	it("stays for as long as it is true, with a way to act on it", () => {
		const down = audioBlocked(() => {});

		const [raised] = sound();
		expect(raised?.options.duration).toBe(Number.POSITIVE_INFINITY);
		expect(raised?.options.action).toBeDefined();

		down();
		expect(toast.dismiss).toHaveBeenCalledWith(raised?.id);
	});

	it("is brought to the front before newer notices push it out of sight", () => {
		const down = audioBlocked(() => {});
		const first = sound()[0]?.id;

		for (let i = 0; i < VISIBLE; i++) deviceFailed("camera", new Error("busy"));

		expect(toast.dismiss).toHaveBeenCalledWith(first);
		expect(sound()).toHaveLength(2);
		down();
	});

	/*
	 * Bringing it forward is a departure and an arrival, so it is done only when
	 * it would otherwise be hidden. Notices that have already gone are not in
	 * front of it, and counting them would make it jump at every arrival.
	 */
	it("is left where it is while the notices in front of it are ones that have gone", () => {
		const down = audioBlocked(() => {});

		for (let i = 0; i < VISIBLE + 2; i++) {
			deviceFailed("camera", new Error("busy"));
			const last = calls[calls.length - 1];
			(last?.options.onAutoClose as (shown: { id: number }) => void)({ id: last?.id ?? 0 });
		}

		expect(sound()).toHaveLength(1);
		down();
	});

	it("is not brought back once it has been taken down", () => {
		const down = audioBlocked(() => {});
		down();

		for (let i = 0; i < VISIBLE; i++) deviceFailed("camera", new Error("busy"));

		expect(sound()).toHaveLength(1);
	});
});
