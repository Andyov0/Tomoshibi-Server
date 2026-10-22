import { expect, it, vi } from "vitest";
import { compare } from "./freshness";

/*
 * Telling a page it is older than the server.
 *
 * The first build seen is the page's own; only a later, different one is news,
 * and it is said once however often it is seen again. An empty build is a
 * server that does not know or will not say, and is never news -- a development
 * server must not tell every open page to reload each time it restarts.
 */

it("says nothing while the build stays the same", () => {
	const onNewer = vi.fn();
	const seen = compare(onNewer);

	seen("aaa");
	seen("aaa");
	seen("aaa");

	expect(onNewer).not.toHaveBeenCalled();
});

it("says so once when the build changes", () => {
	const onNewer = vi.fn();
	const seen = compare(onNewer);

	seen("aaa");
	seen("bbb");
	seen("bbb");
	seen("ccc");

	expect(onNewer).toHaveBeenCalledTimes(1);
});

it("never compares a build nobody knows", () => {
	const onNewer = vi.fn();
	const seen = compare(onNewer);

	seen("");
	seen("aaa");
	seen("");

	expect(onNewer).not.toHaveBeenCalled();
});
