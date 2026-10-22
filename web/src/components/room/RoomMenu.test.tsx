import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forget } from "@/hooks/useJoining";
import { RoomMenu } from "./RoomMenu";

/*
 * That the room's link is only offered where it is a way in.
 *
 * This deployment asks for an invitation. A plain address to a room opens for
 * nobody under that door — so a button offering to copy it is an offer to
 * invite somebody, answered with a link that turns them away, and neither the
 * sender nor the person they sent it to has any way to know that until it
 * fails.
 *
 * The item is drawn from what the server says rather than from a guess, so this
 * asks the server twice: once as a deployment anybody may join, and once as one
 * that wants an invitation.
 */

function open() {
	render(
		<RoomMenu>
			<div>the room</div>
		</RoomMenu>,
	);

	fireEvent.contextMenu(screen.getByText("the room"));
}

function says(joinedBy: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ openedBy: "anyone", joinedBy, source: "" }))),
	);
}

// The answer is cached for the life of a page, and a test file is one page.
beforeEach(forget);

afterEach(() => {
	vi.unstubAllGlobals();
});

it("offers the link where anybody may join", async () => {
	says("anyone");
	open();

	await waitFor(() => expect(screen.getByText("Copy link")).toBeDefined());
});

it("offers nothing where the room asks for an invitation", async () => {
	says("invited");
	open();

	// Given time to appear, because the fault it guards against is an item that
	// arrives late rather than one that is never drawn.
	await new Promise((wait) => setTimeout(wait, 50));

	expect(screen.queryByText("Copy link")).toBeNull();
});
