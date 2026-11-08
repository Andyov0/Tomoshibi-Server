import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/*
 * An action that cannot be taken yet is grey, not a fainter amber.
 *
 * The owner's rule for every client: the one action on a screen is the
 * amber, and disabled it is the neutral grey, because a pale amber still
 * reads as the button to press and somebody presses it and nothing happens.
 * The primary variant draws exactly that. The default variant is the amber
 * as well and fades to forty per cent when disabled, which is right for a
 * switch that is on and wrong for an action, and two actions were left on it:
 * the management page's sign-in, whose "Sign in" stayed a pale orange until
 * both fields were filled, and the send button under the messages. Neither
 * looked broken in a shot that was not taken empty.
 *
 * So a Button that can be disabled names its variant. A variant chosen by an
 * expression is a switch showing its state, and is left to its caller.
 */

const root = join(import.meta.dirname, "..", "..");

function sources(dir: string): { path: string; text: string }[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.tsx$/.test(entry.name) && !entry.name.includes(".test.") ? [{ path, text: readFileSync(path, "utf8") }] : [];
	});
}

it("never leaves an action that can be disabled on the amber that fades", () => {
	const faded = sources(root).flatMap(({ path, text }) =>
		[...text.matchAll(/<Button\b([^>]*?)>/gs)]
			.map((m) => m[1] ?? "")
			.filter((attributes) => /\bdisabled\b/.test(attributes))
			.filter((attributes) => !/\bvariant=/.test(attributes) || /\bvariant="default"/.test(attributes))
			.map((attributes) => `${path.replace(root, "")}: <Button${attributes.replace(/\s+/g, " ").slice(0, 80)}`),
	);

	expect(faded, "an amber action disabled to a pale amber rather than grey; give it variant=\"primary\"").toEqual([]);
});

it("draws the primary disabled in the neutral grey", () => {
	const button = readFileSync(join(root, "components/ui/button.tsx"), "utf8");
	const primary = /primary: cn\(([\s\S]*?)\),/.exec(button)?.[1] ?? "";

	expect(primary).toContain("disabled:bg-surface-hi");
	expect(primary).toContain("disabled:text-fg-muted");
	expect(primary).toContain("disabled:opacity-100");
});
