import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MediaBrowser } from "./MediaBrowser";

/*
Browsing a media server: into a library, a series, back out, a search -- and a
press on something playable hands over its link, and a press on a folder never
does.
*/

const browseMedia = vi.fn();
const searchMedia = vi.fn();

vi.mock("@/live/watch-api", async (original) => {
	const real = await original<typeof import("@/live/watch-api")>();
	return {
		...real,
		browseMedia: (...args: unknown[]) => browseMedia(...args),
		searchMedia: (...args: unknown[]) => searchMedia(...args),
	};
});

const item = (id: string, name: string, kind: "folder" | "playable") => ({
	id,
	name,
	type: kind === "folder" ? "Series" : "Movie",
	folder: kind === "folder",
	playable: kind === "playable",
	year: 0,
	duration: kind === "playable" ? 600 : 0,
	image: "",
});

beforeEach(() => {
	browseMedia.mockReset().mockImplementation(async (_server: string, parent?: string) =>
		parent === undefined ? [item("a1", "Shows", "folder"), item("b2", "A film", "playable")] : [item("c3", "Episode one", "playable")],
	);
	searchMedia.mockReset().mockResolvedValue([item("d4", "Found film", "playable")]);
});

it("goes into a folder and back, and hands over what is chosen to play", async () => {
	const chosen = vi.fn();
	render(<MediaBrowser servers={[{ key: "home", name: "Home" }]} onChoose={chosen} />);

	fireEvent.click(await screen.findByRole("button", { name: "Shows" }));
	expect(chosen).not.toHaveBeenCalled();
	await waitFor(() => expect(browseMedia).toHaveBeenLastCalledWith("home", "a1"));
	fireEvent.click(await screen.findByRole("button", { name: "Watch Episode one" }));
	expect(chosen).toHaveBeenCalledWith("library:home/c3");

	fireEvent.click(screen.getByRole("button", { name: /Shows/ }));
	expect(await screen.findByRole("button", { name: "Watch A film" })).toBeTruthy();
});

it("searches, and a choice from the results is handed over the same way", async () => {
	const chosen = vi.fn();
	render(<MediaBrowser servers={[{ key: "home", name: "Home" }, { key: "away", name: "Away" }]} onChoose={chosen} />);

	fireEvent.click(screen.getByRole("button", { name: "Away" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Search films and series" }), { target: { value: "film" } });
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	fireEvent.click(await screen.findByRole("button", { name: "Watch Found film" }));

	expect(searchMedia).toHaveBeenCalledWith("away", "film");
	expect(chosen).toHaveBeenCalledWith("library:away/d4");
});

it("says the server did not answer, rather than that it is empty", async () => {
	browseMedia.mockResolvedValue(undefined);
	render(<MediaBrowser servers={[{ key: "home", name: "Home" }]} onChoose={vi.fn()} />);

	expect(await screen.findByText(/did not answer/)).toBeTruthy();
});
