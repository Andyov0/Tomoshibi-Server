import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Refused, join as requestJoin } from "@/live/api";
import { App } from "./App";

/*
 * That a refused join reaches the screen somebody pressed.
 *
 * The waiting room is two halves. The server turns a stranger away with
 * `not_invited`, and the join screen answers that one refusal by offering to
 * knock on the door — every other failure is only reported. The half that
 * decides which is which is a `catch` in App, and it swallowed the rejection:
 * it said what went wrong, then returned normally, so the screen saw a join
 * that had worked and drew nothing to press.
 *
 * Nothing failed. The message was correct, the button came back, and the door
 * was simply never offered. It survived a typecheck, a unit run and a review,
 * and was found by two browsers a week later.
 *
 * So the guard is here rather than in PreJoin's own tests: PreJoin was right
 * the whole time, and testing it again would have gone green on the broken
 * build. What has to hold is that the rejection crosses the seam between the
 * two, which is the thing nothing was watching.
 */

const camera = { stop: vi.fn(), attach: vi.fn(), detach: vi.fn() };

vi.mock("livekit-client", async (original) => ({
	...(await original<typeof import("livekit-client")>()),
	createLocalVideoTrack: () => Promise.resolve(camera),
}));

// The refusal under test, and a room object for the join to tear down. Neither
// is ever connected: the join fails on the first call.
vi.mock("@/live/api", async (original) => ({
	...(await original<typeof import("@/live/api")>()),
	join: vi.fn(),
	deployment: async () => ({ openedBy: "anyone", joinedBy: "invited", source: "" }),
}));

vi.mock("@/live/room", () => ({
	create: () => ({ disconnect: async () => {}, once: () => {}, localParticipant: {} }),
	connect: async () => {},
	tokenFor: () => "",
}));

// Said with sonner, which wants a toaster mounted and has nothing to do with
// this.
vi.mock("@/live/notices", () => ({ newerVersion: vi.fn(), joinFailed: vi.fn(), watch: () => () => {} }));

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.location.hash = "#/standup";

	vi.mocked(requestJoin).mockRejectedValue(
		new Refused("not_invited", "Rooms here are by invitation."),
	);

	Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
	Object.defineProperty(navigator, "mediaDevices", {
		value: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

it("offers the door when the server says the room is by invitation", async () => {
	render(<App />);

	const name = await screen.findByLabelText("Your name");
	fireEvent.change(name, { target: { value: "Bo" } });
	fireEvent.click(screen.getByRole("button", { name: "Join" }));

	await waitFor(() => expect(vi.mocked(requestJoin)).toHaveBeenCalled());

	// The whole point. Refused, and offered a way to ask anyway.
	await waitFor(() => expect(screen.getByRole("button", { name: /let in/i })).toBeTruthy());
});
