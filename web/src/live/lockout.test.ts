import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { lockedUntil, minutesLeft, shutOutFor } from "./lockout";

/*
 * What somebody shut out of signing in is told, and how long it says.
 *
 * The failure this guards is the sentence saying less time than is left —
 * "try again in a minute" about twenty-nine of them — which sends somebody
 * back to a door that is still shut, and every attempt they make there is
 * another refusal. So the minutes round up, never down, and never to nought.
 */

const now = Date.parse("2026-11-01T12:00:00Z");
const after = (seconds: number) => new Date(now + seconds * 1000).toISOString();

afterEach(() => setLocale("en"));

describe("the minutes a lockout has left", () => {
	it.each([
		[30 * 60, 30],
		[29 * 60 + 1, 30],
		[29 * 60, 29],
		[61, 2],
		[60, 1],
		[1, 1],
		[0, 1],
		[-30, 1],
	])("%i seconds is %i minutes", (seconds, minutes) => {
		expect(minutesLeft(after(seconds), now)).toBe(minutes);
	});
});

describe("the sentence", () => {
	it("says the minutes, and the singular for the last one", () => {
		expect(shutOutFor(after(25 * 60), now)).toBe("Too many failed sign-ins. Try again in 25 minutes.");
		expect(shutOutFor(after(40), now)).toBe("Too many failed sign-ins. Try again in a minute.");
	});

	it("is said in every language", () => {
		setLocale("zh-Hans");
		expect(shutOutFor(after(25 * 60), now)).toBe("登录失败次数太多，请 25 分钟后再试。");

		setLocale("zh-Hant");
		expect(shutOutFor(after(25 * 60), now)).toBe("登入失敗次數太多，請 25 分鐘後再試。");

		setLocale("ja");
		expect(shutOutFor(after(25 * 60), now)).toBe("サインインの失敗が多すぎます。25 分後にもう一度お試しください。");
	});
});

describe("a refusal that names a lockout", () => {
	it("is a 429 saying until, and nothing else is", async () => {
		const until = after(600);

		expect(await lockedUntil(new Response(JSON.stringify({ error: "rate_limited", until }), { status: 429 }))).toBe(until);

		// The guessing budget's own refusal names no end.
		expect(await lockedUntil(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }))).toBeUndefined();
		expect(await lockedUntil(new Response(JSON.stringify({ error: "not_yours", until }), { status: 401 }))).toBeUndefined();
		expect(await lockedUntil(new Response("not json", { status: 429 }))).toBeUndefined();
	});

	it("leaves the answer readable by whoever reads it next", async () => {
		const response = new Response(JSON.stringify({ error: "rate_limited", until: after(60) }), { status: 429 });

		await lockedUntil(response);

		expect(((await response.json()) as { error: string }).error).toBe("rate_limited");
	});
});
