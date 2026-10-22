// Whether a sealed call is actually sealed, and whether an unsealed one still
// works.
//
// Nothing in a unit test can answer this. What is claimed is that frames leave
// the browser encrypted, that the media server forwards something it cannot
// read, and that two people who typed the same word can see each other through
// it — three facts about three processes. The SDK reports the middle one
// itself: `room.isE2EEEnabled`, and every remote participant carries an
// encryption state the receiving end works out from the frames it is actually
// getting.
//
// The check that matters most is the negative one. A call somebody was told is
// encrypted and is not is the single failure here that must not be quiet, so
// this asserts that a room built without a word reports itself unencrypted
// rather than trusting that it would have said so.
//
//   cd web && pnpm run build && cd ..
//   go build -o /tmp/tomoshibi . && /tmp/tomoshibi /tmp/dev.yaml &
//   for p in 9341 9342; do
//     chrome --headless=new --remote-debugging-port=$p \
//       --user-data-dir=$(mktemp -d) --use-fake-device-for-media-stream \
//       --use-fake-ui-for-media-stream --mute-audio about:blank &
//   done
//   node dev/twobrowsers/sealed.mjs http://127.0.0.1:39687
//
// --mute-audio matters: the fake microphone emits a beep once a second, and
// two of these in one room decode each other's tone straight into the
// speakers, which sounds exactly like the machine developing a fault.
//
// Exits non-zero when it fails.

const AT = process.argv[2] ?? "http://127.0.0.1:8080";

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

// See handover.mjs. An old process outliving the one meant to replace it makes
// every reading here true of the wrong build.
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

// Skipped against the dev server, which serves modules rather than a built
// bundle — and which is what this has to run against, because the handle it
// reads is only present in a development build. A page that hands its room
// object to anything on the page is a page where an extension can end the call.
if (!AT.includes(":5173")) await serving(AT);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

let failed = 0;
function check(what, ok, detail) {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `\n        ${detail}` : ""}`);
}

async function join(page, room, name, word) {
	await page.go("about:blank");
	await wait(400);
	await page.go(`${AT}/`);
	await wait(700);
	await page.run("localStorage.clear(); sessionStorage.clear(); 1");
	await page.go("about:blank");
	await wait(300);
	await page.go(`${AT}/#${room}`);
	await wait(3500);

	await type(page, 'input[aria-label="Your name"]', name);
	await wait(200);

	if (word) {
		// The control is folded away, because it is not a question most people
		// should be asked.
		await page.run(`(() => {
			const b = [...document.querySelectorAll("button")]
				.find((x) => /seal this call/i.test(x.textContent || ""));
			if (b) b.click();
		})()`);
		await wait(500);

		await type(page, 'input[aria-label="Sealing word"]', word);
		await wait(200);

		const filled = await page.run(
			`(() => { const f = document.querySelector('input[aria-label="Sealing word"]'); return f ? f.value.length : -1; })()`,
		);
		if (filled !== word.length) {
			console.log(`FAIL  the sealing word did not go in (${filled} of ${word.length})`);
			process.exit(1);
		}
	}

	await page.run(
		`(() => { const b = [...document.querySelectorAll("button")].find(x => /join/i.test(x.textContent)); if (b && !b.disabled) b.click(); })()`,
	);
	await wait(5000);
}

// What the SDK says about the room this tab is in.
//
// `isEncrypted` on a participant is not what it sounds like: it reports that
// the publisher declared encryption in signalling, not that this end can read
// them. So two people with different words both report each other encrypted,
// and an assertion built on it passes for a pair who cannot hear one another.
// That is what the first version of this asserted, and it failed correctly.
//
// What says the key is wrong is RoomEvent.EncryptionError, which the SDK raises
// when a frame arrives that it cannot make sense of. Counted from the moment
// the listener is installed, so it has to go on before anybody joins.
const listen = `(() => {
	window.__errors = 0;
	const held = window.__room;
	if (!held) return false;
	held.on("encryptionError", () => { window.__errors += 1; });
	return true;
})()`;

const sealedness = `(() => {
	const held = window.__room;
	if (!held) return JSON.stringify({ reachable: false });
	return JSON.stringify({
		reachable: true,
		mine: held.isE2EEEnabled === true,
		declared: [...held.remoteParticipants.values()].map((p) => p.isEncrypted === true),
		unreadable: window.__errors || 0,
		people: held.remoteParticipants.size,
	});
})()`;

const alice = cdp(9341);
const bob = cdp(9342);
await alice.open();
await bob.open();

// ---- a call nobody sealed ----
const plain = `plain-${process.pid}`;
await join(alice, plain, "Alice", "");
await join(bob, plain, "Bob", "");
await wait(2000);

await alice.run(listen);
const aPlain = JSON.parse(await alice.run(sealedness));

if (!aPlain.reachable) {
	console.log("the client does not expose the room; add `window.__room = made` in App.tsx to run this");
	process.exit(1);
}

check("a call nobody sealed reports itself unsealed", aPlain.mine === false, JSON.stringify(aPlain));
check("and the two of them are in it", aPlain.people === 1, JSON.stringify(aPlain));

// ---- a call both sealed ----
const shut = `sealed-${process.pid}`;
await join(alice, shut, "Alice", "open sesame");
await join(bob, shut, "Bob", "open sesame");
await wait(3000);

await alice.run(listen);
await wait(3000);
const aShut = JSON.parse(await alice.run(sealedness));
const bShut = JSON.parse(await bob.run(sealedness));

check("a sealed call reports itself sealed at both ends", aShut.mine === true && bShut.mine === true,
	`${JSON.stringify(aShut)} ${JSON.stringify(bShut)}`);

check(
	"and each can read the other",
	aShut.declared.every(Boolean) && aShut.declared.length === 1 && aShut.unreadable === 0,
	JSON.stringify(aShut),
);

// ---- two people who typed different words ----
//
// The one that says the key is doing anything. Both ends encrypt, both report
// themselves sealed, and neither can read the other: the receiving end works
// out that state from the frames it is actually getting, so "not encrypted" for
// a participant who is encrypting is the SDK saying it cannot make sense of
// them. Somebody who was told the wrong word joins and hears nothing, which is
// the behaviour the whole feature rests on.
const apart = `apart-${process.pid}`;
await join(alice, apart, "Alice", "open sesame");
await alice.run(listen);
await join(bob, apart, "Bob", "a different word");

// Long enough for frames to arrive and fail. Nothing is raised until something
// is actually sent, so this waits on the call rather than on the connection.
await wait(9000);

const aApart = JSON.parse(await alice.run(sealedness));

check(
	"somebody with the wrong word cannot be read",
	aApart.mine === true && aApart.unreadable > 0,
	JSON.stringify(aApart),
);

alice.close();
bob.close();

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
