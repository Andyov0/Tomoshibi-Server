import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Candidate, addressSeenBy, ownAddress, relayToAsk } from "./connection";

/*
 * Which address the connection panel calls somebody's own.
 *
 * Measured from a forwarded call in two headless browsers: the candidate in use
 * was a peer-reflexive one whose address was the exchange a mainland relay
 * crosses the border through, and the panel showed it as the caller's address.
 * Every case below is a shape a browser actually reported.
 */

const own = (entries: [string, Candidate][], nominated: string) => ownAddress(new Map(entries), nominated);

it("shows the reflexive address on a direct path", () => {
	expect(
		own([["a", { address: "198.51.100.7", kind: "srflx", related: "192.168.1.24", relayed: false }]], "a"),
	).toBe("198.51.100.7");
	expect(own([["a", { address: "198.51.100.7", kind: "prflx", relayed: false }]], "a")).toBe("198.51.100.7");
});

it("shows nothing for a private address", () => {
	expect(own([["a", { address: "192.168.1.24", kind: "host", relayed: false }]], "a")).toBeUndefined();
});

it("shows the address the relay saw, not the relay's own", () => {
	expect(
		own([["r", { address: "203.0.113.5", kind: "relay", related: "198.51.100.7", relayed: true }]], "r"),
	).toBe("198.51.100.7");
});

it("shows the address the entry relay saw, not where a forwarded path comes out", () => {
	const entries: [string, Candidate][] = [
		["r", { address: "203.0.113.5", kind: "relay", related: "198.51.100.7", relayed: true }],
		["p", { address: "192.0.2.80", kind: "prflx", related: "203.0.113.5", relayed: true }],
	];

	expect(own(entries, "p")).toBe("198.51.100.7");
});

it("shows nothing when the browser has hidden the address the relay saw", () => {
	const hidden: [string, Candidate][] = [
		["r", { address: "203.0.113.5", kind: "relay", relayed: true }],
		["p", { address: "192.0.2.80", kind: "prflx", related: "203.0.113.5", relayed: true }],
	];
	expect(own(hidden, "p")).toBeUndefined();
	expect(own([["r", { address: "203.0.113.5", kind: "relay", related: "0.0.0.0", relayed: true }]], "r")).toBeUndefined();
});

it("asks the relay a relayed candidate went through, in the clear only where it already was", () => {
	expect(relayToAsk({ address: "x", kind: "prflx", relayed: true, url: "turn:relay.example:39219?transport=udp" })).toBe(
		"stun:relay.example:39219",
	);
	expect(relayToAsk({ address: "x", kind: "relay", relayed: true, url: "turn:relay.example:39219?transport=tcp" })).toBe(
		"stun:relay.example:39219",
	);
	expect(relayToAsk({ address: "x", kind: "relay", relayed: true, url: "turns:relay.example:443" })).toBeUndefined();
	expect(relayToAsk({ address: "x", kind: "srflx", relayed: false, url: "stun:relay.example:39219" })).toBeUndefined();
});

describe("asking a relay for this browser's address", () => {
	const made: { config: RTCConfiguration; closed: boolean }[] = [];
	let answer: Partial<RTCIceCandidate>[] = [];

	class FakePeerConnection {
		onicecandidate: ((event: { candidate: Partial<RTCIceCandidate> | null }) => void) | null = null;
		record: { config: RTCConfiguration; closed: boolean };
		constructor(config: RTCConfiguration) {
			this.record = { config, closed: false };
			made.push(this.record);
		}
		createDataChannel() {}
		async createOffer() {
			return {};
		}
		async setLocalDescription() {
			for (const candidate of [...answer, null]) this.onicecandidate?.({ candidate });
		}
		close() {
			this.record.closed = true;
		}
	}

	beforeEach(() => {
		made.length = 0;
		vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("takes the server-reflexive address, closes the connection, and asks once", async () => {
		answer = [
			{ type: "host", address: "192.168.1.24" },
			{ type: "srflx", address: "198.51.100.7" },
		];

		expect(await addressSeenBy("stun:one.example:39219")).toBe("198.51.100.7");
		expect(await addressSeenBy("stun:one.example:39219")).toBe("198.51.100.7");
		expect(made).toHaveLength(1);
		expect(made[0]?.config.iceServers).toEqual([{ urls: "stun:one.example:39219" }]);
		expect(made[0]?.closed).toBe(true);
	});

	it("says nothing when the relay gave no address", async () => {
		answer = [{ type: "host", address: "192.168.1.24" }];

		expect(await addressSeenBy("stun:two.example:39219")).toBeUndefined();
		expect(made[0]?.closed).toBe(true);
	});
});
