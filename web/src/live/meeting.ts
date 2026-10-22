/**
 * Meetings arranged ahead of time.
 *
 * The server file carries the argument for what one is; this is the client's
 * side of the door. Two people use it: a host arranging one from the lobby and
 * being handed the link, and a person who opened that link — possibly hours
 * early — asking whether it has begun.
 *
 * ## The token in the link
 *
 * The link is `?meeting=<token>#/<room>`. The token is a bearer secret for a
 * day's entry once the meeting begins, so it is treated the way `?invite=` is:
 * read once, kept for this tab, and taken out of the address bar — people share
 * their screens in calls, and the address bar is on the screen.
 *
 * ## The room is what the server says
 *
 * The hash names a room and so does the meeting record, and only the second is
 * trusted: the hash can be edited by hand, and the invitation this turns into
 * is good for the arranged room and no other.
 */

import { Refused } from "./api";
import { locale } from "./i18n";
import { keepForTab, recallForTab } from "@/lib/storage";

/** Where a meeting token this tab arrived with is kept. */
const MEETING_KEY = "meet-live.meeting";

/** What the server says about one, host and guest alike. */
export interface Arrangement {
	id: string;
	room: string;
	/** RFC 3339, an instant. Shown in the reader's own zone. */
	at: string;
	relay?: string;
	started: boolean;
	ended: boolean;
	/** RFC 3339: when the host may begin it, which is before `at`. */
	from?: string;
	/** The secret in the link, said only to the host. */
	token?: string;
	/** Whether whoever is asking arranged it. */
	mine?: boolean;
	/** The way in, said only once it has begun and while it is good. */
	invite?: string;
}

/** The token this tab arrived with, from the address or from what it kept. */
export function meetingToken(): string {
	const said = new URLSearchParams(window.location.search).get("meeting");
	if (said) return said;

	try {
		return recallForTab(MEETING_KEY) ?? "";
	} catch {
		return "";
	}
}

/**
 * Keep the token for this tab and take it out of the address bar.
 *
 * Kept so a reload during the wait does not lose the meeting; removed for the
 * reason given in the header. The hash stays, because the room name is the
 * only thing in the address anybody needs to see.
 */
export function keepMeeting(token: string): void {
	try {
		keepForTab(MEETING_KEY, token);
	} catch {
		// A tab that will not keep it can still use it until it is closed.
	}

	const clean = new URL(window.location.href);
	if (clean.searchParams.has("meeting")) {
		clean.searchParams.delete("meeting");
		window.history.replaceState(null, "", clean.toString());
	}
}

/** Forget it, once the person has left or the meeting is over. */
export function forgetMeeting(): void {
	try {
		keepForTab(MEETING_KEY, undefined);
	} catch {
		// Nothing to forget.
	}
}

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});

	if (!response.ok) {
		const reason = await response
			.json()
			.then((body) => (body as { error?: string }).error)
			.catch(() => undefined);

		throw new Refused(reason, String(response.status));
	}

	if (response.status === 204) return undefined as T;

	return (await response.json()) as T;
}

/** Ask what a link points at. Throws Refused with `no_such_meeting` for a dead one. */
export function arranged(token: string): Promise<Arrangement> {
	return ask(`/api/meetings/${encodeURIComponent(token)}`);
}

/**
 * Arrange one.
 *
 * `at` is an instant: the form's local wall-clock value is turned into one here
 * with `toISOString`, because a time with no zone is a time in a zone somebody
 * guessed, and the server refuses it.
 */
export function arrange(room: string, at: Date, relay: string): Promise<Arrangement> {
	return ask("/api/meetings", {
		method: "POST",
		body: JSON.stringify({ room, at: at.toISOString(), relay }),
	});
}

/** The caller's own arrangements, soonest first, each with its link. */
export async function arrangements(): Promise<Arrangement[]> {
	const said = await ask<{ meetings?: Arrangement[] }>("/api/meetings");

	return said.meetings ?? [];
}

export function cancel(id: string): Promise<void> {
	return ask(`/api/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The link for one, built from the page's own address the way invites are. */
export function linkFor(meeting: Arrangement): string {
	const url = new URL(window.location.href);
	url.search = `?meeting=${encodeURIComponent(meeting.token ?? "")}`;
	url.hash = `#/${meeting.room}`;

	return url.toString();
}

/**
 * How often to ask whether it has begun, given how far off it is.
 *
 * Every three seconds inside the last ten minutes, when the host is expected
 * any moment and a person is watching the screen. Every thirty before that: a
 * link opened an hour early is a tab left open, and a tab left open asking
 * every three seconds for an hour is twelve hundred requests for an answer
 * that cannot change until the host arrives — and thirty people behind one
 * office's address doing that would trip the rate limit for all of them.
 */
export function askEvery(at: string, now: number): number {
	const until = new Date(at).getTime() - now;

	return until > 10 * 60_000 ? 30_000 : 3_000;
}

/**
 * How long after the arranged time to keep asking before concluding the host is
 * not coming. Two hours: longer than anybody is late, shorter than the day the
 * server keeps the record.
 */
export const HOST_NOT_COMING_AFTER = 2 * 60 * 60_000;

/**
 * When a meeting is for, in the reader's own clock and zone.
 *
 * Spelled out as parts rather than `dateStyle`/`timeStyle`, because those two
 * cannot be combined with `timeZoneName` — Intl throws "Invalid option", and
 * it threw during the render right after arranging, which took the lobby down
 * with the link still unread. The zone is the point: a host in Shanghai and a
 * guest in Tokyo must each see their own eleven o'clock and know which it is.
 */
export function whenSaid(at: string): string {
	return new Date(at).toLocaleString(locale(), {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	});
}
