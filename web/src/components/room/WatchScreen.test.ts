import { afterEach, expect, it } from "vitest";
import { rememberedVolume, siteOf } from "./WatchScreen";

/*
A video's volume, this viewer's own: full until they turn it down. Nothing kept
reads back as null, which made every video start silent.
*/

afterEach(() => localStorage.clear());

it("plays a video at full volume until told otherwise, and as told after", () => {
	expect(rememberedVolume()).toBe(1);
	localStorage.setItem("meet-live.watch-volume", "0.4");
	expect(rememberedVolume()).toBe(0.4);
	localStorage.setItem("meet-live.watch-volume", "-3");
	expect(rememberedVolume()).toBe(1);
});

it("names the site a viewer cannot reach as people say it, and nothing for what is not a web address", () => {
	expect(siteOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube.com");
	expect(siteOf("https://cdn.example.invalid/v.mp4")).toBe("cdn.example.invalid");
	expect(siteOf("javascript:alert(1)")).toBe("");
	expect(siteOf("library:home/1a2b")).toBe("");
	expect(siteOf("")).toBe("");
});
