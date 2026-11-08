import { App } from "@/App";
import { Notices } from "@/components/room/Notices";
import { followTheSystem } from "@/live/appearance";
import { start } from "@/live/i18n";
import { watchRequests } from "@/live/progress";
import { listenForPresses } from "@/live/speakers";
import { TopProgress } from "@/components/TopProgress";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// Before anything is drawn, so nothing is drawn in the wrong language and
// corrected a frame later. The document's own `lang` is settled here too, which
// a screen reader has already read by the time the first component renders.
start();

// Day and night fade into each other, and nothing chases the fade (live/appearance.ts).
followTheSystem();

// Before the first press, because the first press is the one that matters: the
// press on Join is what lets this page's speakers play for every call after it,
// including the ones it rejoins by itself. See live/speakers.ts.
listenForPresses();

// Before the first request, so the page's arrival is counted from the start
// (live/progress.ts).
watchRequests();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<App />
		{/* At the root rather than inside the room. Anything that goes wrong
		    before there is a room — and the one thing that can, a room that will
		    not open — has somewhere to be said. */}
		<Notices />
		{/* After the page, so its first effect runs after the page's. */}
		<TopProgress />
	</StrictMode>,
);
