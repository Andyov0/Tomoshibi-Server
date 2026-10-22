// A room held under a scope, driven end to end.
//
// The unit tests settle who the door admits and what the token says. They
// cannot settle that the account page makes a link that works, that a guest's
// screen shows the name the link was made for and the room's roster shows the
// same one, that a stranger is turned away with something to press, that a
// link made in the call dies with the meeting while a lasting one outlives it,
// or that a guest whose window closed while they were in the call is still
// there after the media server has renewed their token. Each of those is the
// real thing or it is not the claim.
//
// Three browsers: the member, the guest whose link has a window, and a stranger
// who later comes in on a lasting link.
//
//   cd web && pnpm run build && cd ..
//   go build -o /tmp/tomoshibi . && /tmp/tomoshibi /tmp/scoped.yaml &
//   dev/twobrowsers/launch.sh start 9361 9362 9363
//   node dev/twobrowsers/scoped.mjs http://127.0.0.1:8080 '<administrator passphrase>'
//   dev/twobrowsers/launch.sh stop
//
// It refuses to run against a server that is not serving the client on disk.
//
// The administrator is needed to make the two accounts and give one of them the
// scope, and to ask the media server who is in the room — which is the
// authority on what name somebody is wearing, rather than the screen.
//
// The last part waits six minutes, because that is what it takes to cross a
// token renewal: the media server renews every connected participant's token
// every five, keeping their name, and a guest whose window had closed being
// dropped at that moment is exactly the failure being looked for. Pass --quick
// to skip it.
//
// Exits non-zero when anything fails.

import { cdp, mouse, set, wait } from "./drive.mjs";

const AT = process.argv[2] ?? "http://127.0.0.1:8080";
const ADMIN = process.argv[3] ?? "";
const QUICK = process.argv.includes("--quick");

// Which three browsers, so that two deployments can be driven at once:
// BROWSERS=9364,9365,9366 for a second set.
const [MEMBER, GUEST, STRANGER] = (process.env.BROWSERS ?? "9361,9362,9363").split(",").map(Number);

const RUN = process.pid;
const SCOPE = `acme${RUN % 1000}`;
const ROOM = `standup-${RUN}@${SCOPE}`;
const ADA = { name: `ada${RUN}`, passphrase: `ada's passphrase ${RUN}` };
const BOB = { name: `bob${RUN}`, passphrase: `bob's passphrase ${RUN}` };

// Where the interface keeps the language somebody chose. See live/i18n.ts.
const LANGUAGE_KEY = "meet-live.locale";

let failed = 0;
function check(what, ok, detail) {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n        ${detail}` : ""}`);
}

function finish() {
	console.log(failed ? `\n${failed} failed` : "\nall good");
	process.exit(failed ? 1 : 0);
}

// The management session, from the administrator's passphrase.
async function administrator() {
	const response = await fetch(`${AT}/api/admin/session`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ passphrase: ADMIN }),
	});

	const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
	if (!response.ok || !cookie) {
		console.log(`FAIL  the administrator could not sign in: ${response.status}`);
		process.exit(1);
	}

	return async (path, init = {}) => {
		const answer = await fetch(`${AT}/api/admin${path}`, {
			...init,
			headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
		});

		return { status: answer.status, body: await answer.json().catch(() => undefined) };
	};
}

// Who the media server says is in the room, by name.
async function inTheRoom(admin) {
	const said = await admin(`/rooms/${encodeURIComponent(ROOM)}/participants`);

	return (said.body ?? []).map((one) => ({ name: one.name, proven: one.trip?.proven, identity: one.identity }));
}

// Back to a page with nothing kept from before: storage cleared at the
// deployment's own origin, and the cookies, so a session or a spent link from an
// earlier step is not what the next one is about.
async function fresh(page, url) {
	await page.go("about:blank");
	await wait(300);
	await page.go(`${AT}/`);
	await wait(800);
	// And the language pinned, because every check below reads English and a
	// headless browser takes the machine's — which on the machine this was
	// written on is Chinese, so the first run found no button called Join.
	await page.run(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem(${JSON.stringify(LANGUAGE_KEY)}, "en"); 1`);
	await page.send("Network.clearBrowserCookies");
	await page.go("about:blank");
	await wait(300);
	await page.go(url);
	await wait(3000);
}

const inCall = `!!document.querySelector('button[aria-label="Leave"]')`;

// A link made on the account page, as a member would: signed in, the form
// filled, the button pressed, the link read off the page, signed out again.
async function makeLink(page, { name = "", until = "" } = {}) {
	await fresh(page, `${AT}/account`);

	await set(page, 'input[autocomplete="username"]', ADA.name);
	await set(page, 'input[autocomplete="current-password"]', ADA.passphrase);
	await mouse(page).click("Sign in", true);
	await wait(2000);

	await set(page, 'input[aria-label="Room name"]', ROOM.split("@")[0]);
	if (name) await set(page, 'input[aria-label="Their name, if the link is for one person"]', name);
	if (until) await set(page, 'input[type="datetime-local"]', until);
	await wait(300);

	await mouse(page).click("Make a link", true);
	await wait(1500);

	const made = await page.run(`(() => {
		const p = [...document.querySelectorAll("p.readout")].find((e) => e.textContent.includes("?invite="));
		const said = [...document.querySelectorAll("p")].find((e) => /This link works/.test(e.textContent));
		return JSON.stringify({ link: p ? p.textContent : "", said: said ? said.textContent : "" });
	})()`);

	await mouse(page).click("Sign out", true);
	await wait(800);

	return JSON.parse(made);
}

// The join screen's button, once the screen is there.
async function join(page) {
	await mouse(page).click("Join", true);
	await wait(5000);

	return page.run(inCall);
}

// A local wall-clock time, as the browser's picker writes one, this many
// minutes past the start of the coming minute.
function minutesAhead(minutes) {
	const at = new Date(Date.now() + 60_000 * minutes);
	at.setSeconds(0, 0);

	const pad = (n) => String(n).padStart(2, "0");

	return {
		at,
		typed: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
	};
}

// The server under test must be serving the client on disk.
//
// What handover.mjs says about this happened here too. The servers for a second
// run were started on a fresh binary while the first ones were still holding
// the ports, because they had been started as ./tomoshibi and the pkill meant
// to end them named the absolute path. The new processes failed to bind and
// exited in the background, the health check was answered by the old ones, and
// a run reported a panel the code no longer drew. The page names the bundle it
// wants and the build wrote the one it made; if those differ, nothing below is
// about the working tree.
async function serving() {
	const { readdirSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");

	const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist", "assets");
	const built = readdirSync(dist).find((name) => /^index-.*\.js$/.test(name));

	const page = await (await fetch(`${AT}/`)).text();
	const asked = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(page)?.[1];

	if (!built || !asked || built !== asked) {
		console.log("FAIL  the server is not serving the client on disk");
		console.log(`        page wants ${asked}, the build made ${built}`);
		console.log("        an old process is probably still holding the port");
		process.exit(1);
	}
}

await serving();

// --- set up ---------------------------------------------------------------

const admin = await administrator();

for (const person of [ADA, BOB]) {
	const made = await admin("/accounts", { method: "POST", body: JSON.stringify(person) });
	if (made.status !== 200) {
		console.log(`FAIL  could not make ${person.name}: ${made.status} ${JSON.stringify(made.body)}`);
		process.exit(1);
	}
}

const tagged = await admin(`/accounts/${ADA.name}`, { method: "PATCH", body: JSON.stringify({ scopes: [SCOPE] }) });
check(`${ADA.name} is given ${SCOPE}`, tagged.status === 200, JSON.stringify(tagged.body));

const member = cdp(MEMBER);
const guest = cdp(GUEST);
const stranger = cdp(STRANGER);

for (const page of [member, guest, stranger]) {
	await page.open();
	await page.send("Network.enable");

	// The panel waits on its clipboard write before it lets go of the next
	// press, and a headless page that does not think it has focus can leave
	// that write unanswered — which would hold "Close the room" behind a link
	// that was already on screen.
	await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
	await page
		.send("Browser.grantPermissions", { origin: AT, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] })
		.catch(() => {});
}

console.log(`\n${ROOM}\n`);

// --- a member, by passphrase ----------------------------------------------

await fresh(member, `${AT}/#/${ROOM}`);
await set(member, 'input[aria-label="Your name"]', "Ada");
await set(member, 'input[aria-label="Passphrase"]', ADA.passphrase);
check("a member enters by passphrase", await join(member), await member.text());

check(
	"a member is offered the room's controls",
	await member.run(`!!document.querySelector('button[aria-label="Running this room"]')`),
);

// --- a stranger, by name alone --------------------------------------------

await fresh(stranger, `${AT}/#/${ROOM}`);
await set(stranger, 'input[aria-label="Your name"]', "Stranger");
await set(stranger, 'input[aria-label="Passphrase"]', BOB.passphrase);
const strangerIn = await join(stranger);
const strangerSees = await stranger.text();

check("somebody outside the scope is turned away", !strangerIn, strangerSees);
check(
	"and told who the room is for",
	strangerSees.includes(`Only members of ${SCOPE} can join`),
	strangerSees,
);
check("and offered the knock", strangerSees.includes("Ask to be let in"), strangerSees);

// --- a lasting link, made on the account page -----------------------------

const lasting = await makeLink(stranger);
check("a link with no end says so", /until somebody stops it/.test(lasting.said), JSON.stringify(lasting));

await fresh(stranger, lasting.link);
check(
	"its guest is asked for a name",
	await stranger.run(`(() => { const f = document.querySelector('input[aria-label="Your name"]'); return !!f && !f.readOnly; })()`),
);
await set(stranger, 'input[aria-label="Your name"]', "Visitor");
check("its guest is let in", await join(stranger), await stranger.text());

let present = await inTheRoom(admin);
check(
	"the media server has the visitor as a guest",
	present.some((one) => one.name === "Visitor" && !one.proven),
	JSON.stringify(present),
);

// --- a link made in the call, the meeting ends, and only the lasting link works

await member.run(`(() => { const b = document.querySelector('button[aria-label="Running this room"]'); b && b.click(); return 1; })()`);
await wait(800);

// With somebody else in the list, so that a missing Make host is the scope and
// not an empty roster.
const panel = JSON.parse(
	await member.run(`JSON.stringify({
		others: [...document.querySelectorAll('button[aria-label="Remove from room"]')].length,
		handover: !!document.querySelector('button[aria-label="Make host"]'),
		invite: document.body.innerText.includes("Invite somebody"),
	})`),
);
check(
	"the panel offers no handover in a scoped room, and makes a link as a plain room's does",
	panel.others > 0 && !panel.handover && panel.invite,
	JSON.stringify(panel),
);

await mouse(member).click("Invite somebody", true);
await wait(1500);

const inCallLink = await member.run(
	`(() => { const p = [...document.querySelectorAll("p.readout")].find((e) => e.textContent.includes("?invite=")); return p ? p.textContent : ""; })()`,
);
const afterInvite = await member.text();
check("a link made in the call is shown", inCallLink !== "", afterInvite);
check(
	"and said to last until the meeting ends",
	afterInvite.includes("until you end the meeting") && afterInvite.includes("It stops working after a day"),
	afterInvite,
);
check(
	"and the revoke beside it says it stops every link, the standing ones included",
	afterInvite.includes("Stop every link to this room working"),
	afterInvite,
);

const inCallToken = inCallLink ? new URL(inCallLink).searchParams.get("invite") : "";
const before = await fetch(`${AT}/api/invites/${encodeURIComponent(inCallToken)}`);
const beforeSaid = await before.json().catch(() => ({}));
check(
	"the link made in the call works while the meeting runs, and names no end",
	before.status === 200 && beforeSaid.expires === undefined,
	`${before.status} ${JSON.stringify(beforeSaid)}`,
);

await mouse(member).click("End this meeting", true);
await wait(500);
check(
	"ending says which links stop and which do not",
	(await member.text()).includes("links made on an account page do not"),
	await member.text(),
);
await mouse(member).click("Close the room", true);
await wait(4000);

check("ending the meeting puts the guest out", !(await stranger.run(inCall)), await stranger.text());

const after = await fetch(`${AT}/api/invites/${encodeURIComponent(inCallToken)}`);
check("the link made in the call stops working when the meeting ends", after.status === 404, String(after.status));

await fresh(stranger, lasting.link);
await set(stranger, 'input[aria-label="Your name"]', "Visitor");
check("the same lasting link lets them back in after the meeting ended", await join(stranger), await stranger.text());

// --- a member back in, and a guest with a window and a name --------------

await fresh(member, `${AT}/#/${ROOM}`);
await set(member, 'input[aria-label="Your name"]', "Ada");
await set(member, 'input[aria-label="Passphrase"]', ADA.passphrase);
check("the member comes back", await join(member), await member.text());

// A minute or so ahead, so the guest is in before the window closes and is
// then in the call when it does.
const closes = minutesAhead(2);
const windowed = await makeLink(guest, { name: "Client Co", until: closes.typed });
check("a link with an end says when", /This link works until/.test(windowed.said), JSON.stringify(windowed));
check("and who it is for", /joins as Client Co/.test(windowed.said), JSON.stringify(windowed));

await fresh(guest, windowed.link);
const field = JSON.parse(
	await guest.run(`(() => { const f = document.querySelector('input[aria-label="Your name"]'); return JSON.stringify(f ? { value: f.value, locked: f.readOnly } : {}); })()`),
);
check("the guest's name is the link's, and fixed", field.value === "Client Co" && field.locked, JSON.stringify(field));
check("the guest is told when the link stops", /This link works until/.test(await guest.text()), await guest.text());
check("the guest is let in", await join(guest), await guest.text());

await wait(2000);
present = await inTheRoom(admin);
check(
	"the media server has the guest under the link's name, unproven",
	present.some((one) => one.name === "Client Co" && !one.proven),
	JSON.stringify(present),
);
check("the member sees the guest by that name", (await member.text()).includes("Client Co"), await member.text());

if (QUICK) {
	member.close();
	guest.close();
	stranger.close();
	finish();
}

// --- past the window, and past a token renewal ----------------------------

console.log(`\nwaiting six minutes, past ${closes.at.toLocaleTimeString()} and a token renewal...`);
await wait(6 * 60_000 + 15_000);

check("the guest is still in the call", await guest.run(inCall), await guest.text());

present = await inTheRoom(admin);
check(
	"and the media server still has them, under the same name",
	present.some((one) => one.name === "Client Co" && !one.proven),
	JSON.stringify(present),
);

// The documented limit, checked rather than assumed: the window is over, so the
// same link is refused to anybody arriving now, a reload included.
const token = new URL(windowed.link).searchParams.get("invite");
const late = await fetch(`${AT}/api/invites/${encodeURIComponent(token)}`);
check("the link itself is refused once its window has closed", late.status === 410, String(late.status));

member.close();
guest.close();
stranger.close();
finish();
