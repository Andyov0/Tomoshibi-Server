# Deploying Tomoshibi Server

Tomoshibi Server is a fork of [5t-RawBeRry/Tomoshibi](https://github.com/5t-RawBeRry/Tomoshibi),
licensed under the AGPL-3.0. Upstream is a video meeting server in one binary;
this fork keeps that and adds a second shape: one control node and a fleet of
media relays, with the routing, certificates, monitoring and native-app
support a fleet spread across borders needs.

This guide is the whole of deploying it, from an empty machine to a fleet.
It is written against the code in this repository. Where the code and the
older prose in README.md or RELAY.md disagree, the code was followed and the
difference is noted.

**Conventions.**

- Every name under `example.com`, every address in `203.0.113.0/24`,
  `198.51.100.0/24` and the private ranges, and everything in angle brackets
  is a placeholder. Replace them with your own.
- **(To be confirmed: ...)** marks something the code and examples do not
  settle. It is a question, not an answer; check it on your own deployment.
- Port numbers in examples are the enrolment defaults (13377, 13378, 13379)
  where the code has defaults, and arbitrary otherwise (13380 for the STUN
  probe, 13381 for TURN). Any unremarkable port works.

## Contents

| Chapter | |
| --- | --- |
| 1. [Overview](#1-overview) | What the pieces are and how a call flows through them. This file. |
| 2. [Preparation](docs/deploy/prepare.md) | Machines, domains and DNS, certificates, ports, CDN, mainland China. |
| 3. [Building](docs/deploy/build.md) | Go, the web client, cross-compiling, what comes out. |
| 4. [The control node](docs/deploy/control-node.md) | Configuration, systemd, first start, administrators, the management pages, the store and its backups. |
| 5. [Relays](docs/deploy/relays.md) | Enrolment, configuration by hand, certificates, health checks, how rooms are placed, maintenance. |
| 6. [Cross-border routing](docs/deploy/cross-border.md) | Silent relays, signalling through another relay, TURN forwarding, the `viahk` routing, redis and its password, `crossrelay`. |
| 7. [Optional features](docs/deploy/features.md) | Watching together, the music library, Emby, YouTube, Bilibili, account permissions. |
| 8. [Native apps](docs/deploy/native-apps.md) | The download page, `apps.json`, updates, TestFlight, app links, `remote.json`. |
| 9. [Operations](docs/deploy/operations.md) | Upgrades, monitoring and alerts, certificates, logs, troubleshooting. |
| 10. [Security](docs/deploy/security.md) | What to keep out of repositories, firewalls, SSH, administrator passphrases. |
| 11. [FAQ](docs/deploy/faq.md) | Short answers to the questions that come up. |
| Reference | [Configuration reference](docs/deploy/configuration.md): every key, its default, and when it matters. |
| Examples | [docs/deploy/examples/](docs/deploy/examples/): configuration files, systemd units, nginx, manifests and scripts with placeholders. |

## 1. Overview

### One binary, three roles

The same `tomoshibi` binary is all of it. What a process does is decided by
`meet.role` in its configuration file:

| Role | Serves | Starts a media server | Keeps a store |
| --- | --- | --- | --- |
| `full` (default) | the web client, the join API, the management pages, and media | yes | yes |
| `control` | the web client, the join API, the management pages | no | yes |
| `relay` | signalling and media only | yes | no |

- **`full`** is one machine doing everything. It is what upstream does and
  what a small deployment wants: two ports, one certificate, one file to copy.
- **`control`** is the half that wants a name, a certificate and somewhere
  cheap to live. It signs every join token, decides which relay each person is
  sent to, holds the store (administrators, accounts, relay definitions,
  invitations, settings), serves the management pages at `/admin`, and talks
  to every relay over HTTPS to read its counters and push its certificate. No
  media passes through it.
- **`relay`** is the half that wants good routes and is charged by the byte.
  It runs the embedded LiveKit media server behind the signalling path, and
  serves nothing else: no client, no join API, no management pages, no store.
  A relay reachable by a name somebody could type must not serve a join
  endpoint, so its router returns before any of those routes is registered.

The web client (Vite, React, LiveKit's client SDK) is compiled into the
binary. There is no directory to ship beside it.

### What else is involved

| Piece | Needed for | Where it comes from |
| --- | --- | --- |
| A reverse proxy with a certificate (nginx or similar), or `meet.tls_cert` | Any deployment used from another machine. Browsers withhold cameras outside a secure page. | Your own. Example: [nginx-meet.conf](docs/deploy/examples/nginx-meet.conf). |
| redis | A fleet of more than one relay: it is how relays see one cluster, route a meeting between them, and carry signalling for a relay that signals through another. | Your own. One instance every relay reaches. |
| A wildcard certificate for the relays | Relays dialled by name over `wss://`. | Issued on the control node (an ACME client with DNS validation), handed to relays at enrolment and pushed hourly. |
| Cloudflare API token (optional) | Creating and removing each relay's DNS record automatically. | Your Cloudflare account. |
| Watch-together gateway, music gateway (optional) | Watching a video together; playing a music library into a call. | Separate programs, not in this repository. |
| Native apps (optional) | The Mac, Windows, Android and iOS apps. | Built elsewhere; this server offers the builds, the update check, TestFlight invitations and a remote configuration file. |
| An alerting bot (optional) | Being told about faults that do not fix themselves. | `dev/watch/` posts to a small forwarder on the machine that holds the bot's token. |

### The shape of a fleet

```
                       browsers and native apps
          |                                         |
          | HTTPS: page, API, join                  | WSS signalling (TCP 13377)
          v                                         | media (UDP 13378, TCP 13379)
  +------------------------+                        | STUN probe (UDP 13380, optional)
  | (CDN, optional)        |                        v
  | nginx, TLS             |          +-----------------------------+
  | control node           |  HTTPS   | relay hk  (role: relay)     |
  |   role: control        |--------->|   embedded LiveKit          |
  |   client, join API,    |  bearer  |   TURN (optional, UDP)      |
  |   /admin, store,       |  token:  +-----------------------------+
  |   signs tokens         |  stats,  | relay jp  (role: relay)     |
  +------------------------+  cert    +-----------------------------+
                              push    | relay sh  (role: relay,     |
                                      |   silent, signals via hk)   |
                                      +-------------+---------------+
                                                    |
                                     every relay -> | redis (one instance)
                                                    v
                                              +-----------+
                                              |  redis    |
                                              +-----------+
```

The control node and every relay carry the same API key pair. The control
node signs a token with it; the relay the client then dials verifies with the
same pair. There is no second secret to distribute.

### What happens when somebody joins

1. The browser loads `https://meet.example.com/`, which is the client built
   into the control node's binary.
2. It asks `GET /api/relays` for the fleet. Under the `probe` policy it times
   every relay at once (STUN on the probe port where every relay has one,
   otherwise by opening and closing the signalling socket) and remembers the
   fastest name for five minutes.
3. It sends `POST /api/rooms/{room}/join` with the name, any passphrase, and
   the relay it measured as fastest. The control node applies the room
   policies (who may open a new name, who may enter an existing one, scopes,
   invitations), then decides two relays:
   - the **entry**, the machine this person dials: the policy's choice, or an
     operator's pin for this person;
   - the **holding** relay, the machine the meeting lives on: wherever it is
     already being held, or where an operator placed it.
4. If entry and holding differ, the entry relay may carry the call by TURN to
   the holding relay ("Forwards other rooms"), unless the pair is kept apart;
   otherwise the person is sent straight to the holding relay. A relay that
   cannot be reached over TLS has its signalling carried by another relay
   ("Signals through"), with redis carrying it on.
5. The control node answers with a signed token, the signalling URL, and TURN
   credentials where there are any. From here on the call is between the
   browser and the relays; the control node is not involved.

Chapter 5 has the [placement rules](docs/deploy/relays.md#how-rooms-are-placed)
in full.

### What each machine going away costs

- **The control node**, stopped for sixty seconds during a call, cost the call
  nothing (measured; RELAY.md). Nobody new can join while it is down, and the
  host panel polls `/api/rooms/{name}/host` and keeps its last answer.
- **A relay restart** ends every call on it, including calls whose media it
  was only forwarding to another relay. A clean stop waits up to 30 seconds
  for meetings to end before ending them.
- **A `full` machine restart** ends every call.
- **redis** going away splits the cluster: a meeting whose people are on
  different relays stops hearing itself, and a relay that signals through
  another stops receiving signalling. The control node signs tokens without
  redis.

## Choosing a shape

**One machine** (`full`) when the people are in one region and one machine's
bandwidth is enough. You need a domain, a certificate, TCP 443 (or the
listener behind a proxy) and one UDP port.

**A control node and relays** when media should be near the people sending it,
when egress is metered, or when part of the audience is behind a border that
treats traffic differently. The control node can be a small, cheap machine;
the relays are where the bandwidth is.

## Quick start: one machine

The details of each step are in the chapters; this is the order.

1. Point `meet.example.com` at the machine. Open TCP 80/443 and UDP 7882 (and
   TCP 7881 for media over TCP).
2. Build the binary ([chapter 3](docs/deploy/build.md)) and copy it to
   `/usr/local/bin/tomoshibi`.
3. Get a certificate for `meet.example.com` and configure nginx from
   [nginx-meet.conf](docs/deploy/examples/nginx-meet.conf).
4. Copy [full.yaml](docs/deploy/examples/full.yaml) to
   `/etc/tomoshibi/meet.yaml`, replace the key pair with the output of
   `tomoshibi keygen`, and set `public_url`, `source_url`.
5. Make the first administrator **before the first start**:
   `tomoshibi admin new /etc/tomoshibi/meet.yaml`. Put the printed trip into
   `meet.admins`, the passphrase into a password manager.
6. Install [tomoshibi.service](docs/deploy/examples/tomoshibi.service) with
   `ExecStart` pointing at `meet.yaml`, then `systemctl enable --now tomoshibi`.
7. Open `https://meet.example.com/admin` and sign in with the name and the
   passphrase. Then open `https://meet.example.com/#/some-room`, type the
   same passphrase in the join screen's passphrase field (with
   `opened_by: admins` only an administrator may open a new name), and use
   **Invite somebody** in the call to get a link for a second browser (with
   `joined_by: invited` a room's name alone does not let anybody in).
8. Back up `/var/lib/tomoshibi/meet.db` (copies appear daily beside it) and,
   separately, `/var/lib/tomoshibi/tripcode.key`.

## Quick start: control node and relays

1. **Prepare** ([chapter 2](docs/deploy/prepare.md)): names for the control
   node (`meet.example.com`) and a zone for relays (`*.relay.example.com`);
   a wildcard certificate for `*.relay.example.com` on the control node;
   a redis every relay can reach; firewall rules.
2. **Build** one binary for the architecture of the whole fleet.
3. **Control node** ([chapter 4](docs/deploy/control-node.md)): copy
   [control.yaml](docs/deploy/examples/control.yaml), set the key pair, the
   enrolment section (secret, domain, ports, certificate, redis address,
   Cloudflare), at least one entry under `meet.relays`, the first
   administrator; start `tomoshibi.service`; put nginx in front.
4. **Relays** ([chapter 5](docs/deploy/relays.md)): in the management pages,
   **Relays**, **Add a machine**, copy the command and run it as root on each
   new machine with its prefix. `SILENT=1` in front of it for a relay in
   mainland China. Open the relay's ports.
5. **Describe each relay** on its page: where it is (latitude, longitude),
   its probe address ("Measured at"), its TURN address if it forwards, and
   for a mainland relay the relay it signals through.
6. **Cross-border routing** if you need it ([chapter 6](docs/deploy/cross-border.md)).
7. **Monitoring** ([chapter 9](docs/deploy/operations.md#monitoring-and-alerts)):
   `dev/watch/watch.sh` from cron on the control node, posting to a bot.
8. **Backups**: the store and the tripcode key, as above.

## Where things live

| Path | Machine | What |
| --- | --- | --- |
| `/usr/local/bin/tomoshibi` | all | The binary. |
| `/etc/tomoshibi/control.yaml` or `meet.yaml` | control / full | Configuration. |
| `/etc/tomoshibi/relay.yaml` | relay | Configuration, written by the enrolment. Mode 640, group `tomoshibi-certs`. |
| `/etc/tomoshibi/certs/relay.fullchain.pem`, `relay.key` | relay | The relay's certificate, written by the enrolment and replaced by the hourly push. |
| `/var/lib/tomoshibi/meet.db` | control / full | The store (bbolt). One process at a time. |
| `/var/lib/tomoshibi/meet.db.YYYY-MM-DD` | control / full | Daily copies, seven kept. |
| `/var/lib/tomoshibi/tripcode.key` | control / full | The key every passphrase signature is derived from. Not copied by the server. |
| `/var/lib/tomoshibi/apps/` | control / full | Native app builds, `apps.json`, `remote.json` (when `meet.apps.mac_dir` points here). |
| `/etc/systemd/system/tomoshibi.service` | control / full | The service. |
| `/etc/systemd/system/tomoshibi-relay.service` | relay | The service, installed by the enrolment. |
| `/usr/local/lib/viahk/`, `viahk.service` | mainland relays, the hub | Cross-border routing rules, replayed at boot. |
| `/etc/tomoshibi/watch.env`, `/var/log/tomoshibi-watch.log` | control | The watchdog's credential and log. |

## The licence obligation

The AGPL's section 13 obliges whoever offers this over a network to offer its
source to the people using it that way. The join page carries a link for that,
taken from `meet.source_url`. Set it to wherever your running code can be read,
your own fork if you changed anything. Left empty, the page shows no link and
the server warns at every start.
