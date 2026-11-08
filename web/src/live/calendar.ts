import type { Arrangement } from "./meeting";

/**
 * An arranged meeting as a calendar event, for whoever keeps a calendar.
 *
 * One file, once, made here from what the page already knows — the time, the
 * name, the link — and handed to the browser to save. Nothing on the server
 * takes part, and nothing keeps the file and the meeting in step afterwards:
 * a meeting cancelled on the site stays in the calendar it was added to. That
 * is what a file export is, and the button says "add" rather than "sync".
 *
 * ## The shape of the file
 *
 * RFC 5545. Lines end in CRLF, text is escaped, and no line runs past
 * seventy-five octets — folded, with a continuation line beginning with a
 * space, and folded on a character boundary so a name in Chinese is not cut
 * through the middle of a byte sequence. Times are written in UTC and left to
 * the calendar to show in whatever zone it is opened in, which is the one
 * convention every calendar agrees on.
 *
 * The event ends an hour after it starts. An arrangement is a moment rather
 * than a span, and nothing on the site knows how long a meeting will be, so
 * this used to write a start and no end, which the RFC allows and reads as an
 * event that ends when it begins. Calendars draw that as a sliver of nothing
 * or as zero minutes, and some leave it off a day's view altogether, which
 * for a meeting somebody added on purpose is worse than any length (the
 * health check of 2026-10-29). An hour is the length every common calendar
 * gives an event made without one, so it is the one people already expect to
 * see and to drag; and the site has no length of its own to offer instead —
 * the card arranges a time on the quarter hour and nothing else.
 *
 * The UID is the meeting's own id under a fixed domain, so exporting the same
 * meeting twice makes the same event twice rather than two events.
 */
/** What a calendar is told a meeting lasts, the length it gives one made without any. */
export const ASSUMED_LENGTH = 60 * 60_000;

export function icsFor(meeting: Arrangement, link: string, now: Date = new Date()): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Tomoshibi//Arranged meeting//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		`UID:${meeting.id}@tomoshibi`,
		`DTSTAMP:${stamp(now)}`,
		`DTSTART:${stamp(new Date(meeting.at))}`,
		`DTEND:${stamp(new Date(new Date(meeting.at).getTime() + ASSUMED_LENGTH))}`,
		`SUMMARY:${escapeText(meeting.room)}`,
		`URL:${link}`,
		`DESCRIPTION:${escapeText(link)}`,
		"END:VEVENT",
		"END:VCALENDAR",
	];

	return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** A file name the meeting can be saved under. */
export function fileNameFor(meeting: Arrangement): string {
	return `${meeting.room}.ics`;
}

/**
 * Hand the file to the browser to save, and take back the object URL.
 *
 * A URL made for a Blob holds the Blob until it is revoked, and a page that
 * exports a few meetings an afternoon would otherwise keep every one of them.
 * Revoked on the next tick rather than at once, because the click that starts
 * the download reads the URL after this function has returned.
 */
export function download(name: string, text: string): void {
	const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
	const url = URL.createObjectURL(blob);

	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	a.remove();

	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A DATE-TIME in UTC, the form every calendar reads. */
function stamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");

	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
	);
}

/** TEXT as the RFC wants it: backslash, semicolon and comma escaped, and a
 * line break written as the two characters \n. */
function escapeText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** How many octets a line may carry, excluding the line break. */
const OCTETS = 75;

const encoder = new TextEncoder();

/**
 * Fold a line that runs past seventy-five octets.
 *
 * Counted in bytes, split on characters: a continuation begins with one
 * space, which counts toward its seventy-five, and no character is cut in
 * two, because a name in Chinese is three bytes a character and a split in
 * the middle of one is a file some calendars refuse whole.
 */
function fold(line: string): string {
	if (encoder.encode(line).length <= OCTETS) return line;

	const out: string[] = [];
	let current = "";
	let used = 0;
	let limit = OCTETS;

	for (const ch of line) {
		const width = encoder.encode(ch).length;

		if (used + width > limit) {
			out.push(current);
			current = ` ${ch}`;
			used = 1 + width;
			limit = OCTETS;
			continue;
		}

		current += ch;
		used += width;
	}

	out.push(current);

	return out.join("\r\n");
}
