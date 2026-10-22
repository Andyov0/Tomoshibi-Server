# Tomoshibi Server

> **A modified version** of [Tomoshibi](https://github.com/5t-RawBeRry/Tomoshibi) by
> 5t-RawBeRry, released under the same licence, AGPL-3.0. It is the server of the
> [Tomoshibi Native](https://github.com/Andyov0/Tomoshibi-Native) apps, which do not
> work with upstream Tomoshibi. It was forked from upstream on
> 2026-08-15 (eb0def1) and has been changed since by Andyov0; among what it adds:
>
> - media relays: a fleet of relay machines a room is placed on, picked by who is in it,
>   probed for whether media reaches them, a mainland relay carrying media with its
>   signalling through another (RELAY.md);
> - invitations and arranged meetings, opened from their names and handed to calendars;
> - watching a video together in step, the song desk and lossless music, a fuller voice,
>   stereo and an app's own sound;
> - raised hands and reactions, rejoining after a refresh, staying in a call when a
>   device fails;
> - the native apps: the download page, TestFlight invitations, and the apps' own
>   update checks and downloads;
> - more of the management surface: the relays, the load over six months, read-only
>   administrators.
>
> This repository is published without its development history: each update here is a
> snapshot of the deployment's own source. `dev/` holds the tools and notes that
> deployment is run with.

A video meeting server in one binary. The media server, the API, and the client
are compiled together into a single file: deploying is copying it to a machine
and running it, and there is nothing beside it to keep in step.

Somebody opens a link, is shown their own camera, types a name, and is in a
call. Nobody registers, and a deployment can run without a single account on it.
What it does have is a way of proving a name — a passphrase turns one into a
name nobody else can wear — a management surface for whoever runs the
deployment, a switch limiting new rooms to people who can prove one, and
accounts for the deployments that want them.

`tomoshibi` is Japanese for a small light left burning: a lamp in a window,
enough for the people who need it and no brighter.

```
main.go      Command dispatch, the embedded client, graceful shutdown.
internal/
  app/       HTTP surface: the client, the join endpoint, the signalling proxy,
             the host's controls, and what a control node does about its fleet.
  admin/     The management pages' API: relays, accounts, rooms, readings, the
             audit log, and bringing a new relay up from one line on a machine.
  config/    One document split into this server's half and the media server's.
  rtc/       The embedded media server, a proxy to its loopback listener, the
             cluster client, and the STUN responder a browser times.
  room/      Room names, identities, and the tokens that authorise them.
  store/     Everything this deployment remembers, and copies of it.
  dns/       Each relay's DNS record, made and removed as relays come and go.
  guess/     How fast a passphrase may be tried, shared by every door that
             takes one.
  limit/     How fast rooms can be asked for.
web/         Vite, React, Tailwind, and the LiveKit client SDK.
dev/         Example configuration, and the tools for finding out what is
             wrong with a fleet. See Testing.
```

One binary, three roles. This document describes the single-machine one; a
deployment split into a control node and several relays is RELAY.md.

## Building it

Go 1.26 and pnpm. The client is compiled into the binary, so it is built first
and every time; a stale `web/dist` is a stale application with no sign of it.

```bash
cd web && pnpm install && pnpm run build && cd ..
go build -o tomoshibi .
```

For something to hand to a server, strip the symbol table and the build id. The
last of those is what makes two builds of one commit byte-identical, which is
the only way to tell whether a binary on a machine is the one that was meant to
be there.

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w -buildid=" -o tomoshibi .
```

## Running it

```bash
cd dev && ../tomoshibi meet.yaml
```

Open the printed URL and pick a room with `#/room-name`. Two tabs in different
windows are enough to have a call with yourself.

While working on the client, `pnpm run dev` proxies the API and the signalling
to a running server, so changes reload without recompiling anything.

## Deploying it

Two ports have to be reachable, and only two:

| Port | Protocol | What it carries |
| --- | --- | --- |
| `meet.listen` | TCP | The client, the API, and the signalling WebSocket |
| `rtc.udp_port` | UDP | Every track, from everybody, multiplexed onto one port |

Put a reverse proxy in front of the TCP one and give it a certificate. This is
not a preference: browsers withhold cameras and microphones outside a secure
context, and only `localhost` is exempt, so an unproxied deployment is usable
from the machine it runs on and nowhere else. The UDP port needs no certificate
— media is encrypted end to end regardless — and must not be proxied.

A working deployment, then, is four files and a service:

```
/usr/local/bin/tomoshibi          the binary
/etc/tomoshibi/meet.yaml          the configuration
/var/lib/tomoshibi/meet.db        the store, created on first run
/var/lib/tomoshibi/tripcode.key   the signing key, created on first run
```

```ini
[Unit]
Description=Tomoshibi
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/tomoshibi serve /etc/tomoshibi/meet.yaml
WorkingDirectory=/var/lib/tomoshibi
Restart=on-failure
RestartSec=2

# Nothing here needs a privileged port, a shell, or anybody else's files.
DynamicUser=yes
StateDirectory=tomoshibi
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

The configuration it wants:

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]

rtc:
  udp_port: 7882
  tcp_port: 7881
  # True on any machine with a public address. False hands participants an
  # address only the host can reach, and the call connects to nothing.
  use_external_ip: true

keys:
  # Generate a real pair with `tomoshibi keygen`. These are one secret rather
  # than two: the same process signs and verifies with them.
  APIyourkey: your-secret

meet:
  listen: ":8080"
  database: /var/lib/tomoshibi/meet.db
  tripcode_key: /var/lib/tomoshibi/tripcode.key

  # The address clients are told to dial, when it is not the one they arrived
  # at. Needed behind a proxy.
  public_url: https://meet.example.com

  # Only behind a proxy that sets them. Exposed directly they are whatever the
  # caller typed, and believing them hands anybody a fresh rate-limit budget.
  trust_proxy: true
  # How many proxies append to X-Forwarded-For: 1 for nginx alone, 2 for a CDN
  # in front of nginx. Counted from the right to find the caller.
  proxies: 1
```

Upgrading is replacing the binary and restarting. The running one holds the
file open, so write beside it and move it into place:

```bash
scp tomoshibi server:/usr/local/bin/tomoshibi.new
ssh server 'mv /usr/local/bin/tomoshibi.new /usr/local/bin/tomoshibi \
  && systemctl restart tomoshibi'
```

Nothing in the store needs migrating between versions: a record a build cannot
read is treated as one that is not there.

That used to be affordable because nothing in there mattered — who is in a room
is the media server's to know, and a token is signed rather than stored. It is
not affordable any more. The store now holds the administrators, the relay
definitions and every field measured about them, the accounts, the invitations
and the opening policy, and it is the only place any of that exists. **Back it
up.** Copies are taken daily beside it; see **Watching it**.

Upgrading a fleet: the control node distributes the binary it is itself running,
so it goes first, and each relay is then re-enrolled with `REPLACE=1`. Restarting
a relay ends the calls it is holding. Restarting the control node does not end
any call — it stops anybody new joining for as long as it is down.

`tomoshibi version` says which build a machine is on, and the startup log
carries the same string. It is read out of the build rather than stamped in, so
it is right without anybody remembering to pass a flag, and a binary built from
a working tree with uncommitted changes says so.

## Administrators

An administrator is not an account. It is a signature listed in the
configuration file — the same signature their passphrase already produces beside
their name in every room they join.

```bash
tomoshibi admin new /etc/tomoshibi/meet.yaml
```

```
passphrase  7mrdz-nlq32
trip        5dtfc2ouiu
```

The passphrase goes into a password manager and the trip goes into the file. The
passphrase is not stored anywhere and cannot be recovered; the trip is public and
grants nothing, which is the whole reason it is the half that gets written down.

```yaml
meet:
  admins:
    - trip: 5dtfc2ouiu
      name: adam
      can: [moderate]
```

`can` is empty for somebody who may only watch: the readings, the trend, the
health checks, and who is in which room. `moderate` adds every action. Between
the two are four finer capabilities, each a part of what `moderate` holds:

| `can` | adds |
| --- | --- |
| `rooms` | removing a participant, muting a track, closing and moving a room — from the management pages and from inside a call — and running a room held under a scope |
| `accounts` | making, renaming, blocking and removing accounts, setting their passphrases, and ticking what each may use — except Emby, and the passphrase of an account that holds it |
| `relays` | adding, editing, ordering and removing relays, and the install line that enrols one |
| `settings` | who may open and enter rooms, whether the Emby relay is on at all, whether YouTube is relayed for viewers who cannot reach it, and whether Bilibili's bangumi are relayed for everybody |
| `moderate` | all four, the list of administrators, and the Emby grant: giving or taking away anybody's, and setting the passphrase of an account that holds it |

Several levels rather than one, because binding them together makes the choice
"everybody gets the dangerous half, or nobody gets the useful one". An entry
written as `[moderate]` or as nothing before the finer ones existed means
exactly what it meant then.

Restart, and `/admin` exists. Where no administrator is listed it does not: the
address answers like any other nobody claimed, so there is no sign-in page on a
deployment with nobody to sign in.

**The file is read once.** The first start copies the list into the store, and
from then on the store is the authority — a deployment adds and removes
administrators through the pages, and it would be no good if a restart put back
somebody who had been removed. So on a deployment that has already started once,
editing this list does nothing at all: no error, no warning, and a sign-in that
answers 401. `meet.relays` and `meet.rooms.opened_by` work the same way.

Which means the file is not the way back in if the pages are unreachable. The
way back in is `dev/roster`, which writes to the store directly. It needs the
service stopped, because the store admits one process:

```bash
systemctl stop tomoshibi
go build -o /tmp/roster ./dev/roster
tomoshibi admin trip /etc/tomoshibi/meet.yaml 'the passphrase'   # prints a trip
/tmp/roster /var/lib/tomoshibi/meet.db add <trip> <name>
systemctl start tomoshibi
```

Stopping the control node does not end calls in progress. It stops anybody new
joining, for as long as it is down.

The other way to be locked out is worse and has no recovery: `meet.tripcode_key`
is what every signature is derived from, so a lost or replaced key invalidates
every administrator, every account and every host claim at once. A missing file
is silently replaced with a new one — the service starts, nothing is logged, and
nobody's passphrase works any more. Back it up with the store, and keep it
somewhere the store's copies are not, since one file compromises the signatures
and the other holds them.

To sign in, type the passphrase. `adam#7mrdz-nlq32` is accepted too, because that
is the form this application teaches everywhere else.

Somebody who has already joined a call has their trip printed beside their name,
and the management pages will copy it: right-click their picture and take **Copy
the signature**. That is the string to paste into the file.

## Letting only administrators open rooms

A room here is a name and nothing else — there is no object to create — so the
question this answers is *who may be the first to use a name*. Names already in
use are untouched, which means a meeting in progress can never be interrupted by
it, and everybody who has the link still gets in.

From the management pages: **Rooms**, then **New rooms**, then
**Administrators**. It takes effect at once and needs no restart.

To have a deployment start that way, set the value the store adopts on its first
run:

```yaml
meet:
  rooms:
    opened_by: admins   # or `anyone`, which is the default
```

Rooms age out. A name nobody has joined for `meet.rooms.remember` — thirty days
by default, `0` to keep them for ever — is forgotten, and is a name nobody has
used again. That is one setting doing two things that happen to agree: a name was
written down the first time somebody joined it and nothing ever took one away, so
the store grew for as long as anybody asked it for names, bounded by the rate
limiter in how fast and by nothing in how many. And a name nobody has spoken in a
month is not a room in use — calling it one leaves a room open for good because
somebody said its name once, last year.

The sweep runs hourly in bounded passes, because the store admits one writer and
a join is a write: clearing a neglected file in a single transaction would make
everybody joining a call wait behind it.

That is the starting value only. The management pages change it afterwards and
cannot edit a file, so the choice lives in the store from then on; the runtime
panel shows the file's value beside the one in force, so a file edited later is
visibly not being obeyed rather than puzzlingly ignored.

Asking for `admins` where nobody is listed as an administrator is a rule nothing
could satisfy — every new name would be refused for good, and the pages that
could undo it would not exist either — so it is read as `anyone` and said so at
startup.

An administrator opens a new room by joining it with their passphrase, in the
passphrase field on the join page. Everybody else is told the room has not been
opened and to ask whoever is holding the meeting for the link.

## Sealing a call

Every call here crosses a machine that is rented rather than owned. The media
server on it decrypts each stream and encrypts it again for each subscriber —
that is what an SFU does — so whoever holds the machine, or takes it, has the
pictures and the sound.

There is a word for that on the join screen, folded away. Type one, tell the
other people some other way, and the frames are encrypted in the browser before
they are sent. The relay forwards something it cannot read.

The key is the room name and the word, derived in the browser. **The server
never sees it**: it is not in the token, it is not the passphrase that proves a
name, and it does not leave the tab except as the frames it encrypts. The room
name is in it so that one word used for two meetings does not make them one key.

What it does not hide is who is in the room, what they are called, when they
joined, or how much they are sending. All of that is signalling and all of it is
the server's to know.

Three things worth saying plainly:

- **Everybody has to type the same word.** Somebody who types a different one
  joins, appears in the roster, and hears nothing — which is the point, and is
  also what it looks like when somebody mistypes.
- **A reload loses it.** The word is held in the tab's memory and written down
  nowhere, so a refresh comes back unsealed and has to be told again. That is
  the cost of not storing it, and it is the right way round.
- **Not every browser can.** Safari has no insertable streams. The control is
  absent rather than present-and-inert where it cannot work, because a promise
  about who can read a conversation is the worst kind to break quietly.

Cheap here for a reason that is specific to this deployment: nothing on the
server needs the plaintext. There is no recording and no transcription, so
turning it on takes nothing away.

## Accounts

Optional, and a deployment that wants none has none: nothing above this line
needs them. What they add is a name that is remembered rather than proved each
time — somebody signs in once, and their name, their avatar and their chosen
relay are theirs on every visit without a passphrase being typed into a join
screen.

There is no self-service registration, deliberately. An administrator makes an
account in the management pages, and the person is given a name and a passphrase
the way they would be given any other credential. A meeting server that anybody
on the internet can create an account on is a meeting server that anybody on the
internet is inside.

An account is worth having where `rooms.opened_by` is `signed`: it is what makes
somebody able to start a meeting without keeping a passphrase in their head.
Under `anyone` it buys a remembered name and nothing else.

The session is a cookie, good for thirty days of not being used and ninety in
total, and it survives a restart because it is kept in the store. Signing out
ends it everywhere. An account can be blocked, which refuses its next sign-in
and its next join without ending a call it is already in.

Accounts and administrators are separate lists, and an administrator's
credentials work at the account sign-in as well — the same passphrase, the same
signature. Everything that tries a passphrase, at any of those doors, spends
from one budget: ten a minute per address with a ceiling on the endpoint. A
limit on one door and not the others is not three limits.

## Scopes

A scope is a name a group of people share — a company, a team — and a room
written `standup@acme` is a room only the people of `acme` may enter. It is
still a name and nothing more: nothing is created first and nothing is cleaned
up afterwards, exactly as with any other room.

A scope is a label on an account, not a record of its own. In the management
pages, **Accounts**, press the `@` beside somebody and type the scopes they
belong to, separated by commas. Lowercase letters, digits and inner dashes, at
most 32 of them; the change is written to the audit log with what it was.
Renaming or deleting an account takes its scopes with it, and somebody given
the same name later does not inherit them. Administrators belong to every scope
without being given any.

Who may enter `room@scope` is asked on **every** join, not only the first:

- somebody signed in to an account carrying the scope, or to an administrator's;
- somebody holding a live invitation to that room, who comes in as a **guest**
  whatever else they bring — an issued mark, and the name the link was made
  for, if it was made for one;
- somebody whose passphrase belongs to an account carrying the scope, or to an
  administrator.

Nobody else. A blocked account is not a member. The deployment's
`rooms.opened_by` and `rooms.joined_by` do not apply to scoped rooms at all,
and a scoped name cannot be arranged in advance — a link with a time on it does
that job instead.

**Links.** Two kinds. *Invite somebody*, in the call, makes the same link it
makes in any room: it lasts until the meeting is ended, and a day at most. A
member also makes standing links on their own page at `/account`, under *Guest
links*: the room, and optionally the name the guest will be called, when the
link starts working, and when it stops. Leave the end empty and the link works
until somebody stops it. The window is checked when somebody comes through the
door and at no other time, so a guest already in the call stays when it closes.
Either kind is worth exactly its maker's standing: take somebody out of the
scope, or block them, and every link they made stops working.

**Running the room.** A scoped room has no host on record. Every member, and
every administrator given `rooms` (which `moderate` carries), runs it — mutes,
removes, ends the meeting, moves it, answers a knock, stops the room's links —
whether or not they are in the call. There is therefore nobody to hand it over
to, and that control is not offered.

**Ending is not revoking.** Ending a scoped meeting takes the links made in the
call and keeps the standing ones, because those were made by members for other
days and other people. To keep somebody out after ending a meeting, stop the
room's links as well — *Stop every link to this room working*, in the call or on
the account page — which stops all of them, whoever made them.

**When the store does not answer**, scoped rooms refuse everybody, where every
other room lets joins through. That rule protects a first use by people who
already know a name; a scope protects every use, and letting it through would
hand the meeting to anybody who guessed the name.

What it does not do, said plainly:

- A link past its end refuses a reload. Moving the room to another relay, or an
  operator placing somebody on one, sends the client through the join again, so
  a guest whose window has closed is dropped then too.
- During a store outage nobody can enter a scoped room.
- A link with no end sits in `?invite=`, and so in a reverse proxy's access log.
  Ordinary invitations do too, but they stop working after a day.
- A member who is signed in and opens a guest link comes in as themselves.
- Any member can end any meeting in the scope, remove anybody in it (another
  member included, who can come straight back), and stop links somebody else
  made — without being in the call.
- A member who typed their passphrase into the join screen without signing in
  loses the room's controls about five minutes in, because the join token lasts
  five minutes. Ordinary hosts have the same limit today; signing in avoids it.
- *Close* on a room in the management pages does not remove that room's
  invitations, unlike a host ending the meeting. That predates scopes and is
  left as it is.

## How it works

**The media server runs inside this process.** LiveKit ships as a library whose
server can be constructed and started directly, so `rtc.Start` builds one and
keeps it on the loopback interface. Three things follow, and they are the whole
reason for the arrangement:

- The token is signed with the same credentials, in the same process, that
  verify it. There is no shared secret to distribute and no second service whose
  configuration can drift out of step with this one.
- Deploying is copying one file. The client is compiled in, so there is no
  directory to ship beside the binary and nothing to get out of sync with it.
- One TCP port faces the network, and it is ours. The client, the API, and the
  signalling WebSocket share an origin, which is what makes this usable from
  another machine: camera access and secure WebSockets both need a secure
  context, and one origin means one certificate rather than two.

Signalling reaches the media server through a reverse proxy on the loopback
interface. The standard library carries a WebSocket upgrade through unchanged,
which is the only thing that path needs.

**A room is a name and nothing else.** There is no room object on the server and
no membership table. `POST /api/rooms/{room}/join` mints a token scoped to one
room and one identity, with no administrative rights, and a room exists because
somebody named it. Nothing has to be created first and nothing has to be cleaned
up after.

That also makes the name the credential, so arriving at the bare address
generates one rather than funnelling everybody into a shared default, which is a
room strangers walk into. Three words and four digits is 37 bits, drawn from
`crypto.getRandomValues`; guessed at the rate the server allows, stumbling onto
one of a few thousand rooms in use takes longer than anybody will spend. A name
somebody typed instead is short and meaningful, which is exactly what makes it
guessable, so the client says so about those and stays quiet about the rest.

**Everybody carries a mark; not every mark proves anything.** Anybody can call
themselves anything, so a passphrase is sent with the join request and the
server derives a short mark from it, keyed with a file of its own. Somebody who
gives no passphrase is issued one instead, drawn from nothing and fresh each
visit — without it, two people arriving under one name are indistinguishable and
the roster cannot say which of them spoke.

The passphrase has a field of its own, which is less a matter of taste than it
sounds. It used to be the half of the name field after a hash, and no password
manager on earth can see that — not the browser's, not the one in the extension
bar — so the thing every person was asked to remember was the one thing nothing
was allowed to remember for them. It is a password field with an autocomplete
attribute now, and Chromium is additionally offered the credential outright,
since a page that never navigates never gives its heuristic the submission it
watches for. `Alice#secret` still works and is no longer advertised: a syntax
that quietly stops being accepted is worse than one that is no longer mentioned.

The two kinds must never look alike, or the earned one is worth nothing: an
impostor would point at their own and claim it. So they wear different prefixes
on the identity, which its bearer cannot choose, and the interface draws an
earned mark at reading weight behind a leading dot while an issued one is
dimmer and has none — a serial number rather than a claim about who somebody
is. The same passphrase always earns the same mark, which is the whole point; a
different one earns a different mark and takes effect on the next join.

The mark goes into the identity, which is signed into the token and enforced by
the media server, so it is not a claim travelling beside the name but part of
what the participant provably is.

Two things follow from where the key lives. It is separate from the API
credentials because the two have opposite lifetimes: those should be rotated, and
rotating this one silently changes everybody's signature. And without it a
signature cannot be attacked offline at all, which is the difference between this
and the tripcodes it borrows its syntax from: the only way to find a passphrase
is to guess it through the join endpoint, where the rate limiter is waiting.

Somebody who cannot prove a name that another participant has proven is marked,
and nothing else is. Two people genuinely called Alex is ordinary; impersonating
a name nobody recognises achieves nothing.

**Identity and display name are both signed in.** The identity comes back on the
next join so that reloading a tab keeps the same one, which is why a refresh does
not look like somebody leaving and a stranger arriving. The display name travels
with the request rather than being set after connecting, so it is there in the
first roster update and nobody can rename themselves to somebody else mid-call.

**How loud everybody is is one person's own decision.** A sound panel lists what
can be heard rather than who can be seen — sound is rendered outside the stage on
purpose, so the person who is too loud is as likely as not to be on the second
page — with a row per thing there is to hear: somebody's voice, and separately the
sound of a screen they are sharing, because those were always two tracks.
Stopping one asks the media server to stop sending it rather than turning it down
here, which is the difference between hearing nothing and paying for it anyway.

Neither of the media library's own places for this remembers. A volume lives on
the remote participant and a block on the publication, and a full reconnect
rebuilds every participant while a restarted share is a new publication — so the
setting is kept here and put back whenever the room changes underneath. It is
also what a mark is for: a setting is written down only against a proven
signature, which is the same string next week, while a guest's lasts the call
because there is no persistent them to remember.

A picture whose sound has been silenced says so, and that mark outranks the one
saying its owner muted themselves. Both mean no sound; only one of them is
something the person looking can undo.

**The layout unit is a picture, not a person.** Somebody sharing their screen
while their camera is on contributes two, which is why `Surface` exists and why
every layout takes surfaces. A share auto-pins itself to the stage and releases
it when it stops, but only if the pin was automatic: a manual pin outranks the
automation in both directions. The stage offers a switch to that person's other
picture, so reaching their face during a share is one click rather than a hunt
through the filmstrip.

**The grid is chosen, not divided.** Splitting the container into equal cells is
what CSS does for free, and it gives two people on a wide screen a pair of tall
thin cells that crop a 16:9 picture down to a strip. Instead every column count
is tried and the one giving each person the most area wins, with the tiles
keeping their shape and the slack becoming space around them. Empty cells count
against an arrangement, so four people are never spread over six, and a ceiling
on height stops one participant filling the window edge to edge.

Clicking a tile puts it on the stage and clicking it again takes it back;
double-clicking fills the screen. Once there are more people than fit on a page,
whoever spoke most recently comes forward, since somebody talking from the second
page is somebody nobody can see. Below that threshold the order holds still,
because a grid that rearranges itself mid-sentence is worse than one that does
not.

**Subscription follows rendering.** A tile that is not on screen is not on the
wire either, and the layer that is sent matches the size of the element it is
going into. Both are the client SDK's own adaptive streaming, driven by the
video element rather than by anything this code decides. An earlier version
managed subscriptions by hand and got neither behaviour reliably; the two were
fighting for the same control.

**Joining is rate limited.** A room exists because somebody named it, so asking
for one nobody is using succeeds exactly like asking for a busy one. There is no
failure to count, which leaves the rate as the only thing between a script and
somebody else's meeting.

**One signal colour.** Speaking, sharing, unread, copied — all amber, so at any
moment only one thing on screen is saying something. Red appears twice in the
whole application, on leaving and on errors; keyboard focus is white rather than
a second hue. Speaking is drawn as a line along the bottom edge of a picture
rather than a halo around it, opening from the centre and closing back to it, on
the model of the tally light that marks the live camera in a studio.

The neutrals lean warm. A blue-grey ground pushes skin tones towards green, and
this interface is a screen full of faces.

**A camera that is off shows who is missing, not what.** An avatar derived from
the identity: the same picture every time that person appears, different enough
between people that a grid of dark tiles is still a grid of individuals. Its
palette is muted on purpose — an avatar is content, standing in for video, but
it must never out-shout the tally.

**Notices say the four things worth interrupting for.** Somebody arriving,
somebody leaving, somebody else taking the stage with a share, and the two
failures a person can act on. A button somebody pressed is not reported back to
the person who pressed it, a copied link answers on the button itself, and a
connection that is down is a standing condition that belongs in the banner over
the stage rather than in something that fades.

**Messages arrive on the speaker's own picture.** A message is something a
person said, and the tile is already labelled with who they are, so the bubble
carries neither face nor name. Anybody with no tile to borrow — on another page,
or hidden behind a share — falls back to the corner, which is the only place a
message needs both. The panel that holds the whole conversation floats over the
room rather than pushing it aside: pushing would move and resize every tile at
once because one person wanted to type.

Addresses in a message are clickable, in the bubble as well as the panel, since
a link is the commonest thing anybody types during a call. Only complete `http`
and `https` URLs are matched: guessing at bare hostnames turns an ordinary
sentence into a link to somewhere nobody meant, and a false link is worse than a
missed one because it is clickable and looks deliberate.

Nothing is written down. Messages last as long as the call, which is the same
rule the room follows, and the empty panel says so — whether that is true and
whether it looks true are different things, and only the second stops somebody
posting what they would rather not leave behind.

## Configuration

One file describes the whole process. The media server's loader rejects keys it
does not recognise, so the `meet` section is lifted out before the rest is handed
over. See `dev/meet.yaml`.

Two ports need to be reachable: the one under `meet.listen`, over TCP, and
`rtc.udp_port`, over UDP. A single UDP port rather than a range, because every
track is multiplexed onto it.

`meet.tripcode_key` names the file that signs passphrases. It is created on
first use and must not be replaced: doing so changes every existing signature.

Behind a proxy, set `meet.trust_proxy` so that `X-Forwarded-For` and
`X-Forwarded-Host` are believed. Exposed directly they are whatever the caller
typed, and believing them would let anybody claim a fresh rate-limit budget per
request.

The caller is read from the right of `X-Forwarded-For`, never the left: each
proxy appends what it saw to whatever the caller already wrote there, so the
first entry is the caller's to choose. `meet.proxies` says how many proxies
append, one when unset. Behind a CDN and then nginx it is two, and leaving it
at one charges everybody the CDN node serves as a single caller.

`meet.rooms.opened_by` is who may use a name nobody has used before. Three
values:

- `anyone` — the default, and what an anonymous meeting link means.
- `signed` — anybody who joined with a passphrase, which is to say anybody who
  can prove a name. The middle setting, and the one most deployments want.
- `admins` — only a passphrase belonging to somebody listed under `meet.admins`.

A name already in use is untouched by any of them: a meeting in progress is
never interrupted by this, and everybody who has the name still gets in.

It is the starting value only. The management pages change it, and cannot edit a
file, so the choice is kept in the store and the file is what the store adopts on
first run. Editing it afterwards does nothing; the runtime panel shows the file's
value beside the one in force so the difference is visible rather than puzzling.

Asking for `admins` where nobody is listed as one is a rule nothing could satisfy
and every new name would be refused for good, so it is read as `anyone` and said
so at startup.

### The rest of the `meet` section

Everything above is what most deployments touch. These are the ones that make a
fleet work, and none of them had been written down anywhere:

| | |
| --- | --- |
| `tls_cert`, `tls_key` | Serve TLS from this process rather than from a proxy. A renewed certificate is picked up without a restart. |
| `public_url` | What this deployment calls itself in links it hands out. |
| `public_addresses` | Addresses that are this machine. Without it, a node behind NAT resolves its own name for every management call — measured at twelve seconds each on the deployment that prompted it, and eleven milliseconds with it. |
| `silent` | **Relays only.** Answer nothing but a WebSocket upgrade. For a machine on a network that decides what it is by asking it; an unregistered domain that answers an HTTPS request is a website and is taken off the air. Off elsewhere, where a machine that answers can be diagnosed. |
| `probe_port` | **Relays only.** Where this machine answers STUN, so a browser can time one round trip rather than three. Zero is off. Not 3478, which is scanned continuously. |
| `web_root` | Serve the client from a directory instead of from inside the binary. |
| `token_ttl` | How long a join token is good for. |
| `join_rate`, `join_burst` | How often anybody may ask to join. Separate from the budget that bounds passphrase guesses, which is fixed and shared between the join, the account sign-in and the management sign-in. |
| `link_mbits` | What a relay's network link is thought to carry. Drives the bandwidth bars, the "busy" mark and the trend plot's axis, none of which can be measured from here. A gigabit if unset. |
| `rooms.remember` | How long a name is remembered after nobody has used it. |

`role` is `full`, `control` or `relay`, and two of the sections below are read
only under one of them: `meet.enrol` on a control node, `meet.silent` on a
relay. Written under the wrong role they are accepted and do nothing, which for
`silent` is the most expensive silent failure here.

### `meet.enrol`, on a control node

What a relay receives when it runs the install line. Absent, the enrolment
endpoints do not exist and relays are added by hand.

| | |
| --- | --- |
| `secret` | What a machine must present to enrol. It travels in the operator's own command. |
| `domain` | New relays become `<prefix>.<domain>`. |
| `public_url` | Where a relay reaches this node. |
| `listen_port`, `udp_port`, `tcp_port` | The ports every relay in the deployment uses, so nobody has to remember. |
| `probe_port` | Written into each new relay's `meet.probe_port`. Unset means enrolled relays answer no STUN and are timed the slow way. |
| `cert_file`, `key_file` | The certificate handed to a new relay and pushed hourly thereafter. Falls back to `meet.tls_cert`, so a control node behind a proxy that terminates TLS has neither and distributes nothing — set these explicitly there. |
| `redis_addr` | Where relays reach redis, which is how they see one cluster. |
| `binary` | What `/download/tomoshibi` serves. Defaults to this process's own, so the fleet must share its architecture. |
| `cloudflare_token`, `cloudflare_zone` | Used to create the DNS record for a new relay, and to remove it when one is dropped. |

## Commands

```bash
tomoshibi [serve] [config.yaml]   Serve the client, the API, and the media
tomoshibi version                 Print which build this is
tomoshibi keygen                  Print a fresh API key and secret
tomoshibi rooms <database>        List the rooms a store has seen
tomoshibi admin new [config.yaml] Make an administrator's passphrase and trip
tomoshibi admin trip [config.yaml] <passphrase>
                                  Work out the trip a passphrase already gives
```

`rooms` needs the server stopped: the store admits one process at a time. Live
occupancy is a different question with a different answer, and the media server
already knows it.

## Testing

```bash
go test ./...
cd web && pnpm run check && pnpm test
```

The interesting behaviour needs two browsers and a running server, so it is
driven through headless Chrome with fake media devices rather than unit-tested.
`dev/twobrowsers/` holds those: `call.mjs` puts two people in a room, turns on a
camera, checks frames arrive at both ends and that the button on the
one-person-left screen is not underneath the control island; `doorway.mjs`
checks which screen somebody holding a room name lands on, against a deployment
configured with `rooms.opened_by: signed`; `scoped.mjs` takes three browsers
through a room held under a scope — a member, a stranger turned away, links
made on the account page and in the call, a meeting ended with only the lasting
link still working, and a guest whose window closes while they are in the call
and who is still there after the media server has renewed their token.

The flags that matter are `--use-fake-device-for-media-stream` and
`--use-fake-ui-for-media-stream`, and each run should use a fresh room name so
that a session which has not timed out yet is not counted twice.

`dev/` also holds the tools worth knowing about before something goes wrong,
since the day to find them is not the day something has:

| | |
| --- | --- |
| `roster` | Add or remove an administrator directly in the store. The way back in when nobody can sign in; see **Administrators**. |
| `udpcheck` | Send STUN binding requests to a relay's probe port. Answers "is media reaching this machine", which the management pages cannot. |
| `turncheck` | Whether a relay will accept a TURN allocation. |
| `snicheck` | Whether a path refuses a name in the TLS handshake, which is the failure a relay dialled by bare address exists for. |
| `peekroom` | What the media server thinks is in a room. |
| `crossrelay` | Whether two relays can carry a call between them, which is what `apart` records. |
| `viahk` | Routing a mainland relay's overseas traffic through Hong Kong. Its own README. |
| `watch` | The two scripts that put what this notices in front of a person. Its own README. |

## Watching it

Everything this notices is written to the log. `dev/watch/` reads that log and
the fleet every five minutes and puts the part that cannot fix itself in front
of a person, through whatever bot the operator already has — its README is the
whole deployment, and the discipline it follows is that a fault has to survive
three rounds before anybody hears about it.

What is said, so that somebody reading a journal knows what they are looking at:

| Said | When |
| --- | --- |
| `a relay stopped answering and is no longer offered to clients` | Its signalling port went quiet. Once on the change, not every sweep. |
| `a relay answers signalling but its media port does not answer` | Calls sent there will connect and have no sound or picture. Only for relays with `probe_port` set. |
| `most of the fleet did not answer this sweep` | Almost always this machine's own line rather than the fleet. The readings are held rather than acted on. |
| `a relay is serving a certificate that expires soon` | Within two days, and this node cannot renew it — look at the acme client on that machine. |
| `no relay would take the certificate this hour` | Nothing here knows what any of them are serving. |
| `the store is empty and there are copies of it beside it` | This deployment held something and no longer does. See below. |
| `could not copy the store` | There will be nothing to restore from. |

The store is copied once a day to `<database>.YYYY-MM-DD` beside itself, seven
kept. This matters more than it looks: the store holds the relay definitions and
every field measured about them, the accounts, the administrators, the
invitations and the opening policy, and the configuration file holds three of a
relay's nineteen fields and is read only on a first start. A store truncated to
nothing opens without an error and reports no buckets, so the service starts,
adopts what little the file has, and answers normally with everything else gone.

To restore: stop the service, move a copy over the store, start it.

`meet.tripcode_key` is not copied and should be, separately — see
**Administrators** for what losing it costs.

## What is not here

- **Recording and telephony.** Both are available from the media server and
  neither is wired up. Recording needs a second service, which is the property
  this deployment is built around not having.
- **Self-service registration.** There are accounts — see below — but nobody
  signs themselves up. An administrator makes them, or a deployment runs without
  any and everybody is a guest.
- **Metrics.** No `/metrics`, no statsd, no OpenTelemetry. The readings this
  keeps are for the management pages and the six-month trend in the store, and
  a deployment wanting them somewhere else would have to read them from there.

  Alerting is not on this list any more: `dev/watch/` sends the faults that
  cannot fix themselves to a bot. It is a pair of scripts rather than something
  built in, because which bot is a property of whoever runs the deployment.

Three things this section used to list are here now, and were listed as missing
for long enough that the list is worth correcting explicitly rather than quietly:

- **Chat** was built. `web/src/live/chat.ts` and `ChatPanel.tsx`; the section
  above describes it at length.
- **Accounts** were built. `internal/store/accounts.go`, `internal/app/account.go`,
  a separate `/account` page, sessions that survive a restart, avatars, blocking.
  What is missing is only the self-service half.
- **TLS** is here, and the claim was backwards: this binary terminates TLS
  itself, from `meet.tls_cert` and `meet.tls_key`, and reloads a renewed
  certificate without a restart. A proxy in front still works and is what a
  deployment already running one should do.

  Without either, the server is usable only from the machine it runs on:
  browsers withhold cameras and microphones outside a secure context, and only
  localhost is exempt. The client says so rather than failing, and the startup
  log qualifies the network address for the same reason.

## Licence

[GNU Affero General Public License, version 3 or later](LICENSE).

The Affero clause is the one that matters for something like this. A meeting
server is used over a network and never distributed, so an ordinary copyleft
licence would place no obligation on anybody running a changed copy: they would
owe their participants nothing, and the participants would have no way of asking.
Section 13 closes that — whoever offers this over a network owes its source to
the people using it that way.

Which is why the join page carries a link to it. Set `meet.source_url` to
wherever a changed copy lives; a link to somebody else's repository is not an
offer of the code anybody is actually running.

The embedded media server is LiveKit, under Apache-2.0, and everything the client
is built from is MIT or ISC. All of them may be carried by an AGPL work.
