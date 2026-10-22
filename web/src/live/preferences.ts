import { keep, recall } from "@/lib/storage";
import type { Room } from "livekit-client";
import type { Quality } from "./music";

/*
 * Choices somebody makes once and expects to find made, in this browser.
 *
 * Each of these used to be written from one place only — the devices from the
 * join button, the music quality from the music panel, blur from the switch in
 * the room — and read wherever it was needed. The account page is now a second
 * place to make them, ahead of any call, and it is its own document with its
 * own bundle. The modules the keys used to live in carry a call with them: the
 * join screen, the music panel, and blur.ts, which imports the segmentation
 * runtime. A page with three checkboxes on it should not load a video model to
 * learn which key the third one writes. So the reading and writing is here, and
 * each of those modules uses it, so that one key has one spelling and one way of
 * reading garbage back.
 *
 * The keys still say the name this was called before, on purpose: they are what
 * browsers already have written down, and a key renamed is a setting abandoned.
 *
 * Every reader treats a value it does not recognise as never having been told
 * anything, and answers with the default. A value can be half written, written
 * by a later build, or typed into the console, and none of those may be a call
 * that starts with a hidden control or a silent microphone.
 *
 * Nothing here goes to the server. These are about this machine — which camera
 * is plugged in, how much of a line it has to spare — and somebody signing in on
 * another one is better served by that machine's defaults than by this one's
 * guesses.
 */

// ---------------------------------------------------------------------------
// What is switched on when somebody joins.

const DEVICES_KEY = "meet-live.devices";

/** Whether the camera and the microphone start on. */
export interface Joining {
	camera: boolean;
	microphone: boolean;
}

/**
 * What was chosen last time, or the defaults on a first visit: the microphone
 * on and the camera off, which is how most people walk into a call and the
 * cheaper of the two mistakes. A camera nobody expected to be on is the worse
 * surprise.
 *
 * Read by the join screen, and by a reload going straight back into a call:
 * somebody rejoining after a refresh has made these two decisions already and
 * should not be asked again.
 */
export function rememberedDevices(): Joining {
	const fallback: Joining = { camera: false, microphone: true };

	try {
		const stored = recall(DEVICES_KEY);
		if (!stored) return fallback;

		const parsed = JSON.parse(stored) as unknown;
		if (typeof parsed !== "object" || parsed === null) return fallback;

		const { camera, microphone } = parsed as Record<string, unknown>;

		// Each on its own: a record that lost one half keeps the other.
		return {
			camera: typeof camera === "boolean" ? camera : fallback.camera,
			microphone: typeof microphone === "boolean" ? microphone : fallback.microphone,
		};
	} catch {
		return fallback;
	}
}

export function rememberDevices(devices: Joining): void {
	keep(DEVICES_KEY, JSON.stringify({ camera: devices.camera, microphone: devices.microphone }));
}

// ---------------------------------------------------------------------------
// Blurring what is behind somebody.

const BLUR_KEY = "meet-live.blur";

/** Whether this browser was asked to blur, so it does not have to be asked again. */
export function blurWanted(): boolean {
	return recall(BLUR_KEY) === "on";
}

export function rememberBlur(on: boolean): void {
	keep(BLUR_KEY, on ? "on" : undefined);
}

// ---------------------------------------------------------------------------
// How music from a library is fetched.

const MUSIC_QUALITY_KEY = "meet-live.music-quality";

/** The two qualities somebody chooses between. Lossy is the library's answer, never a choice. */
export type MusicQuality = Extract<Quality, "best" | "lossless">;

/**
 * Lossless by default, and the highest tier only when asked for.
 *
 * The highest is a master where there is one -- 24-bit at 192 kHz on one of the
 * libraries this was built against -- which is two hundred megabytes to fetch,
 * four hundred to hold decoded, and several megabits a second to every listener.
 * A 24-bit file at the CD's rate is lossless and a tenth of that.
 */
export function rememberedMusicQuality(): MusicQuality {
	return recall(MUSIC_QUALITY_KEY) === "best" ? "best" : "lossless";
}

export function rememberMusicQuality(quality: MusicQuality): void {
	keep(MUSIC_QUALITY_KEY, quality === "best" ? "best" : undefined);
}

// ---------------------------------------------------------------------------
// How sharp a video watched together may get, on this screen.

const WATCH_QUALITY_KEY = "meet-live.watch-quality";

/** The ceilings offered, from none to the lowest. */
export const WATCH_QUALITIES = ["auto", "1080p", "720p"] as const;
export type WatchQuality = (typeof WATCH_QUALITIES)[number];

/** The picture height each ceiling allows. */
const LINES: Record<Exclude<WatchQuality, "auto">, number> = {
	"1080p": 1080,
	"720p": 720,
};

/**
 * The ceiling this viewer chose, or none.
 *
 * A ceiling and not a choice of quality, because what plays is still decided
 * by the line: somebody on a slow connection who said 1080p gets whatever their
 * connection carries, and somebody who said 720p never gets more than that
 * however fast it is. It exists for the second person — on a metered phone, or
 * sharing a line with the rest of a household — for whom "as sharp as it will
 * go" is the wrong goal.
 */
export function watchQuality(): WatchQuality {
	const stored = recall(WATCH_QUALITY_KEY);
	return WATCH_QUALITIES.find((one) => one === stored) ?? "auto";
}

export function rememberWatchQuality(quality: WatchQuality): void {
	keep(WATCH_QUALITY_KEY, quality === "auto" ? undefined : quality);
}

/** As much of a playlist's level as this needs, so a test can describe one in a line. */
export interface LevelSize {
	width?: number;
	height: number;
}

/**
 * The highest level a ceiling allows, as an index into the playlist's levels,
 * or -1 for no ceiling at all — the value hls.js itself uses for one.
 *
 * An index and not a size because that is what the player takes: it allows
 * every level up to the one named. It orders levels by bitrate, which is nearly
 * always by size as well; where it is not, the ceiling stops below the first
 * level that is too tall, so that nothing taller is let through by sitting
 * later in the list.
 *
 * Measured on the shorter side, so that "1080p" means what people mean by it
 * whatever the shape: a film cropped to 1920×800 is a 1080p film, and a 4K one
 * cropped to 3840×1600 is not. A level that does not say its size — audio only,
 * or a playlist that left it out — is allowed, because refusing it could leave
 * nothing to play.
 *
 * Eight lines of slack because encoders round a picture up to whole sixteen-
 * pixel blocks, and a 1080p stream that says 1088 is still the one asked for.
 *
 * Where even the first level is above the ceiling, that one is allowed:
 * somebody who asked for less is better served by the least there is than by
 * a player with nothing it may play.
 */
export function levelCap(levels: readonly LevelSize[], quality: WatchQuality): number {
	if (quality === "auto") return -1;

	const most = LINES[quality] + 8;
	const tooTall = levels.findIndex((level) => {
		const side = level.width ? Math.min(level.width, level.height) : level.height;
		return side > most;
	});

	if (tooTall === -1) return -1;

	return Math.max(0, tooTall - 1);
}

/**
 * What the player's ceiling should be, given what it is now.
 *
 * Lowered to the viewer's, never raised. The player may already be holding the
 * picture below it for its own reasons — sized to the tile it is drawn in, on a
 * relay this page fell back to — and that ceiling is the deployment's bandwidth,
 * which this choice is only allowed to save more of.
 */
export function capping(current: number, levels: readonly LevelSize[], quality: WatchQuality): number {
	const most = levelCap(levels, quality);
	if (most < 0) return current;

	return current < 0 || current > most ? most : current;
}

// ---------------------------------------------------------------------------
// Which microphone, camera and speakers.

const CHOICE_KEY = "meet-live.device-choice";

/** The kinds of device somebody picks from a list in the room. */
export const CHOSEN_KINDS = ["audioinput", "videoinput", "audiooutput"] as const;
export type ChosenKind = (typeof CHOSEN_KINDS)[number];
export type DeviceChoice = Partial<Record<ChosenKind, string>>;

/** Longer than any browser's device identifier, and short enough to refuse what is not one. */
const MOST_ID = 256;

/**
 * The devices last picked in a call, by kind.
 *
 * Only this browser's, and that is not a limitation to work round: a device's
 * identifier is made up per site and per browser profile, so the same headset
 * is a different string in another browser and means nothing on another
 * machine.
 */
export function deviceChoice(): DeviceChoice {
	try {
		const stored = recall(CHOICE_KEY);
		if (!stored) return {};

		const parsed = JSON.parse(stored) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

		const choice: DeviceChoice = {};

		for (const kind of CHOSEN_KINDS) {
			const id = (parsed as Record<string, unknown>)[kind];
			if (typeof id === "string" && id !== "" && id.length <= MOST_ID) choice[kind] = id;
		}

		return choice;
	} catch {
		return {};
	}
}

export function rememberDeviceChoice(kind: ChosenKind, deviceId: string): void {
	if (!deviceId || deviceId.length > MOST_ID) return;

	keep(CHOICE_KEY, JSON.stringify({ ...deviceChoice(), [kind]: deviceId }));
}

export function forgetDeviceChoice(): void {
	keep(CHOICE_KEY, undefined);
}

/**
 * Which of the remembered devices can be asked for, given what the browser
 * lists now.
 *
 * One that is listed, certainly. One whose kind is listed with real identifiers
 * that do not include it is unplugged, or gone, and asking for it would at best
 * be refused and at worst be a camera that fails to start — so the browser's
 * own default stands, and the choice stays written down for the day the headset
 * comes back.
 *
 * And one whose kind is listed with its identifiers blanked, which is what a
 * browser does before it has been given a microphone or a camera on this site.
 * There is nothing to compare against, and the request is made anyway: it asks
 * for the device as a preference rather than a requirement, so a browser that
 * has it uses it and one that does not falls back to its default by itself. A
 * check that skipped these would forget the choice on exactly the visits where
 * permission is asked afresh, which in some browsers is every visit.
 */
export function restorable(
	choice: DeviceChoice,
	present: readonly Pick<MediaDeviceInfo, "kind" | "deviceId">[],
): [ChosenKind, string][] {
	const out: [ChosenKind, string][] = [];

	for (const kind of CHOSEN_KINDS) {
		const id = choice[kind];
		if (!id) continue;

		const listed = present.filter((device) => device.kind === kind);
		if (listed.length === 0) continue;

		const hidden = listed.every((device) => device.deviceId === "");
		if (hidden || listed.some((device) => device.deviceId === id)) out.push([kind, id]);
	}

	return out;
}

/** The remembered devices that can be asked for now. */
export async function usableDeviceChoice(): Promise<DeviceChoice> {
	const choice = deviceChoice();
	if (Object.keys(choice).length === 0) return {};

	try {
		return Object.fromEntries(restorable(choice, await navigator.mediaDevices.enumerateDevices()));
	} catch {
		// No device list at all, which is a browser without media devices or one
		// refusing to say. Nothing remembered is asked for.
		return {};
	}
}

/**
 * Point a room at the remembered devices, before its microphone and camera are
 * started.
 *
 * Through the room's own switch rather than its capture options, because the
 * switch is what the device menu uses, and the two must agree on what "the
 * chosen microphone" means — the menu ticks whatever the room says is active.
 * Asked for as a preference (the third argument), so that a device unplugged
 * between the check above and the capture falls back to the default instead of
 * failing the microphone for the length of the call.
 *
 * Never throws. A speaker that cannot be chosen — Safari cannot choose one at
 * all — leaves sound where it was, which is where it went before this existed.
 */
export async function restoreDevices(room: Pick<Room, "switchActiveDevice">): Promise<void> {
	const usable = await usableDeviceChoice();

	for (const kind of CHOSEN_KINDS) {
		const id = usable[kind];
		if (!id) continue;

		try {
			await room.switchActiveDevice(kind, id, false);
		} catch {
			// The default stands.
		}
	}
}
