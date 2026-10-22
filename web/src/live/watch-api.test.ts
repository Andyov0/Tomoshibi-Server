import { afterEach, describe, expect, it, vi } from "vitest";
import {
	askAgain,
	browseMedia,
	knownInfo,
	mediaLink,
	mediaServers,
	readResolved,
	readTicket,
	rememberInfo,
	resolveVideo,
	searchMedia,
	watchReady,
} from "./watch-api";

/*
The watch gateway's answers, read defensively.

They come from a service the client never sees, through the server, and what
they name is played and fetched by this page: so an address that is not http,
a relay that is not this server's own relay path, or a YouTube id that is not
one is refused rather than used.

And a film from a media server is relayed for the person given that who chose
it, and only them. What the client owes that rule is small and easy to lose: to
say when it is reading a link for somebody else, to tell the two refusals that
name a person apart from a link that would not read, and to take whether a
ticket is relayed from each answer about it rather than once for the page.
*/

afterEach(() => {
	vi.unstubAllGlobals();
});

const good = {
	ticket: "Abc_def-1234567890xyz",
	title: "A film",
	duration: 213,
	cover: "https://i.example.invalid/c.jpg",
	link: "https://example.invalid/v",
	live: false,
	relay: false,
	play: { kind: "file", url: "https://cdn.example.invalid/v.mp4" },
	proxy: { kind: "file", url: "media?t=Abc_def-1234567890xyz" },
};

describe("a resolved video", () => {
	it("is read with its relay made a path on this server", () => {
		expect(readResolved(good)).toEqual({ ...good, proxy: { kind: "file", url: "/api/watch/media?t=Abc_def-1234567890xyz" } });
	});

	it("starts on the relay only when the gateway says so, and never because a field is missing", () => {
		expect(readResolved({ ...good, relay: true })?.relay).toBe(true);
		const { relay: _, ...without } = good;
		expect(readResolved(without)?.relay).toBe(false);
		expect(readResolved({ ...good, relay: "yes" })?.relay).toBe(false);
	});

	it("plays YouTube by id alone", () => {
		const found = readResolved({ ...good, play: { kind: "youtube", id: "dQw4w9WgXcQ", url: "https://x" } });
		expect(found?.play).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
	});

	it("is refused where it names something this page should not fetch or run", () => {
		for (const bad of [
			{ ...good, play: { kind: "file", url: "javascript:alert(1)" } },
			{ ...good, play: { kind: "file", url: "//evil.example.invalid/v.mp4" } },
			{ ...good, play: { kind: "youtube", id: "../../x" } },
			{ ...good, play: { kind: "flash", url: "https://x" } },
			{ ...good, proxy: { kind: "file", url: "https://evil.example.invalid/media?t=x" } },
			{ ...good, proxy: { kind: "file", url: "../admin?t=x" } },
			{ ...good, proxy: { kind: "file", url: "media?t=x&url=https://evil" } },
			{ ...good, proxy: { kind: "file", url: "media?t=Another_ticket_1234567" } },
			{ ...good, ticket: "short" },
		]) {
			expect(readResolved(bad as Record<string, unknown>)).toBeUndefined();
		}
	});

	it("drops a cover served over plain http, which the page could not show", () => {
		expect(readResolved({ ...good, cover: "http://i.example.invalid/c.jpg" })?.cover).toBe("");
	});
});

describe("asking the gateway", () => {
	const answer = (status: number, body: unknown = {}) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

	it("tells a link that is not a video from one that cannot be played from one that failed", async () => {
		vi.stubGlobal("fetch", answer(404, { error: "not_a_video" }));
		expect(await resolveVideo("hello")).toBe("not_a_video");
		vi.stubGlobal("fetch", answer(422, { error: "unavailable" }));
		expect(await resolveVideo("https://x")).toBe("unavailable");
		vi.stubGlobal("fetch", answer(502));
		expect(await resolveVideo("https://x")).toBe("failed");
		vi.stubGlobal("fetch", answer(200, good));
		expect(await resolveVideo("https://x")).toMatchObject({ title: "A film" });
	});

	it("reads why a video cannot be played where the gateway says, and anything else as only that it cannot", async () => {
		// A members' Bilibili episode, one under DRM, one not offered where the
		// deployment reads it, one Bilibili says is not there: each its own 422.
		for (const reason of ["members_only", "copy_protected", "region_locked", "not_found"]) {
			vi.stubGlobal("fetch", answer(422, { error: reason }));
			expect(await resolveVideo("https://www.bilibili.com/bangumi/play/ep508405")).toBe(reason);
		}
		// The server's own 422, a code this page does not know, and a body that
		// is not JSON are all a video that cannot be played here.
		for (const body of [{ error: "unavailable" }, { error: "<b>account_banned</b>" }, {}]) {
			vi.stubGlobal("fetch", answer(422, body));
			expect(await resolveVideo("https://x")).toBe("unavailable");
		}
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 422 })));
		expect(await resolveVideo("https://x")).toBe("unavailable");
		// The same codes on any other status are not read as these.
		for (const reason of ["members_only", "not_found"]) {
			vi.stubGlobal("fetch", answer(404, { error: reason }));
			expect(await resolveVideo("https://x")).toBe("not_a_video");
		}
	});

	it("says when it reads a link for somebody else, and only then", async () => {
		const fetched = answer(200, good);
		vi.stubGlobal("fetch", fetched);

		await resolveVideo("library:home/1a2b", { forOther: true });
		await resolveVideo("library:home/1a2b");

		const asked = (fetched.mock.calls as unknown as [string][]).map(([url]) => new URL(url, "https://meet.invalid").searchParams);
		expect(asked[0]?.get("for")).toBe("other");
		expect(asked[0]?.get("url")).toBe("library:home/1a2b");
		expect(asked[1]?.has("for")).toBe(false);
	});

	it("tells the two refusals of a person apart, and from anything else refused", async () => {
		vi.stubGlobal("fetch", answer(403, { error: "emby_not_allowed" }));
		expect(await resolveVideo("library:home/1a2b")).toBe("emby_not_allowed");
		vi.stubGlobal("fetch", answer(403, { error: "not_allowed" }));
		expect(await resolveVideo("https://x")).toBe("not_allowed");
		vi.stubGlobal("fetch", answer(403, { error: "something_else" }));
		expect(await resolveVideo("https://x")).toBe("failed");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 403 })));
		expect(await resolveVideo("https://x")).toBe("failed");
		vi.stubGlobal("fetch", answer(401, { error: "not_signed_in" }));
		expect(await resolveVideo("https://x")).toBe("failed");
	});

	it("reads no gateway, or nobody signed in, as not ready", async () => {
		vi.stubGlobal("fetch", answer(404));
		expect(await watchReady()).toBe(false);
		vi.stubGlobal("fetch", answer(401));
		expect(await watchReady()).toBe(false);
		vi.stubGlobal("fetch", answer(200, { ready: true }));
		expect(await watchReady()).toBe(true);
	});
});

describe("a video only the relay can play", () => {
	it("is read with no address of its own, and its poster from the relay", () => {
		const found = readResolved({ ...good, relay: true, play: { kind: "relay", url: "https://media.example.invalid/x?api_key=secret" }, cover: "media?t=Poster_ticket_12345678" });
		expect(found?.play).toEqual({ kind: "relay" });
		expect(found?.cover).toBe("/api/watch/media?t=Poster_ticket_12345678");
	});

	it("takes no poster from anywhere but the relay or the open web", () => {
		for (const cover of ["library?op=image&server=a&id=1", "../media?t=x", "javascript:x", "//evil.invalid/c.jpg", "media?t=x&y=z"]) {
			expect(readResolved({ ...good, cover })?.cover).toBe("");
		}
	});
});

/*
 * A Bilibili bangumi episode, which the deployment relays for everybody: its
 * whole, and anything above 720p, Bilibili hands only to a request carrying its
 * own Referer, so there is no address of its own for a page to fall back to.
 * Where the server relays it, every viewer plays the relay from the start, held
 * to the player's size (relay stays false, which is what keeps the cap on);
 * where it says it will not (X-Watch-Relay: off, the switch turned off), the
 * episode is a video that cannot be played here -- said when it is pasted, and
 * by every page that is handed its ticket.
 */
describe("a bangumi episode", () => {
	const episode = {
		...good,
		link: "https://www.bilibili.com/bangumi/play/ep508405",
		cover: "https://i0.hdslb.com/bfs/archive/ep508405.jpg",
		relay: false,
		play: { kind: "bangumi" },
		proxy: { kind: "hls", url: `media?t=${good.ticket}` },
	};

	it("is read with no address of its own, and the relay as where it plays", () => {
		const found = readResolved({ ...episode, play: { kind: "bangumi", url: "https://upos-sz.bilivideo.com/x.m4s" } });
		expect(found?.play).toEqual({ kind: "bangumi" });
		expect(found?.relay).toBe(false);
		expect(found?.proxy).toEqual({ kind: "hls", url: `/api/watch/media?t=${good.ticket}` });
		expect(found?.cover).toBe(episode.cover);
	});

	it("plays through the relay where the server relays it", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(episode), { status: 200 })));
		expect(await resolveVideo(episode.link)).toMatchObject({ play: { kind: "bangumi" }, proxy: { kind: "hls" } });
	});

	it("cannot be played here where the server says there is no relay for it", async () => {
		const off = { "X-Watch-Relay": "off" };
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(episode), { status: 200, headers: off })));
		expect(await resolveVideo(episode.link)).toBe("unavailable");

		const ticket = "Bangumi_switched_off_01";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ ...episode, ticket, proxy: { kind: "hls", url: `media?t=${ticket}` } }), { status: 200, headers: off })),
		);
		expect(await readTicket(ticket)).toBe("unavailable");
	});
});

/*
 * A ticket asked about again, by a player whose relay stopped partway through a
 * video that plays only through it (WatchScreen's halted). What the page learned
 * of a ticket is otherwise kept for the life of the page, which is what left
 * every viewer of an episode whose switch was turned off at its last frame,
 * with the page still sure it played. The server saying it will no longer relay
 * it replaces what the page knew; nothing else does -- not a ticket still
 * playable, whose player tries again, and not an answer that could not be read,
 * which is no reason to unlearn a video that was playing.
 */
describe("a ticket asked about again", () => {
	const episodeOf = (ticket: string) => ({
		...good,
		ticket,
		link: "https://www.bilibili.com/bangumi/play/ep508405",
		play: { kind: "bangumi" },
		proxy: { kind: "hls", url: `media?t=${ticket}` },
	});

	it("is asked of the server even where the page knows it, and unlearned only where the relay is off", async () => {
		const ticket = "Asked_again_ticket_0001";
		const read = readResolved(episodeOf(ticket));
		if (!read) throw new Error("the episode did not read");
		rememberInfo(read);
		const known = knownInfo(ticket);

		const fetched = vi.fn(async (url: string) => {
			expect(url).toBe(`/api/watch/info?t=${ticket}`);
			return new Response(JSON.stringify(episodeOf(ticket)), { status: 200 });
		});
		vi.stubGlobal("fetch", fetched);
		expect(await askAgain(ticket)).toMatchObject({ ticket, play: { kind: "bangumi" } });
		expect(fetched).toHaveBeenCalledTimes(1);
		expect(knownInfo(ticket)).toBe(known);

		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
		expect(await askAgain(ticket)).toBe("failed");
		expect(knownInfo(ticket)).toBe(known);

		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
		expect(await askAgain(ticket)).toBe("failed");
		expect(knownInfo(ticket)).toBe(known);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(episodeOf(ticket)), { status: 200, headers: { "X-Watch-Relay": "off" } })),
		);
		expect(await askAgain(ticket)).toBe("unavailable");
		expect(knownInfo(ticket)).toBe("unavailable");
	});

	it("is never asked about where it is not a ticket", async () => {
		const fetched = vi.fn();
		vi.stubGlobal("fetch", fetched);
		expect(await askAgain("https://evil.example.invalid/v.mp4")).toBe("failed");
		expect(fetched).not.toHaveBeenCalled();
	});
});

describe("a deployment that relays nothing", () => {
	const direct = (body: unknown) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "X-Watch-Relay": "off" } }));

	it("gives a video no relayed copy, never starts one on the relay, and shows no poster only the relay has", async () => {
		vi.stubGlobal("fetch", direct({ ...good, relay: true, cover: "media?t=Poster_ticket_12345678" }));
		const found = await resolveVideo("https://x");
		expect(found).toMatchObject({ title: "A film", relay: false, cover: "", proxy: undefined });
		expect(found).toMatchObject({ play: good.play });
	});

	it("refuses what only the relay could play when it is pasted, as a link that cannot be played", async () => {
		vi.stubGlobal("fetch", direct({ ...good, relay: true, play: { kind: "relay" } }));
		expect(await resolveVideo("library:home/1a2b")).toBe("unavailable");
	});

	it("still relays the one film it agreed to, whose answer alone does not say otherwise", async () => {
		const film = { ...good, relay: true, play: { kind: "relay" }, cover: "media?t=Poster_ticket_12345678" };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(film), { status: 200, headers: { "X-Watch-Grantor": "eeeeefffff" } })),
		);

		expect(await resolveVideo("library:home/1a2b")).toMatchObject({
			play: { kind: "relay" },
			relay: true,
			cover: "/api/watch/media?t=Poster_ticket_12345678",
			proxy: { kind: "file", url: `/api/watch/media?t=${good.ticket}` },
			// Whose choice it was, kept with what this page now knows of it, so
			// a show run here checks it as it checks a ticket handed over.
			grantor: "eeeeefffff",
		});
	});
});

describe("a ticket somebody else read", () => {
	const info = (ticket: string, body: unknown, headers: Record<string, string> = {}) =>
		vi.fn(async (url: string) => {
			expect(new URL(url, "https://meet.invalid").searchParams.get("t")).toBe(ticket);
			return new Response(JSON.stringify(body), { status: 200, headers });
		});

	// Each its own ticket: what a page learns of one is kept for the page.

	it("reads as what the server says it plays, relayed where the server relays it", async () => {
		const ticket = "Granted_film_ticket_001";
		vi.stubGlobal("fetch", info(ticket, { ...good, ticket, proxy: { kind: "hls", url: `media?t=${ticket}` }, relay: true, play: { kind: "relay" } }));

		expect(await readTicket(ticket)).toMatchObject({ ticket, play: { kind: "relay" }, proxy: { url: `/api/watch/media?t=${ticket}` } });
	});

	// Not "failed": a retry does not play a film whose grant was taken away,
	// and saying "try again" sent somebody retrying it.
	it("reads as unavailable where it is a film the server will not relay", async () => {
		const ticket = "Ungranted_film_ticket_02";
		vi.stubGlobal("fetch", info(ticket, { ...good, ticket, proxy: { kind: "hls", url: `media?t=${ticket}` }, relay: true, play: { kind: "relay" } }, { "X-Watch-Relay": "off" }));

		expect(await readTicket(ticket)).toBe("unavailable");
	});

	it("reads as nothing, not unavailable, where the answer is about another ticket or unreadable", async () => {
		const ticket = "Other_answer_ticket_0007";
		vi.stubGlobal(
			"fetch",
			info(ticket, { ...good, ticket: "Someone_elses_ticket_08", proxy: { kind: "hls", url: "media?t=Someone_elses_ticket_08" }, play: { kind: "bangumi" } }, { "X-Watch-Relay": "off" }),
		);
		expect(await readTicket(ticket)).toBe("failed");

		const garbled = "Garbled_answer_ticket_09";
		vi.stubGlobal("fetch", info(garbled, { ...good, ticket: garbled, play: { kind: "bangumi" } }, { "X-Watch-Relay": "off" }));
		expect(await readTicket(garbled)).toBe("failed");
	});

	it("reads as nothing where it has expired, and is never asked about where it is not a ticket", async () => {
		const ticket = "Expired_film_ticket_0003";
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 410 })));
		expect(await readTicket(ticket)).toBe("failed");

		const fetched = vi.fn();
		vi.stubGlobal("fetch", fetched);
		expect(await readTicket("https://evil.example.invalid/v.mp4")).toBe("failed");
		expect(fetched).not.toHaveBeenCalled();
	});

	// The holder of a show queues a relayed film only from whoever's grant it
	// is (Theatre.addTicket), and this is where it learns whose.
	it("names whose grant a relayed film is under, as the server said it", async () => {
		const ticket = "Grantor_film_ticket_005";
		vi.stubGlobal(
			"fetch",
			info(
				ticket,
				{ ...good, ticket, proxy: { kind: "hls", url: `media?t=${ticket}` }, relay: true, play: { kind: "relay" } },
				{ "X-Watch-Grantor": "eeeeefffff" },
			),
		);

		expect(await readTicket(ticket)).toMatchObject({ ticket, grantor: "eeeeefffff" });
	});

	it("names nobody for a ticket the server said nothing about", async () => {
		const ticket = "Nobodys_film_ticket_006";
		vi.stubGlobal("fetch", info(ticket, { ...good, ticket, proxy: { kind: "file", url: `media?t=${ticket}` } }));

		const read = await readTicket(ticket);
		expect(typeof read !== "string" && read.grantor).toBeFalsy();
	});

	it("is asked about once, however many times it is read", async () => {
		const ticket = "Asked_once_ticket_00004";
		const fetched = info(ticket, { ...good, ticket, proxy: { kind: "file", url: `media?t=${ticket}` } });
		vi.stubGlobal("fetch", fetched);

		const [first, second] = await Promise.all([readTicket(ticket), readTicket(ticket)]);
		expect(first).toBe(second);
		expect(await readTicket(ticket)).toBe(first);
		expect(fetched).toHaveBeenCalledTimes(1);
	});
});

describe("the media servers", () => {
	const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

	it("are listed by key, and a key that is not one is dropped", async () => {
		vi.stubGlobal("fetch", answer({ servers: [{ key: "home", name: "Home" }, { key: "../x", name: "Bad" }] }));
		expect(await mediaServers()).toEqual([{ key: "home", name: "Home" }]);
	});

	it("are none where there is no gateway or nobody signed in", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
		expect(await mediaServers()).toEqual([]);
	});

	it("give items whose ids and posters are what the gateway makes, and nothing else", async () => {
		vi.stubGlobal("fetch", answer({ items: [
			{ id: "1a2b", name: "Film", type: "Movie", folder: false, playable: true, year: 2020, duration: 5400, image: "library?op=image&server=home&id=1a2b&tag=abc" },
			{ id: "3c", name: "Odd poster", image: "https://evil.invalid/p.jpg" },
			{ id: "not-hex!", name: "Bad id" },
		] }));
		const found = await browseMedia("home");
		expect(found?.map((one) => one.id)).toEqual(["1a2b", "3c"]);
		expect(found?.[0]?.image).toBe("/api/watch/library?op=image&server=home&id=1a2b&tag=abc");
		expect(found?.[1]?.image).toBe("");
	});

	it("is undefined, not empty, when the server did not answer", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
		expect(await searchMedia("home", "x")).toBeUndefined();
	});

	it("names an item to play the way the gateway reads it", () => {
		expect(mediaLink("home", "1a2b")).toBe("library:home/1a2b");
	});
});

