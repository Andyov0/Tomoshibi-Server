import { TrackEvent } from "livekit-client";
import { EventEmitter } from "node:events";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMirrored } from "./useMirrored";

/*
 * The half of this that would go wrong silently.
 *
 * Switching camera does not hand back a new track. The media library restarts
 * the one that is there, replacing what it captures from and leaving the object
 * every component holds exactly as it was — so nothing about a React tree
 * changes, nothing re-renders, and a component that read the direction once goes
 * on drawing the answer it got for the camera before.
 *
 * Which is the bug as it was reported: the picture turned round and the mirror
 * stayed on.
 */

/** A track whose camera can be turned round, the way the library turns one. */
function turnable(facing: "user" | "environment") {
	const track = new EventEmitter() as never as {
		mediaStreamTrack: { getSettings(): MediaTrackSettings };
		emit(event: string, ...args: unknown[]): boolean;
	};

	let now = facing;
	(track as never as { mediaStreamTrack: unknown }).mediaStreamTrack = {
		getSettings: () => ({ facingMode: now }),
	};

	return {
		track,
		// What restartTrack does: the same object, capturing from somewhere else.
		turn(to: "user" | "environment") {
			now = to;
			track.emit(TrackEvent.Restarted, track);
		},
	};
}

function Picture({ track }: { track: never }) {
	return <span data-testid="picture">{useMirrored(track) ? "mirrored" : "as it is"}</span>;
}

describe("useMirrored", () => {
	it("follows the camera when it is turned round", () => {
		const camera = turnable("user");

		render(<Picture track={camera.track as never} />);
		expect(screen.getByTestId("picture").textContent).toBe("mirrored");

		act(() => camera.turn("environment"));
		expect(screen.getByTestId("picture").textContent).toBe("as it is");

		act(() => camera.turn("user"));
		expect(screen.getByTestId("picture").textContent).toBe("mirrored");
	});

	// Nothing to point anywhere yet, and a picture that is about to be somebody's
	// own face. Mirrored is the answer that does not flicker into place.
	it("mirrors before there is a camera", () => {
		render(<Picture track={undefined as never} />);
		expect(screen.getByTestId("picture").textContent).toBe("mirrored");
	});
});
