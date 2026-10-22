import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

/*
 * What this guards is a refusal that reaches the page as a status code.
 *
 * The server sends a code and this file owns the sentence, so a code with no
 * case here is shown as "The server refused the request. (HTTP 400)" — which
 * is what a malformed change to an account said for as long as the accounts and
 * the roster answered "unreadable" and only "unreadable_request" was mapped.
 * The codes below are the ones the permission boxes and the finer roles brought
 * with them, plus that one: each is a press somebody makes on purpose and is
 * then told nothing useful about, unless its sentence is here.
 */

function refusing(status: number, error: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ error }), { status })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a refusal from the management API", () => {
	it.each([
		[403, "not_allowed", "Your administrator role does not cover this."],
		[
			403,
			"emby_needs_moderate",
			"Only an administrator who can manage everything can give or take away Emby, or set the passphrase of somebody who has it.",
		],
		[
			400,
			"unknown_permission",
			"That is not a permission this server knows. It may be running an older version.",
		],
		[
			400,
			"unknown_capability",
			"That is not a role this server knows. It may be running an older version.",
		],
		[400, "unreadable", "The request could not be read."],
	])("%i %s is said as a sentence", async (status, code, sentence) => {
		refusing(status, code);

		await expect(api.changeAccount("ada", { perms: { emby: true } })).rejects.toThrow(sentence);
	});
});

/*
 * Each relay switch is its own request, naming that switch and nothing else.
 *
 * The server changes only what a request names, so a body that named the
 * wrong switch would move somebody else's -- pressing "Relay no bangumi" would
 * turn YouTube's relay off and leave every episode relayed -- and the radio
 * would then read the switch it did move as the one pressed. The card's own
 * test holds which call each radio makes; this holds what each call sends.
 */
describe("the relay switches", () => {
	it.each([
		["setEmbyRelay", "embyRelay"],
		["setYouTubeRelay", "youtubeRelay"],
		["setBangumiRelay", "bangumiRelay"],
	] as const)("%s sends %s alone", async (call, field) => {
		const sent = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
		vi.stubGlobal("fetch", sent);

		await api[call](false);

		const [url, init] = sent.mock.calls[0] ?? [];
		expect(url).toMatch(/\/settings$/);
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual({ [field]: false });
	});
});
