/**
 * What this guards is a request nobody in this repository writes.
 *
 * livekit-client sends an HTTPS GET to `/rtc/validate` whenever a signalling
 * WebSocket fails to open, to phrase a better error. Every other HTTPS request
 * to a relay has been removed from this project, because a relay in mainland
 * China is blocked by exactly that shape of request arriving from a probe, and
 * a deployment that serves one continuously is supplying the evidence itself.
 *
 * The failure this catches is the guard quietly stopping to work: an SDK
 * upgrade renaming the path, or the predicate being widened until it swallows
 * an ordinary API call. The first would put the request back with nothing said,
 * and the second would break the application in a way that looks like a network
 * fault. So both directions are asserted — the probe is answered locally, and
 * everything else reaches the real fetch untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installNoValidate, isValidationProbe, uninstallNoValidate } from "./novalidate";

describe("the validation probe", () => {
	it("recognises both signalling paths the SDK uses", () => {
		// It picks between them by what the server supports, and falls back from
		// one to the other mid-connection, so neither spelling is optional.
		expect(isValidationProbe("https://gz.relay.example:13377/rtc/validate")).toBe(true);
		expect(isValidationProbe("https://gz.relay.example:13377/rtc/v1/validate")).toBe(true);
	});

	it("recognises it with the access token attached", () => {
		// The real one carries the token in the query string, which is most of
		// why it should not be leaving the browser.
		expect(
			isValidationProbe("https://gz.relay.example:13377/rtc/v1/validate?access_token=ey.a.b"),
		).toBe(true);
	});

	it("leaves this application's own requests alone", () => {
		for (const url of [
			"/api/relays",
			"/api/deployment",
			"/api/rooms/empty-archer-shape-0962/join",
			"/api/health",
			"https://live.example/admin/rooms",
			// Near misses, which is where a widened predicate would show up.
			"https://gz.relay.example:13377/rtc",
			"https://gz.relay.example:13377/rtc/v1",
			"https://live.example/validate",
		]) {
			expect(isValidationProbe(url), url).toBe(false);
		}
	});
});

describe("the guard over fetch", () => {
	let original: typeof globalThis.fetch;

	beforeEach(() => {
		original = globalThis.fetch;
	});

	afterEach(() => {
		uninstallNoValidate(original);
	});

	it("answers the probe without touching the network", async () => {
		const network = vi.fn();
		globalThis.fetch = network as unknown as typeof globalThis.fetch;

		installNoValidate();

		const response = await globalThis.fetch(
			"https://gz.relay.example:13377/rtc/v1/validate?access_token=ey.a.b",
		);

		expect(network).not.toHaveBeenCalled();

		// Not 404, 401 or 403. Those three are the statuses the SDK replaces the
		// error with a more specific one for; anything else leaves it reporting
		// the WebSocket failure it already had, which is the true reason.
		expect(response.status).toBe(204);
	});

	it("passes everything else through unchanged", async () => {
		const network = vi.fn(async () => new Response("{}", { status: 200 }));
		globalThis.fetch = network as unknown as typeof globalThis.fetch;

		installNoValidate();

		await globalThis.fetch("/api/relays");

		expect(network).toHaveBeenCalledTimes(1);
	});

	it("does not wrap itself when installed twice", async () => {
		const network = vi.fn(async () => new Response("{}", { status: 200 }));
		globalThis.fetch = network as unknown as typeof globalThis.fetch;

		installNoValidate();
		const once = globalThis.fetch;
		installNoValidate();

		expect(globalThis.fetch).toBe(once);
	});
});
