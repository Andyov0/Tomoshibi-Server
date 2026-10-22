# 2. Preparation

[Back to the guide](../../DEPLOY.md)

Before building or installing anything: which machines, which names, which
certificates, and which ports. Most first deployments that fail do so here,
and look like something else when they do.

## Machines

**Operating system.** Linux with systemd. The enrolment script is `/bin/sh`
and uses `systemctl`, `journalctl`, `groupadd`, `curl`, and optionally `ip`,
`dig` or `nslookup`; it must run as root. The cross-border routing scripts need
nftables (or, for the mainland end only, iptables with a nat table). Nothing
in the repository depends on a particular distribution. The reference control
node runs Debian 13 (trixie) on 8 cores and 16 GB of memory. (To be confirmed:
which distributions and versions the reference relays run.)

**Architecture.** A relay that enrols downloads the control node's own running
binary from `/download/tomoshibi`, so every enrolled relay must have the
control node's CPU architecture. `meet.enrol.binary` can point that endpoint at
another file, but there is only one, so a mixed fleet enrols one architecture
and installs the other by hand.

**The control node** carries no media. It serves the pages, the join API, the
management pages, the app downloads, and, if watching together is set up to
relay video, every relayed byte of that video. A small machine is enough for
the first four. One data point from the reference control node, read at an
idle moment: the `tomoshibi` process at about 60 MB resident memory and about
0.2% CPU, with the system load close to zero. That is a reading taken while
nothing was happening, not a capacity test. (To be confirmed: how a control
node's load grows with joins, management pages and relayed video; nothing in
the repository measures it.)

**A relay** carries every byte of every call held on it, and twice that for a
call it forwards to another relay (in and out again). Memory grows with the
square of the people in the largest meeting, because everybody with a camera
on is N x (N - 1) subscriptions. Measured on one machine with synthetic
participants, everybody publishing a camera and one also a 48 Mb/s screen
share, resident memory after a minute (RELAY.md):

| People | Video subscriptions | LiveKit defaults | This repository's relay settings |
| --- | --- | --- | --- |
| 2 | 3 | 70 MB | 82 MB |
| 5 | 24 | 91 MB | 124 MB |
| 10 | 99 | 142 MB | 241 MB |
| 15 | 224 | 211 MB | 434 MB |

CPU in the same runs: about 95% of one Apple-silicon core at ten people, and
150 to 175% at fifteen. That overstates a real meeting (every viewer was sent
the 48 Mb/s share whole), but on a one-core machine the processor is likely
the first limit. For a relay under a systemd `MemoryMax`, see
[GOMEMLIMIT](relays.md#memory-limits).

The media server asks for 16 MB socket buffers on its UDP socket and is given
up to `net.core.rmem_max` / `net.core.wmem_max`. Raising those helps a busy
relay and also adds tens of megabytes to its memory charge exactly when it is
falling behind.

## Names and DNS

You need two kinds of name.

**The control node** (or the single machine): one name, for example
`meet.example.com`, pointing at the machine or at a CDN in front of it.

**The relays**: a zone they are named under, `meet.enrol.domain`, for example
`relay.example.com`. A relay enrolled with the prefix `hk` becomes
`hk.relay.example.com` and is dialled as `wss://hk.relay.example.com:13377`.

- A prefix is lowercase letters, digits and dashes, not starting or ending
  with a dash, at most 63 characters. It is also the relay's name, which never
  changes (clients send it back after measuring), so choose something short.
  The management pages can show people a friendlier label.
- **The domain must not be, or sit under, a name that has a CNAME.** A CNAME
  shadows every name beneath it: records created under it appear in the zone
  and are never answered.
- With `meet.enrol.cloudflare_token` and `cloudflare_zone` set, the control
  node creates each relay's record itself: an `A` record, TTL 300, **not
  proxied**. It updates the first existing `A` record for that name and
  removes any others, and removes the record when the relay is removed from
  the management pages. Twenty seconds after creating it, it checks that the
  name resolves to the machine and logs either `a relay's name resolves to it`
  or `a relay's name was created and does not resolve to it`. The token needs
  permission to edit DNS records in that zone; the zone ID is on the zone's
  overview page in Cloudflare.
- Without Cloudflare credentials, the relay still enrols and the script ends
  with `The DNS record was not created. Point <host> at <address> before this
  relay can be used.` Create the record yourself.
- **Relays are never behind a CDN.** Browsers dial them directly on their own
  ports; signalling, STUN and media cannot pass through an HTTP proxy.

**A relay dialled by bare address.** Some networks filter a relay by the name
in the TLS handshake and by nothing else. Such a relay is given a URL like
`wss://203.0.113.31:13377` and a certificate for its own address. That makes
its address visible in the join response, and its certificate becomes
something only that machine can renew; see below and
[chapter 6](cross-border.md#relays-dialled-by-address).

## Certificates

| Certificate | Covers | Where it lives | Who renews it | Watch it? |
| --- | --- | --- | --- | --- |
| The control node's public certificate | `meet.example.com` | On nginx or the CDN, or in `meet.tls_cert` / `meet.tls_key` | Your ACME client on that machine | As you would any website's. |
| The relays' wildcard | `*.relay.example.com` | Issued on the control node at `meet.enrol.cert_file` / `key_file`; copied to each relay at `/etc/tomoshibi/certs/relay.fullchain.pem` and `relay.key` | An ACME client on the control node. The control node then pushes it to every relay within the hour. | The control node logs `offered the renewed certificate to the relays` when it changes. |
| A bare-address relay's own certificate | `203.0.113.31` | On that relay, at the same paths | An ACME client **on that relay** (not part of this repository) | **Yes.** The control node cannot renew it and warns when it is under two days from expiry. |
| TURN | nothing | Not needed: TURN here is UDP only | | |

How certificates move:

- **Hot reload everywhere.** A process serving TLS itself (`meet.tls_cert`)
  re-reads the files on the next handshake after their modification time or
  size changes. Renewal is a file copy; no restart, no dropped calls.
- **The hourly push.** Once an hour, and at startup, the control node reads
  the relay certificate from disk and offers it to every relay over HTTPS with
  the deployment's credentials. A relay keeps what it has unless the offered
  certificate expires later **and** covers every name the held one covers. A
  relay already holding it answers that it has it; a refused push is logged on
  the control node at warning level with the reason. The same round reads back
  what each relay is serving, which is how a bare-address relay's expiry is
  noticed.
- **The wildcard must cover `<prefix>.<domain>`.** A wildcard covers one
  label: `*.relay.example.com` covers `hk.relay.example.com` and not
  `hk.example.com`.
- **Keep the relays' wildcard apart from the control node's own.** Every relay
  holds its private key, so a relay compromised is that wildcard compromised.
  With `meet.enrol.domain: relay.example.com` and a certificate for
  `*.relay.example.com` only, it is not also the control node's.
- **A control node behind a TLS-terminating proxy** has no `meet.tls_cert`,
  so the push has nothing to send unless `meet.enrol.cert_file` and `key_file`
  are set explicitly.

The ACME client itself is outside this repository. The code mentions acme.sh
rewriting these files on its own schedule. As an illustration only (generic
acme.sh usage with Cloudflare DNS validation, not something this repository
ships or tests):

```bash
export CF_Token='<cloudflare token allowed to edit DNS in the zone>'
acme.sh --issue --dns dns_cf -d relay.example.com -d '*.relay.example.com'
acme.sh --install-cert -d relay.example.com \
  --fullchain-file /etc/tomoshibi/certs/relay-wildcard.fullchain.pem \
  --key-file       /etc/tomoshibi/certs/relay-wildcard.key \
  --reloadcmd 'chgrp tomoshibi-certs /etc/tomoshibi/certs/relay-wildcard.* && chmod 640 /etc/tomoshibi/certs/relay-wildcard.key'
```

The reload command fixes the group and mode and nothing else. Restarting a
relay or a full machine to pick up a certificate drops every call on it, and
is unnecessary.

For a bare-address relay: the reference deployment used six-day certificates
for an IP address, renewed every two days by a cron job on the relay. (To be
confirmed: which ACME client, certificate authority and profile issue those;
the job is not in this repository.)

## Ports

Open these, in the host firewall **and** in any cloud security group in front
of the machine. A security group is the usual reason a relay answers
signalling and carries no media.

### Control node

| Port | Protocol | From | What |
| --- | --- | --- | --- |
| 443 | TCP | everyone | nginx: the page, the API, `/install`, `/download/tomoshibi`, `/api/enrol` |
| 80 | TCP | everyone | Redirect to HTTPS, HTTP-01 validation if your ACME client uses it |
| `meet.listen` (8080 in the examples) | TCP | loopback only | The process behind nginx. Or 443 itself with `meet.tls_cert`. |

The `rtc` ports in a control node's file are never bound. Outbound, the
control node needs: TCP to every relay's signalling port (reachability every
30 seconds, counters, certificate push), UDP to every relay's probe port, the
Cloudflare API if configured, App Store Connect if TestFlight is configured,
and its gateways.

### Relay

| Port | Protocol | From | What |
| --- | --- | --- | --- |
| `meet.listen` (enrolment default 13377) | TCP | everyone | WSS signalling; the control node's HTTPS calls (`/twirp/relay.stats`, `/twirp/relay.certificate`) |
| `rtc.udp_port` (default 13378) | UDP | everyone | Media. One port carries every track. Never proxied. |
| `rtc.tcp_port` (default 13379) | TCP | everyone | Media over TCP for networks that drop UDP |
| `meet.probe_port` (optional, e.g. 13380) | UDP | everyone | STUN probe: browsers and the control node time one round trip |
| `turn.udp_port` (optional, e.g. 13381) | UDP | everyone | TURN, for a relay that forwards calls held elsewhere |
| `turn.relay_range_start`..`end` (LiveKit default 30000-40000) | UDP | the other relays | The TURN allocations' relayed addresses. (To be confirmed: whether a stateful firewall that allows replies makes opening these inbound unnecessary; `dev/turncheck ... -self` answers it for a given machine.) |
| 7880 | TCP | loopback only | The embedded media server's own HTTP listener |

The enrolment script's closing message lists the first three; the probe and
TURN ports are yours to add.

**Do not use 3478 for the probe or TURN.** It is the standard STUN port and is
scanned continuously.

### Single machine (`full`)

TCP 443 (and 80) for nginx, UDP `rtc.udp_port`, optionally TCP `rtc.tcp_port`.
The signalling WebSocket shares the page's origin, so it goes through nginx.

### Supporting machines

| Port | Protocol | From | What |
| --- | --- | --- | --- |
| redis (6379 or yours) | TCP | the relays only | The cluster |
| viahk hub ports (yours) | UDP | the mainland relays only | Cross-border routing, [chapter 6](cross-border.md#viahk-routing-a-mainland-relays-overseas-traffic-through-hong-kong) |
| Alert forwarder (49771 by default) | TCP | the control node, over a private network only | Alerts, [chapter 9](operations.md#monitoring-and-alerts) |
| Music and watch-together gateways | TCP | the control node only | [chapter 7](features.md) |

## A reverse proxy or a CDN in front of the control node

The process can terminate TLS itself, but most deployments put nginx in front:
[nginx-meet.conf](examples/nginx-meet.conf).

- Set `meet.trust_proxy: true`, and `meet.proxies` to the number of proxies
  that append to `X-Forwarded-For`: 1 for nginx alone, 2 for a CDN in front of
  nginx. The caller is counted that many entries in from the right. Left at 1
  behind a CDN, everybody arriving through one CDN node shares one rate-limit
  budget.
- Never set `trust_proxy` on a listener reachable directly: the forwarded
  headers are then whatever the caller typed, and believing them hands anybody
  a fresh rate-limit budget per request.
- `X-Forwarded-Host` and `X-Forwarded-Proto` are read under `trust_proxy` (the
  latter decides `wss` against `ws` on a single machine).
- The `nearest` relay policy reads `X-Client-Region`, or Cloudflare's
  `CF-IPCountry`, only under `trust_proxy`.
- **Caching.** The server marks its answers: app downloads `private, no-cache`;
  the apps' update checks, `/api/apps/remote`, `/install` and app builds served
  as updates `no-store`, with `Vary: User-Agent` on the update endpoints. Let
  the CDN honour the origin's headers on `/api/`, `/install` and `/download/`;
  a rule that caches everything would hand one person's answer to the next.
- **Large files.** `/download/tomoshibi` (the relay binary, tens of
  megabytes) and the app builds pass through the CDN. (To be confirmed: your
  CDN's size and time limits for a single response.)
- **Relayed video.** If watching together relays video (chapter 7), every
  relayed byte goes through the control node and the CDN.
- **WebSockets** pass through the CDN only on a single machine. On a control
  node nothing on its own origin is a WebSocket.

## Mainland China

Four properties of the networks there shape the fleet; chapter 6 covers each.

1. **Servers are probed for websites.** Something opens a TLS port, sends an
   ordinary HTTPS request and reads the answer; a port that answers anything,
   even 404, is a website, and an unregistered domain may not run one. Relays
   there run with `meet.silent: true` (`SILENT=1` at enrolment), which closes
   any connection that is not a WebSocket upgrade or a request carrying the
   deployment's bearer token.
2. **TLS to servers without an ICP filing is intercepted**, by name or by bare
   address, while UDP and other TCP pass (recorded in the code from the
   owner's observation on 2026-10-20). A relay there can be told to have its
   signalling carried by another relay ("Signals through") while its media
   stays on it.
3. **Some paths filter by the TLS name.** `dev/snicheck` tells a name being
   filtered from an address being filtered.
4. **Direct cross-border paths can be poor, and some work in one direction
   only.** Relays can be kept apart, bridged, or routed through a hub
   (`viahk`).

Practicalities when bringing a mainland relay up:

- Outbound TCP 443 is often blocked. The enrolment must reach the control
  node to download the script, the binary and its configuration, so it may
  need an HTTP proxy in the environment. The script then works the machine's
  own address out over DNS (UDP 53, which a proxy cannot carry), or takes it
  from `ADDRESS=`, so the relay is not enrolled under the proxy's address.
- Nothing is fetched from GitHub or a package mirror: the binary comes from
  your control node.

## redis

One instance for the fleet. The relays use it to see one cluster: a meeting
whose people landed on different relays is routed between them through it,
and a relay that signals through another receives its signalling through it.
Without it every relay is an island and the `sticky` policy is the only one
that works; the server warns at startup.

- Reachable from every relay, and from nothing else. Set a password. Example
  directives: [redis.conf](examples/redis.conf).
- The connection settings are LiveKit's: `redis.address`, `username`,
  `password`, `db`, and `tls` for an encrypted connection, among others.
- **The reference deployment does not use TLS to redis**: its redis has no
  TLS port, and the relays reach it over plain TCP. The password and the
  cluster's traffic then cross the network unencrypted, so put redis on a
  private network with the relays, or carry that port through a tunnel, or
  configure redis's TLS together with LiveKit's `redis.tls`.
- The control node never connects to redis. Its `redis` section is only the
  address and password enrolment hands to new relays.
- Changing the password across the fleet without an outage:
  [chapter 6](cross-border.md#rotating-the-redis-password).

## Checklist

- [ ] Machines: Linux with systemd, one architecture for every enrolled relay.
- [ ] `meet.example.com` resolves to the control node (or its CDN).
- [ ] A zone for relays, not under a CNAME; Cloudflare token and zone ID if
      records are to be created automatically.
- [ ] A certificate for `meet.example.com`, and a wildcard for
      `*.relay.example.com` on the control node, with renewal in place.
- [ ] redis reachable from every relay, with a password, firewalled.
- [ ] Ports opened in host firewalls and cloud security groups, as above.
- [ ] For mainland relays: an HTTP proxy for the enrolment if outbound 443 is
      blocked; `SILENT=1`.
