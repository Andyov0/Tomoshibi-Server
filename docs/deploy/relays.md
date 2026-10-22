# 5. Relays

[Back to the guide](../../DEPLOY.md)

A relay is the same binary with `meet.role: relay`. It runs the embedded
LiveKit media server and serves, on its one TCP port:

- the signalling paths (`/rtc`, and LiveKit's `/twirp/` API, which only the
  control node uses, with the deployment's credentials);
- `/twirp/relay.stats`, its counters, behind the deployment's credentials;
- `/twirp/relay.certificate`, where the control node pushes certificates.

Nothing else. There is deliberately no health endpoint: on a network that
probes ports for websites, an endpoint answering anybody is the evidence that
gets a machine taken off the air.

There are two ways to bring one up: the enrolment script, which is the normal
way, or by hand.

## Before the first relay

- The control node is running with a `meet.enrol` section (secret, domain,
  public URL, ports, certificate, redis address) and, ideally, Cloudflare
  credentials.
- The wildcard for `*.<enrol.domain>` is at `meet.enrol.cert_file` /
  `key_file` and readable by the service.
- redis is reachable from the new machine.
- The new machine runs Linux with systemd, has `curl`, and has the control
  node's CPU architecture.

## Enrolling a relay

In the management pages: **Relays**, **Add a machine**. The page shows the one
command to run on the new machine as root, with the enrolment secret already
in it:

```bash
bash <(curl -fLSs https://meet.example.com/install) <prefix> <enrolment secret>
```

Replace `<prefix>` with the name the machine should answer to; leave it out
and the script asks. The page also offers the whole script to read first
(**What that runs, in full**), which is the copy with the secret embedded.

The script at the public `/install` carries no secret; it travels in the
operator's own command, so nothing that logs URLs ever sees it. The other form
in RELAY.md, `curl -fsSL https://meet.example.com/install | ENROL=<secret> sh
-s <prefix>`, does the same. Process substitution is preferred because a
script read from a pipe has the download on its standard input.

**The command is a credential.** Whoever holds it can add a relay and receives
the API secret, the redis password and the certificate's private key. Do not
paste it anywhere it will be kept.

### Options

Set in front of the command, for example `SILENT=1 REGION=cn-east bash <(...)`:

| Variable | Effect |
| --- | --- |
| `SILENT=1` | Writes `meet.silent: true`. For relays in mainland China. |
| `REPLACE=1` | Take over a prefix already in use without asking. Only for a rebuild of the same relay. |
| `REGION=<label>` | The relay's region label (what `nearest` compares and the picker groups by). |
| `ADDRESS=<ipv4>` | The address the relay's name should point at, when it cannot be worked out. |
| `PREFIX=`, `ENROL=` | The prefix and the secret, in place of the arguments. |
| `http_proxy`, `https_proxy` | Honoured by `curl` for reaching the control node, for machines whose outbound 443 is blocked. Never used for working out the machine's own address. |

### What the script does

1. Checks it runs as root, that `curl` exists and that it has a secret.
2. Checks the prefix (lowercase letters, digits, inner dashes) and asks the
   control node whether it is taken (`/api/enrol/taken`). A prefix already in
   use is refused unless you confirm a takeover or pass `REPLACE=1`: a typo
   would otherwise move an existing relay's name to this machine while that
   relay went on holding calls at an address nobody reaches.
3. Works out the machine's public IPv4 address: `ADDRESS` if given; otherwise
   over DNS (`dig` or `nslookup` against OpenDNS's resolvers, which a proxy
   cannot intercept); otherwise from public address-echo services over HTTPS
   with every proxy setting removed; otherwise leaves it to the control node,
   which uses the address the request came from.
4. Claims its configuration from `/api/enrol`. The control node checks the
   secret (wrong secrets are rate limited and logged), refuses a taken prefix,
   creates the DNS record through Cloudflare if configured (and checks it
   resolves twenty seconds later), records the relay as enabled, and answers
   with the API key and secret, the redis address and password, the
   certificate and key, the ports, and, where locations are known, the
   relay's region name and the fleet's region list.
5. Downloads the binary from `/download/tomoshibi` to
   `/usr/local/bin/tomoshibi`.
6. Writes the certificate to `/etc/tomoshibi/certs/relay.fullchain.pem` (644)
   and `relay.key` (640), group `tomoshibi-certs`.
7. Writes `/etc/tomoshibi/relay.yaml` (640, group `tomoshibi-certs`): the
   ports, `use_external_ip: true`, the measured media settings
   (`packet_buffer_size_video: 4000`, the sender-side estimate), the outward
   network interface, the key pair, redis, `region` and `node_selector` when
   available, `meet.role: relay`, `listen`, the certificate paths,
   `probe_port` when the deployment sets one, and `silent` with `SILENT=1`.
8. Installs and starts `tomoshibi-relay.service`
   ([the same unit](examples/tomoshibi-relay.service)), and shows the last
   twenty log lines if it is not running five seconds later.
9. Prints the relay's address, whether the DNS record was created, and the
   ports to open.

Taking over a prefix keeps everything set on the relay's page (its probe
address, TURN address, location, flags, which relays it is kept apart from);
only the region, the URL and "in service" come from the installer. The region
is whatever `REGION` says, so give it again or the label is cleared.

Enrolment is IPv4 only: the address detection and the DNS record are IPv4
(`A`). (To be confirmed: whether a relay reachable only over IPv6
can be run, set up by hand.)

### After the script

1. **Open the ports** in the host firewall and any cloud security group:
   TCP 13377, UDP 13378, TCP 13379, plus the probe port and any TURN ports
   ([chapter 2](prepare.md#relay)).
2. **Describe the relay** on its row in **Relays** (all optional, all worth
   doing; see [the relay record](#the-relay-record)):
   - **Where it is**: latitude and longitude. Draws it on the join screen's
     globe and, once two or more relays have one, lets later enrolments write
     the distance-aware `node_selector` block.
   - **Measured at**: `hk.relay.example.com:13380`, the probe port, so clients
     and the control node can time it over STUN. The enrolment writes
     `probe_port` into the relay's file but **not** this field.
   - **Shown to people as**: a readable label.
   - **Forwards through** and **Forwards other rooms**: if it runs TURN.
   - **Signals through**: for a relay no TLS reaches.
3. **Check it**: the row turns reachable within half a minute; **Measure
   again** asks now. From another machine, `udpcheck hk.relay.example.com:13380`
   answers whether media can reach it.
4. **Read its start**: `journalctl -u tomoshibi-relay -n 40 -o cat`. Look for
   `relay: media and signalling only`, the line `settings: how each viewer's
   media is chosen` with `"send side bwe": true` and `"video nack window": 4000`,
   and no warning about `use_external_ip` or redis.

**The region list is written once.** The enrolment renders `node_selector`
for the machine being enrolled from the locations known at that moment. It
writes nothing when fewer than two relays have a location, or when this relay
has none yet (a list without the relay's own region stops the media server),
and logs why. Relays enrolled earlier keep the list they were given. (To be
confirmed: what a relay with an older list does with a room meant for a relay
missing from it; adding the new region to older relays' files by hand, with
the fleet idle, keeps them consistent.)

## Adding a relay by hand

For a machine you do not want to enrol, or a different architecture.

1. Copy the binary to `/usr/local/bin/tomoshibi`.
2. Write `/etc/tomoshibi/relay.yaml` from [relay.yaml](examples/relay.yaml)
   with the deployment's key pair and redis, and a certificate the relay can
   serve. `rtc.use_external_ip: true` is required.
3. `groupadd -f tomoshibi-certs`; key and configuration 640 in that group.
4. Install [tomoshibi-relay.service](examples/tomoshibi-relay.service),
   `systemctl enable --now tomoshibi-relay`.
5. In **Relays**, **Add by address**: the name and the address a browser
   dials (`wss://...`). Or, before the control node's first start only, list
   it under `meet.relays`.
6. Point its DNS name at it yourself.

The control node pushes its relay certificate to every relay in the list,
including this one, hourly.

## The relay record

What the control node knows about each relay, stored in its store. Three of
these fields can come from the configuration file; the rest are set on the
relay's row in **Relays**.

| Field (page label) | Meaning |
| --- | --- |
| Name | The key: in logs, in the join, and what a measuring client sends back. Short, lowercase. Renaming orphans clients that measured the old name; use the label instead. |
| Address ("What a browser dials") | `wss://hk.relay.example.com:13377`, or `wss://203.0.113.31:13377` for a relay dialled by address. |
| Region | The deployment's own label. Groups the picker (a slash nests: `Oversea/Asia`) and is what `nearest` matches. |
| Shown to people as | A label shown instead of the name. |
| Measured at | `host:port` where it answers STUN. Empty: clients time the signalling socket instead. Clients only use STUN when every relay in the list has one, so a fleet is measured one way. |
| Forwards through | `host:port` of its TURN server (UDP). Empty: it cannot carry a call it is not holding. |
| Forwards other rooms | Whether it may. Forwarding costs the relay two bytes for every one it carries, so this is the switch on its bill. |
| Never forwards with | Relay names, comma separated, in both directions: pairs whose networks carry nothing usable between them. |
| Stands in for pairs that cannot reach each other | A bridge: used as the entry for somebody whose own entry is kept apart from the relay holding their meeting. |
| Signals through | A relay name. This relay's signalling is carried by that relay (through redis); its media stays here. For a machine no TLS reaches. The named relay must signal for itself, and may not be this one. |
| Where it is | Latitude, longitude. The globe, and the media servers' distance-aware placement. |
| Keep in reserve | Only used when no ordinary relay is available. |
| Administrators only | Never chosen for anybody else, and refused when somebody else asks for it by name, unless the meeting they are joining is already held there. Shown in everybody's list without its address. |
| Send calls here / Stop sending here | In service or not. Out of service takes no new calls and keeps the ones it is holding. |
| Order | Drag to reorder; the order the pages list relays in. |

A relay's media-server region name (`node` in the store) is its name,
lowercased, unless set through the API.

## TURN forwarding

A meeting lives on one relay: the media server binds a room to the node that
opened it. Without forwarding, everybody who joins later is sent to that
relay whatever they picked, so a relay chosen for its domestic routes carries
nothing for them. With forwarding, a client keeps the relay it picked and
allocates on that relay's TURN server, and the relay passes its packets on to
the one holding the room: one extra hop, paid on purpose, for the call
entering the country the person is in.

The TURN server is LiveKit's own, so there is no coturn to run. Credentials
are minted by the control node from the deployment's key pair at each join,
usable for twelve hours to open an allocation (a call in progress keeps
refreshing past that).

To set it up on a relay:

1. Add to its `/etc/tomoshibi/relay.yaml` (keys from LiveKit v1.13.5; the
   enrolment does not write them, and a re-enrolment removes them):

   ```yaml
   turn:
     enabled: true
     udp_port: 13381
     relay_range_start: 30000
     relay_range_end: 40000
   ```

2. Open UDP 13381 to everyone and the relay range to the other relays.
3. Restart it with the fleet idle (it ends the calls on it).
4. Check from outside:
   `turncheck hk.relay.example.com:13381 <api key> <api secret>` (an
   allocation is granted), then `... -self` (something sent through the
   allocation comes back). `turncheck` needs the deployment's key pair, so run
   it from a machine you trust.
5. On the relay's row: **Forwards through** `hk.relay.example.com:13381`
   (a bare address works, and is what a relay whose name is filtered should
   use), and tick **Forwards other rooms**.

A pair that forwards badly is put in **Never forwards with**; the control node
logs `refused to forward between relays kept apart` when it declines one.

## Media settings

Every relay the script brings up has these under `rtc`:

```yaml
packet_buffer_size_video: 4000
congestion_control:
  enabled: true
  use_send_side_bwe: true
```

Chosen by measurement with a 1440p screen share on shaped lines (RELAY.md has
the numbers): the sender-side estimate made most rounds watchable where the
defaults made none, and 4000 packets of resend history stopped `cannot be
sequenced` and constant keyframe requests. The cost is memory, roughly 1 MB
per video subscription at ten people.

A relay brought up before these settings has a file holding things added by
hand, which a re-enrolment would remove. Add the lines instead:

1. Choose a moment with nobody in a meeting **anywhere in the fleet**. A relay
   at zero clients can still be forwarding somebody's media to the relay
   holding their meeting.
2. `cp -a /etc/tomoshibi/relay.yaml /etc/tomoshibi/relay.yaml.before-smooth`
3. Insert the five lines directly under `rtc:`, two spaces in. Look first for
   an existing `congestion_control` or `packet_buffer_size_video`: a key
   written twice is refused.
4. `systemctl restart tomoshibi-relay`, then read what the process loaded,
   not the file: `journalctl -u tomoshibi-relay -n 40 -o cat | grep 'how each viewer'`
   must show `send side bwe` true and `video nack window` 4000. On a relay
   logging JSON (`logging.json: true`) there is no space after the colon, so
   match `grep -E '"send side bwe": ?true'`.
5. If it did not come up, put the copy back, restart, and read the log for
   the key the loader refused.

### Memory limits

On a relay under a systemd `MemoryMax`, give the Go runtime a lower limit in a
drop-in of its own: [gomemlimit.conf](examples/gomemlimit.conf)
(`GOMEMLIMIT=340MiB` for a ceiling of 400M). Fifteen people measured 354 MB
with it. Write the unit the way Go reads it (`MiB`); a value it cannot parse
stops the relay, and a bare number is bytes.

## Certificates on relays

- The enrolment writes the wildcard; the control node pushes renewals hourly.
  The relay re-reads its certificate on the next handshake, so no restart.
- A relay takes a pushed certificate only if it expires later than what it
  holds **and** answers for every name the held one answers for. Both rules
  came from real outages: a wildcard pushed over two bare-address relays'
  certificates took them off the air.
- **Undoing a certificate pushed by mistake** with a distant expiry: there is
  no override, by design. On the relay, `rm /etc/tomoshibi/certs/relay.fullchain.pem`;
  the next hourly push lands. No restart.
- **A relay dialled by address** serves a certificate for its own IP,
  issued and renewed by an ACME client on that machine. Set that client's
  reload command to fix the files' group and mode and nothing else (no
  restart). The control node reports every hour which relays serve their own
  certificate and when it runs out, and warns at under two days:
  `a relay is serving a certificate that expires soon, and it is not one this
  node can renew: look at the acme client on that machine`.

## Health checks and probes

What the control node does, from `internal/app/reachable.go`:

- Every **30 seconds** it opens a TCP connection to each relay's signalling
  port and closes it without sending a byte (4-second timeout).
- A relay is withdrawn from what clients are offered after **two** failed
  checks in a row, and offered again on the first success. Logged once on each
  change: `a relay stopped answering and is no longer offered to clients`,
  `a relay is answering again`.
- If **most of the fleet** (three or more relays, fewer than half answering)
  fails in one sweep, it assumes its own line is the problem and keeps the
  previous readings: `most of the fleet did not answer this sweep`.
- Where a relay has **Measured at** set, it also sends one STUN request. A
  relay whose signalling answers and whose media port does not is logged
  (`this node reaches a relay's signalling port but not its media port`) and
  **kept in service**: the control node's path is one vantage point, and one
  relay in the reference fleet answers UDP from everywhere except the control
  node while carrying calls perfectly. Ask from another machine before
  touching it.
- Out-of-service relays are still checked when another relay signals through
  them.

What clients do: under `probe`, the browser fetches `/api/relays`, measures
every relay in parallel (STUN when every relay has a probe address, otherwise
the signalling socket, about three round trips), at most a second and a half
each, caches the result for five minutes, and sends the fastest name. A
failure anywhere means no preference; measuring can never stop a call.

Tools, built as in [chapter 3](build.md#the-development-tools):

| Tool | Answers |
| --- | --- |
| `udpcheck host:port ...` | Does STUN reach this relay's probe port from here? Run it from several places; differing answers are the measurement, not noise. |
| `turncheck host:port key secret [-self]` | Is a TURN allocation granted? Does traffic come back through it? |
| `snicheck address:port name ... -` | Is a path filtering by the TLS name? (`-` offers no name.) |
| `peekroom <db> <room>` | Where the store says a room is held, and who hosts it. Service stopped, or a copy. |

## How rooms are placed

Everything that decides which machine a person dials and which machine holds
their meeting, in the order the join applies it (`internal/app/app.go`,
`internal/app/relay.go`).

**1. The candidates.** Enabled relays; without the "administrators only" ones
for everybody else. Preferred: relays that are answering and not in reserve.
If none, answering reserve relays; if none, every ordinary relay; if none,
every reserve relay. A deployment whose relays all look down still holds
calls somewhere.

**2. The entry relay** (what this person dials) by `meet.relay_policy`:

| Policy | Chooses |
| --- | --- |
| `sticky` (default) | A stable hash (FNV) of the room name over the candidates: everybody in a room on one relay, identical across control nodes and restarts. Cheapest on metered egress, since media never crosses between relays. |
| `probe` | The relay the client measured as fastest, if it is one of ours (even a reserve one, since it asked). Otherwise as `sticky`. Needs redis. |
| `nearest` | The candidate whose `region` equals `X-Client-Region` or `CF-IPCountry` (case-insensitive), under `trust_proxy`. Otherwise as `sticky`. |
| `round_robin` | Each in turn, ignoring room and region. |

An operator can pin one person to a relay (**Rooms**, a participant, **Send in
through another relay**): they are dropped from the call and come back in
through that relay. The pin is used once.

**3. The holding relay** (where the meeting is):

- **Placed by an operator** (**Rooms**, **Move**, **Hold the next call
  here**), or by an arranged meeting's own placement: always that relay,
  whatever its state, with a warning if it is out of service. The room is
  created on that node before anybody signals, so it really is held there.
- **Otherwise, where it already is**: the store's note of the holding relay
  is checked against the media servers. If the meeting is still going, there;
  if it ended, the note is released and the entry relay will hold it.
- A placement lasts as long as the room's record, `meet.rooms.remember`.

**4. When entry and holding differ:**

- If the pair is kept apart (**Never forwards with**, either side), a
  **bridge** relay that may pair with the holding relay is used as the entry
  instead, if there is one.
- If the entry relay forwards (**Forwards through** set and **Forwards other
  rooms** ticked) and the pair may pair, the client is handed TURN
  credentials for it and keeps it as its entry.
- Otherwise the client is sent straight to the holding relay.

**5. Signalling.** The client opens its WebSocket to the entry relay, unless
the entry **Signals through** another relay: then to that relay if it is
answering, otherwise to the nearest answering relay that signals for itself,
otherwise to the entry itself. A new room is put on the entry relay first, so
the meeting is not created on the relay that only carries its signalling.

**6. Inside the cluster.** Which media node creates a room for a signalling
connection is LiveKit's node selector: `regionaware` with the fleet's
locations when the relay's file has a `node_selector` block, otherwise a
random choice, which once put people into rooms on machines they could not
reach.

## Maintenance

**Taking a relay out of service**: **Stop sending here** on its row. New calls
go elsewhere; the calls it holds continue. Reversible.

**Restarting** ends every call on it, including forwarded ones. Do it with the
fleet idle ([chapter 9](operations.md#is-anybody-in-a-call)).

**Updating the binary**: replace the binary and restart, keeping the
configuration. `dev/watch/update-relay.sh <ssh-target> [binary]` does one
relay with rollback; [upgrade-relays.sh](examples/upgrade-relays.sh) does a
fleet; [chapter 9](operations.md#upgrading-relays) has the procedure.
Re-running the enrolment with `REPLACE=1` also installs the control node's
current binary, but **rewrites `relay.yaml` whole**: anything added by hand
(a TURN section, a hand-made region list, `silent` unless `SILENT=1` is given
again) is gone, and the relay's region label is replaced by `REGION`, which
is empty unless given again. A `GOMEMLIMIT` drop-in survives, being a file of
its own. Re-enrol a machine that is being rebuilt; update the binary of one
that is running.

**Removing a relay**:

1. **Stop sending here**, and wait for its calls to end.
2. If another relay **Signals through** it, change that first: removal is
   refused while one does.
3. **Remove relay** on its row. With Cloudflare configured, its DNS record is
   removed too (a stale record would go on resolving to an address that may
   later be somebody else's). Placements naming it are logged as
   `a room is placed on a relay this deployment does not have`; clear them in
   **Rooms**.
4. On the machine: `systemctl disable --now tomoshibi-relay`, remove
   `/etc/tomoshibi`, the unit and `/usr/local/bin/tomoshibi`, and any
   `viahk` rules ([chapter 6](cross-border.md#rolling-back)).
5. Remove its address from redis's firewall, the viahk hub's mappings, and
   other relays' **Never forwards with** lists.
