import { afterEach, describe, expect, it, vi } from "vitest";
import { audioUrl, clock, describeAudio, describeTrack, libraries, searchLibrary } from "./music";

/*
The music library's client.

The answers come from a gateway the client never sees, through the server, so
each is read defensively and the shapes that matter are pinned: "no library"
must read as absent rather than as an error on every page, "this account may
not play it" must be told apart from "the library broke", and the quality shown
must be what the file is.
*/

function answer(status: number, body: unknown) {
	return vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("which libraries there are", () => {
	it("reads them, signed in or not", async () => {
		vi.stubGlobal("fetch", answer(200, { sources: [{ id: "a", name: "A", signedIn: true }, { id: "b", name: "B", signedIn: false }] }));
		expect(await libraries()).toEqual([
			{ id: "a", name: "A", signedIn: true },
			{ id: "b", name: "B", signedIn: false },
		]);
	});

	it("is none where the deployment has none or nobody is signed in", async () => {
		vi.stubGlobal("fetch", answer(404, {}));
		expect(await libraries()).toBeUndefined();
		vi.stubGlobal("fetch", answer(401, { error: "not_signed_in" }));
		expect(await libraries()).toBeUndefined();
	});
});

describe("searching", () => {
	it("keeps what a track needs and drops what is not one", async () => {
		const fetch = answer(200, {
			tracks: [
				{ id: "1", title: "Sunny Day", artists: ["Jay"], album: "Ye Hui Mei", cover: "c", duration: 269 },
				{ id: "", title: "no id" },
				{ title: "no id either" },
			],
		});
		vi.stubGlobal("fetch", fetch);

		expect(await searchLibrary("a", "sunny")).toEqual([
			{ id: "1", title: "Sunny Day", artists: ["Jay"], album: "Ye Hui Mei", cover: "c", duration: 269 },
		]);
		expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/music/search?source=a&q=sunny&page=1");
	});
});

describe("what a track is", () => {
	it("is the format, rate and bits the file has", async () => {
		vi.stubGlobal("fetch", answer(200, { format: "flac", rate: 44100, channels: 2, bits: 24, tier: "lossless" }));
		expect(await describeTrack("a", "1")).toEqual({ format: "flac", rate: 44100, channels: 2, bits: 24, tier: "lossless" });
	});

	it("is unavailable, not a failure, where the account may not play it", async () => {
		vi.stubGlobal("fetch", answer(404, { error: "unavailable" }));
		expect(await describeTrack("a", "1")).toBe("unavailable");
	});

	it("is a failure where the library broke", async () => {
		vi.stubGlobal("fetch", answer(502, { error: "upstream" }));
		await expect(describeTrack("a", "1")).rejects.toThrow();
	});

	it("is said as what is played", () => {
		expect(describeAudio({ format: "flac", rate: 44100, channels: 2, bits: 24, tier: "lossless" })).toBe(
			"FLAC · 24-bit · 44.1 kHz",
		);
		expect(describeAudio({ format: "flac", rate: 96000, channels: 2, bits: 24, tier: "hires" })).toBe(
			"FLAC · 24-bit · 96 kHz",
		);
		expect(describeAudio({ format: "mp3", rate: 44100, channels: 2, bits: 16, tier: "320k" })).toBe("MP3 · 320 kbps");
	});
});

it("plays from the same origin, so the page may read the samples", () => {
	expect(audioUrl("a", "1")).toBe("/api/music/audio?source=a&id=1&quality=best");
	expect(clock(269)).toBe("4:29");
	expect(clock(5)).toBe("0:05");
});
