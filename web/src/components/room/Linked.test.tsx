import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Linked } from "./Linked";

/** The hrefs a piece of text turns into. */
function links(text: string): string[] {
	const { container } = render(<Linked text={text} />);
	return [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

describe("Linked", () => {
	it("finds a complete address", () => {
		expect(links("see https://example.com/a?b=1")).toEqual(["https://example.com/a?b=1"]);
	});

	it("finds more than one", () => {
		expect(links("http://a.test and https://b.test")).toEqual(["http://a.test", "https://b.test"]);
	});

	// A false link is worse than a missed one: it is clickable, it goes
	// somewhere, and it looks deliberate.
	it("does not guess at anything that is not one", () => {
		expect(links("see example.com or www.example.com")).toEqual([]);
		expect(links("port 4443 on the box")).toEqual([]);
		expect(links("ftp://files.test")).toEqual([]);
	});

	// A sentence ending in an address is written with a stop after it, and the
	// stop is not part of the address.
	it("leaves trailing punctuation out of the address", () => {
		expect(links("it is at https://example.com/docs.")).toEqual(["https://example.com/docs"]);
		expect(links("(https://example.com)")).toEqual(["https://example.com"]);
		expect(links("https://example.com, then")).toEqual(["https://example.com"]);
	});

	it("keeps the words around it", () => {
		const { container } = render(<Linked text="go to https://example.com now" />);
		expect(container.textContent).toBe("go to https://example.com now");
	});

	// The room is still running in this tab.
	it("opens elsewhere and cannot reach back", () => {
		const { container } = render(<Linked text="https://example.com" />);
		const anchor = container.querySelector("a");

		expect(anchor?.getAttribute("target")).toBe("_blank");
		expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
	});
});
