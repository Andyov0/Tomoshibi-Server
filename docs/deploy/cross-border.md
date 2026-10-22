# 6. Cross-border routing

[Back to the guide](../../DEPLOY.md)

A fleet with machines on both sides of a border meets four problems. Each has
its own tool, and they combine.

| Problem | Tool |
| --- | --- |
| The network probes servers for websites and takes unregistered ones off the air. | [Silent relays](#silent-relays) |
| TLS to a server without an ICP filing is intercepted, so the signalling socket cannot be opened to it, though UDP passes. | [Signals through](#signals-through-media-here-signalling-elsewhere) |
| Some pairs of relays carry nothing usable between them, or carry it in one direction only. | [Never forwards with, bridges, forwarding](#pairs-that-do-not-carry) |
| The direct path from a mainland relay to an overseas relay is slow or lossy, while a hop through Hong Kong is not. | [viahk](#viahk-routing-a-mainland-relays-overseas-traffic-through-hong-kong) |
| A path filters a relay by the name in the TLS handshake. | [Relays dialled by address](#relays-dialled-by-address) |

Everything here sits on one shared redis; its password rotation is
[below](#rotating-the-redis-password).

## Silent relays

`meet.silent: true` (written by `SILENT=1` at enrolment), read on relays only.

The relay then answers nothing but:

- a WebSocket upgrade (the signalling a call makes), and
- a request carrying `Authorization: Bearer ...` (the control node's counters
  and certificate push; the token is checked by the handler behind).

Everything else is hijacked and closed after the TLS handshake, without a
status line. A prober learns that the port accepts TCP and completes TLS and
nothing more; a `curl https://sh.relay.example.com:13377/` gets no answer at
all. HTTP/2 is off on the relay's listener, so the hijack always works.

The cost is the ability to ask the relay anything from a browser. Leave it off
elsewhere: a machine that answers is a machine that can be diagnosed. Written
on a control node or a single machine, `silent` is accepted and does nothing.

## Signals through: media here, signalling elsewhere

For a relay in mainland China that no TLS reaches. Its media is DTLS-SRTP over
UDP (and a forwarded call's TURN is UDP), so the media never needed TLS; only
the signalling WebSocket did.

On the mainland relay's row in **Relays**, set **Signals through** to another
relay's name, typically one in Hong Kong. Then, for anybody whose entry is the
mainland relay:

1. The join hands out the **named relay's** signalling URL instead of the
   mainland relay's.
2. A new room is put on the mainland relay first. The cluster creates a room
   on the node that receives its first signalling, which would otherwise be
   the Hong Kong relay, taking the meeting to the wrong side of the border.
3. The named relay passes the signalling to the mainland relay through redis,
   as the cluster already does for any meeting held on another node.
4. Media goes directly between the browser and the mainland relay's UDP port.

Requirements and rules:

- Both relays use the same redis.
- The named relay must signal for itself: it cannot be this relay, and cannot
  itself signal through another (`signal_via_itself`,
  `signal_via_unknown`, `signal_via_chained` are refused when saving).
- If the named relay is not answering, the control node uses the nearest
  answering relay that signals for itself (not an administrators-only one),
  and logs `a relay signals through one that is not answering, so its clients
  signal through another`. If there is none, clients signal to the mainland
  relay directly, logged as `a relay signals through another and none can
  carry it`: a call that may be intercepted rather than one that certainly
  fails.
- The named relay is kept under watch even when out of service, and cannot be
  removed while a relay signals through it.
- Usually combined with `SILENT=1` on the mainland relay.

To check it: join a room through the mainland relay. In **Rooms** the room is
held on the mainland relay; in the browser's WebRTC internals the remote media
candidate is the mainland relay's address while the WebSocket goes to the
named relay.

(To be confirmed: whether the control node's HTTPS calls to a relay whose TLS
is intercepted on every path, for its counters and the certificate push,
still succeed. The 30-second reachability check is a bare TCP connect and does
not depend on TLS.)

## Pairs that do not carry

Reachability between two machines is a fact about the networks between them;
nothing here derives it. Three fields on the relay page describe it, and the
join applies them as described in
[chapter 5](relays.md#how-rooms-are-placed).

- **Never forwards with** lists relays this one must not be paired with, in
  either direction (a rule written on either side holds for both). Somebody
  whose entry is kept apart from the meeting's relay is not forwarded; they
  get a bridge, or are sent straight to the meeting's relay.
- **Stands in for pairs that cannot reach each other** marks a bridge: a relay
  that can talk to both sides. Somebody abroad joining a meeting held inside
  is sent to the bridge instead of the relay they picked, when their pick is
  kept apart from the meeting's relay. A bridge still has to be allowed to
  pair with the meeting's relay.
- **Forwards through** and **Forwards other rooms** let an entry relay carry a
  call held elsewhere over its TURN server, so a person keeps the domestic
  relay they picked and the media crosses the border once, between relays,
  on a link you chose ([TURN forwarding](relays.md#turn-forwarding)).

Deliberately not derived from regions: regions group the picker for people,
and inferring a network rule from them would let a change made for
legibility silently change where media goes.

## viahk: routing a mainland relay's overseas traffic through Hong Kong

### What it is

Not a tunnel. No WireGuard, GRE, sing-box, or any other software is
installed. Two shell scripts set **nftables NAT rules**: on the mainland relay
(the *spoke*), packets the relay itself sends to an overseas relay's port have
their destination rewritten to a Hong Kong machine (the *hub*) on a port
chosen for that destination; on the hub, a packet arriving on that port is
rewritten to the real destination and sent on as the hub. Conntrack undoes
both rewrites on the way back, so the relay process sees the overseas address
it addressed and never learns any of this happened.

What leaves a mainland machine is ordinary UDP to another of your machines on
a port you chose. A tunnel would be tidier, and would also be a protocol with
a handshake that can be fingerprinted, which on a machine rented in mainland
China is a reason not to have one.

Why it works with TURN: a TURN client makes one allocation, so there is no
field in which to say "and pass through Hong Kong". But which route the
mainland relay's kernel takes is the relay's own business. The browser still
sees one hop.

What it was measured to do (dev/viahk/README.md), from a relay in Guangzhou
to the relays' probe ports:

| Path | Direct | Through Hong Kong |
| --- | --- | --- |
| to Hong Kong | 11-14 ms | (the hub) |
| to Singapore | 339-356 ms | about 45 ms |
| to Tokyo | 117-231 ms, 1 of 8 lost | about 60 ms |
| to Los Angeles | 158-165 ms | about 156 ms |

The cost: the hub carries every mainland participant's media for overseas
meetings, in both directions, and its bill and uptime become that path's.

### The shape

```
mainland relay (spoke) --UDP--> Hong Kong hub --UDP--> overseas relays
   output: dst overseas:port      prerouting: dst hub:port
     -> dnat hub:hub-port           -> dnat overseas:port
   postrouting: masquerade        hubpost: masquerade
```

One destination per hub port, because the port is the whole mapping. Several
spokes may share one hub port; conntrack tells them apart.

**Two ports per destination**, because a relay is reached on two UDP ports and
both should take the better road:

- its STUN probe port (what browsers and `udpcheck` time), and
- its media port (`rtc.udp_port`, what a forwarded call is carried on).

Choose hub ports so the destination can be read off the number, for example
`41001`-`41009` for probe traffic and `41011`-`41019` for media traffic, in
the same order of destinations.

### Installing it

Copy `dev/viahk/viahk.sh`, `viahk-hub.sh` and `viahk-install.sh` together to
each machine (the installer refuses to run without the other two beside it).
They are bash scripts and run as root.
The installer applies the rules now, saves its arguments, and installs
`viahk.service` (a oneshot unit, after `network-online.target`) to replay them
at every boot. A reboot without it silently returns the relay to the bad path
with every health check green.

On the **hub**, once, with every mapping it should carry:

```bash
viahk-install.sh hub \
  41001:198.51.100.31:13380 \
  41002:198.51.100.32:13380 \
  41011:198.51.100.31:13378 \
  41012:198.51.100.32:13378
# <hub-port>:<destination ip>:<destination port> ...
```

It also turns on `net.ipv4.ip_forward`, now and in
`/etc/sysctl.d/99-viahk.conf`.

On **each mainland relay**:

```bash
viahk-install.sh spoke 203.0.113.50 \
  198.51.100.31:13380:41001 \
  198.51.100.32:13380:41002 \
  198.51.100.31:13378:41011 \
  198.51.100.32:13378:41012
# <hub ip> <destination ip>:<destination port>:<hub port> ...
```

The spoke uses nftables where it exists and falls back to iptables (its own
`VIAHK_OUT` / `VIAHK_POST` chains in the nat table); the hub needs nftables.
Use addresses, not names: a name would be resolved on the mainland machine,
and some of these destinations are dialled by address precisely because their
names are filtered.

dev/viahk/README.md shows an older argument form under "Applying it"; the
scripts' own usage lines, as above, are what they accept.

Firewalls: the hub must accept UDP on its hub ports from the spokes'
addresses (only those). The destinations already accept UDP on their probe
and media ports from anywhere.

Both roles on one machine are supported, and useful: a relay that sends its
own overseas traffic through Hong Kong can also be the hub for a path that
only works in one direction (Hong Kong reaches one mainland relay only
through another mainland relay six milliseconds from it). The two scripts own
different chains of the same `ip viahk` table (`output` and `postrouting`
against `prerouting` and `hubpost`), so installing one role leaves the other
alone.

**A hop that is forwarded must be a hub mapping, never a spoke rule.** The
spoke's rule is in the `output` chain, which only sees packets the machine
itself sends. Forwarded packets go prerouting, forward, postrouting and never
reach `output`. A second leg written as a spoke rule on a machine that is
forwarding for others does nothing for the forwarded traffic, and in the
reference deployment took three relays from 348 ms to answering nothing. Write
the second leg as a mapping on the hub that sends to the next machine's hub
port.

Keep a record of the mappings you install (which machine forwards what to
where, on which port). dev/viahk/MAPPINGS.md is that record for the reference
deployment, with documentation addresses.

### Checking it

```bash
viahk-install.sh show            # arguments installed, unit state, rule count
nft list table ip viahk          # the rules themselves
systemctl status viahk
udpcheck 198.51.100.31:13380     # from the spoke, before and after
```

**Count the rules before and after any change, and the counts must match
what you meant.** A mapping quietly one rule short reads as working until
somebody says the meeting is bad. In the reference deployment, an older
layout's masquerade rules sat in the chain the spoke rebuilds and were
flushed when the spoke role was installed; only the count showed it.

To measure the difference fairly, `dev/viahk/compare.py` probes each
destination on two ports in the same minute, one with a rule and one without,
so both readings share the same weather. Edit its `RELAYS` list and its `VIA`
and `DIRECT` ports for your fleet, run it on the spoke (for example as a
service), and it appends a line per round to `/var/log/viahk-compare.log`.
`dev/viahk/report.py [log]` folds that by hour, with loss beside the
milliseconds: the question is which hours the detour earns its keep in, which
a daily average hides. (To be confirmed: compare.py needs each destination to
answer STUN on both ports, while `meet.probe_port` is a single port; how the
reference destinations answer on the second port is not recorded in the
repository.)

Once a mainland-to-overseas pair carries well through the hub, it may no
longer need to be kept apart; whether to take it out of **Never forwards
with** is a decision about the hub's bandwidth. (To be confirmed: what the
reference deployment chose.)

### Rolling back

```bash
viahk-install.sh off
```

disables and removes `viahk.service`, runs both scripts' `off`, and deletes
the saved arguments. One role cannot be removed alone this way; re-run the
installer for the role that should stay.

**On the hub, `off` turns IP forwarding off** (`net.ipv4.ip_forward=0` now,
and removes `/etc/sysctl.d/99-viahk.conf`). On a machine that forwards for
anything else (docker, a VPN, a router role), that breaks it; turn forwarding
back on afterwards.

Running `viahk.sh off` or `viahk-hub.sh off` by hand removes the rules until
the next boot, when the unit puts them back.

## Rotating the redis password

From dev/viahk/rotate-redis.md. The password is in redis and in every relay's
configuration (and in the control node's, which hands it to new relays).
Changing redis and then racing to change the machines would leave relays
unable to see the cluster for the length of the race. There is no race,
because a redis user can hold several passwords at once.

1. **Add the new password beside the old one.** Passwords on the command line
   are visible to other users of the machine; `redis-cli` reads one from the
   `REDISCLI_AUTH` environment variable instead.

   ```bash
   REDISCLI_AUTH='OLD' redis-cli -p 6379 ACL SETUSER default '>NEW'
   ```

   Both work now, and nothing is disconnected. **Check all three cases before
   going on**: the old works, the new works, a wrong one fails
   (`REDISCLI_AUTH='...' redis-cli -p 6379 PING`). `OLD` and `NEW` stand for
   the passwords themselves: `>` adds one, `<` removes one.

2. **Change each machine, one at a time.** Copy its file first
   (`cp -a /etc/tomoshibi/relay.yaml /etc/tomoshibi/relay.yaml.rotate-bak`),
   change `redis.password`, restart it, and read its log for redis errors.
   The password is read at startup, so editing the file changes nothing until
   the restart; a machine part-way through is not broken, since redis accepts
   either. A relay restart ends the calls on that relay only, so do it with
   the fleet idle. Change the control node's `redis.password` too, so new
   relays are handed the new one; restarting the control node ends no calls.

3. **Remove the old password** once every machine holds the new one:

   ```bash
   REDISCLI_AUTH='NEW' redis-cli -p 6379 ACL SETUSER default '<OLD'
   ```

   Check first: a machine still on the old password works until its next
   reconnect and then fails quietly.

4. **Persist it in redis's own configuration.** `ACL SETUSER` changes the
   running server. If redis takes its password from `requirepass` in its file,
   change that line too, or the next redis restart brings back whatever the
   file says. (`CONFIG REWRITE` is unavailable while `CONFIG` is disabled,
   which the reference deployment keeps it.) (To be confirmed: how the
   reference deployment persists its redis password.)

Rolling back: until step 3 the old password still works, so restore the
`.rotate-bak` files and restart. After step 3 only the new one works.

`CONFIG`, `FLUSHALL`, `FLUSHDB`, `SHUTDOWN` and `KEYS` are disabled on the
reference deployment's redis, and should stay so; `ACL` does this job without
re-enabling any of them. Example directives: [redis.conf](examples/redis.conf).

## crossrelay: what happens without the join

`dev/crossrelay` answers one question: when somebody dials relay A and the
meeting is held on relay B, where does their media go **if the join's
forwarding layer is absent**? It mints a LiveKit token directly (`mint`) and
connects a headless browser straight to a relay, skipping the join endpoint,
which is exactly the part that chooses forwarding.

```bash
go build -o /tmp/mint ./dev/crossrelay
/tmp/mint "$KEY" "$SECRET" myroom alice > /tmp/a.txt     # the deployment's own pair
/tmp/mint "$KEY" "$SECRET" myroom bob   > /tmp/b.txt

cp web/node_modules/livekit-client/dist/livekit-client.esm.mjs dev/crossrelay/
(cd dev/crossrelay && python3 -m http.server 8877 &)

# One headless browser per relay, with fake media devices, opening
#   http://<this machine>:8877/page.html?url=wss%3A%2F%2Fhk.relay.example.com%3A13377&token=<token>
```

Then read `window.__room.serverInfo` and the peer connection's remote candidate
in each browser. The reference run found both people in the room with media
flowing, and the one who dialled the mainland relay connected straight to the
Hong Kong relay holding the room: the relay they picked carried nothing. That
is the floor, and the reason the forwarding layer exists; it is not how the
product behaves. The tokens it mints are good for thirty minutes and carry the
deployment's authority, so run it only where you would keep the key.

## Relays dialled by address

Some paths refuse a relay by the name in its TLS handshake and by nothing
else. `dev/snicheck` checks the claim properly: same address, same port, only
the offered name changes, several rounds each, because the filtering is
intermittent.

```bash
snicheck 203.0.113.31:13377 hk.relay.example.com new-unused.example.com -
```

A relay in that position is given a bare address in its URL
(`wss://203.0.113.31:13377`), which costs three things:

- **Its address is visible** in the join response and any browser's network
  panel.
- **Its certificate is its own**: issued for its IP address on the machine
  itself, short-lived (six days in the reference deployment), renewed by an
  ACME client there. The fleet-wide push refuses to replace it, since a
  wildcard does not cover an address.
- **Nothing else can renew it.** The control node reports what each such
  relay serves every hour and warns under two days. That warning reaches a
  person through the watchdog ([chapter 9](operations.md#monitoring-and-alerts)).

Its TURN address ("Forwards through") should be the bare address too.

The alternative, moving to a fresh name each time one is filtered, works and
was not chosen: a new name is clean only until it has been used, and the
rotation is a schedule somebody has to keep.
