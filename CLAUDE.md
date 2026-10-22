# Working on Tomoshibi

Read this before changing anything. It is not a style guide in the usual sense:
most of what follows is here because getting it wrong has already cost somebody
an afternoon, and the reason is recorded so the rule can be argued with rather
than merely obeyed.

## What this is

A video meeting server in one binary. Go compiles LiveKit's server in as a
library and serves the built client from an `embed.FS`, so one process holds the
media server, the API, and the pages. There is no second service, no shared
secret to distribute, and one TCP port facing the network.

The same binary is three things, decided by `role`. A `full` deployment is one
machine and is what the README describes. A `control` node holds the store, the
management pages and the client, and holds no media. A `relay` holds media and
nothing else — no store, no pages, no administrators — and several of them share
one cluster through redis, so a meeting can be held on whichever machine is
nearest to the people in it.

Most of the work in this fork is in that split, and none of it is in the file
map above: `internal/admin/enrol.go` and `install.go` bring a relay up from one
line on a new machine, `internal/app/certificate.go` and
`internal/rtc/certificate.go` keep the fleet's certificates current from the
control node, `internal/dns` creates and removes each relay's DNS record,
`internal/app/reachable.go` decides which relays clients are offered, and
`internal/app/silent.go` is what lets a relay in mainland China answer nothing
that would identify it as a website. RELAY.md is the document for all of this.
`dev/viahk/` is the routing that gets a mainland relay's overseas traffic onto a
usable path, and has its own README.

Go 1.26, pnpm, React, Tailwind v4, Vite. `pnpm`, never `npm` or `bun` — the
lockfile is `pnpm-lock.yaml` and it is committed.

## The three ideas everything else follows from

**A room is a name.** There is no room object on the server and no membership
table. `POST /api/rooms/{name}/join` mints a token for one room and one identity
and that is the whole of it. Nothing is created first and nothing is cleaned up
after. When a feature seems to need a room object, it does not — it needs
something about a *name*, and the only moment anybody asks for a name is the
join.

**The layout unit is a picture, not a person.** Somebody sharing their screen
with their camera on contributes two, which is why `Surface` exists and why every
layout function takes surfaces. Their voice and the sound of their screen are two
tracks and two separate decisions, for the same reason.

**An identity is signed into the token.** A display name, a signature, and
whether that signature was earned all travel inside the identity the media server
enforces. Nothing about a participant that matters is a claim they send
alongside; it is part of what they provably are. A `t` prefix is a signature
derived from a passphrase, stable across visits; `g` is one drawn from nothing,
fresh every tab. Anything worth remembering about somebody is remembered against
the first kind, because the second is not a person, it is a string.

## Comments

Comments say **why**, in prose, in the third person, about the thing rather than
about the change. They are the reason this codebase can be picked up again after
a month, and they are held to a higher standard than the code.

- No `// increment the counter`. If the code says it, do not repeat it.
- Say what was considered and rejected, and what breaks if it is undone. A
  comment that only describes the present tells nobody why not to change it.
- Where a fault prompted the code, name the fault. Half of this repository's
  comments exist because a symptom pointed away from its cause, and writing that
  down is what stops the next person chasing the symptom.
- Personified where it reads naturally — a store *admits* one process, a policy
  *asks* for an administrator, a refusal *says* something. Never chatty.
- No emoji anywhere: not in code, comments, commit messages, the interface, or
  the documentation.
- Never sign anything as written by an assistant, in code or in a commit.

Package and file headers carry the argument; function comments carry the local
reason. Long block comments at the top of a test file explaining what class of
fault it guards are normal here and wanted.

## Tests

Test the thing that would go wrong silently. Type errors are caught by the
compiler and do not need a test; a rule enforced in the wrong place does.

- **A test that passes when the code is broken is worse than no test.** Break the
  guard, watch the test go red, put it back. This has already caught one test
  that aged its own input by the very constant it was checking and so passed for
  any value, and one that asserted the absence of something that was never going
  to be there.
- Test through the router, not the handler. A handler tested directly is a
  handler tested with its gate removed.
- Where a gate needs a concrete dependency to be exercised, the dependency is the
  problem. `internal/admin` names a narrow interface for each thing it needs —
  fourteen of them now — for exactly this reason; the API held a real media server
  once and sat at nothing per cent.
- Verify against the real thing when the claim is about the real thing. Two
  headless browsers with `--use-fake-device-for-media-stream` have settled more
  arguments here than any amount of reasoning, and the media server's own debug
  log is the authority on whether a client's request reached it.
- Do not trust a library's documentation over its source. Several decisions here
  rest on reading `node_modules/livekit-client/dist/livekit-client.esm.mjs`, and
  at least one README example in that package describes an API that no longer
  exists.

## The client

**Every phrase goes through `t()` and lives in all four dictionaries.** English,
Simplified Chinese, Traditional Chinese, Japanese. English is the key as well as
the value, so a missing translation falls back to a readable sentence. A test
compares every dictionary against the English one in both directions, so a phrase
that is no longer said fails just as a missing one does. Reuse an existing phrase
before adding a near-duplicate.

**Errors are `sonner`, everywhere, including the management pages.** Something
still true stays put and something that already happened fades. A refused device
and a room that would not open are things somebody has to act on, so they have no
duration; a press that did not take is over, so it goes.

**The server sends a code; the client owns the sentence.** `rate_limited` on a
screen is an implementation detail escaping, and it escapes untranslated.

**Storage keys keep the old product name on purpose.** They are what a browser
already has written down. Renaming one abandons it.

**The passphrase is kept in local storage, in the clear, on purpose.** The rule
here used to read "a secret does not go in local storage" and say that this
application stores none of it. That was never true of the code: `PreJoin.tsx`
writes `meet-live.passphrase` on every join, so that the field is filled next
time. It is offered to the browser's password manager as well — which is
encrypted, behind the machine's lock, syncs to somebody's other devices, and is
the better home of the two — and the local copy is the one that guarantees the
field is filled for somebody who has no manager or declined to use it.

What it buys, said accurately, because the comment beside it understated this
for a while: a passphrase is a display name nobody else can wear, **and** it is
what makes somebody the host of a room they opened — moving the call to another
machine, removing people, muting them, ending the meeting. The join field is
also where an **administrator** types their administrator passphrase, since the
same field is tested against the administrator list, so an administrator who
does that leaves that credential in local storage in the clear.

And, since scopes, it is **membership**. The same field is tested against the
accounts, and a passphrase belonging to an account tagged `acme` lets whoever
holds it into every room named `…@acme`, run every one of them — mute, remove,
end, move, answer the door — whether or not they are in it, and send links into
them that work until they are revoked, possibly for ever. The copy in local
storage is a key to a group's meetings, not one person's room.

This is an accepted risk on this deployment rather than an oversight: the cost
of the alternative is retyping a passphrase on every visit, which is how a
field stops being filled at all. Anybody weighing it again should weigh that,
not the older and gentler claim that the worst it buys is a name.

The sealing word for an encrypted call is a different secret and is **not**
kept anywhere — see `live/secrecy.ts`.

**Dependencies are counted, not assumed.** `src/dependencies.test.ts` walks every
import and compares both directions against the manifest, because an unused
package makes nothing slower and is therefore never found. Prefer a dependency
over hand-rolling — the context menu shares every transitive package with the
dropdown that was already installed — but prefer the platform over a dependency,
which is why the password manager holds passwords and the browser draws the
slider.

## Go

- `internal/room` depends on nothing else in this repository. Keep it that way;
  `config` and `store` both import it.
- Errors read as sentences and name the thing that failed and the way out. The
  startup checks exist so that a mistyped configuration is a message rather than
  a door that opens for nobody.
- Refuse at startup what cannot mean anything, but never refuse in a way that
  turns one broken thing into an outage. A store that will not answer lets a join
  through and says so loudly, because it cannot tell an unused name from one a
  meeting is happening in.

  The one deliberate exception is a room held under a scope, which is refused
  while the store is down. That rule protects a first use, by people who already
  know the name; the scope protects every use, and letting it through would hand
  the meeting to whoever guessed the name. `internal/app/scope.go` carries the
  argument, and a test holds both directions apart.
- `gofmt`, `go vet`, and `go test ./...` before every commit. The race detector
  when anything concurrent moved.

## Commits

Prose, not a changelog. Say what was wrong, what was considered, what was chosen,
and what was verified — in enough detail that somebody reading it in a year does
not have to reconstruct the argument from the diff. Record the things found by
testing rather than reasoning, especially where the first guess was wrong.

Never attribute a commit to an assistant.

## Before finishing

```bash
gofmt -l . && go vet ./... && go test ./...
cd web && pnpm run check && pnpm test
```

And, when anything about media, layout, or the browser changed: build the client,
run the server, and drive it with two headless browsers. The unit tests cannot
see a black tile, a silent call, or a menu that will not open.
