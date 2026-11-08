import { Room, RoomEvent, type RemoteAudioTrack } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { booster } from "./boost";

/*
 * A sound turned up past as loud as it was sent goes through a gain (boost.ts)
 * and comes back to its element at one or below. What would go wrong quietly:
 * the element left playing beside the gain, which is the same voice twice --
 * the library's setAudioContext() does not mute an element already attached,
 * and that was how it first came out -- and a sound left on the gain when it is
 * turned back down, out of the browser's echo cancelling for no reason.
 */

const sinks: string[] = [];

class FakeContext {
	state = "running";
	closed = false;
	setSinkId(id: string) {
		sinks.push(id);
		return Promise.resolve();
	}
	resume() {
		return Promise.resolve();
	}
	close() {
		this.closed = true;
		return Promise.resolve();
	}
}

function track() {
	const element = document.createElement("audio");
	const one = {
		attachedElements: [element],
		setAudioContext: vi.fn(),
		setVolume: vi.fn(),
	};
	return { one, element, as: one as unknown as RemoteAudioTrack };
}

beforeEach(() => {
	sinks.length = 0;
	vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => vi.unstubAllGlobals());

describe("a sound turned up past as sent", () => {
	it("goes through a gain with its element muted, and back to its element at one or below", () => {
		const room = new Room();
		const boost = booster(room);
		const { one, element, as } = track();

		boost.set(as, 2.5);
		expect(one.setAudioContext).toHaveBeenCalledTimes(1);
		expect(one.setAudioContext.mock.calls[0]?.[0]).toBeInstanceOf(FakeContext);
		expect(element.muted).toBe(true);
		expect(one.setVolume).toHaveBeenLastCalledWith(2.5);

		// Further along the gain: no second context.
		boost.set(as, 3);
		expect(one.setAudioContext).toHaveBeenCalledTimes(1);
		expect(one.setVolume).toHaveBeenLastCalledWith(3);

		boost.set(as, 0.8);
		expect(one.setAudioContext).toHaveBeenLastCalledWith(undefined);
		expect(element.muted).toBe(false);
		expect(one.setVolume).toHaveBeenLastCalledWith(0.8);
		boost.stop();
	});

	it("leaves a sound at or below as sent on its element", () => {
		const boost = booster(new Room());
		const { one, element, as } = track();

		boost.set(as, 1);
		boost.set(as, 0.4);

		expect(one.setAudioContext).not.toHaveBeenCalled();
		expect(element.muted).toBe(false);
		boost.stop();
	});

	it("puts every sound back on its element when it stops", () => {
		const boost = booster(new Room());
		const { one, element, as } = track();

		boost.set(as, 2);
		boost.stop();

		expect(one.setAudioContext).toHaveBeenLastCalledWith(undefined);
		expect(element.muted).toBe(false);
		expect(one.setVolume).toHaveBeenLastCalledWith(1);
		const context = one.setAudioContext.mock.calls[0]?.[0] as FakeContext;
		expect(context.closed).toBe(true);
	});

	it("is heard from the speakers the room is using, and follows a change of them", () => {
		const room = new Room();
		const device = vi.spyOn(room, "getActiveDevice").mockReturnValue("headphones-1");
		const boost = booster(room);

		boost.set(track().as, 2);
		expect(sinks).toEqual(["headphones-1"]);

		device.mockReturnValue("speakers-2");
		room.emit(RoomEvent.ActiveDeviceChanged, "audiooutput", "speakers-2");
		expect(sinks).toEqual(["headphones-1", "speakers-2"]);
		boost.stop();
	});
});
