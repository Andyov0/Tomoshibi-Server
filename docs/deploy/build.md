# 3. Building

[Back to the guide](../../DEPLOY.md)

One binary holds the server, the embedded media server and the web client.
The client is compiled in, so it is built first and every time: a stale
`web/dist` is a stale application with no sign of it.

## Toolchain

| Tool | Version | Why |
| --- | --- | --- |
| Go | 1.26 (`go.mod` says `go 1.26.0`, `toolchain go1.26.10`) | The server. A Go older than 1.26.10 fetches go1.26.10 by itself because of the `toolchain` line, unless `GOTOOLCHAIN=local` forbids it. |
| Node.js | a version Vite 7 supports (20.19 or later, or 22.12 or later) | Building the client. |
| pnpm | 10.32.1 (`packageManager` in `web/package.json`) | The client's package manager. `corepack enable` provides the pinned version. |
| git | any | The build reads its revision from the repository; see [Which build is this](#which-build-is-this). |

**pnpm, never npm, yarn or bun.** The lockfile is `web/pnpm-lock.yaml` and it
is committed; the others would resolve a different tree from the same
manifest. `.gitignore` refuses their lockfiles for that reason.

## Build

```bash
# The client, into web/dist, which the binary embeds.
cd web
corepack enable            # once per machine, for the pinned pnpm
pnpm install --frozen-lockfile
pnpm run build             # tsc --noEmit && vite build
cd ..

# The server, for a Linux machine on x86-64.
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w -buildid=" -o tomoshibi .
```

- `-s -w` strips the symbol table and debug information.
- `-buildid=` empties the build ID, which is what makes two builds of one
  commit byte-identical. That is the way to tell whether the binary on a
  machine is the one that was meant to be there: build the same commit and
  compare SHA-256 sums.
- `CGO_ENABLED=0` gives a static binary that runs on any Linux of that
  architecture.

If `web/dist` holds nothing but its `.gitkeep` marker, the binary still builds
and serves one page saying which command to run, and logs `no client was built
into this binary, serving instructions instead`.

## Other architectures

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags="-s -w -buildid=" -o tomoshibi-arm64 .
```

The control node hands relays its **own running binary** at enrolment, so the
fleet enrolled from one control node shares its architecture. To enrol relays
of a different architecture, point `meet.enrol.binary` at a build for them
(the endpoint then serves that file to every relay that enrols), or install
those relays by hand.

## What comes out

| Artifact | Where | Notes |
| --- | --- | --- |
| `tomoshibi` | repository root | The only file a machine needs. Ignored by git. |
| `web/dist/` | inside the repository | The built client, embedded at compile time. Ignored by git except `.gitkeep`. |

The repository's own `.gitignore` also ignores the development tools when built
in the root (`/roster`, `/peekroom`, `/turncheck`, `/snicheck`, `/udpcheck`,
`/ascstub`). Build them with `-o` somewhere else anyway; a forty-megabyte
binary was once committed by accident.

## Which build is this

```bash
tomoshibi version
```

prints the first twelve characters of the commit and its time, for example
`0123456789ab 2026-10-21T09:12:00Z`. It is read out of the Go build
information, not stamped in by a flag:

- built from a working tree with uncommitted changes, it says
  `<revision>+changes`;
- built outside a git checkout, it says `unknown (built outside a repository)`.

The same string is in the startup log line `settings: this deployment`, under
`build`. Upgrade scripts compare it to decide whether a machine came back on
the new build.

## The development tools

Small programs under `dev/`, each built on demand:

```bash
go build -o /tmp/roster    ./dev/roster     # add or remove an administrator in the store
go build -o /tmp/udpcheck  ./dev/udpcheck   # STUN to a relay's probe port
go build -o /tmp/turncheck ./dev/turncheck  # whether a relay grants a TURN allocation
go build -o /tmp/snicheck  ./dev/snicheck   # whether a path filters by the TLS name
go build -o /tmp/peekroom  ./dev/peekroom   # what the store recorded about one room
go build -o /tmp/mint      ./dev/crossrelay # a join token for connecting straight to a relay
```

Cross-compile them the same way (`GOOS=linux GOARCH=amd64`) to run them on a
server. Chapter 9 says when each is useful.

## Tests

```bash
gofmt -l . && go vet ./... && go test ./...
cd web && pnpm run check && pnpm test
```

The behaviour that needs a real call (frames arriving, layout, menus) is
driven with headless Chrome: `dev/twobrowsers/` (see its README). It uses
Chrome for Testing and fake media devices, never the browser you use day to
day.

## Running it locally

```bash
cd dev && ../tomoshibi meet.yaml
```

`dev/meet.yaml` is a single-machine configuration with development
credentials and `web_root: ../web/dist`, so a client rebuild shows on reload
without recompiling the server. Open the printed URL and pick a room with
`#/room-name`; two windows are a call with yourself. `pnpm run dev` in `web/`
runs Vite and proxies the API and signalling to that server.

Development credentials must never reach a machine anybody else can reach.

### The TestFlight stand-in

`dev/ascstub` answers the four App Store Connect requests an invitation makes,
so the iOS invitation flow can be tried without inviting a real person. It
works only with a binary built with the `ascstub` tag; a release build cannot
be pointed anywhere but Apple. See [chapter 8](native-apps.md#trying-it-without-apple).
