import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Fleet } from "./Lobby";

/*
 * The light beside the deployment's name, which says how much of the fleet is
 * answering. A deployment of one machine has no fleet, and the server says so
 * as none of none; read as none answering, that was a red light on every such
 * lobby, in the colour kept for leaving and for errors. Nothing on the page
 * looks broken without it, which is why it is held here.
 */

function answering(fleet: { online: number; total: number }) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ relays: [], measure: false, fleet }))),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

it("draws nothing where there is no fleet", async () => {
	answering({ online: 0, total: 0 });
	const { container } = render(<Fleet />);

	await waitFor(() => expect(fetch).toHaveBeenCalled());
	await new Promise((settle) => setTimeout(settle, 0));
	expect(container.textContent).toBe("");
	expect(container.querySelector(".bg-danger")).toBeNull();
});

it("is red only when a fleet that exists has stopped answering", async () => {
	answering({ online: 0, total: 3 });
	const { container } = render(<Fleet />);

	await screen.findByText("0/3");
	expect(container.querySelector(".bg-danger")).not.toBeNull();
});

it("is green when all of it answers", async () => {
	answering({ online: 3, total: 3 });
	const { container } = render(<Fleet />);

	await screen.findByText("3/3");
	expect(container.querySelector(".bg-good")).not.toBeNull();
});
