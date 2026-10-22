// A host who moves their own meeting, and whether they still run it afterwards.
//
// Moving a room ends the call and every tab comes straight back. The rejoin
// used to send an empty passphrase, which mints a mark drawn from nothing — so
// the host arrived on the new machine as somebody else, with the room still
// answering to the mark they no longer had. Every control they had a moment ago
// answered 403, and the way back was to leave and join again with the
// passphrase they had typed two minutes earlier.
//
// Needs a deployment with two relays, which is what /tmp/two.yaml is for. The
// relays do not have to exist: what is under test is who somebody is when they
// come back, and that is settled by the join rather than by the media.
//
//   node dev/twobrowsers/moved.mjs http://127.0.0.1:39487 <admin-passphrase>
//
// Exits non-zero when it fails.

const AT = process.argv[2] ?? "http://127.0.0.1:39487";
const ROOM = `moved-${process.pid}`;

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

// The server under test must be running the client on disk. See handover.mjs
// for what this is guarding: an old process outliving the one that replaced it
// makes every reading below true of the wrong build.
async function serving(at) {
	const { readdirSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");

	const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist", "assets");
	const built = readdirSync(dist).find((name) => /^index-.*\.js$/.test(name));

	const page = await (await fetch(`${at}/`)).text();
	const asked = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(page)?.[1];

	if (!built || !asked || built !== asked) {
		console.log("FAIL  the server is not serving the client on disk");
		console.log(`        page wants ${asked}, the build made ${built}`);
		process.exit(1);
	}
}

await serving(AT);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The document is fetched again per field: React replaces nodes as it
// re-renders, so an id taken before the first field was typed into resolves to
// nothing and DOM.querySelector answers zero rather than an error.
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

const hosting = `[...document.querySelectorAll("button")]
	.some((b) => /running this room/i.test(b.getAttribute("aria-label") || b.textContent || ""))`;

const page = cdp(9341);
await page.open();

let failed = 0;
function check(what, ok, detail) {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `\n        ${detail}` : ""}`);
}

const SECRET = "the-hosts-own-passphrase";

await page.go("about:blank");
await wait(400);
await page.go(`${AT}/`);
await wait(800);
await page.run("localStorage.clear(); sessionStorage.clear(); 1");
await page.go("about:blank");
await wait(300);
await page.go(`${AT}/#${ROOM}`);
await wait(3500);

await type(page, 'input[aria-label="Your name"]', "Alice");
await wait(200);
await type(page, 'input[aria-label="Passphrase"]', SECRET);
await wait(200);

const filled = await page.run(
	`(() => { const f = document.querySelector('input[aria-label="Passphrase"]'); return f ? f.value.length : -1; })()`,
);
if (filled !== SECRET.length) {
	console.log(`FAIL  the passphrase did not go in (${filled} of ${SECRET.length})`);
	process.exit(1);
}

await page.run(
	`(() => { const b = [...document.querySelectorAll("button")].find(x => /join/i.test(x.textContent)); if (b && !b.disabled) b.click(); })()`,
);
await wait(4000);

check("the room answers to whoever opened it with a passphrase", await page.run(hosting));

console.log("\nthe room is moved to the other machine...");

// From here rather than from inside the page, and that is the whole of why this
// test was worth writing carefully.
//
// Signing in as an administrator in the browser under test leaves a management
// cookie on it, and the check for who may run a room accepts a management
// session that may moderate. So the tab passes every assertion below on the
// strength of the cookie, whoever it came back as — which is exactly what
// happened, and made a run with the fix removed report that everything was
// fine.
const session = await fetch(`${AT}/api/admin/session`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ name: "adam", passphrase: process.argv[3] ?? "" }),
});

if (!session.ok) {
	console.log(`FAIL  could not sign in to move the room: ${session.status}`);
	process.exit(1);
}

const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0];

const put = await fetch(`${AT}/api/admin/rooms/${ROOM}/relay`, {
	method: "PUT",
	headers: { "Content-Type": "application/json", Cookie: cookie },
	body: JSON.stringify({ relay: "tokyo", now: true }),
});

console.log(" ", put.status, (await put.text()).slice(0, 120));

// What is on screen while it happens, sampled through the move rather than
// after it. The rejoin has always worked; what this is checking is that it does
// not look like being thrown out — the room used to come down and the join
// screen appear, and a person watching that says the meeting ended.
const seen = [];
for (let i = 0; i < 14; i++) {
	seen.push(
		await page.run(`(() => {
			const said = document.querySelector('[role="status"]');
			const joining = [...document.querySelectorAll("button")].some((b) => /^join$/i.test((b.textContent || "").trim()));
			return JSON.stringify({ moving: Boolean(said), text: said ? said.textContent.slice(0, 40) : "", joining });
		})()`),
	);
	await wait(500);
}

const frames = seen.map((one) => JSON.parse(one));

check(
	"the move is said on screen while it happens",
	frames.some((f) => f.moving),
	frames.find((f) => f.moving)?.text ?? "(never shown)",
);

check(
	"and the join screen is never what somebody is left looking at",
	!frames.some((f) => f.joining && !f.moving),
	JSON.stringify(frames.filter((f) => f.joining).slice(0, 3)),
);

check(
	"and it goes away again",
	!frames[frames.length - 1]?.moving,
	JSON.stringify(frames[frames.length - 1]),
);

// Asked of the server rather than read off the screen, and that distinction is
// the whole test.
//
// The button is drawn from a reading this tab holds, and a tab that has just
// rejoined may still be showing the answer it had a moment ago — so a run with
// the fix removed reported everybody fine while the media server's own log
// showed the person coming back under a "g" identity, which is a mark drawn
// from nothing. Every arrival is written down with the identity it came in on,
// and that is the fact.
const arrivals = await fetch(`${AT}/api/admin/rooms/${ROOM}/participants`, { headers: { Cookie: cookie } });
const people = arrivals.ok ? await arrivals.json() : undefined;

const marks = JSON.stringify(people ?? {});
const proven = (marks.match(/"identity":"t/g) ?? []).length;
const drawnFromNothing = (marks.match(/"identity":"g/g) ?? []).length;

check(
	"comes back as who they were rather than as a stranger with their name",
	proven >= 1 && drawnFromNothing === 0,
	`proven ${proven}, unproven ${drawnFromNothing} — ${marks.slice(0, 200)}`,
);

// Kept as a reading rather than as a check, because it is not one. It passed
// in both directions while the identity above was the thing that changed: the
// button is drawn from a reading the tab already had, and a tab that has just
// come back may be showing the answer from before it left. Printed because it
// is what a person would look at, and it is worth knowing that looking is not
// enough.
console.log(`      (the panel says ${await page.run(hosting)}, which is not evidence)`);

page.close();

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
