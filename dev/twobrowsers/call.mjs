// Two browsers, one room, and the questions no unit test can answer.
//
// CLAUDE.md asks for this whenever media, layout or the browser changed, and it
// asks for it because the suite cannot see a black tile, a silent call, or a
// button underneath the controls. All three have happened here, and the last
// one shipped: the card offering the link to an empty room had its button
// completely covered by the control island, on every screen, for every release
// since the controls stopped being a footer.
//
// What it checks, in order, because each step is the setup for the next:
//
//   - two people can name themselves and get in
//   - turning on a camera produces frames at both ends, which is the only
//     evidence that the media path works at all
//   - one can leave, which is a different code path from the room ending
//   - and the one left behind can reach the button that is the entire point of
//     that screen: elementFromPoint at its centre has to be the button, not
//     whatever is drawn over it
//
// Run it against a local deployment, which needs no account:
//
//   cd web && pnpm run build && cd ..
//   go build -o /tmp/tomoshibi . && (cd dev && /tmp/tomoshibi serve meet.yaml &)
//   for p in 9341 9342; do
//     chrome --headless=new --remote-debugging-port=$p \
//       --user-data-dir=$(mktemp -d) --use-fake-device-for-media-stream \
//       --use-fake-ui-for-media-stream --mute-audio http://127.0.0.1:8080/ &
//   done
//   node dev/twobrowsers/call.mjs
//
// --mute-audio matters: the fake microphone emits a beep once a second, and
// two of these in one room decode each other's tone straight into the
// speakers, which sounds exactly like the machine developing a fault.
//
// One trap worth knowing before changing the selectors: the name field carries
// no type attribute, so input[type="text"] does not match it while
// HTMLInputElement.type still reports "text". It is found by its aria-label.

const ROOM = "room-c";

function cdp(port) {
	let ws, id = 0;
	const send = (m, params = {}) => new Promise((ok, bad) => {
		const mine = ++id;
		const on = (e) => { const x = JSON.parse(e.data); if (x.id !== mine) return; ws.removeEventListener("message", on); x.error ? bad(new Error(JSON.stringify(x.error))) : ok(x.result); };
		ws.addEventListener("message", on); ws.send(JSON.stringify({ id: mine, method: m, params }));
	});
	return {
		async open(mobile) {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const target = list.find((t) => t.type === "page");
			ws = await new Promise((ok, bad) => { const s = new WebSocket(target.webSocketDebuggerUrl); s.onopen = () => ok(s); s.onerror = bad; });
			await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
			if (mobile) await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
		},
		go: (url) => send("Page.navigate", { url }),
		send,
		async run(e) { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? "EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 180) : r.result.value; },
		close: () => ws.close(),
	};
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function type(page, selector, text) {
	const doc = await page.send("DOM.getDocument", {});
	const f = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
	if (!f.nodeId) return "not found";
	await page.send("DOM.focus", { nodeId: f.nodeId });
	for (const ch of text) { await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch }); await page.send("Input.dispatchKeyEvent", { type: "keyUp" }); }
	return "ok";
}

const alice = cdp(9341), bob = cdp(9342);
await alice.open(true); await bob.open(false);

for (const [who, page, name] of [["alice", alice, "Alice"], ["bob", bob, "Bob"]]) {
	await page.go(`http://127.0.0.1:8080/#${ROOM}`);
	await wait(3500);
	await type(page, 'input[aria-label="Your name"]', name);
	await wait(300);
	await page.run(`(() => { const b = [...document.querySelectorAll("button")].find(x => /join/i.test(x.textContent)); if (b && !b.disabled) b.click(); })()`);
	await wait(1500);
	console.log(`${who} 进房`);
}
await wait(6000);

for (const [, page] of [["alice", alice], ["bob", bob]]) {
	await page.run(`(() => { [...document.querySelectorAll("button")].filter(b => /camera|microphone/i.test(b.getAttribute("aria-label")||"")).forEach(b => b.click()); })()`);
}
await wait(7000);
console.log("\n两人通话中:");
for (const [who, page] of [["alice", alice], ["bob", bob]]) {
	console.log(`  ${who}: ${await page.run(`(() => { const v=[...document.querySelectorAll("video")]; return JSON.stringify({live: v.filter(x=>!x.paused&&x.videoWidth>0).map(x=>x.videoWidth+"x"+x.videoHeight)}); })()`)}`);
}

console.log("\nbob 离开…");
await bob.run(`(() => { const b = document.querySelector('button[aria-label*="Leave"]'); if (b) b.click(); })()`);
await wait(1800);
console.log("  确认按钮:", await bob.run(`[...document.querySelectorAll("button")].map(b=>(b.textContent||"").trim()).filter(Boolean).join(" | ").slice(0,150)`));
await bob.run(`(() => { const b = [...document.querySelectorAll("button")].find(x => /^(leave|end|hang)/i.test((x.textContent||"").trim())); if (b) b.click(); })()`);
await wait(6000);

console.log("\nalice 独自在房间时,复制链接按钮:");
console.log(await alice.run(`(() => {
	const buttons = [...document.querySelectorAll("button")];
	const copy = buttons.find(b => /copy|link/i.test((b.getAttribute("aria-label")||"") + " " + (b.textContent||"")));
	if (!copy) return JSON.stringify({ found: false, buttons: buttons.map(b => (b.getAttribute("aria-label")||b.textContent||"").trim()).filter(Boolean) });
	const r = copy.getBoundingClientRect();
	const at = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
	return JSON.stringify({ found: true, box: Math.round(r.top)+"-"+Math.round(r.bottom), viewport: innerHeight, clickable: copy.contains(at) || copy === at, topmost: at ? (at.getAttribute("aria-label") || at.className || at.tagName).toString().slice(0,40) : null });
})()`));
alice.close(); bob.close(); process.exit(0);
