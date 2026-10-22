# 11. Frequently asked questions

[Back to the guide](../../DEPLOY.md)

**Do I need relays at all?**
No. `role: full` on one machine is the whole product: two ports and one
certificate. Split into a control node and relays when media should be near
the people sending it, or when egress is metered.

**Why does the camera not work when I open the server by its address?**
Browsers withhold cameras and microphones outside a secure page, and only
`localhost` is exempt. Put HTTPS in front of it.

**I edited `meet.admins` (or `meet.relays`, or `rooms.opened_by`) and nothing
changed.**
Those are starting values, read on the store's first start. Change them in
the management pages; for administrators when you cannot sign in, use
`dev/roster` with the service stopped.

**Why does my control node insist on a relay in its file when the pages hold
the list?**
The startup check refuses a control node with no relays configured, and it
reads the file. Keep one entry there; it changes nothing after the first
start.

**Can I run the control node and a relay on the same machine?**
Two processes with different roles, ports and units would be needed; one
process has one role. (To be confirmed: not described anywhere in the
repository.) If the control node reaches that relay by its public name through
NAT, list the public address under `meet.public_addresses`.

**How do I upgrade a relay?**
Replace the binary and restart, with the fleet idle:
`dev/watch/update-relay.sh`, or [upgrade-relays.sh](examples/upgrade-relays.sh)
for many. Re-enrolling with `REPLACE=1` also works but rewrites the relay's
configuration.

**Does restarting the control node drop calls?**
No. Nobody can join while it is down. Restarting a relay, or a single
machine, does end the calls on it.

**What happens if redis goes down?**
Meetings whose people are all on one relay continue. A meeting split across
relays stops hearing itself, and relays that signal through another stop
receiving signalling. The control node goes on signing tokens.

**Which relay policy should I use?**
`sticky` to keep every meeting on one relay (cheapest), `probe` to let each
browser pick the fastest (needs redis). `nearest` needs a proxy or CDN that
sets a region header, and `round_robin` is for identical machines.

**The fleet has machines of two architectures.**
Enrolment serves one binary (`meet.enrol.binary`, or the control node's own).
Enrol one architecture and install the other by hand.

**Can relays use IPv6?**
The enrolment works out an IPv4 address and creates an `A` record. (To be
confirmed: whether relays are usable over IPv6, or dual-stack, when set up by
hand.)

**I lost `tripcode.key`.**
Restore it from backup. If there is none, every administrator, account and
host signature is gone: make a new administrator with `admin new` and
`roster`, and give every account a new passphrase.

**How do I know which build a machine runs?**
`tomoshibi version`, or the `build` in the startup line `settings: this
deployment`. Two builds of one commit with the flags in chapter 3 are
byte-identical, so a SHA-256 comparison also works.

**A mainland relay keeps disappearing.**
Set `meet.silent: true`. If WebSocket handshakes to it are reset, use
**Signals through**. If only its name is refused, dial it by address. Chapter
6 covers each.

**Where is `viahk`'s tunnel?**
There is none. It is nftables NAT on two machines; nothing is installed and
nothing handshakes.

**The apps do not see a new build.**
The newest line in `apps.json` is offered only when its file exists with the
exact size and SHA-256 the line gives. The server logs the reason. The update
endpoints also answer only the apps' user agent.

**Why is the notice in the apps not showing?**
`remote.json` needs a server from the 2026-10-22 snapshot or later and apps
from 0.1.4, and the notice needs an `id`, an `until` that has not passed (or
none), and text in at least one language. Its `id` decides whether somebody
who closed the last notice sees this one.

**Is there a metrics endpoint?**
No. The management pages and the six-month trend hold the readings; alerts go
through `dev/watch`.

**What does the AGPL require of me?**
Offering the source of what you run to the people using it over the network.
Set `meet.source_url` to your fork.
