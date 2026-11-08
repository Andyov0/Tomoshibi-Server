import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/live/i18n";
import { LinuxCommand, linuxCommand } from "./LinuxCommand";

/*
 * The command is pasted into a terminal and run, so what is guarded is that it
 * names the deployment the reader is on and the path the server answers
 * (internal/app/linux.sh is served at /linux.sh), and that Copy puts exactly
 * that on the clipboard: a command copied with a word missing or another
 * deployment's address runs somebody else's script, or nothing.
 */

afterEach(() => act(() => setLocale("en")));

describe("LinuxCommand", () => {
	it("is the page's own deployment's script, piped to sh", () => {
		expect(linuxCommand("https://meet.example.com")).toBe("curl -fsSL https://meet.example.com/linux.sh | sh");
	});

	it("shows the command for the page's origin and copies it whole", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

		render(<LinuxCommand origin="https://meet.example.com:8443" />);

		expect(screen.getByText("curl -fsSL https://meet.example.com:8443/linux.sh | sh")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("curl -fsSL https://meet.example.com:8443/linux.sh | sh"));
		expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
	});

	it("takes the address bar's origin where none is given", () => {
		render(<LinuxCommand />);
		expect(screen.getByText(`curl -fsSL ${window.location.origin}/linux.sh | sh`)).toBeDefined();
	});

	it("says what it does in the reader's language", () => {
		act(() => setLocale("zh-Hans"));
		render(<LinuxCommand origin="https://meet.example.com" />);

		expect(screen.getByText("不确定选哪个？把这条命令粘贴到终端里：")).toBeDefined();
		expect(screen.getByRole("button", { name: "复制" })).toBeDefined();
	});
});
