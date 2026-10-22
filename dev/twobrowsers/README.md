# Driving a deployment with browsers

The unit tests cannot see a black tile, a share that will not start, or a menu
that will not open. These scripts can.

```bash
dev/twobrowsers/launch.sh start 9361 9362    # two browsers, one per port
node dev/twobrowsers/<script>.mjs
dev/twobrowsers/launch.sh stop               # always, when the batch is done
```

`launch.sh` uses **Google Chrome for Testing**, not the browser on the Dock.
Launching `/Applications/Google Chrome.app` headless registers with the same
bundle as the person's own Chrome, and from then on the Dock icon activates the
invisible test instance and Chrome "will not open". That happened twice. The
launcher refuses to run that bundle, and `stop` kills by PID — a name would
match the person's browser, and `pkill -f` matches its own command line.

`drive.mjs` is the shared hand: `cdp(port)`, `mouse(page)`, `set(page, …)`.

Three traps it already knows about, each of which produced a run that looked
like the product was broken:

- A press below the fold lands on nothing. Elements are scrolled into view.
- A row containing two inputs and a button has exactly the button's text and
  the same child count, so by text alone the row wins and the press lands on an
  input. Ties break on the element with least inside it.
- The share control is a **menu** whose own last item starts the share; the
  toolbar button of the same name only opens the menu. Use `mouse().menu(…)`
  for anything inside an open menu.
- A textarea is not an input. The value setter is per-prototype, and using the
  wrong one throws `Illegal invocation` — which ends the run, rather than
  failing the step, so it reads as the script hanging.

Two more that belong to the page rather than the rig:

- Changing only the fragment of the address is a same-document navigation: the
  page never reloads and the app stays in whatever room it was already in. Go
  to `about:blank` first.
- Clearing storage at `about:blank` clears `about:blank`'s storage. Do it at the
  deployment's own origin.
