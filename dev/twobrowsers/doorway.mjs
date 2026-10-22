// Which screen a stranger holding a room name actually lands on.
//
// The unit tests for this settle what the policy says. They cannot settle
// whether the policy is the thing the page runs — the decision used to live
// inside an effect that also connects to rooms and reads storage, and being
// unreachable from a test is exactly how it came to be wrong.
//
// The fault it is here to prevent: on a deployment where not everybody may
// start a meeting, somebody told the name of one landed on a sign-in page for
// an account they do not have, under a line reading "If somebody sent you a
// link, open that instead" — which is what they had just done. The server would
// have admitted them; only a name nobody has ever used is refused.
//
// Run it against a deployment with `rooms.opened_by: signed`:
//
//   cd web && pnpm run build && cd ..
//   go build -o /tmp/tomoshibi . && /tmp/tomoshibi /tmp/signed.yaml &
//   chrome --headless=new --remote-debugging-port=9341 \
//     --user-data-dir=$(mktemp -d) about:blank &
//   node dev/twobrowsers/doorway.mjs http://127.0.0.1:39377
//
// Exits non-zero when it fails, so it can be believed.

const AT = process.argv[2] ?? "http://127.0.0.1:39377";
const ROOM = `doorway-${process.pid}`;

function cdp(port) {
	let ws,
		id = 0;
	const send = (m, params = {}) =>
		new Promise((ok, bad) => {
			const mine = ++id;
			const on = (e) => {
				const x = JSON.parse(e.data);
				if (x.id !== mine) return;
				ws.removeEventListener("message", on);
				x.error ? bad(new Error(JSON.stringify(x.error))) : ok(x.result);
			};
			ws.addEventListener("message", on);
			ws.send(JSON.stringify({ id: mine, method: m, params }));
		});
	return {
		async open() {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const target = list.find((t) => t.type === "page");
			ws = await new Promise((ok, bad) => {
				const s = new WebSocket(target.webSocketDebuggerUrl);
				s.onopen = () => ok(s);
				s.onerror = bad;
			});
			await send("Page.enable");
			await send("Runtime.enable");
		},
		go: (url) => send("Page.navigate", { url }),
		async run(e) {
			const r = await send("Runtime.evaluate", {
				expression: e,
				awaitPromise: true,
				returnByValue: true,
			});
			return r.exceptionDetails ? `EXC:${JSON.stringify(r.exceptionDetails).slice(0, 200)}` : r.result.value;
		},
		close: () => ws.close(),
	};
}

// The server under test must be running the client on disk.
//
// A backgrounded process outlived the pkill meant to end it, so for thirteen
// minutes every reading here came from a binary thirteen minutes old. The
// measurements were consistent, repeatable and about the wrong build, and they
// said the fix under test made no difference — which was very nearly believed.
//
// Content-hashed bundle names make this cheap to check: the page names the one
// it wants and the build wrote the one it made, and if those differ then
// nothing below is about the code in the working tree.
//
// This catches a stale client and not a stale server. A run where only Go
// changed serves the same bundle and passes here, so the binary's own build is
// worth reading too — `tomoshibi version` prints it, and the startup log
// carries it.
async function serving(at) {
	const { readdirSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");

	const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist", "assets");
	const built = readdirSync(dist).find((name) => /^index-.*\.js$/.test(name));

	const page = await (await fetch(`${at}/`)).text();
	const asked = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(page)?.[1];

	if (!built || !asked || built !== asked) {
		console.log(`FAIL  the server is not serving the client on disk`);
		console.log(`        page wants ${asked}, the build made ${built}`);
		console.log(`        an old process is probably still holding the port`);
		process.exit(1);
	}
}

await serving(AT);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const page = cdp(9341);
await page.open();

// Storage cleared between navigations, because this is about somebody arriving
// for the first time and a tab that remembers being in the room takes a
// different path on purpose.
async function fresh(url) {
	await page.go(`${AT}/`);
	await wait(800);
	await page.run("localStorage.clear(); sessionStorage.clear(); 1");

	// Away from the origin and back, because navigating from "/" to "/#room"
	// changes only the fragment and a browser treats that as staying on the same
	// page: no load, no effect, and a harness that reports whatever the previous
	// screen was. This wasted a round of thinking the fix had not worked.
	await page.go("about:blank");
	await wait(300);
	await page.go(url);
	await wait(3000);
}

let failed = 0;
function check(what, got, want) {
	const ok = want(got);
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}\n        ${JSON.stringify(got)}`);
}

// The whole of the question: is the name field on the page, or a passphrase
// prompt for an account nobody has?
const screen = `(() => ({
	name: Boolean(document.querySelector('input[aria-label="Your name"]')),
	join: [...document.querySelectorAll("button")].some((b) => /join/i.test(b.textContent)),
	room: document.body.innerText.includes(${JSON.stringify(ROOM)}),
	text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 160),
}))()`;

console.log(`against ${AT}, room ${ROOM}\n`);

await fresh(`${AT}/#${ROOM}`);
const held = await page.run(screen);
check("a stranger holding a room name reaches the join screen", held, (s) => s.name && s.join);
check("and the room they were told is the one on the screen", held, (s) => s.room);

// The other half, which must not have been broken in the fixing. A bare
// address on this setting is somebody with no name and no account, and there is
// nothing for them but the sign-in.
await fresh(`${AT}/`);
const bare = await page.run(screen);
check("a bare address still reaches the sign-in", bare, (s) => !s.name);

page.close();

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
