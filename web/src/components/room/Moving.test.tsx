import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Moving } from "./Moving";

/*
 * What a call being moved looks like from a chair.
 *
 * A move ends the call: there is no message in the protocol that asks a browser
 * to move, so everybody is disconnected and comes straight back. The coming
 * back has always worked — what it looked like was being thrown out. The room
 * came down, the join screen appeared, and the call returned a few seconds
 * later, which from where somebody sat is indistinguishable from having been
 * removed and then let in again.
 *
 * These hold the two things that stop it reading that way: something stays on
 * screen, and it says where the meeting is going. The destination has always
 * been sent by the server and was thrown away by the client.
 */

describe("a meeting being moved", () => {
	it("says nothing at all when nothing is happening", () => {
		const { container } = render(<Moving to={undefined} />);

		expect(container.textContent).toBe("");
	});

	it("says where it is going, in the words the picker uses", async () => {
		render(<Moving to="Hong Kong" />);

		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent).toContain("Hong Kong");
	});

	// A move the server did not name a destination for is still a move, and
	// saying so without a name beats saying nothing.
	it("still says something when the destination is unnamed", async () => {
		render(<Moving to=" " />);

		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent).toMatch(/moving/i);
	});

	// The one thing worth saying about it. Somebody who thinks they have been
	// disconnected reaches for the join button, and the join button is behind
	// this.
	it("says nobody has to do anything", async () => {
		render(<Moving to="Tokyo" />);

		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent).toMatch(/back in a moment/i);
	});

	// Drawn over a room whose controls are still underneath. A click landing on
	// a button somebody cannot see is worse than the move itself.
	it("cannot be clicked through to", async () => {
		render(<Moving to="Tokyo" />);

		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").className).toContain("pointer-events-none");
	});

	// The screen going quiet for three seconds is exactly when somebody using a
	// reader needs telling.
	it("announces itself", async () => {
		render(<Moving to="Tokyo" />);

		const said = await screen.findByRole("status");
		expect(said.getAttribute("aria-live")).toBe("polite");
	});
});
