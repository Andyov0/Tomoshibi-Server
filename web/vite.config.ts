import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where the server is listening while developing. */
const server = "http://127.0.0.1:8080";

/**
 * Put back the marker file the server's embed directive needs.
 *
 * The repository tracks web/dist/.gitkeep so that a fresh clone has a directory
 * for `//go:embed all:web/dist` to read before any client has been built; without
 * it the server does not compile at all. Vite empties the output directory
 * before every build and takes the marker with it, so each build left the file
 * deleted in the working tree, which is the likeliest way it came to be listed in
 * .gitignore as tracked while never actually having been committed.
 */
function keepMarker(): Plugin {
	return {
		name: "keep-embed-marker",
		apply: "build",
		closeBundle() {
			writeFileSync(resolve("./dist/.gitkeep"), "");
		},
	};
}

/**
 * The progress bar each document draws for itself, before any script or
 * stylesheet has arrived (components/TopProgress.tsx takes it over).
 *
 * The page's arrival is the wait the bar is most wanted for: on a slow line
 * the script is most of a megabyte and the window stays blank while it comes,
 * and a bar that only began once the script had run would begin after the
 * wait it was for. So the document draws one with nothing but a rule of its
 * own, growing quickly and then ever more slowly towards most of the way, and
 * shown only once 150 milliseconds have gone, as the component shows a wait,
 * so a page that arrives at once does not flash it.
 *
 * Drawn the same as the component's, in the person's colour as the stylesheet
 * gives it by day and by night, the night as the document's own script sets it
 * for a reload in the middle of a call. Put into every document here rather
 * than written into each, so the three cannot come to draw it differently.
 */
const BOOT_PROGRESS_CSS = [
	"#boot-progress{position:fixed;top:0;left:0;right:0;height:2px;z-index:100;pointer-events:none;",
	"transform-origin:0 50%;transform:scaleX(0);background:#f2901e;box-shadow:0 0 10px #f2901e;",
	"animation:boot-progress-grow 12s cubic-bezier(.08,.7,.25,1) forwards,boot-progress-show .15s linear .15s both}",
	"@media (prefers-color-scheme:dark){#boot-progress{background:oklch(.79 .157 64);box-shadow:0 0 10px oklch(.79 .157 64)}}",
	"[data-appearance=night] #boot-progress{background:oklch(.79 .157 64);box-shadow:0 0 10px oklch(.79 .157 64)}",
	"@media (prefers-reduced-motion:reduce){#boot-progress{animation:boot-progress-show 1ms linear .15s both;transform:scaleX(.5)}}",
	"@keyframes boot-progress-grow{from{transform:scaleX(.04)}to{transform:scaleX(.85)}}",
	"@keyframes boot-progress-show{from{opacity:0}to{opacity:1}}",
].join("");

/**
 * What the first paint needs before the stylesheet has arrived, besides the bar.
 *
 * The page's own background, by day and by night as the stylesheet decides
 * them. With the stylesheet moved below the bar, the first paint no longer
 * waits for it, and that paint was the browser's own white until the
 * stylesheet arrived and turned it grey: every page opened, and every move
 * between the lobby, the account and the management pages, which are separate
 * documents, flashed.
 *
 * And a fade between those documents rather than one replacing the other
 * (cross-document view transitions), which the owner asked for when moving
 * between the pages "jumped about": opted into here, in the head, because the
 * new document has to say so before its first paint, which comes before its
 * stylesheet. Browsers without them simply replace the page, as before.
 */
const FIRST_PAINT_CSS = [
	"html{background:oklch(.165 .003 68)}",
	"@media (prefers-color-scheme:light){html:not([data-appearance=night]){background:#f2f2f7}}",
	"@view-transition{navigation:auto}",
	"::view-transition-old(root),::view-transition-new(root){animation-duration:.2s}",
	"@media (prefers-reduced-motion:reduce){@view-transition{navigation:none}}",
].join("");

function bootProgress(): Plugin {
	return {
		name: "boot-progress",
		transformIndexHtml: {
			order: "post",
			handler(html) {
				// The stylesheet moved from the head to just after the bar. In
				// the head it held back the first paint of the whole document,
				// the bar with it: on a slow line measured at 120 KB/s the page
				// stayed blank, bar and all, for the three seconds the stylesheet
				// took. In the body it holds back only what comes after it, so
				// the bar is drawn at once; and the script still waits for it, as
				// a script waits for any stylesheet before it, so the page is
				// never drawn without its styles.
				const sheets = html.match(/<link rel="stylesheet"[^>]*>\s*/g) ?? [];
				let moved = html;
				for (const sheet of sheets) moved = moved.replace(sheet, "");
				return moved
					.replace("</head>", `<style>${FIRST_PAINT_CSS}${BOOT_PROGRESS_CSS}</style>\n</head>`)
					.replace(/<body([^>]*)>/, `<body$1>\n<div id="boot-progress" aria-hidden="true"></div>\n${sheets.join("").trim()}`);
			},
		},
	};
}

export default defineConfig({
	plugins: [react(), tailwindcss(), keepMarker(), bootProgress()],
	resolve: {
		alias: {
			"@": resolve("./src"),
		},
	},
	build: {
		rollupOptions: {
			// Two pages rather than one with a route in it. The management code
			// then never reaches a participant: it is not in their bundle, not
			// in a chunk their bundle knows the name of, and on a deployment
			// with no administrator configured the server does not serve this
			// document at all — which a route inside the client could not be,
			// since both would be the same file.
			input: {
				index: resolve("./index.html"),
				admin: resolve("./admin.html"),
				account: resolve("./account.html"),
			},
		},
	},
	server: {
		port: 5173,

		// Explicitly IPv4, because `localhost` resolves to `::1` here and binding
		// only there leaves `http://127.0.0.1:5173` refusing connections. Bound to
		// `127.0.0.1` instead, both spellings reach it: a client given the name
		// tries `::1` first and falls back, which one given a literal address
		// cannot do.
		//
		// Loopback only. Another machine should be pointed at the server itself,
		// which serves the built client on one origin with the API and the
		// signalling; the dev server has no business being reachable.
		host: "127.0.0.1",

		proxy: {
			"/api": server,

			// Signalling, forwarded so the client can be developed against a
			// running server without knowing it lives somewhere else. `ws` because
			// this one is an upgrade rather than a request.
			"/rtc": { target: server, ws: true },
			"/twirp": server,
		},
	},
	test: {
		// The hooks under test render, so they need a document. Node alone would
		// fail on the first one with an error that says nothing about hooks.
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
	},
});
