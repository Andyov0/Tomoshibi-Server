import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/live/i18n";
import { Steady } from "./Steady";

/*
 * Words drawn at the size of their longest language. The owner chose
 * Simplified Chinese and watched the page change size, buttons narrowing and
 * cards losing a line; every language is now drawn at once, one over another,
 * the reader's alone visible. What would go wrong quietly is the hiding: a
 * hidden language a screen reader still reads, or that names a button twice
 * over, or a change of language that changes which words exist rather than
 * which are seen, which is what moves the page.
 */

afterEach(() => {
	cleanup();
	act(() => setLocale("en"));
});

describe("Steady", () => {
	it("draws every language, and shows and says only the reader's", () => {
		const { container } = render(<Steady phrase="Start" />);
		const said = [...container.querySelectorAll("[lang]")];
		expect(said.map((one) => one.getAttribute("lang"))).toEqual(["en", "zh-Hans", "zh-Hant", "ja"]);

		const shown = said.filter((one) => !one.classList.contains("invisible"));
		expect(shown.map((one) => one.textContent)).toEqual(["Start"]);
		for (const hidden of said.filter((one) => one.classList.contains("invisible"))) {
			expect(hidden.getAttribute("aria-hidden"), "a hidden language is read aloud").toBe("true");
		}
	});

	it("names a button in the reader's language alone", () => {
		render(
			<button type="button">
				<Steady phrase="Start" />
			</button>,
		);
		expect(screen.getByRole("button").textContent).toContain("开始");
		expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();

		act(() => setLocale("zh-Hans"));
		expect(screen.getByRole("button", { name: "开始" })).toBeTruthy();
	});

	it("changes which words are seen, not which are there, as the language changes", () => {
		const { container } = render(<Steady phrase="Admin console" />);
		const before = container.innerHTML.replace(/ class="[^"]*"| aria-hidden="true"/g, "");

		act(() => setLocale("zh-Hans"));
		const after = container.innerHTML.replace(/ class="[^"]*"| aria-hidden="true"/g, "");
		expect(after, "the words drawn changed with the language, and so would their size").toBe(before);

		const shown = [...container.querySelectorAll("[lang]")].filter((one) => !one.classList.contains("invisible"));
		expect(shown.map((one) => one.getAttribute("lang"))).toEqual(["zh-Hans"]);
	});
});
