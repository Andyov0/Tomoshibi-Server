import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { start } from "@/live/i18n";
import { Notices } from "@/components/room/Notices";
import { Account } from "./Account";
import { Apps } from "./Apps";

/**
 * The page somebody looks after their own account from.
 *
 * Its own document, like the management pages and for the same reason: none of
 * this is in a participant's bundle, and a deployment with no accounts serves
 * nothing here at all rather than a route that refuses.
 *
 * Not the management pages, and it matters that it cannot become them. What
 * somebody does here is about their own account and their own browser: their
 * passphrase and picture, the links into their own scopes, what they have been
 * allowed to use — read, never changed — and how their calls start on this
 * machine. Everything that belongs to the deployment belongs to whoever runs it,
 * and is changed from there.
 */
// The management pages deliberately do not do this. This page is not them: it
// is where somebody who was handed an account goes to change the passphrase
// they were handed, which is the first thing they ever do here and the one page
// they arrive at without having chosen anything. Without this its phrases, and
// the document's own lang, stayed at the initial "en". It now has a language
// picker of its own as well, for the reader the browser guessed wrongly.
start();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The download page is this document at another address, and not a document of
// its own. It is behind the same session and signs people in with the same
// form; a fourth document would be a fourth bundle carrying that form, and the
// first place the two could come to disagree about who is signed in.
const downloads = window.location.pathname.replace(/\/+$/, "") === "/apps";

createRoot(root).render(
	<StrictMode>
		{downloads ? <Apps /> : <Account />}
		<Notices />
	</StrictMode>,
);
