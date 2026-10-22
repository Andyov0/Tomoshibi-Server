import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { FADE_IN_MS, resetDuck } from "./duck";
import { LOSSLESS, MUSIC } from "./lossless";
import {
	LISTENING,
	LISTENING_BITRATE,
	MUSIC_CAPTURE,
	NoSound,
	ORIGINAL_BITRATE,
	VOICE_BITRATE,
	listening,
	monitorVolume,
	musicPaused,
	nowPlaying,
	pauseMusic,
	playLibraryTrack,
	setMonitorVolume,
	sendingLossless,
	startListening,
	subscribePlaying,
	stopListening,
	stopMusic,
	voiceCapture,
	voicePublish,
} from "./sound";

/*
 * How sound is captured and sent.
 *
 * Every one of these failed silently before it was set: a call ran on the SDK's
 * defaults, and the only symptom was that it sounded worse than it should, which
 * nobody files as a bug. So the settings are asserted where they are made, and
 * sharing sound on its own is driven through a picker that can be told what to
 * hand back -- including nothing, which is what a browser does when the sound
 * box was left unticked.
 */

vi.mock("livekit-client", async (original) => {
	const real = await original<typeof import("livekit-client")>();

	// A track around a fake MediaStreamTrack; the real one wants a browser.
	class LocalAudioTrack {
		constructor(
			public mediaStreamTrack: MediaStreamTrack,
			public constraints?: MediaTrackConstraints,
		) {}
	}

	return { ...real, LocalAudioTrack };
});

describe("a voice", () => {
	it("is processed by default, without voice isolation", () => {
		expect(voiceCapture(false)).toMatchObject({
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
			voiceIsolation: false,
		});
	});

	it("is left alone in original sound, except for echo cancellation", () => {
		expect(voiceCapture(true)).toMatchObject({
			echoCancellation: true,
			noiseSuppression: false,
			autoGainControl: false,
			voiceIsolation: false,
		});
	});

	it("is sent continuously, with redundancy, at more than the SDK's default", () => {
		expect(voicePublish(false)).toEqual({ audioPreset: { maxBitrate: VOICE_BITRATE }, dtx: false, red: true });
		expect(voicePublish(true).audioPreset).toEqual({ maxBitrate: ORIGINAL_BITRATE });
		expect(VOICE_BITRATE).toBeGreaterThan(48_000);
	});
});

function fakeTrack(kind: "audio" | "video") {
	return { kind, enabled: true, stop: vi.fn(), addEventListener: vi.fn() } as unknown as MediaStreamTrack & {
		stop: ReturnType<typeof vi.fn>;
	};
}

function fakeRoom(options: Record<string, unknown> = {}) {
	const publications = new Map<string, unknown>();
	const publishTrack = vi.fn(async (track: unknown, options: { source: string; name: string }) => {
		const publication = { source: options.source, trackName: options.name, track };
		publications.set(options.name, publication);
		return publication;
	});
	const unpublishTrack = vi.fn(async (track: unknown) => {
		for (const [name, publication] of publications) {
			if ((publication as { track: unknown }).track === track) publications.delete(name);
		}
	});
	const room = {
		options,
		localParticipant: { trackPublications: publications, publishTrack, unpublishTrack },
		remoteParticipants: new Map(),
		on: vi.fn(),
		off: vi.fn(),
	};

	return { room: room as unknown as Room, publishTrack, unpublishTrack };
}

describe("sharing sound on its own", () => {
	const getDisplayMedia = vi.fn();

	beforeEach(() => {
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getDisplayMedia },
			configurable: true,
		});
	});

	afterEach(() => {
		getDisplayMedia.mockReset();
	});

	it("asks for one application's sound, untouched and in stereo", async () => {
		const sound = fakeTrack("audio");
		const picture = fakeTrack("video");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [sound],
			getVideoTracks: () => [picture],
			getTracks: () => [sound, picture],
		});
		const { room } = fakeRoom();

		await startListening(room);

		const asked = getDisplayMedia.mock.calls[0]?.[0];
		expect(asked.windowAudio).toBe("window");
		expect(asked.audio).toEqual(MUSIC_CAPTURE);
		expect(asked.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, channelCount: 2 });
	});

	it("publishes it at Opus's ceiling, without the RED that would sink it", async () => {
		const sound = fakeTrack("audio");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [sound],
			getVideoTracks: () => [],
			getTracks: () => [sound],
		});
		const { room, publishTrack } = fakeRoom();

		await startListening(room, false);

		const options = publishTrack.mock.calls[0]?.[1];
		expect(options).toMatchObject({
			source: "screen_share_audio",
			name: LISTENING,
			forceStereo: true,
			dtx: false,
			red: false,
			audioPreset: { maxBitrate: LISTENING_BITRATE },
		});
		expect(LISTENING_BITRATE).toBe(510_000);
		expect(listening(room)).toBeDefined();
		expect(sendingLossless(room)).toBe(false);
	});

	describe("losslessly", () => {
		// Reads nothing: these tests are about what is offered, not what is sent.
		class Processor {
			readable = new ReadableStream({ start() {} });
		}

		beforeEach(() => {
			vi.stubGlobal("MediaStreamTrackProcessor", Processor);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });
		});

		const sharing = () => {
			const sound = fakeTrack("audio");
			getDisplayMedia.mockResolvedValue({
				getAudioTracks: () => [sound],
				getVideoTracks: () => [],
				getTracks: () => [sound],
			});
		};

		it("offers the lossless stream under its own name, and sends it", async () => {
			sharing();
			const { room, publishTrack } = fakeRoom();

			await startListening(room, true);

			expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LOSSLESS });
			expect(listening(room)).toBeDefined();
			expect(sendingLossless(room)).toBe(true);

			await stopListening(room);
			expect(sendingLossless(room)).toBe(false);
		});

		it("never offers it in an encrypted call, where it would cross the relay in the clear", async () => {
			sharing();
			const { room, publishTrack } = fakeRoom({ e2ee: { keyProvider: {}, worker: {} } });

			await startListening(room, true);

			expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LISTENING });
			expect(sendingLossless(room)).toBe(false);
		});

		it("does not offer it where the browser cannot read samples off a track", async () => {
			vi.unstubAllGlobals();
			sharing();
			const { room, publishTrack } = fakeRoom();

			await startListening(room, true);

			expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LISTENING });
			expect(sendingLossless(room)).toBe(false);
		});
	});

	it("keeps the picture it had to take, switched off, and stops it with the sound", async () => {
		const sound = fakeTrack("audio");
		const picture = fakeTrack("video");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [sound],
			getVideoTracks: () => [picture],
			getTracks: () => [sound, picture],
		});
		const { room, unpublishTrack } = fakeRoom();

		await startListening(room);
		expect(picture.enabled).toBe(false);
		expect(picture.stop).not.toHaveBeenCalled();

		await stopListening(room);
		expect(unpublishTrack).toHaveBeenCalledTimes(1);
		expect(picture.stop).toHaveBeenCalledTimes(1);
		expect(listening(room)).toBeUndefined();
	});

	it("says so when the choice came back with no sound, and lets the capture go", async () => {
		const picture = fakeTrack("video");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [],
			getVideoTracks: () => [picture],
			getTracks: () => [picture],
		});
		const { room, publishTrack } = fakeRoom();

		await expect(startListening(room)).rejects.toBeInstanceOf(NoSound);
		expect(picture.stop).toHaveBeenCalledTimes(1);
		expect(publishTrack).not.toHaveBeenCalled();
	});
});

describe("sharing sound losslessly, in order", () => {
	it("is listening for asks before the publication that invites them exists", async () => {
		const sound = { kind: "audio", enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
		Object.defineProperty(navigator, "mediaDevices", {
			value: {
				getDisplayMedia: vi.fn(async () => ({
					getAudioTracks: () => [sound],
					getVideoTracks: () => [],
					getTracks: () => [sound],
				})),
			},
			configurable: true,
		});
		vi.stubGlobal("MediaStreamTrackProcessor", class {
			readable = new ReadableStream({ start() {} });
		});

		const order: string[] = [];
		const room = {
			options: {},
			remoteParticipants: new Map(),
			on: vi.fn((event: string) => order.push(`on:${event}`)),
			off: vi.fn(),
			localParticipant: {
				trackPublications: new Map(),
				publishTrack: vi.fn(async () => {
					order.push("publish");
					return {};
				}),
			},
		} as unknown as Room;

		await startListening(room, true);

		expect(order.indexOf("on:dataReceived")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("on:dataReceived")).toBeLessThan(order.indexOf("publish"));
		await stopListening(room);
		vi.unstubAllGlobals();
	});
});

describe("playing a track from the library", () => {
	function stubAudio() {
		const contexts: { options: AudioContextOptions; closed: boolean; monitor: { value: number } }[] = [];
		const nodes: {
			started: boolean;
			stopped: boolean;
			from?: number;
			connected: unknown[];
			listeners: Record<string, () => void>;
		}[] = [];
		const decodedAt: number[] = [];
		const fetched: string[] = [];
		const destinationTrack = fakeTrack("audio");

		class FakeContext {
			record: { options: AudioContextOptions; closed: boolean; monitor: { value: number } };
			currentTime = 0;
			destination = { name: "speakers" };
			out = { name: "out", stream: { getAudioTracks: () => [destinationTrack] }, channelCount: 0, channelCountMode: "" };
			constructor(options: AudioContextOptions) {
				this.record = { options, closed: false, monitor: { value: 1 } };
				contexts.push(this.record);
			}
			async resume() {}
			async close() {
				this.record.closed = true;
			}
			hums: { offset: number; connected: unknown[]; started: boolean }[] = [];
			createConstantSource() {
				const hum = { offset: 1, connected: [] as unknown[], started: false };
				this.hums.push(hum);
				return {
					offset: {
						set value(v: number) {
							hum.offset = v;
						},
					},
					connect: (target: unknown) => hum.connected.push(target),
					start: () => {
						hum.started = true;
					},
				};
			}
			createGain() {
				return { name: "monitor", gain: this.record.monitor, connect: vi.fn() };
			}
			createBufferSource() {
				const record = {
					started: false,
					stopped: false,
					from: undefined as number | undefined,
					connected: [] as unknown[],
					listeners: {} as Record<string, () => void>,
				};
				nodes.push(record);
				return {
					buffer: null,
					connect: (target: unknown) => record.connected.push(target),
					start: (_when?: number, from?: number) => {
						record.started = true;
						record.from = from;
					},
					stop: () => {
						record.stopped = true;
					},
					addEventListener: (name: string, listener: () => void) => {
						record.listeners[name] = listener;
					},
				};
			}
			createMediaStreamDestination() {
				return this.out;
			}
		}

		class FakeOffline {
			constructor(
				_channels: number,
				_length: number,
				public sampleRate: number,
			) {}
			async decodeAudioData() {
				decodedAt.push(this.sampleRate);
				return { sampleRate: this.sampleRate, duration: 240 };
			}
		}

		vi.stubGlobal("AudioContext", FakeContext);
		const made: FakeContext[] = [];
		const Tracked = class extends FakeContext {
			constructor(options: AudioContextOptions) {
				super(options);
				made.push(this);
			}
		};
		vi.stubGlobal("AudioContext", Tracked);
		vi.stubGlobal("OfflineAudioContext", FakeOffline);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				fetched.push(url);
				return new Response(new Uint8Array(1000), { headers: { "Content-Length": "1000" } });
			}),
		);
		vi.stubGlobal("MediaStreamTrackProcessor", class {
			readable = new ReadableStream({ start() {} });
		});

		/** Move the newest context's clock on, as playing would. */
		const advance = (seconds: number) => {
			const context = made.at(-1);
			if (context) context.currentTime += seconds;
		};

		return { contexts, nodes, decodedAt, fetched, destinationTrack, advance, made };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		localStorage.clear();
		resetDuck();
	});

	it("decodes at the track's own rate, so nothing resamples it, and shares it losslessly", async () => {
		const { contexts, nodes, decodedAt, fetched, destinationTrack } = stubAudio();
		const { room, publishTrack } = fakeRoom();
		const progress = vi.fn();

		await playLibraryTrack(
			room,
			{ url: "/api/music/audio?x", rate: 44_100, format: "flac", bits: 16, now: { title: "t", artists: "a", quality: "q" } },
			true,
			() => {},
			progress,
		);

		expect(decodedAt).toEqual([44_100]);
		expect(contexts[0]?.options.sampleRate).toBe(44_100);
		expect(fetched).toEqual(["/api/music/audio?x"]);
		expect(progress).toHaveBeenLastCalledWith(1);
		expect(nodes[0]?.started).toBe(true);
		// On a source of its own, not as a share's sound; see MUSIC in lossless.ts.
		expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: MUSIC.lossless, source: "unknown" });
		expect((publishTrack.mock.calls[0]?.[0] as { mediaStreamTrack: unknown }).mediaStreamTrack).toBe(destinationTrack);
		expect(nowPlaying(room)?.title).toBe("t");
		expect(sendingLossless(room, MUSIC)).toBe(true);
		expect(sendingLossless(room)).toBe(false);
	});

	it("plays on through the same output when the next track has its rate and depth", async () => {
		const { contexts, nodes } = stubAudio();
		const { room, publishTrack } = fakeRoom();

		await playLibraryTrack(room, { url: "/1", rate: 44_100, format: "flac", bits: 16 }, true, () => {}, () => {}, () => {});
		await playLibraryTrack(room, { url: "/2", rate: 44_100, format: "flac", bits: 16 }, true, () => {}, () => {}, () => {});

		expect(contexts).toHaveLength(1);
		expect(publishTrack).toHaveBeenCalledTimes(1);
		expect(nodes[0]?.stopped).toBe(true);
		expect(nodes[1]?.started).toBe(true);
	});

	it("opens a new output for a track at another rate, rather than resample it", async () => {
		const { contexts } = stubAudio();
		const { room, publishTrack } = fakeRoom();

		await playLibraryTrack(room, { url: "/1", rate: 44_100, format: "flac", bits: 16 }, true, () => {}, () => {}, () => {});
		await playLibraryTrack(room, { url: "/2", rate: 48_000, format: "flac", bits: 16 }, true, () => {}, () => {}, () => {});

		expect(contexts.map((one) => one.options.sampleRate)).toEqual([44_100, 48_000]);
		expect(contexts[0]?.closed).toBe(true);
		expect(publishTrack).toHaveBeenCalledTimes(2);
	});

	it("opens a new output for a track of another depth, whose samples are recovered differently", async () => {
		const { contexts } = stubAudio();
		const { room, publishTrack } = fakeRoom();

		await playLibraryTrack(room, { url: "/1", rate: 44_100, format: "flac", bits: 16 }, true, () => {}, () => {}, () => {});
		await playLibraryTrack(room, { url: "/2", rate: 44_100, format: "flac", bits: 24 }, true, () => {}, () => {}, () => {});

		expect(contexts).toHaveLength(2);
		expect(publishTrack).toHaveBeenCalledTimes(2);
	});

	it("tells whoever is waiting when the track ends, rather than stopping", async () => {
		const { nodes } = stubAudio();
		const { room, unpublishTrack } = fakeRoom();
		const ended = vi.fn();

		await playLibraryTrack(room, { url: "/u", rate: 44_100 }, false, () => {}, () => {}, ended);
		nodes[0]?.listeners.ended?.();

		expect(ended).toHaveBeenCalledTimes(1);
		expect(unpublishTrack).not.toHaveBeenCalled();
	});

	it("plays at full volume in this machine's speakers until told otherwise", () => {
		localStorage.clear();
		expect(monitorVolume()).toBe(1);
		localStorage.setItem("meet-live.music-monitor", "0");
		expect(monitorVolume()).toBe(0);
		localStorage.setItem("meet-live.music-monitor", "loud");
		expect(monitorVolume()).toBe(1);
		localStorage.clear();
	});

	it("turns down only this machine's speakers, never what is sent", async () => {
		const { contexts, nodes } = stubAudio();
		const { room } = fakeRoom();

		await playLibraryTrack(room, { url: "/u", rate: 44_100 }, true);
		// Past the fade-in, which starts the music from nothing; see duck.ts.
		const later = performance.now() + FADE_IN_MS + 100;
		vi.spyOn(performance, "now").mockReturnValue(later);
		setMonitorVolume(room, 0.25);

		expect(contexts[0]?.monitor.value).toBe(0.25);
		// The published track takes the node straight; only the monitor is turned down.
		expect(nodes[0]?.connected.map((target) => (target as { name: string }).name)).toEqual(["out", "monitor"]);
		expect(monitorVolume()).toBe(0.25);
	});

	it("plays on beside sound shared from an application, and each stops without the other", async () => {
		const { nodes } = stubAudio();
		const { room, unpublishTrack } = fakeRoom();
		const shared = fakeTrack("audio");
		const getDisplayMedia = vi.fn(async () => ({ getAudioTracks: () => [shared], getVideoTracks: () => [], getTracks: () => [shared] }));
		Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });

		const now = { title: "t", artists: "a", quality: "q" };
		await playLibraryTrack(room, { url: "/u", rate: 44_100, now }, true, () => {}, () => {}, () => {});
		await startListening(room, true);
		expect(sendingLossless(room)).toBe(true);
		expect(sendingLossless(room, MUSIC)).toBe(true);

		await stopListening(room);
		expect(listening(room)).toBeUndefined();
		expect(nowPlaying(room)).toBeDefined();
		expect(nodes[0]?.stopped).toBe(false);
		expect(sendingLossless(room, MUSIC)).toBe(true);

		await startListening(room, true);
		await stopMusic(room);
		expect(listening(room)).toBeDefined();
		expect(sendingLossless(room)).toBe(true);
		expect(unpublishTrack).toHaveBeenCalledTimes(2);
	});

	it("pauses by stopping the node and keeping the stream, and goes on from the same place", async () => {
		const { nodes, advance, made } = stubAudio();
		const { room, unpublishTrack } = fakeRoom();
		const ended = vi.fn();
		const now = { title: "t", artists: "a", quality: "q" };
		await playLibraryTrack(room, { url: "/u", rate: 44_100, now }, true, () => {}, () => {}, ended);

		advance(12.5);
		pauseMusic(room, true);
		expect(nodes[0]?.stopped).toBe(true);
		expect(musicPaused(room)).toBe(true);
		// The stopped node ends, and that is not the track ending.
		nodes[0]?.listeners.ended?.();
		expect(ended).not.toHaveBeenCalled();
		expect(unpublishTrack).not.toHaveBeenCalled();
		expect(sendingLossless(room, MUSIC)).toBe(true);
		// What keeps the stream going with nothing playing: zeros, into what is sent.
		const [hum] = made[0]?.hums ?? [];
		expect(hum).toMatchObject({ offset: 0, started: true });
		expect((hum?.connected[0] as { name: string }).name).toBe("out");

		advance(30);
		pauseMusic(room, false);
		expect(nodes[1]?.started).toBe(true);
		expect(nodes[1]?.from).toBe(12.5);
		expect(musicPaused(room)).toBe(false);

		nodes[1]?.listeners.ended?.();
		expect(ended).toHaveBeenCalledTimes(1);
	});

	it("takes back a track it was still publishing when the music was stopped", async () => {
		stubAudio();
		const { room, publishTrack, unpublishTrack } = fakeRoom();
		let finish: (() => void) | undefined;
		const published = { source: "unknown", trackName: MUSIC.lossless, track: { name: "late" } };
		publishTrack.mockImplementationOnce(() => new Promise((resolve) => {
			finish = () => resolve(published as never);
		}));

		const playing = playLibraryTrack(room, { url: "/u", rate: 44_100 }, true, () => {}, () => {}, () => {});
		for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
		await stopMusic(room);
		finish?.();

		await expect(playing).rejects.toMatchObject({ name: "AbortError" });
		expect(unpublishTrack).toHaveBeenCalledWith(published.track, true);
		expect(nowPlaying(room)).toBeUndefined();
		expect(sendingLossless(room, MUSIC)).toBe(false);
	});

	it("stops playing, lets the context go and says nothing is playing when stopped", async () => {
		const { contexts, nodes } = stubAudio();
		const { room } = fakeRoom();
		const told = vi.fn();
		const unsubscribe = subscribePlaying(told);

		await playLibraryTrack(room, { url: "/u", rate: 48_000 }, true);
		await stopMusic(room);

		expect(nodes[0]?.stopped).toBe(true);
		expect(contexts[0]?.closed).toBe(true);
		expect(nowPlaying(room)).toBeUndefined();
		expect(sendingLossless(room, MUSIC)).toBe(false);
		expect(told).toHaveBeenCalled();
		unsubscribe();
	});

	it("stops by itself when the track ends and nobody is waiting", async () => {
		const { nodes } = stubAudio();
		const { room, unpublishTrack } = fakeRoom();

		await playLibraryTrack(room, { url: "/u", rate: 44_100 }, false);
		nodes[0]?.listeners.ended?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(unpublishTrack).toHaveBeenCalled();
		expect(nowPlaying(room)).toBeUndefined();
	});
});
