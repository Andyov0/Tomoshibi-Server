import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { start } from "@/live/i18n";
import { Notices } from "@/components/room/Notices";
import { Manage } from "./Manage";

/**
 * The management pages, entered from their own document.
 *
 * Their own rather than a route inside the client, for two reasons that both
 * come to the same thing. None of this reaches a participant: it is not in
 * their bundle and not in a chunk their bundle knows the name of. And where
 * nobody has configured an administrator the server serves no document here at
 * all, which a route could not be — a route and the client would be one file.
 *
 * The language is chosen the same way the client chooses it, and offered in the
 * rail. This used to say that none was chosen and none offered, on the ground
 * that whoever reads these pages runs the deployment — which is true and is not
 * an argument for reading them in a second language. The pages are translated;
 * without this they were translated into a language nothing ever selected.
 */
start();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<Manage />
		{/* The same notices the client raises, in the same corner, following the
		    same rule: an action that failed is something that happened and
		    fades; a panel that cannot reach the server is something still true
		    and stays where the missing figures are. */}
		<Notices />
	</StrictMode>,
);
