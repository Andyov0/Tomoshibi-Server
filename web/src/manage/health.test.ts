import { describe, expect, it } from "vitest";
import type { NodeReading } from "./api";
import { ago, certificate, lasted, reason, verdict } from "./health";
import { linkIs } from "./units";

/*
 * What a machine's figures are said to mean.
 *
 * Every fault here reads as reassurance. A relay that did not answer drawn as
 * "Healthy" because its zeros look like a quiet machine; a certificate four
 * days from expiring drawn in the quiet ink because the threshold was counted
 * in hours; a refused connection explained as a timeout, which sends somebody
 * to check the network when the service has stopped. None of these throws and
 * all of them are believed.
 */

const quiet: NodeReading = {
	name: "hk",
	url: "wss://hk.example:443",
	reachable: true,
	node: "ND_hk",
	ip: "198.51.100.5",
	rooms: 0,
	clients: 0,
	tracksIn: 0,
	tracksOut: 0,
	outPerSec: 0,
	inPerSec: 0,
	bytesIn: 0,
	bytesOut: 0,
	cpus: 4,
	load: 0,
};

describe("a relay's verdict", () => {
	it("is down when it did not answer, however quiet its zeros look", () => {
		expect(verdict({ ...quiet, reachable: false })).toBe("down");
		expect(verdict(quiet)).toBe("ok");
	});

	it("is busy past four fifths of its processor, two thirds of its line, or fifty packets asked for again", () => {
		linkIs(100);

		expect(verdict({ ...quiet, load: 0.8 })).toBe("ok");
		expect(verdict({ ...quiet, load: 0.81 })).toBe("busy");

		// Bytes a second against a line counted in bits: seventy megabits of a
		// hundred is busy, sixty is not.
		expect(verdict({ ...quiet, outPerSec: 60e6 / 8 })).toBe("ok");
		expect(verdict({ ...quiet, outPerSec: 70e6 / 8 })).toBe("busy");

		expect(verdict({ ...quiet, nackPerSec: 51 })).toBe("busy");

		linkIs(undefined);
	});
});

describe("why a relay did not answer", () => {
	it("points at what to check, from the shape of the transport's error", () => {
		expect(reason("dial tcp 203.0.113.5:443: connect: connection refused")).toMatch(/Nothing is listening/);
		expect(reason("dial tcp: i/o timeout")).toMatch(/did not answer in time/);
		expect(reason("context deadline exceeded")).toMatch(/did not answer in time/);
		expect(reason("dial tcp: lookup hk.example: no such host")).toMatch(/does not lead anywhere/);
		expect(reason("tls: failed to verify certificate: x509: certificate has expired")).toMatch(/certificate may have expired/);
		expect(reason("relay answered 401")).toMatch(/refused this deployment's key/);
		expect(reason("read: connection reset by peer")).toMatch(/cut off/);
		expect(reason(undefined)).toBe("It did not answer.");
	});
});

describe("a certificate", () => {
	const now = Date.parse("2026-10-29T00:00:00Z");
	const inDays = (days: number) => new Date(now + days * 86_400_000).toISOString();

	it("says nothing where nothing was reported, rather than a date", () => {
		expect(certificate(undefined, now)).toBeUndefined();
	});

	it("is quiet with three weeks left, amber under that, and red under a week or past it", () => {
		expect(certificate(inDays(60), now)).toEqual({ tone: "fine", text: "60 days left" });
		expect(certificate(inDays(21), now)?.tone).toBe("fine");
		expect(certificate(inDays(20.5), now)?.tone).toBe("soon");
		expect(certificate(inDays(6.5), now)).toEqual({ tone: "urgent", text: "6 days left" });
		expect(certificate(inDays(0.5), now)).toEqual({ tone: "urgent", text: "expires today" });
		expect(certificate(inDays(-1), now)).toEqual({ tone: "urgent", text: "expired" });
	});
});

describe("how long", () => {
	const now = Date.parse("2026-10-29T12:00:00Z");
	const before = (seconds: number) => new Date(now - seconds * 1000).toISOString();

	it("is said in words at the largest unit that still says something", () => {
		expect(lasted(before(30), now)).toBe("under a minute");
		expect(lasted(before(25 * 60), now)).toBe("25 min");
		expect(lasted(before(3 * 3600 + 5 * 60), now)).toBe("3 h 5 min");
		expect(lasted(before(2 * 86_400 + 4 * 3600), now)).toBe("2 d 4 h");
	});

	it("calls a moment under a minute old just now, and the rest ago", () => {
		expect(ago(before(10), now)).toBe("just now");
		expect(ago(before(25 * 60), now)).toBe("25 min ago");
	});
});
