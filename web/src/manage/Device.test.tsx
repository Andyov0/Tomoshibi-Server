import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setLocale } from "@/live/i18n";
import { Device, DeviceLine } from "./Device";

/*
 * What the rooms page says somebody joined from.
 *
 * The faults are quiet ones: an app's kind not matched shows every iPhone as
 * "something else", and a browser's name split wrongly from its version shows
 * "WeChat 8" untranslated to the people most likely to be using it.
 */

afterEach(() => setLocale("en"));

it("names an app, its version, its system and its model", () => {
	render(
		<Device client={{ kind: "iphone", app: "0.1.0.8", system: "iOS 27.0.1", device: "iPhone17,1", agent: "Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)" }} />,
	);

	const shown = screen.getByTitle("Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)");
	// What it is on one line, and the system and the model whole on the next,
	// rather than all of it on one line cut short.
	const [what, where] = shown.querySelectorAll("span.block");
	expect(what?.textContent).toBe("iPhone app 0.1.0.8");
	expect(where?.textContent).toBe("iOS 27.0.1 · iPhone17,1");
	expect(shown.querySelector(".truncate")).toBeNull();
});

it("names a browser as the people here would, with its version kept", () => {
	setLocale("zh-Hans");
	const { container } = render(<Device client={{ kind: "web", browser: "WeChat 8", system: "Android 14" }} />);

	expect(container.textContent).toBe("微信 8Android 14");
});

it("names the Linux app, with its distribution and its machine", () => {
	const { container } = render(
		<Device client={{ kind: "linux", app: "0.1.7", system: "Ubuntu 24.04.4 LTS", device: "LENOVO 21K5 x86_64" }} />,
	);

	expect(container.textContent).toBe("Linux app 0.1.7Ubuntu 24.04.4 LTS · LENOVO 21K5 x86_64");
});

// A Linux machine's name is the firmware's maker and product with the
// processor last, and runs to seventy characters. Held to one line, as every
// part was, it was clipped at 375 on the list of lockouts and the log page,
// the processor with it. jsdom lays nothing out, so this holds the rule that
// does it: no part is kept from breaking, and none breaks unless it must.
it("lets a Linux machine's long name break rather than be clipped", () => {
	const machine = "Parallels International GmbH. Parallels ARM Virtual Machine aarch64";
	const client = { kind: "linux", app: "0.1.7", system: "Debian GNU/Linux 13 trixie", device: machine };

	const line = render(<DeviceLine client={client} />).container;
	const part = [...line.querySelectorAll("span")].find((one) => one.textContent === machine);
	expect(part).toBeDefined();
	expect(part?.className).not.toContain("whitespace-nowrap");
	expect(part?.className).toContain("min-w-0");

	const lines = render(<Device client={client} />).container;
	const kept = [...lines.querySelectorAll("span")].find((one) => one.textContent === machine);
	expect(kept?.className).not.toContain("whitespace-nowrap");
	expect(kept?.className).toContain("max-w-full");
});

it("says an older app is an app", () => {
	const { container } = render(<Device client={{ kind: "app" }} />);

	expect(container.textContent).toBe("An older app that did not say which");
});

it("draws nothing for a join recorded before this was kept", () => {
	const { container } = render(<Device />);

	expect(container.textContent).toBe("");
});
