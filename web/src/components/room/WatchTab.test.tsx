import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/live/i18n";
import { type Refusal, TOPIC, closeTheatre, hearShows, myTheatre } from "@/live/watch";
import type { Resolved } from "@/live/watch-api";
import { addVideo, refusal } from "./WatchTab";

/*
Adding a video, from the panel.

What matters is whose browser reads the link, because that is whose choice the
server takes it to be, and a film from a media server is relayed under the
chooser's grant and nobody else's. Somebody who may read links reads their own,
in somebody else's show as much as their own, and hands over only the ticket;
somebody who may not hands over the link, for the holder to read on their
behalf. Got wrong, a granted person's choice in a friend's show is refused, or
read with the friend's session -- and nothing on the screen says which.
*/

const resolveVideo = vi.fn();
const readTicket = vi.fn();
const actionFailed = vi.fn();

vi.mock("@/live/watch-api", async (original) => {
	const real = await original<typeof import("@/live/watch-api")>();
	return {
		...real,
		resolveVideo: (...args: unknown[]) => resolveVideo(...args),
		readTicket: (...args: unknown[]) => readTicket(...args),
	};
});

vi.mock("@/live/notices", () => ({
	actionFailed: (...args: unknown[]) => actionFailed(...args),
}));

type Handler = (...args: unknown[]) => void;

function fakeRoom(others: string[] = ["gholder-2"]) {
	const handlers = new Map<string, Set<Handler>>();
	const sent: { message: Record<string, unknown>; to?: string[] }[] = [];
	const remoteParticipants = new Map(others.map((id) => [id, { identity: id, name: id.toUpperCase() }]));

	const room = {
		options: {},
		remoteParticipants,
		localParticipant: {
			identity: "tme-1",
			name: "Me",
			publishData: vi.fn(async (bytes: Uint8Array, opts: { destinationIdentities?: string[] }) => {
				sent.push({ message: JSON.parse(new TextDecoder().decode(bytes)), to: opts.destinationIdentities });
			}),
		},
		on(event: string, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
		},
		off(event: string, handler: Handler) {
			handlers.get(event)?.delete(handler);
		},
	};

	const send = (identity: string, message: unknown) => {
		for (const handler of handlers.get("dataReceived") ?? []) {
			handler(new TextEncoder().encode(JSON.stringify(message)), remoteParticipants.get(identity), 0, TOPIC);
		}
	};

	return { room: room as unknown as Room, sent, send };
}

const film: Resolved = {
	ticket: "Chosen_film_ticket_0001",
	title: "A film",
	duration: 5400,
	cover: "/api/watch/media?t=Poster_ticket_12345678",
	link: "library:home/1a2b",
	live: false,
	relay: true,
	play: { kind: "relay" },
	proxy: { kind: "hls", url: "/api/watch/media?t=Chosen_film_ticket_0001" },
};

/** A show somebody else runs, as this page heard it. */
function theirShow(send: (identity: string, message: unknown) => void) {
	send("gholder-2", {
		t: "state",
		show: { holder: "gholder-2", holderName: "Holder", queue: [], playing: false, position: 0, version: 1 },
	});
}

let stops: (() => void)[] = [];

beforeEach(() => {
	resolveVideo.mockReset().mockResolvedValue(film);
	readTicket.mockReset().mockResolvedValue(film);
	actionFailed.mockReset();
});

afterEach(() => {
	for (const stop of stops) stop();
	stops = [];
});

describe("in somebody else's show", () => {
	it("reads a choice here, as this person's own, and hands over only its ticket", async () => {
		const { room, sent, send } = fakeRoom();
		stops.push(hearShows(room));
		theirShow(send);

		expect(await addVideo(room, "library:home/1a2b", true, t)).toBe(true);

		expect(resolveVideo).toHaveBeenCalledTimes(1);
		expect(resolveVideo.mock.calls[0]?.[0]).toBe("library:home/1a2b");
		expect(resolveVideo.mock.calls[0]?.[1]?.forOther).toBeFalsy();
		// A media server's film without its link: an older holder would read
		// the link with its own session, as its own choice on its own grant.
		expect(sent.at(-1)).toEqual({ message: { t: "add", ticket: film.ticket }, to: ["gholder-2"] });
	});

	// A holder whose page predates tickets reads the link and nothing else, and
	// a call outlives an upgrade of the server its pages come from. Handed a
	// ticket alone, such a holder read "undefined" and said every link was not
	// a video.
	it("sends the link beside the ticket, for a holder that reads only links", async () => {
		const { room, sent, send } = fakeRoom();
		stops.push(hearShows(room));
		theirShow(send);
		const clip: Resolved = {
			...film,
			ticket: "Youtube_clip_ticket_0001",
			link: "https://youtu.be/dQw4w9WgXcQ",
			relay: false,
			play: { kind: "youtube", id: "dQw4w9WgXcQ" },
		};
		resolveVideo.mockResolvedValue(clip);

		expect(await addVideo(room, "https://youtu.be/dQw4w9WgXcQ", true, t)).toBe(true);

		const message = sent.at(-1)?.message as { t: string; ticket?: string; text?: unknown };
		expect(message).toEqual({ t: "add", ticket: clip.ticket, text: "https://youtu.be/dQw4w9WgXcQ" });

		// What such a holder did with it: String(message.text), resolved.
		expect(String(message.text)).toBe("https://youtu.be/dQw4w9WgXcQ");
	});

	it("hands the link itself to whoever runs it, from somebody who may not read one", async () => {
		const { room, sent, send } = fakeRoom();
		stops.push(hearShows(room));
		theirShow(send);

		expect(await addVideo(room, "https://example.invalid/v", false, t)).toBe(true);

		expect(resolveVideo).not.toHaveBeenCalled();
		expect(sent.at(-1)).toEqual({ message: { t: "add", text: "https://example.invalid/v" }, to: ["gholder-2"] });
	});

	it("says here why its own choice was refused, and sends nothing", async () => {
		const { room, sent, send } = fakeRoom();
		stops.push(hearShows(room));
		theirShow(send);
		const before = sent.length;
		resolveVideo.mockResolvedValue("emby_not_allowed");

		expect(await addVideo(room, "library:home/1a2b", true, t)).toBe(false);

		expect(actionFailed).toHaveBeenCalledWith("The media servers have not been opened to you.");
		expect(sent.length).toBe(before);
	});

	it("starts a show with what it read, where the one it was for ended while it read", async () => {
		const { room, send } = fakeRoom();
		stops.push(hearShows(room));
		theirShow(send);
		resolveVideo.mockImplementation(async () => {
			send("gholder-2", { t: "closed" });
			return film;
		});

		expect(await addVideo(room, "library:home/1a2b", true, t)).toBe(true);

		expect(resolveVideo).toHaveBeenCalledTimes(1);
		expect(readTicket).toHaveBeenCalledWith(film.ticket);
		expect(myTheatre(room)?.state().now?.ticket).toBe(film.ticket);
		closeTheatre(room);
	});
});

it("reads a link as its own where it starts the show", async () => {
	const { room } = fakeRoom([]);

	expect(await addVideo(room, "library:home/1a2b", true, t)).toBe(true);

	expect(resolveVideo).toHaveBeenCalledWith("library:home/1a2b", { forOther: false });
	expect(myTheatre(room)?.state().now?.ticket).toBe(film.ticket);
	closeTheatre(room);
});

it("says each refusal as its own sentence, so none of them reads as a link that would not load", () => {
	const all: Refusal[] = [
		"not_a_video",
		"unavailable",
		"members_only",
		"copy_protected",
		"region_locked",
		"not_found",
		"not_allowed",
		"emby_not_allowed",
		"failed",
	];

	expect(new Set(all.map(refusal)).size).toBe(all.length);
	expect(refusal("not_allowed")).toBe("Watching together has not been opened to you.");
	expect(refusal("emby_not_allowed")).toBe("The media servers have not been opened to you.");
});
