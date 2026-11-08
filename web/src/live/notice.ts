import { useSyncExternalStore } from "react";
import { keep, recall } from "@/lib/storage";

/*
 * The two notices the management pages publish (internal/remote): the lobby's,
 * for people signed in, and the sign-in page's, for people who are not. The
 * apps show the lobby's at the top of their lobby; this page shows each at the
 * top of its own screen.
 *
 * The lobby's went to the apps alone at first. The owner published one, opened
 * the site in Chrome, and saw nothing; once the page showed it, it showed it on
 * the sign-in as well, and the owner asked for the sign-in page's to be its own:
 * "this one is for people signed in". The server hands the sign-in page's to
 * anybody and the lobby's to a caller signed in, both in /api/deployment, which
 * every page reads before anything else, and they are learned here from that
 * answer (api.ts deployment).
 *
 * Closed notices are remembered by id, as the apps remember them
 * (apple Remote.swift `closed`): a notice keeps its id for as long as it is up,
 * and publishing again gives a new one, so somebody who closed the last notice
 * is shown the next.
 */

export type NoticeKind = "lobby" | "signin";

export interface SiteNotice {
	id: string;
	level: "info" | "warning";
	/** By language: en, zh-Hans, zh-Hant, ja. */
	text: Record<string, string>;
	/** RFC 3339; absent for a notice up until it is taken down. */
	until?: string;
}

/**
 * Under the old product name, like every other key this client keeps. The
 * lobby's is the key the one notice was closed under before there were two,
 * so a notice somebody closed then stays closed.
 */
const CLOSED: Record<NoticeKind, string> = {
	lobby: "meet-live.notice.closed",
	signin: "meet-live.signin-notice.closed",
};
/** Ids closed long ago are notices long taken down; twenty is plenty. */
const HELD = 20;

const current: Record<NoticeKind, SiteNotice | undefined> = { lobby: undefined, signin: undefined };
let learnedAt = 0;
const listeners = new Set<() => void>();

function told(): void {
	for (const listener of listeners) listener();
}

/** A notice as the server says it, when it is one that can be shown. */
export function noticeOf(said: unknown): SiteNotice | undefined {
	if (!said || typeof said !== "object") return undefined;

	const { id, level, text, until } = said as Record<string, unknown>;
	if (typeof id !== "string" || id === "" || !text || typeof text !== "object") return undefined;

	const words: Record<string, string> = {};
	for (const [language, line] of Object.entries(text as Record<string, unknown>)) {
		if (typeof line === "string" && line.trim() !== "") words[language] = line;
	}
	if (Object.keys(words).length === 0) return undefined;

	return {
		id,
		level: level === "warning" ? "warning" : "info",
		text: words,
		...(typeof until === "string" && until !== "" ? { until } : {}),
	};
}

/**
 * Whether two notices are the same in everything shown. Not by id and end
 * alone: the server gives a notice a new id when it is published again with
 * new words, but a page that trusted that to see a change kept a notice drawn
 * as a warning after it was put up again as a plain one under the same id.
 */
function same(a: SiteNotice | undefined, b: SiteNotice | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Learns both notices from /api/deployment's answer: the newest answer wins,
 * and a notice it does not carry is taken down here, which is how the lobby's
 * leaves a page that has signed out.
 */
export function learnNotice(body: { notice?: unknown; signInNotice?: unknown } | undefined): void {
	learnedAt = Date.now();

	const lobby = noticeOf(body?.notice);
	const signin = noticeOf(body?.signInNotice);
	if (same(lobby, current.lobby) && same(signin, current.signin)) return;

	current.lobby = lobby;
	current.signin = signin;
	told();
}

/** When the server's answer was last learned, so a screen need not ask twice in a row. */
export function lastLearned(): number {
	return learnedAt;
}

/** The notice's words for a reader of `language`: theirs, else English, else none, as the apps say it. */
export function noticeText(notice: SiteNotice, language: string): string | undefined {
	return notice.text[language] ?? notice.text.en;
}

/** Whether a notice is still up at `now`: it has no end, or its end has not come. */
export function stillUp(notice: SiteNotice, now: number = Date.now()): boolean {
	if (!notice.until) return true;
	const end = Date.parse(notice.until);
	return Number.isNaN(end) || now < end;
}

function closedIds(kind: NoticeKind): string[] {
	try {
		const kept = JSON.parse(recall(CLOSED[kind]) ?? "[]");
		return Array.isArray(kept) ? kept.filter((one): one is string => typeof one === "string") : [];
	} catch {
		return [];
	}
}

/** Whether this browser closed that notice. */
export function closedHere(kind: NoticeKind, id: string): boolean {
	return closedIds(kind).includes(id);
}

/** Puts the notice away in this browser, for as long as it keeps the same id. */
export function closeNotice(kind: NoticeKind, id: string): void {
	const ids = [...closedIds(kind).filter((one) => one !== id), id].slice(-HELD);
	keep(CLOSED[kind], JSON.stringify(ids));
	told();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The notice of that kind the server last said, for a component to draw. */
export function useSiteNotice(kind: NoticeKind): SiteNotice | undefined {
	return useSyncExternalStore(
		subscribe,
		() => current[kind],
		() => current[kind],
	);
}

/** For tests: forget what was learned. */
export function forgetNotice(): void {
	current.lobby = undefined;
	current.signin = undefined;
	learnedAt = 0;
	told();
}
