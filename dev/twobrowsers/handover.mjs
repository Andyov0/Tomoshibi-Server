// Handing a room over, and whether either screen notices.
//
// The standing is asked for on joining and again on two events: somebody
// leaving, and the connection changing state. A handover is neither, so both
// people used to find out about it when an unrelated third person left the
// call — the one giving it away kept a panel of controls that had all begun
// answering 403, and the one receiving it saw nothing at all.
//
// This cannot be a unit test. What is being checked is that a message the
// server publishes reaches two browsers and changes what is drawn in each, and
// every part of that is the real thing or it is not the claim.
//
//   cd web && pnpm run build && cd ..
//   go build -o /tmp/tomoshibi . && /tmp/tomoshibi /tmp/dev.yaml &
//   for p in 9341 9342; do
//     chrome --headless=new --remote-debugging-port=$p \
//       --user-data-dir=$(mktemp -d) --use-fake-device-for-media-stream \
//       --use-fake-ui-for-media-stream --mute-audio about:blank &
//   done
//   node dev/twobrowsers/handover.mjs http://127.0.0.1:8080
//
// --mute-audio matters: the fake microphone emits a beep once a second, and
// two of these in one room decode each other's tone straight into the
// speakers, which sounds exactly like the machine developing a fault.
//
// Exits non-zero when it fails.

const AT = process.argv[2] ?? "http://127.0.0.1:8080";
const ROOM = `handover-${process.pid}`;

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
			await send("DOM.enable");
		},
		go: (url) => send("Page.navigate", { url }),
		send,
		async run(e) {
			const r = await send("Runtime.evaluate", {
				expression: e,
				awaitPromise: true,
				returnByValue: true,
			});
			return r.exceptionDetails
				? `EXC:${JSON.stringify(r.exceptionDetails).slice(0, 200)}`
				: r.result.value;
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

// The name field carries no type attribute, so input[type="text"] does not match
// it while HTMLInputElement.type still reports "text". Both are found by their
// aria-label instead.
//
// The document is fetched again for each field rather than once. DOM.getDocument
// hands back a tree of node ids and React replaces nodes as it re-renders, so
// the id for the second field, taken from a tree read before the first field was
// typed into, resolves to nothing — and DOM.querySelector answers zero rather
// than an error. The passphrase silently never went in, the room answered to
// nobody, and the run failed three checks later with "alice does not run the
// room", which reads exactly like the thing under test.
async function type(page, selector, text) {
	const doc = await page.send("DOM.getDocument", { depth: -1 });
	const found = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
	if (!found.nodeId) return "not found";

	await page.send("DOM.focus", { nodeId: found.nodeId });
	for (const ch of text) {
		await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
		await page.send("Input.dispatchKeyEvent", { type: "keyUp" });
	}

	return "ok";
}

// Whether this browser is being shown the host's controls.
const hosting = `(() => {
	const labels = [...document.querySelectorAll("button")]
		.map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim());
	return JSON.stringify({
		// "Running this room" is the button that opens the panel and is drawn
		// only for whoever runs it, which is the whole question here.
		panel: labels.some((l) => /running this room/i.test(l)),
		labels: labels.filter(Boolean).slice(0, 12),
	});
})()`;

const alice = cdp(9341);
const bob = cdp(9342);
await alice.open();
await bob.open();

let failed = 0;
function check(what, ok, detail) {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `\n        ${detail}` : ""}`);
}

// Both with a passphrase, because a room answers to nobody unless whoever
// opened it could prove a name. On a deployment where nobody is asked for one,
// no room ever has a host and none of this exists.
for (const [who, page, name, secret] of [
	["alice", alice, "Alice", "alice-secret-one"],
	["bob", bob, "Bob", "bob-secret-two"],
]) {
	// Away from the origin and back, and the storage cleared, so a second run in
	// the same browser starts where the first one did. Without this the fields
	// keep what was typed into them and the second run's passphrase is the two
	// runs concatenated.
	await page.go("about:blank");
	await wait(400);
	await page.go(`${AT}/`);
	await wait(800);
	await page.run("localStorage.clear(); sessionStorage.clear(); 1");
	await page.go("about:blank");
	await wait(300);
	await page.go(`${AT}/#${ROOM}`);
	await wait(3500);
	await type(page, 'input[aria-label="Your name"]', name);
	await wait(200);
	await type(page, 'input[aria-label="Passphrase"]', secret);
	await wait(200);

	// Checked rather than assumed. A passphrase that did not land means an
	// unproven mark, which means the room answers to nobody, which shows up
	// three checks later as "alice does not run the room" — a failure that
	// reads like the thing under test and is not. It happened.
	const filled = await page.run(
		`(() => { const f = document.querySelector('input[aria-label="Passphrase"]'); return f ? f.value.length : -1; })()`,
	);
	if (filled !== secret.length) {
		console.log(`FAIL  ${who}'s passphrase did not go in (${filled} of ${secret.length})`);
		process.exit(1);
	}

	await page.run(
		`(() => { const b = [...document.querySelectorAll("button")].find(x => /join/i.test(x.textContent)); if (b && !b.disabled) b.click(); })()`,
	);
	await wait(4000);
	console.log(`${who} is in`);
}

await wait(2000);

const aliceBefore = JSON.parse(await alice.run(hosting));
const bobBefore = JSON.parse(await bob.run(hosting));

check("alice opened the room, so alice runs it", aliceBefore.panel, JSON.stringify(aliceBefore.labels));
check("bob does not", !bobBefore.panel, JSON.stringify(bobBefore.labels));

if (!aliceBefore.panel) {
	console.log("\nno host to hand over, so the rest cannot be checked");
	alice.close();
	bob.close();
	process.exit(1);
}

console.log("\nalice hands the room to bob...");

// The panel has to be opened first: its controls are not on the page until the
// button that opens it is pressed, so a script that looks for "Make host"
// straight away finds nothing and reports a handover that never happened. It
// did, once.
// Opened only if it is not already, because the button toggles: pressing it on
// an open panel closes it, and the next line then reports no Make host button
// and a handover that never happened. It did, once.
await alice.run(`(() => {
	const label = (x) => x.getAttribute("aria-label") || x.textContent || "";
	const buttons = [...document.querySelectorAll("button")];
	if (buttons.some((x) => /make host/i.test(label(x)))) return "already open";

	const b = buttons.find((x) => /running this room/i.test(label(x)));
	if (b) b.click();
	return "opened";
})()`);
await wait(1200);

const pressed = await alice.run(`(() => {
	const b = [...document.querySelectorAll("button")]
		.find((x) => /make host/i.test(x.getAttribute("aria-label") || x.textContent || ""));
	if (!b) return "no Make host button";
	b.click();
	return "pressed";
})()`);
console.log(" ", pressed);

await wait(3000);

const aliceAfter = JSON.parse(await alice.run(hosting));
const bobAfter = JSON.parse(await bob.run(hosting));

console.log();
check(
	"alice's controls go without waiting for anybody to leave",
	!aliceAfter.panel,
	JSON.stringify(aliceAfter.labels),
);
check("bob's arrive", bobAfter.panel, JSON.stringify(bobAfter.labels));

alice.close();
bob.close();

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
