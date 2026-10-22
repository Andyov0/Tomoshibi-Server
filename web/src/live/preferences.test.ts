import { afterEach, describe, expect, it, vi } from "vitest";
import {
	blurWanted,
	capping,
	deviceChoice,
	forgetDeviceChoice,
	levelCap,
	rememberDeviceChoice,
	rememberMusicQuality,
	rememberWatchQuality,
	rememberedDevices,
	rememberedMusicQuality,
	restorable,
	restoreDevices,
	watchQuality,
} from "./preferences";

/*
 * What a browser reads back from what it wrote down, including what it did not
 * write.
 *
 * Every one of these is read at the start of something — a join, a video, a
 * song — from storage that may hold a value from an older build, a later one, a
 * half-finished write or somebody's console. The failure is never an error. It
 * is a call that starts with the camera on for somebody who never turned it on,
 * a film held at a quality nobody chose, or a microphone asked for by a name
 * the browser no longer has. So each reader is given nothing, the right thing,
 * and garbage, and garbage has to read as nothing.
 *
 * The keys are spelled out here rather than imported, on purpose: the spelling
 * is what browsers already hold, and a renamed key would pass a test that read
 * its name from the module it was renamed in.
 */

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe("the devices a call starts with", () => {
	it("starts with the microphone on and the camera off until told otherwise", () => {
		expect(rememberedDevices()).toEqual({ camera: false, microphone: true });

		localStorage.setItem("meet-live.devices", JSON.stringify({ camera: true, microphone: false }));
		expect(rememberedDevices()).toEqual({ camera: true, microphone: false });
	});

	it("reads anything it does not recognise as the defaults, one half at a time", () => {
		for (const garbage of ["{", "null", "42", '"on"', "[]", '{"camera":"yes","microphone":1}']) {
			localStorage.setItem("meet-live.devices", garbage);
			expect(rememberedDevices(), garbage).toEqual({ camera: false, microphone: true });
		}

		// A record that lost one half keeps the other.
		localStorage.setItem("meet-live.devices", JSON.stringify({ camera: true }));
		expect(rememberedDevices()).toEqual({ camera: true, microphone: true });
	});
});

describe("blur", () => {
	it("is wanted only where it was asked for", () => {
		expect(blurWanted()).toBe(false);
		localStorage.setItem("meet-live.blur", "on");
		expect(blurWanted()).toBe(true);
		localStorage.setItem("meet-live.blur", "yes");
		expect(blurWanted()).toBe(false);
	});
});

describe("the music library's quality", () => {
	it("is lossless unless the highest was asked for", () => {
		expect(rememberedMusicQuality()).toBe("lossless");

		localStorage.setItem("meet-live.music-quality", "best");
		expect(rememberedMusicQuality()).toBe("best");

		// Lossy is what a library answers with, never what somebody chooses.
		for (const garbage of ["lossy", "BEST", "", "hires"]) {
			localStorage.setItem("meet-live.music-quality", garbage);
			expect(rememberedMusicQuality(), garbage).toBe("lossless");
		}
	});

	it("writes the default as nothing, which older builds read the same way", () => {
		rememberMusicQuality("best");
		expect(localStorage.getItem("meet-live.music-quality")).toBe("best");

		rememberMusicQuality("lossless");
		expect(localStorage.getItem("meet-live.music-quality")).toBeNull();
	});
});

describe("the ceiling on a video's quality", () => {
	it("has none until one is chosen, and none for anything it does not know", () => {
		expect(watchQuality()).toBe("auto");

		localStorage.setItem("meet-live.watch-quality", "720p");
		expect(watchQuality()).toBe("720p");

		for (const garbage of ["4k", "1080P", "", "auto ", "480p"]) {
			localStorage.setItem("meet-live.watch-quality", garbage);
			expect(watchQuality(), garbage).toBe("auto");
		}
	});

	it("forgets the key for no ceiling rather than writing one down", () => {
		rememberWatchQuality("1080p");
		expect(localStorage.getItem("meet-live.watch-quality")).toBe("1080p");

		rememberWatchQuality("auto");
		expect(localStorage.getItem("meet-live.watch-quality")).toBeNull();
	});

	// Levels as a playlist orders them: by bitrate, which is nearly always by size.
	const p360 = { width: 640, height: 360 };
	const p720 = { width: 1280, height: 720 };
	const p1080 = { width: 1920, height: 1080 };
	const p2160 = { width: 3840, height: 2160 };
	const ladder = [p360, p720, p1080, p2160];

	it("allows every level up to the ceiling, and none above it", () => {
		expect(levelCap(ladder, "auto")).toBe(-1);
		expect(levelCap(ladder, "1080p")).toBe(2);
		expect(levelCap(ladder, "720p")).toBe(1);

		// Nothing above it to keep out, so no ceiling at all.
		expect(levelCap(ladder.slice(0, 3), "1080p")).toBe(-1);
		expect(levelCap([], "720p")).toBe(-1);
	});

	it("measures the shorter side, with room for an encoder's rounding", () => {
		// A 1080p stream padded to whole sixteen-pixel blocks is still 1080p:
		// allowed, with the level below it, and only the 4K kept out.
		expect(levelCap([p720, { width: 1920, height: 1088 }, p2160], "1080p")).toBe(1);

		// A film cropped wide is the quality its width says, not its height.
		const scope = [
			{ width: 1920, height: 800 },
			{ width: 3840, height: 1600 },
		];
		expect(levelCap(scope, "1080p")).toBe(0);
		expect(levelCap(scope, "720p")).toBe(0);

		// A level that does not say its size is not refused for it.
		expect(levelCap([{ height: 0 }, p720], "720p")).toBe(-1);
	});

	it("stops below the first level that is too tall, wherever the list puts it", () => {
		const unordered = [p720, p2160, p1080];
		expect(levelCap(unordered, "1080p")).toBe(0);
	});

	it("leaves the least there is when even that is above the ceiling", () => {
		expect(levelCap([p1080, p2160], "720p")).toBe(0);
	});

	it("only ever lowers the player's own ceiling", () => {
		// No ceiling yet: the viewer's.
		expect(capping(-1, ladder, "720p")).toBe(1);
		// The tile allows more than the viewer does: the viewer's.
		expect(capping(3, ladder, "720p")).toBe(1);
		// The tile allows less: the tile's, which is the deployment's bandwidth.
		expect(capping(0, ladder, "720p")).toBe(0);
		// No ceiling chosen: whatever the player had.
		expect(capping(3, ladder, "auto")).toBe(3);
		expect(capping(-1, ladder, "auto")).toBe(-1);
	});
});

describe("the devices picked in a call", () => {
	it("is nothing until something is picked, and nothing for garbage", () => {
		expect(deviceChoice()).toEqual({});

		for (const garbage of ["{", "null", "[]", '"mic"', "7"]) {
			localStorage.setItem("meet-live.device-choice", garbage);
			expect(deviceChoice(), garbage).toEqual({});
		}
	});

	it("keeps only what could be a device of a kind it picks", () => {
		localStorage.setItem(
			"meet-live.device-choice",
			JSON.stringify({
				audioinput: "mic-1",
				videoinput: 42,
				audiooutput: "",
				// Not a kind anybody picks from the menu.
				screen: "window-1",
				// Not an identifier any browser makes.
				extra: "x".repeat(1000),
			}),
		);
		expect(deviceChoice()).toEqual({ audioinput: "mic-1" });

		localStorage.setItem("meet-live.device-choice", JSON.stringify({ videoinput: "x".repeat(257) }));
		expect(deviceChoice()).toEqual({});
	});

	it("remembers each kind beside the others, and forgets them all together", () => {
		rememberDeviceChoice("audioinput", "mic-1");
		rememberDeviceChoice("videoinput", "cam-2");
		rememberDeviceChoice("audioinput", "mic-3");
		expect(deviceChoice()).toEqual({ audioinput: "mic-3", videoinput: "cam-2" });

		// Nothing is not a device.
		rememberDeviceChoice("audiooutput", "");
		expect(deviceChoice()).toEqual({ audioinput: "mic-3", videoinput: "cam-2" });

		forgetDeviceChoice();
		expect(localStorage.getItem("meet-live.device-choice")).toBeNull();
	});

	const device = (kind: MediaDeviceKind, deviceId: string) => ({ kind, deviceId });

	it("asks for a remembered device only where it is still there", () => {
		const choice = { audioinput: "mic-1", videoinput: "cam-gone", audiooutput: "out-1" };
		const present = [
			device("audioinput", "default"),
			device("audioinput", "mic-1"),
			device("videoinput", "cam-other"),
			device("audiooutput", "out-1"),
		];

		expect(restorable(choice, present)).toEqual([
			["audioinput", "mic-1"],
			["audiooutput", "out-1"],
		]);
	});

	it("asks anyway where the browser has not yet said what it has", () => {
		// What a browser lists before it has been given a camera on this site:
		// one of each, with the identifiers blanked.
		const hidden = [device("audioinput", ""), device("videoinput", "")];

		expect(restorable({ audioinput: "mic-1", videoinput: "cam-1" }, hidden)).toEqual([
			["audioinput", "mic-1"],
			["videoinput", "cam-1"],
		]);

		// And not for a kind it lists nothing of at all.
		expect(restorable({ audiooutput: "out-1" }, hidden)).toEqual([]);
	});

	it("points a room at what is there, as a preference, and never fails the join", async () => {
		rememberDeviceChoice("audioinput", "mic-1");
		rememberDeviceChoice("videoinput", "cam-gone");
		rememberDeviceChoice("audiooutput", "out-1");

		vi.stubGlobal("navigator", {
			mediaDevices: {
				enumerateDevices: async () => [
					device("audioinput", "mic-1"),
					device("videoinput", "cam-other"),
					device("audiooutput", "out-1"),
				],
			},
		});

		const asked: unknown[][] = [];
		const room = {
			switchActiveDevice: async (...args: unknown[]) => {
				asked.push(args);
				// A browser that cannot choose a speaker, which is Safari.
				if (args[0] === "audiooutput") throw new Error("cannot switch audio output");
				return true;
			},
		};

		await expect(restoreDevices(room)).resolves.toBeUndefined();
		expect(asked).toEqual([
			["audioinput", "mic-1", false],
			["audiooutput", "out-1", false],
		]);

		// The camera that is gone is still remembered, for when it comes back.
		expect(deviceChoice().videoinput).toBe("cam-gone");
	});

	it("asks the browser nothing when nothing was picked", async () => {
		const enumerateDevices = vi.fn(async () => []);
		vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });

		const switchActiveDevice = vi.fn(async () => true);
		await restoreDevices({ switchActiveDevice });

		expect(enumerateDevices).not.toHaveBeenCalled();
		expect(switchActiveDevice).not.toHaveBeenCalled();
	});

	it("carries on where the browser will not list its devices", async () => {
		rememberDeviceChoice("audioinput", "mic-1");
		vi.stubGlobal("navigator", {});

		const switchActiveDevice = vi.fn(async () => true);
		await expect(restoreDevices({ switchActiveDevice })).resolves.toBeUndefined();
		expect(switchActiveDevice).not.toHaveBeenCalled();
	});
});
