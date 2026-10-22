import { describe, expect, it } from "vitest";
import { askEvery, whenSaid } from "./meeting";

/*
 * Two things about arranged meetings that fail silently.
 *
 * Saying when: Intl refuses `dateStyle` beside `timeZoneName` by throwing, and
 * the throw was inside a render — the lobby went blank the moment a meeting was
 * arranged, with the link unread. Node's Intl throws the same, so this is the
 * cheap way to keep the combination out.
 *
 * Asking how often: a link opened an hour early is a tab left open, and a tab
 * asking every three seconds for an hour is twelve hundred requests for an
 * answer that cannot change yet. Thirty people behind one office address doing
 * that would trip the rate limit for all of them.
 */
describe("saying when a meeting is", () => {
	it("does not throw, and says the year and the zone", () => {
		const said = whenSaid("2026-09-02T08:44:00.000Z");

		expect(said).toMatch(/2026/);
		// A zone, said: an abbreviation, or an offset where the locale has none.
		expect(said).toMatch(/GMT|UTC|[A-Z]{2,5}|[+-]\d{1,2}(:\d{2})?/);
	});
});

describe("how often to ask", () => {
	const at = "2026-09-02T10:00:00.000Z";
	const t = new Date(at).getTime();

	it("is slow while the meeting is far off", () => {
		expect(askEvery(at, t - 60 * 60_000)).toBe(30_000);
		expect(askEvery(at, t - 11 * 60_000)).toBe(30_000);
	});

	it("is quick inside the last ten minutes, and after the time", () => {
		expect(askEvery(at, t - 9 * 60_000)).toBe(3_000);
		expect(askEvery(at, t)).toBe(3_000);
		expect(askEvery(at, t + 30 * 60_000)).toBe(3_000);
	});
});
