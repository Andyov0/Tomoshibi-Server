import { t } from "@/live/i18n";
import type { NodeReading } from "./api";
import { linkBits } from "./units";

/*
What a machine's figures mean, in the words somebody who does not run servers
would use.

The fleet table this replaces showed eleven numbers a row and left the reading
of them to whoever was looking: a load of 0.93, a NACK rate of 61, a Go error
with a URL in it. Every one of those was true and none of them said whether
anything was wrong. These turn each into a verdict first and a figure second —
the verdict is what is scanned for, and the figure is still there for whoever
wants to quote it.

The thresholds are the ones the old table coloured at, so nothing here is a new
opinion about what busy means; it is the same opinion said in a word.
*/

/** How a relay is, in one of three words. */
export type Verdict = "ok" | "busy" | "down";

/**
 * A relay's verdict.
 *
 * Busy is any one of three: the processor past four fifths, the line past two
 * thirds, or the network asking for packets again at a rate that is a failing
 * network rather than an ordinary one. Down is not answering, which is the one
 * that matters and the reason it is decided first.
 */
export function verdict(node: NodeReading): Verdict {
	if (!node.reachable) return "down";

	const load = node.load ?? 0;
	const out = (node.outPerSec ?? 0) * 8;
	const nack = node.nackPerSec ?? 0;

	if (load > 0.8 || out > linkBits() * 0.66 || nack > 50) return "busy";

	return "ok";
}

/**
 * Why a relay did not answer, said as what to check.
 *
 * The control node passes on the transport's own error, which is a sentence
 * written for whoever wrote the transport: "dial tcp 203.0.113.5:443: connect:
 * connection refused". The few shapes it comes in each point at a different
 * thing to go and look at, and that is what this says. The original stays on
 * the page beside it, quieter, because it is the half an engineer wants.
 */
export function reason(detail: string | undefined): string {
	const said = detail ?? "";

	if (/connection refused/i.test(said)) {
		return t("Nothing is listening there. The service on that machine may have stopped.");
	}
	if (/timeout|deadline exceeded|timed out/i.test(said)) {
		return t("It did not answer in time. The machine, or the network to it, may be down.");
	}
	if (/no such host|lookup /i.test(said)) {
		return t("Its address does not lead anywhere. Check the name it was added with.");
	}
	if (/x509|certificate|tls:/i.test(said)) {
		return t("The secure connection to it failed. Its certificate may have expired.");
	}
	if (/\b401\b|unauthori[sz]ed/i.test(said)) {
		return t("It refused this deployment's key. It may belong to another deployment.");
	}
	if (/reset by peer|broken pipe|EOF/.test(said)) {
		return t("The connection to it was cut off.");
	}

	return t("It did not answer.");
}

/** How soon a certificate expires, as a word to colour and a phrase to show. */
export interface CertReading {
	tone: "fine" | "soon" | "urgent";
	text: string;
}

/**
 * A certificate's expiry, read as how long is left.
 *
 * Three weeks is when it starts to be worth noticing: the renewal on the control
 * node runs well before that, so a relay still holding a certificate with three
 * weeks left is a relay that did not take its renewal. Under a week, or past
 * it, is the red, because by then every call through that relay is days from
 * failing to connect.
 */
export function certificate(expires: string | undefined, now = Date.now()): CertReading | undefined {
	if (!expires) return undefined;

	const days = Math.floor((new Date(expires).getTime() - now) / 86_400_000);

	if (days < 0) return { tone: "urgent", text: t("expired") };
	if (days < 1) return { tone: "urgent", text: t("expires today") };
	if (days < 7) return { tone: "urgent", text: t("{count} days left", { count: days }) };
	if (days < 21) return { tone: "soon", text: t("{count} days left", { count: days }) };

	return { tone: "fine", text: t("{count} days left", { count: days }) };
}

/**
 * How long something has lasted, in words rather than in the unit letters the
 * rest of these pages use for figures.
 *
 * "4m" beside a column of byte counts reads as a fourth byte count, and in
 * Chinese it reads as nothing at all.
 */
export function lasted(fromIso: string, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));

	if (seconds < 60) return t("under a minute");

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return t("{count} min", { count: minutes });

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("{hours} h {minutes} min", { hours, minutes: minutes % 60 });

	return t("{days} d {hours} h", { days: Math.floor(hours / 24), hours: hours % 24 });
}

/** How long ago, for a moment rather than a span. */
export function ago(iso: string, now = Date.now()): string {
	const seconds = (now - new Date(iso).getTime()) / 1000;

	if (seconds < 45) return t("just now");

	return t("{time} ago", { time: lasted(iso, now) });
}
