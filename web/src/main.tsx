import { App } from "@/App";
import { Notices } from "@/components/room/Notices";
import { start } from "@/live/i18n";
import { listenForPresses } from "@/live/speakers";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// Before anything is drawn, so nothing is drawn in the wrong language and
// corrected a frame later. The document's own `lang` is settled here too, which
// a screen reader has already read by the time the first component renders.
start();

// Before the first press, because the first press is the one that matters: the
// press on Join is what lets this page's speakers play for every call after it,
// including the ones it rejoins by itself. See live/speakers.ts.
listenForPresses();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<App />
		{/* At the root rather than inside the room. Anything that goes wrong
		    before there is a room — and the one thing that can, a room that will
		    not open — has somewhere to be said. */}
		<Notices />
	</StrictMode>,
);
