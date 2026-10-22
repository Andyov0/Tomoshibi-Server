import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { deviceFailed } from "./notices";

/*
 * Two causes, two remedies. A refused permission is undone from the address
 * bar; a camera another application is holding is not, and sending somebody to
 * a permission they already granted sends them to the one place the fault is
 * not. The second used to say nothing at all.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(() => vi.mocked(toast.error).mockClear());

const said = () => (vi.mocked(toast.error).mock.calls[0]?.[1] as { description?: string })?.description;

it("points a refusal at the address bar", () => {
	deviceFailed("camera", new DOMException("denied", "NotAllowedError"));
	expect(said()).toBe("Allow access from the icon in the address bar.");
});

it("does not point a camera in use at a permission already granted", () => {
	deviceFailed("camera", new DOMException("in use", "NotReadableError"));
	expect(said()).toBe("Something else may be using it.");
});
