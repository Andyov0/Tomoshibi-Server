/**
 * Stopping the SDK from asking a relay a question over HTTPS.
 *
 * When a signalling WebSocket fails to open, livekit-client does not report
 * that failure directly. It first sends an ordinary HTTPS GET to the same
 * address with `/validate` appended, reads the status, and uses it to phrase a
 * better error: 404 becomes "upgrade your server", 401 and 403 become "not
 * allowed". The intent is kind and on an ordinary deployment it costs nothing.
 *
 * On this one it costs the deployment. A relay in mainland China is taken off
 * the air by something that opens its port, sends an ordinary request, and
 * reads what comes back — an answer identifies a website, and an unregistered
 * website is blocked. Every other HTTPS request this project made to a relay
 * has been removed for that reason: the dashboard now times a TCP connection,
 * the client times the signalling upgrade, and the relays no longer serve a
 * health endpoint at all. This request is the one that was left, and it is the
 * worst-shaped of them — it fires precisely when a relay is already in trouble,
 * it repeats on every reconnection attempt, and it carries the access token in
 * the query string where the earlier ones carried nothing.
 *
 * It also cannot succeed here. A relay runs silent: anything that is not a
 * WebSocket upgrade has its connection closed without a reply. So the request
 * fails, the SDK learns nothing from it, and the error it finally reports is
 * the one it already had before asking. Removing it loses no diagnosis.
 *
 * There is no option to switch it off — the URL is derived inside the SDK from
 * the address being dialled, and nothing is passed in that could suppress it.
 * The alternative was patching the published bundle, which pins this project to
 * one version of a minified file. Answering the request here instead is narrow
 * enough to read, survives an SDK upgrade, and fails visibly rather than
 * silently if the SDK ever stops making the call.
 */

/**
 * Whether a request is the SDK's validation probe.
 *
 * Matched on the path alone, and on both spellings the SDK uses: it picks
 * between the v0 and v1 signalling paths by what the server supports, and falls
 * back from one to the other during a connection. Nothing else in this
 * application fetches anything under `/rtc`, which is what makes a test this
 * narrow safe — the media server's own paths are dialled as WebSockets, never
 * fetched.
 */
export function isValidationProbe(url: string): boolean {
	let path: string;
	try {
		path = new URL(url, "http://relay.invalid").pathname;
	} catch {
		return false;
	}

	return path === "/rtc/validate" || path === "/rtc/v1/validate";
}

/**
 * What the SDK is told instead.
 *
 * 204 rather than an error, and deliberately not one of the statuses the SDK
 * inspects. Its handler switches on 404, 401 and 403 to replace the error with
 * a more specific one, and anything else falls through to returning the
 * WebSocket failure it already had. That fallthrough is the honest answer: the
 * connection failed for whatever reason the socket gave, and this project has
 * decided not to ask a relay to elaborate.
 */
function unanswered(): Response {
	return new Response(null, { status: 204, statusText: "No Content" });
}

/** Set once, so that repeated calls do not wrap the wrapper. */
let installed = false;

/**
 * Install the guard over the global fetch.
 *
 * Global because the call being intercepted is made from inside a dependency,
 * from a function this project neither calls nor can reach. The predicate is
 * kept as narrow as it can be for the same reason: this replaces fetch for the
 * whole document, and everything it does not recognise must reach the network
 * exactly as it would have.
 *
 * Idempotent, and called from [create] rather than at module scope so that
 * importing this file in a test does not silently replace fetch for every other
 * test in the file.
 */
export function installNoValidate(): void {
	if (installed || typeof globalThis.fetch !== "function") {
		return;
	}

	installed = true;

	const original = globalThis.fetch.bind(globalThis);

	globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;

		if (isValidationProbe(url)) {
			return Promise.resolve(unanswered());
		}

		return original(input, init);
	};
}

/** Undo the guard. For tests, which must not leak a patched fetch. */
export function uninstallNoValidate(original: typeof globalThis.fetch): void {
	globalThis.fetch = original;
	installed = false;
}
