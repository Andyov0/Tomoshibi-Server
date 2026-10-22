/**
 * Driving a browser from a script, shared by everything in this directory.
 *
 * Each script here grew its own copy of this and they drifted, which is how a
 * script came to click a toolbar button that merely opens a menu and report
 * that the share had started. One copy, and the two things every one of them
 * got wrong are fixed in it: a press lands where the element actually is, and
 * an element is found by what it says without a container winning over the
 * control inside it.
 *
 * Start the browsers with launch.sh, which uses a browser that is not the
 * person's own; see the note at the top of it.
 */

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A connection to one page. Nothing is enabled that is not asked for: a page
 * running WebRTC floods the socket with Runtime and Log events, and the
 * connection stops answering. */
export function cdp(port) {
	let ws;
	let id = 0;
	const pending = new Map();
	const events = [];

	const send = (method, params = {}) => {
		const mine = ++id;
		return new Promise((ok, bad) => {
			pending.set(mine, { ok, bad });
			ws.send(JSON.stringify({ id: mine, method, params }));
		});
	};

	return {
		events,
		send,
		async open() {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const target = list.find((t) => t.type === "page");
			ws = await new Promise((ok, bad) => {
				const s = new WebSocket(target.webSocketDebuggerUrl);
				s.onopen = () => ok(s);
				s.onerror = bad;
			});
			ws.addEventListener("message", (e) => {
				const x = JSON.parse(e.data);
				if (x.id && pending.has(x.id)) {
					const { ok, bad } = pending.get(x.id);
					pending.delete(x.id);
					if (x.error) bad(new Error(JSON.stringify(x.error)));
					else ok(x.result);
				} else if (x.method) {
					events.push(x);
				}
			});
		},
		go: (url) => send("Page.navigate", { url }),
		async run(expression) {
			const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			return r.result.value;
		},
		async text() {
			return String(await this.run("document.body.innerText")).replace(/\n+/g, " | ");
		},
		close: () => ws.close(),
	};
}

/** Pressing things the way a person does: real mouse events at the element's
 * centre, because `.click()` in the page is inert on Radix and on some React
 * controls. */
export function mouse(p) {
	const at = async (x, y) => {
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
			await p.send("Input.dispatchMouseEvent", {
				type,
				x,
				y,
				button: "left",
				buttons: type === "mousePressed" ? 1 : 0,
				clickCount: type === "mouseMoved" ? 0 : 1,
			});
			await wait(40);
		}
	};

	const box = async (match, exact = false) => {
		const found = await p.run(`(() => {
			const want = ${JSON.stringify(match)};
			const all = [...document.querySelectorAll("button,[role=menuitem],[role=menuitemcheckbox],li,a,div,input")];
			const hits = all.filter(e => {
				const t = (e.textContent || "").trim();
				const label = e.getAttribute("aria-label") || e.title || "";
				const said = ${exact} ? t === want : (t.includes(want) || label.includes(want));
				return said && e.children.length <= 3;
			});
			if (!hits.length) return null;
			// The smallest thing that says it, and among equals the one with the
			// least inside it: a row of two inputs and a button has exactly the
			// button's text, so by text alone the row won and the press landed
			// on an input.
			hits.sort((a, b) =>
				((a.textContent || "").length - (b.textContent || "").length) ||
				(a.querySelectorAll("*").length - b.querySelectorAll("*").length));
			const e = hits[0];
			// Into the viewport first: an event dispatched below the fold lands
			// on nothing and reads as a press that did nothing.
			e.scrollIntoView({ block: "center", inline: "nearest" });
			const r = e.getBoundingClientRect();
			if (!r.width || !r.height) return null;
			return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
		})()`);

		return found ? JSON.parse(found) : null;
	};

	return {
		at,
		box,
		async click(match, exact = false) {
			const b = await box(match, exact);
			if (!b) return false;
			await at(b.x, b.y);
			return true;
		},
		/**
		 * Press an item inside an open menu.
		 *
		 * The share control is a menu whose own last item is what starts the
		 * share; the toolbar button of the same name only opens it. Finding by
		 * text alone picks the toolbar button and nothing happens, which was
		 * read as the share failing for three runs.
		 */
		async menu(label) {
			const b = await p.run(`(() => {
				const it = [...document.querySelectorAll('[role^="menuitem"]')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}));
				if (!it) return "null";
				it.scrollIntoView({ block: "center" });
				const r = it.getBoundingClientRect();
				return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
			})()`);

			if (b === "null") return false;
			const { x, y } = JSON.parse(b);
			await at(x, y);
			return true;
		},
	};
}

/** Set a controlled input's value the way React notices. */
export async function set(p, selector, value) {
	return p.run(`(() => {
		const all = document.querySelectorAll(${JSON.stringify(selector)});
		const f = all[all.length - 1];
		if (!f) return "no";
		// The prototype the value setter lives on, not a guess. Calling the
		// HTMLInputElement setter on a textarea throws "Illegal invocation" and
		// takes the whole run down, which is how the chat box — the one
		// multi-line field in the room — stopped every script that typed into it.
		const proto =
			f instanceof HTMLSelectElement
				? HTMLSelectElement.prototype
				: f instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(f, ${JSON.stringify(String(value))});
		f.dispatchEvent(new Event("input", { bubbles: true }));
		f.dispatchEvent(new Event("change", { bubbles: true }));
		return "ok";
	})()`);
}
