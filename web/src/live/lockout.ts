import { t } from "./i18n";

/*
 * What somebody shut out of signing in is told.
 *
 * The server shuts out an address and a device after more than ten failed
 * sign-ins in five minutes, for half an hour (internal/lockout), and says so
 * with the reason the door already gave for too many attempts and the moment
 * the lockout ends. The reason alone is what the apps released before it read,
 * and they say their sentence about trying again in a moment; a page that can
 * read the end says how long, because "in a moment" about half an hour is a
 * sentence that invites the next attempt and the one after it.
 *
 * Shared by the account page and the management sign-in, so the two say the
 * same thing in the same words.
 */

/** Whole minutes until a lockout ends, never less than one. */
export function minutesLeft(until: string, now = Date.now()): number {
	const left = Date.parse(until) - now;
	if (!Number.isFinite(left)) return 1;

	return Math.max(1, Math.ceil(left / 60_000));
}

/** The sentence for a lockout ending at until. */
export function shutOutFor(until: string, now = Date.now()): string {
	const minutes = minutesLeft(until, now);

	// Two phrases rather than one with a number in it, because English needs
	// the singular and the dictionaries here have no plural rules (i18n.ts).
	if (minutes <= 1) return t("Too many failed sign-ins. Try again in a minute.");

	return t("Too many failed sign-ins. Try again in {minutes} minutes.", { minutes });
}

/**
 * The end of the lockout a refusal names, if it names one: a 429 whose body
 * says until. Anything else, including a 429 from a guessing budget, which
 * names no end, is undefined.
 */
export async function lockedUntil(response: Response): Promise<string | undefined> {
	if (response.status !== 429) return undefined;

	try {
		const body = (await response.clone().json()) as { until?: unknown };
		return typeof body.until === "string" ? body.until : undefined;
	} catch {
		return undefined;
	}
}
