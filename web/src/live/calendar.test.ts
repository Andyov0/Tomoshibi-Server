import { describe, expect, it } from "vitest";
import { icsFor } from "./calendar";
import type { Arrangement } from "./meeting";

/*
 * That the file a calendar is handed is one a calendar will read.
 *
 * The parts that go wrong silently: a line over seventy-five octets, which
 * some calendars refuse whole; a multi-byte character cut in half by a fold
 * counted in characters; a comma or semicolon in a name, which unescaped ends
 * the property; a time written in local time and read as UTC; and an id that
 * changes between exports of the same meeting, which makes two events of one.
 */

const meeting: Arrangement = {
	id: "abc123",
	room: "standup",
	at: "2026-09-05T02:15:00.000Z",
	started: false,
	ended: false,
};

const link = "https://live.example/?meeting=tok#/standup";

function unfold(ics: string): string[] {
	return ics
		.split("\r\n")
		.filter((l) => l.length > 0)
		.reduce<string[]>((lines, l) => {
			if (l.startsWith(" ") && lines.length) lines[lines.length - 1] += l.slice(1);
			else lines.push(l);
			return lines;
		}, []);
}

describe("the calendar file", () => {
	it("is a VCALENDAR with one VEVENT, in CRLF", () => {
		const ics = icsFor(meeting, link, new Date("2026-09-01T00:00:00Z"));

		expect(ics.endsWith("\r\n")).toBe(true);
		expect(ics.includes("\n") && !ics.includes("\r\n")).toBe(false);

		const lines = unfold(ics);
		expect(lines[0]).toBe("BEGIN:VCALENDAR");
		expect(lines).toContain("VERSION:2.0");
		expect(lines.some((l) => l.startsWith("PRODID:"))).toBe(true);
		expect(lines).toContain("BEGIN:VEVENT");
		expect(lines).toContain("END:VEVENT");
		expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
	});

	it("writes the arranged time in UTC, and no end", () => {
		const lines = unfold(icsFor(meeting, link, new Date("2026-09-01T00:00:00Z")));

		expect(lines).toContain("DTSTART:20260905T021500Z");
		expect(lines).toContain("DTSTAMP:20260901T000000Z");
		expect(lines.some((l) => l.startsWith("DTEND"))).toBe(false);
		expect(lines.some((l) => l.startsWith("DURATION"))).toBe(false);
	});

	it("keeps the same id for the same meeting", () => {
		const a = unfold(icsFor(meeting, link)).find((l) => l.startsWith("UID:"));
		const b = unfold(icsFor(meeting, link)).find((l) => l.startsWith("UID:"));

		expect(a).toBe("UID:abc123@tomoshibi");
		expect(b).toBe(a);
	});

	it("escapes what would otherwise end the property", () => {
		const lines = unfold(icsFor({ ...meeting, room: "a,b;c\\d\ne" }, link));

		expect(lines).toContain("SUMMARY:a\\,b\;c\\\\d\\ne");
	});

	it("carries the link", () => {
		const lines = unfold(icsFor(meeting, link));

		expect(lines).toContain(`URL:${link}`);
		expect(lines).toContain(`DESCRIPTION:${link.replace(/,/g, "\\,").replace(/;/g, "\;")}`);
	});

	it("folds long lines at seventy-five octets without cutting a character", () => {
		const long = `https://live.example/?meeting=${"x".repeat(120)}#/standup`;
		const name = "每周例会".repeat(12);
		const ics = icsFor({ ...meeting, room: name }, long);
		const encoder = new TextEncoder();

		for (const raw of ics.split("\r\n")) {
			expect(encoder.encode(raw).length).toBeLessThanOrEqual(75);
		}

		// Unfolded, everything is whole again — including the Chinese name,
		// which would be mojibake if a fold had split a character.
		const lines = unfold(ics);
		expect(lines).toContain(`SUMMARY:${name}`);
		expect(lines).toContain(`URL:${long}`);
	});
});
