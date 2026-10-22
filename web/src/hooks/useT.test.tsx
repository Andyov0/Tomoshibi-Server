import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/live/i18n";
import { Phrased, useT } from "./useT";

/*
 * What these guard is that changing language changes what is on screen.
 *
 * The language is held outside React, which is what lets a notice raised from an
 * event handler use the same words as a button. The cost of that choice is that
 * nothing about it forces a component to re-render: a component reading the
 * plain translator would keep showing the language it first rendered in, and
 * would go on doing so until something unrelated happened to redraw it.
 */

afterEach(() => act(() => setLocale("en")));

function Label() {
	const t = useT();
	return <span>{t("Leave")}</span>;
}

describe("useT", () => {
	it("says what the language in use says", () => {
		render(<Label />);
		expect(screen.getByText("Leave")).toBeDefined();

		act(() => setLocale("ja"));
		expect(screen.getByText("退出")).toBeDefined();
	});

	it("follows a change made from anywhere", () => {
		render(<Label />);

		// Not through a prop and not through a context: the language is set by
		// whoever set it, including code that owns no component at all.
		act(() => setLocale("zh-Hant"));
		expect(screen.getByText("離開")).toBeDefined();

		act(() => setLocale("zh-Hans"));
		expect(screen.getByText("离开")).toBeDefined();
	});

	it("tells the document what it is reading", () => {
		// Not decoration: a screen reader picks its voice from this, and a
		// browser picks line breaking and font fallback from it.
		act(() => setLocale("ja"));
		expect(document.documentElement.lang).toBe("ja");
	});
});

describe("Phrased", () => {
	it("puts the value where the translation put its placeholder", () => {
		const { container } = render(
			<Phrased
				phrase="Show {name} larger"
				values={{ name: <strong>Ada</strong> }}
			/>,
		);

		expect(container.querySelector("strong")?.textContent).toBe("Ada");
		expect(container.textContent).toBe("Show Ada larger");
	});

	/*
	 * The reason this exists rather than three concatenated fragments. Japanese
	 * puts the name first and English does not, so a sentence assembled from
	 * translated pieces can only ever come out in the order English wanted.
	 */
	it("lets the value move when the language moves it", () => {
		act(() => setLocale("ja"));

		const { container } = render(
			<Phrased
				phrase="Show {name} larger"
				values={{ name: <strong>Ada</strong> }}
			/>,
		);

		expect(container.textContent).toBe(t("Show {name} larger", { name: "Ada" }));
		expect(container.textContent).toContain("Ada");
		expect(container.querySelector("strong")).not.toBeNull();
	});
});
