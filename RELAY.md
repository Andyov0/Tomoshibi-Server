# Running the media apart from the client

Upstream Tomoshibi is one process holding the media server, the API, and the
client. That is the right shape for one machine, and the wrong one as soon as
the media should live somewhere the client should not.

The two halves want opposite things. Media wants to sit close to the people
sending it, on a network chosen for its routes, and it is charged by the byte
wherever such networks are rented. The client is a few kilobytes and a
certificate, and any static host serves it for nothing. Held together they share
a machine, and it has to be the expensive one.

So the binary knows three roles, set under `meet.role`:

| role | serves | starts media | keeps a store |
|---|---|---|---|
| `full` (default) | client, joins, management, media | yes | yes |
| `relay` | signalling and media only | yes | no |
| `control` | client, joins, management | no | yes |

`full` is unchanged. A deployment that has not thought about this keeps working
exactly as it did.

## What each role refuses to be

A relay serves the signalling paths and a health endpoint, and nothing else. Not
"the client is unnecessary there" — it must not be present. A relay reachable at
a name somebody could type would otherwise serve a join endpoint signing tokens
against a store it does not keep, and management pages for administrators it was
never told about. The router returns early rather than skipping registrations
one at a time, so this cannot be half-true.

A control node starts no media server. The ports in its configuration are read
and never bound.

## The credentials are the join between them

One key pair, in every relay's configuration and in the control node's. The
control node signs a token with it; the relay the client then dials verifies
with the same one. There is no second secret and nothing to keep in step —
which is the property that made a single binary possible upstream, kept intact
across the split.

Generate a pair with `tomoshibi keygen` and put the same one everywhere.

## Redis

Every relay and the control node point at one instance. It is what lets the
relays route between themselves, so a meeting whose participants landed on
different relays can still hear itself.

Without it each relay is an island. A call works only when everybody in it
reached the same one — which the `sticky` policy arranges deliberately and the
`probe` policy deliberately does not. The server says so at startup rather than
letting the first split meeting be the way anybody finds out.

## Choosing a relay

`meet.relay_policy`, on the control node:

**`sticky`** (the default) hashes the room name. Everybody in one room goes to
one relay, so media between two participants never leaves it. On metered egress
this is the cheapest thing to do, because media crossing between relays is
carried twice: once to cross and once to deliver.

The hash is FNV rather than maphash, which is seeded per process. Two control
nodes behind one address must send the same room to the same relay, and a
control node restarted in the middle of a meeting must not start sending the
second half of the participants somewhere else.

**`probe`** asks the browser. Where a client should connect is not something a
server can work out — it sees an address, and an address says where a block was
registered, not how long a packet takes to get there. The browser about to make
the call can simply measure.

The client fetches `/api/relays`, times all of them at once, and sends the
fastest name with its join.

**There is no health endpoint, and adding one back would be the fault it was
removed for.** A relay in mainland China is probed by something that opens its
TLS port, sends an ordinary HTTPS request and reads the answer; a port that
replies is a website, and an unregistered domain may not be one. An endpoint
answering 204 to anybody who asks is that probe's evidence, served continuously
and by us — and every client asking for it before every join is that probe
arriving from our own users. `meet.silent` exists for the same reason and turns
off every answer that is not a WebSocket upgrade.

So the timing is done two other ways, and the choice is made for the whole list
rather than per relay — a relay measured the fast way would beat a nearer one
measured the slow way, on nothing but the measurement it happened to allow:

- **STUN**, where every relay in the list has `meet.probe_port` set. One round
  trip, over the transport a call actually uses. The enrolment writes this from
  `meet.enrol.probe_port`.
- **The signalling socket** otherwise: opened, timed, closed, without a token,
  so the relay refuses and the refusal is the round trip. About three of them —
  TCP, TLS, and the upgrade — so the numbers rank correctly and read as three
  times too slow.

The control node's own check is neither. It opens a TCP connection to the
signalling port and closes it without sending a byte, and where a relay has a
probe port it also sends one STUN request, which is the only thing here that
notices a relay whose signalling is reachable and whose media is not.

What travels is a name from the list it was given and never an address. A forged
one selects a different relay of the deployment's own at worst; an unknown one
is ignored and the client lands on the room's relay like anybody who did not
measure. Measuring is bounded at a second and a half per relay, runs in
parallel, is cached for five minutes in memory, and failure anywhere is answered
with no preference at all. It decides which of several working relays is used
and can never stop a call from happening.

**`nearest`** reads `X-Client-Region`, or Cloudflare's `CF-IPCountry`, and
matches it against each relay's `region`. Only believed when `trust_proxy` is
set, for the same reason the forwarded address is: a header nobody upstream
overwrites is whatever the caller typed. Falls back to `sticky` when nothing
matches, rather than to the first entry — falling to the first would gather
every unlabelled client onto one relay.

**`round_robin`** spreads clients over the relays in turn, ignoring both room and
region.

## Deploying

`dev/relay.yaml` and `dev/control.yaml` are working examples.

The control node first, since a relay enrols against it:

```
tomoshibi /etc/tomoshibi/control.yaml
```

Put it behind TLS, or give it `meet.tls_cert` and `meet.tls_key` and let it
serve TLS itself. Cameras and secure WebSockets both need a secure page, and
browsers exempt only localhost.

### Bringing up a relay

One line on the new machine, taken from the management pages under **Relays →
Add a relay**, where it arrives with the enrolment secret already in it:

```
curl -fsSL https://meet.example/install | ENROL=<secret> sh -s <prefix>
```

What it does, in order: downloads the binary from the control node, asks
`/api/enrol` for its share of the deployment — the API key and secret, the redis
address, the certificate and key, the region and node selector — creates the DNS
record for `<prefix>.<enrol.domain>` through Cloudflare, writes
`/etc/tomoshibi/relay.yaml`, installs a `tomoshibi-relay` systemd unit, and
starts it. `REPLACE=1` re-runs it over an existing relay, which is also the only
way to upgrade one's binary.

Two things to know before running it:

- **`SILENT=1` for a relay in mainland China**, which sets `meet.silent` and
  stops the machine answering anything but a WebSocket upgrade. Off elsewhere,
  where a machine that answers is a machine that can be diagnosed.
- **The whole fleet must be the same architecture.** `/download/tomoshibi`
  serves the control node's own running binary, so an arm64 relay enrolling
  against an amd64 control node downloads something it cannot execute.

`/install` and `/download/tomoshibi` are both unauthenticated. The script served
at the public address carries no secret — that travels in the operator's own
command, so nothing that logs a URL ever sees it — while the copy downloaded
from the management pages has it embedded, because those are behind a session.

Then, on the machine: open the TCP port under `meet.listen`, the UDP port under
`rtc.udp_port`, and `meet.probe_port` if the deployment sets one. A cloud
provider's security group counts as a firewall here and is the usual reason a
relay answers signalling and carries no media.

The relay's certificate is then this control node's business: it compares what
it holds against what each relay serves every hour, sends a renewed one when it
changes, and warns about any relay serving something it did not send and cannot
renew. A relay dialled by bare address has its own short-lived certificate from
an acme client on the machine itself; that cron job is not in this repository
and the hourly check is what notices when it stops.

### By hand

Still supported, and what the examples show:

```
tomoshibi /etc/tomoshibi/relay.yaml
```

Set `rtc.use_external_ip: true` — left false a relay hands out an address only
it can reach, and every connection fails after appearing to succeed. The server
warns about this at startup. Then add the relay in the management pages, or list
it under `meet.relays` before the control node's first start, which is the only
start that reads it.

## What each viewer is sent

Two settings under `rtc`, in `dev/relay.yaml` and in every relay the install
script brings up:

```yaml
rtc:
  packet_buffer_size_video: 4000
  congestion_control:
    enabled: true
    use_send_side_bwe: true
```

Both were chosen by measurement, with a 1440p screen share and the line between
a relay and one end of the call shaped down, and both were measured against the
media server's defaults first.

**The sender-side estimate.** A share is sent in layers, and the relay chooses
one for each viewer. By default it chooses from the browser's receive-side
estimate and starts from an assumed 100 Mb/s, so a viewer on a line narrower
than the largest layer was sent all of it; the estimate collapsed to almost
nothing, the relay fell to the smallest layer, tried again, and collapsed again.
Not one of eight rounds on the defaults was watchable, and a line shaped like a
hotel's — 20 Mb/s down, 3% loss — decoded no frame in a minute. With the
sender-side estimate, which reads the browser's transport-wide feedback, seven
rounds of nine were watchable, four of them at 1080p and thirty frames a second,
and the hotel line gave 1080p at thirty with 2.6 seconds frozen a minute.

It is an improvement and not a cure, and the two rounds that failed are why
that is worth writing down. In one the picture froze for about a minute:
congestion was declared while the share was still climbing to its full rate,
and the relay did not choose again once it had. In the other, two viewers
shared one 20 Mb/s line and neither drew a frame.

**4000 packets of video history.** What a relay keeps to resend a packet that
was lost, both to a viewer and from a sharer. At the default of 500, the four
to five thousand packets a second of a 1440p share leave a tenth of a second —
less than a resend takes from a sharer behind a tunnel — so a lost packet could
not be repaired, the relay logged `cannot be sequenced`, and every viewer asked
for a fresh keyframe. At 4000 those stopped, and a viewer 150 ms away with 0.2%
loss went from about one frame a second to between 13 and 45. It did not
rescue a sharer whose own line was losing packets: that share still froze at
4000, and the only setting measured clean on that path was the sharer choosing
1080p at thirty, which is the sharer's choice to make.

Neither setting asks a sharer to send less. They decide which of the layers a
sharer already sends reaches each viewer, and how long packets are kept. A layer
is still switched off only when nobody has asked for it, as before.

It is `packet_buffer_size_video`, not `packet_buffer_size`. The older key is
still accepted and changes nothing for video: the media server fills the
per-kind sizes from it only where they are unset, and their defaults are not.

The pacer, `send_side_bwe_pacer`, is left at its default. Neither of the two the
media server will select holds a packet back to smooth a burst, so there is
nothing there to tune.

A relay says what it is running with every time it starts, which is the line to
read after changing either:

```
settings: how each viewer's media is chosen  {"congestion control": true, "send side bwe": true, "pacer": "no-queue", "video nack window": 4000}
```

And once somebody joins, the media server logs `using send side BWE` for them.

### What they cost

Memory, on the relay holding the meeting. Every video track each person
receives keeps a 128-byte record for each packet of its history — 512 KB at 4000
rather than 64 KB at 500 — and every camera counts, not only shares, because the
record belongs to the subscription. The incoming copy of a share's largest layer
grows to hold its history as well, to about 6 MB rather than under 1 MB.

Measured on one machine with the relay role and synthetic participants — the
media server's own test client, everybody publishing a camera and one of them
also a 48 Mb/s share — resident memory after a minute, against 39 MB idle:

| people | video subscriptions | defaults | these settings |
| ------ | ------------------- | -------- | -------------- |
| 2      | 3                   | 70 MB    | 82 MB          |
| 5      | 24                  | 91 MB    | 124 MB         |
| 10     | 99                  | 142 MB   | 241 MB         |
| 15     | 224                 | 211 MB   | 434 MB         |

At ten people the sender-side estimate accounts for 5 MB of the difference and
the resend window for the rest. That is about 1 MB a subscription, twice the
record itself, because the Go runtime lets its heap grow to twice what is live
before collecting. `GOMEMLIMIT` makes it collect sooner as it nears a limit:
with `GOMEMLIMIT=340MiB` in the service's environment, fifteen people measured
354 MB.

So a relay under a memory limit is sized by the largest meeting it will hold,
and that grows with the square of the people in it: everybody with a camera on
is N×(N−1) subscriptions. Leave room beyond these figures: they are resident
memory, and a systemd `MemoryMax` is compared against the cgroup's whole
charge, which also counts the kernel's socket buffers. The media server asks
for 16 MB of each on its UDP socket and is granted up to
`net.core.rmem_max`/`wmem_max`, so on a machine where those were raised the
buffers can add tens of megabytes exactly when it is falling behind.

And CPU. In the same runs the relay process used 95% of one Apple-silicon core
at ten people where the defaults used 70%, and 150 to 175% at fifteen where
they used 117% — most of it the sender-side estimate rather than the window
(ten people: window alone 64%, estimate alone 96%). Every viewer there was
sent the 48 Mb/s share whole, which overstates a real meeting, but on a
one-core machine the processor is likely to be the first limit reached.

### Applying them to a relay already running

The installer writes them for a new relay. A relay brought up before them has
its own file, holding things added by hand — a probe port, a region list,
`silent` — and re-enrolling with `REPLACE=1` rewrites it whole and takes those
away. So the lines are added by hand:

1. **Choose a moment with nobody in a meeting anywhere in the fleet.** A restart
   drops every call on the machine. The overview in the management pages counts
   clients per relay, but a relay at zero can still be forwarding somebody's
   media through its TURN server to the relay holding their meeting, and that
   person is counted there. Zero across the whole fleet is the moment.
2. **Keep the file as it was**, beside it:
   `cp -a /etc/tomoshibi/relay.yaml /etc/tomoshibi/relay.yaml.before-smooth`.
3. **Insert the five lines directly under `rtc:`**, two spaces in, as above.
   Look first for a `congestion_control` or `packet_buffer_size_video` already
   there: a key written twice is refused.
4. **Restart, and read the start** rather than the file:
   `journalctl -u tomoshibi-relay -n 40 -o cat | grep 'how each viewer'` must say
   `"send side bwe": true` and `"video nack window": 4000` — without the space
   after each colon on a relay that logs JSON (`logging: json: true`), so match
   them as `grep -E '"send side bwe": ?true'`. The file proves what was written;
   this line proves what the process that is answering read. Its words are held
   by a test (`TestMediaSettingsLine`), because a script reads them too.
5. **If it did not come up**, put the copy back, restart, and read the log for
   the key the loader refused. It refuses a misspelt key, or one at the wrong
   depth, rather than ignoring it — a relay that will not start is the price of
   never running on a file that says one thing and means another.

On a relay held under a systemd `MemoryMax`, the runtime is given a limit below
it in the same restart, as a drop-in of its own beside whatever set the
ceiling — `/etc/systemd/system/tomoshibi-relay.service.d/gomemlimit.conf`,
holding `[Service]` and `Environment=GOMEMLIMIT=340MiB` for a ceiling of 400M —
so that taking it back is removing one file. `systemctl daemon-reload` before
the restart, and afterwards read it from the process rather than the unit:
`tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value tomoshibi-relay)/environ | grep GOMEMLIMIT`.
Write the value the way Go reads it (`340MiB`, not `340M` or `340MB`): one it
cannot read stops the relay at startup. And with its unit: a bare number is
bytes, so `GOMEMLIMIT=340` is a limit of 340 bytes, which Go accepts without a
word and then spends the processor collecting against, and which reads back
from the process exactly as it was written.

## A relay reached by address rather than by name

Some paths refuse a relay by the name in the TLS handshake and by nothing else.
It is worth being precise about that claim, because it is easy to make loosely,
and easy to check: dial the same address on the same port and change only the
name offered in the handshake. `dev/snicheck` does that.

Measured from Singapore, six rounds per name, against one of these machines:

| name offered            | handshakes finished |
| ----------------------- | ------------------- |
| (none)                  | 6/6                 |
| a name it once answered to | 2/6              |
| another it once answered to | 0/6             |
| a name never used       | 6/6                 |

So the filtering follows the name, it is intermittent — a single attempt would
have found any of those answers and reported it as the whole truth — and a name
that has not been used yet is clean until it has been.

A relay in that position is configured with a bare address in its URL, which
costs three things and is worth them:

- **The address is visible.** It is in the join response and in any browser's
  network panel. There is no version of not sending a name that also hides where
  the machine is.
- **The certificate is its own.** A wildcard for a domain cannot answer for an
  address, so the machine issues one for its own address — short-lived, six
  days, renewed by an acme client on the machine itself. The fleet-wide
  certificate push refuses to overwrite it: a renewal never narrows what a
  certificate answers to, whatever its expiry says.
- **Nothing else can renew it.** The control node reads back what each relay is
  serving and says so every round, and warns when one is under two days out.
  That is the whole of watching it, and the message names the machine.

### Undoing a certificate pushed by mistake

The refusal rules go one way, deliberately. A relay never narrows what it
answers to, and never takes a certificate that expires no later than the one it
holds. Both were written after real faults: a wildcard pushed over the
certificates of the two relays dialled by bare address took them off the air.

So a certificate pushed by mistake with a distant expiry cannot be pushed over.
Every correct push afterwards is refused — and a refusal answers 200 and reads
exactly like the ordinary case of a relay already having what was sent. The
control node now says which it was, at warning level, naming the machine and the
reason; before that it looked like nothing at all.

There is no override for this and there should not be. One reachable over the
network is a way for whoever can reach a relay to narrow its certificate, which
is the thing the rule prevents. The way out is on the machine:

```bash
rm /etc/tomoshibi/certs/relay.fullchain.pem
```

With nothing there, the next hourly push has nothing to be refused in favour of
and lands. No restart: the server re-reads its certificate on the next
handshake.

Set the acme client's reload command to fix the file's group and mode and
nothing else. Restarting the relay drops every call on it, and the server
re-reads its certificate on the next handshake — a renewal every two days
should not cost a call every two days.

The alternative — rotating to a fresh name each time one is filtered — works, is
cheaper to operate, and was not chosen: a name that has not been used yet is
clean because it has not been used yet, and the rotation is a schedule somebody
has to keep against an adversary who does not.

## What it costs

A relay carries every byte of every call held on it. That is the point of
putting it where the routes are good, and it is also the whole of the bill on a
host that charges for egress. `sticky` is the policy that minimises it; `probe`
trades some of it for latency, and needs redis to do so.

## What a control node going away costs

Measured rather than reasoned about, because the answer decides how much the
control node's stability matters. It was stopped for sixty seconds during a call
between two people on the same relay.

The call did not notice. Both ends stayed `connected` with no reconnection
event, and traffic went on flowing throughout — one participant's counters moved
from 1.7 MB to 21.6 MB across the outage. Nothing about a call in progress goes
through the control node: it signs the token at the door and the media server
holds everything after that.

What does stop is joining. A token cannot be signed, so nobody new gets in until
it is back — and when it came back, a third person joined normally and was sent
to the relay already holding the room.

The one thing a client asks for mid-call is who the host is, polled from
`/api/rooms/{name}/host`. It fails quietly and keeps the last answer, so a host
panel goes stale rather than a call going down.
