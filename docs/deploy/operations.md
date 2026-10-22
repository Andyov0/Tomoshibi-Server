# 9. Operations

[Back to the guide](../../DEPLOY.md)

Upgrades, monitoring, certificates, logs, and what to do when something is
wrong.

## Is anybody in a call

Every disruptive change waits for an idle fleet. The answer is the management
API's overview, with a read-only administrator's session:

```
GET /api/admin/now
{"fleet": true, "asked": 5, "answered": 5, "clients": 0, "rooms": 0, ...}
```

- **Idle** means `asked == answered` and `clients == 0`. A relay that did not
  answer may be holding somebody, so an incomplete reading is "unknown", not
  zero.
- **Twice, two minutes apart.** Somebody may be about to join.
- **The whole fleet, not one relay.** A relay showing zero clients can still
  be forwarding somebody's media through its TURN server to the relay holding
  their meeting; that person is counted on the other relay.
- On a single machine, `/api/admin/now` describes its own media server and has
  no `asked`/`answered`.

Signing in: `POST /api/admin/session` with `{"name": "...", "passphrase":
"..."}`; the answer sets a session cookie. Requests without a browser's
`Sec-Fetch-Site` header (scripts) are accepted. The example scripts below do
this, taking the credential from a file and never from a command line.

## Upgrading the control node

Order: **the control node first**, then the relays. The control node
distributes its own running binary to relays that enrol, so it should be the
newest. (To be confirmed: whether any pair of control-node and relay builds is
incompatible. Nothing in the code checks versions between them; the reference
practice is the control node first, then the relays, close together.)

Restarting a control node ends no call, but nobody can join while it is down
(usually a few seconds). A single machine's restart ends every call on it,
after letting meetings finish for up to 30 seconds.

The procedure, which [upgrade-control.sh](examples/upgrade-control.sh)
implements (run on the control node, as root):

1. **Stage.** Copy the new binary to the machine (not over the running one)
   and check its SHA-256 against the build machine's.
2. **Wait** until the fleet is idle on two checks two minutes apart.
3. **Check the configuration with the new binary**:
   `cd /var/lib/tomoshibi && /root/stage/tomoshibi.new admin trip /etc/tomoshibi/control.yaml check`
   loads and validates the whole file (the strict loader of the new build may
   refuse a key the old one accepted). Run it from the service's working
   directory: `admin trip` reads the tripcode key and **creates it if it is
   missing**, so a relative `tripcode_key` must resolve to the real one.
4. **Keep the old binary**: `cp -a /usr/local/bin/tomoshibi /usr/local/bin/tomoshibi.before-<date>`.
5. **Swap**: `install -m 0755 /root/stage/tomoshibi.new /usr/local/bin/tomoshibi.new && mv -f /usr/local/bin/tomoshibi.new /usr/local/bin/tomoshibi`.
   Written beside and moved, because the running process holds the file open.
6. **Restart** `systemctl restart tomoshibi`.
7. **Health check** for up to 30 seconds: the unit is active and
   `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health`
   answers `204`.
8. **Roll back** if not: put the kept binary back the same way (install beside,
   move), restart, read `journalctl -u tomoshibi -n 50`.
9. **From outside**: `https://meet.example.com/` and `/api/health` answer; the
   update check answers an app's user agent and refuses a browser's;
   `tomoshibi version` and the log line `settings: this deployment` show the
   new build.

Nothing in the store needs migrating; a record a build cannot read is treated
as absent. Rolling back to an older binary is therefore the same swap.

## Upgrading relays

Restarting a relay ends every call on it. Change only the binary; the
configuration stays.

**One relay**: `dev/watch/update-relay.sh <ssh-target> [binary]` copies the
binary, keeps `tomoshibi.old`, restarts whichever unit is running
(`tomoshibi-relay`, or `tomoshibi` on a machine that is also the control
node), and puts the old binary back if the unit is not active ten seconds
later. It refuses to touch a machine whose service was not running before. It
does not wait for an idle fleet; check that first.

**A fleet**: [upgrade-relays.sh](examples/upgrade-relays.sh) runs from the
machine you deploy from:

1. **Stage** the binary on every relay and check its SHA-256 there. Nothing is
   swapped unless every relay staged it.
2. **Wait** for the whole fleet to be idle twice.
3. **Swap** a few at a time (five by default); each relay keeps
   `tomoshibi.old`, restarts, and puts the old binary back unless its unit is
   active on the expected build ten seconds later.
4. **Read the fleet** again afterwards.

**Mainland relays** download slowly from abroad. Instead of copying from your
workstation, put the binary on a machine near them (a Hong Kong relay or hub),
serve it for the duration over a temporary HTTP server on an unguessable path,
have each relay download it and check the SHA-256, then stop the server and
delete the copy. The checksum, not the transport, is what makes this safe.

After a fleet upgrade, read one relay's start:
`journalctl -u tomoshibi-relay -n 40 -o cat | grep 'how each viewer'` still
shows `send side bwe` true and `video nack window` 4000.

**Re-enrolment** (`REPLACE=1`) also installs the control node's current
binary, but rewrites `relay.yaml` and loses hand edits; it is for rebuilt
machines ([chapter 5](relays.md#maintenance)).

## Monitoring and alerts

The server writes everything it notices to its journal, on one machine among
many, where nobody reads it. `dev/watch/` puts the part that cannot fix itself
in front of a person:

| Piece | Runs on | Does |
| --- | --- | --- |
| `watch.sh`, installed as `/usr/local/bin/tomoshibi-watch` | the control node, from cron every five minutes | Reads the fleet from the management API and the journal, decides whether anything is worth saying, posts text. Holds no bot token. |
| `hermes-relay.py`, installed as `/usr/local/bin/tomoshibi-hermes-relay` | the machine that already holds a Telegram bot's token | Accepts text on a private network and posts it to Telegram as that bot. |

The control node never holds the token: a control node somebody takes can send
messages through the forwarder, not speak as the bot.

### The rule it follows

Only what cannot fix itself. A fault has to survive **three rounds** (fifteen
minutes, longer than any self-healing here) before a message, a fault that
persists is repeated **hourly**, and a recovery is said once for a fault that
was said. A watchdog that cries about blips trains people to swipe its
messages away.

| Message | Source |
| --- | --- |
| Relays not answering | `/api/admin/relays`: enabled relays the control node marks unreachable. Relays out of service are not faults. |
| The control node reaches a relay's signalling port but not its media port | The journal: relays whose **last** word in fifteen minutes was a media-port failure (a failure followed by recovery is a blip). One vantage point; ask from elsewhere before touching the relay. |
| A relay's certificate runs out within two days | The journal. No quiet window. |
| The store opened empty and there are copies beside it | The journal. Sent at once, every time. |
| The store could not be copied | The journal. |
| The watchdog cannot sign in | Its own attempt. A watchdog that has gone blind otherwise reads as good news. |
| The watch gateway's own checks | `GET /health` on the gateway ([chapter 7](features.md#the-gateways-health-for-the-watchdog)). |

### Setting it up

**1. The forwarder**, on the machine with the bot token (a private network to
the control node is assumed):

```bash
install -m 0755 dev/watch/hermes-relay.py /usr/local/bin/tomoshibi-hermes-relay
# bot.env: TELEGRAM_BOT_TOKEN, TELEGRAM_HOME_CHANNEL, optional TELEGRAM_HOME_CHANNEL_THREAD_ID
# forwarder.env: LISTEN (the private address), PORT, ENV_FILE, WORD
```

Unit and both files: [tomoshibi-alerts.service](examples/tomoshibi-alerts.service).
Set `ENV_FILE` explicitly; the script's built-in default is the reference
machine's path. `LISTEN` must be the private address: a listener on a public
address would let anybody make the bot say anything. The recipient comes from
the bot's file, never from the request.

Test it, from the control node:

```bash
curl -s -X POST http://10.0.0.20:49771/say -H 'Content-Type: application/json' \
  -d '{"text":"test","word":"<the WORD>"}'
# {"sent": true}, and a message arrives
```

Any other bot works the same way: `watch.sh` only POSTs
`{"text": "...", "word": "..."}` (HTML formatting) to `SAY`. Replace the
forwarder with anything that accepts that.

**2. A read-only administrator** for the watchdog, belonging to nothing else:

```bash
tomoshibi admin new /etc/tomoshibi/control.yaml          # note passphrase and trip
systemctl stop tomoshibi
/tmp/roster /var/lib/tomoshibi/meet.db add <trip> watch observe
systemctl start tomoshibi
```

The trailing `observe` matters: without it `roster` grants `moderate`. (Or
add the administrator in **Admins** with no capabilities.) A credential on a
cron job that could close every meeting is worth stealing; the reference
deployment found its watchdog's account silently promoted twice, because the
account was shared. Check by trying, not by reading: signing in works, reads
work, and a write answers 403. Aim the write at a name nothing has, so a wrong
answer changes nothing:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Cookie: <session cookie>" \
  http://127.0.0.1:8080/api/admin/relays/no-such-relay      # 403; 404 would mean it can
```

Signing in checks the name as well as the passphrase, so renaming that
administrator blinds the watchdog (which then says so).

**3. The watchdog**, on the control node:

```bash
install -m 0755 dev/watch/watch.sh /usr/local/bin/tomoshibi-watch
install -m 0600 docs/deploy/examples/watch.env /etc/tomoshibi/watch.env   # then fill it in
cp docs/deploy/examples/watch.cron /etc/cron.d/tomoshibi-watch
```

It needs `bash`, `curl`, `python3` and `journalctl`. Settings
([watch.env](examples/watch.env), [watch.cron](examples/watch.cron)):

| Variable | From | Meaning |
| --- | --- | --- |
| `WATCH_NAME`, `WATCH_PASSPHRASE` | watch.env | The read-only administrator. |
| `SAY`, `WORD` | watch.env (or environment) | Where to post, and the shared word. |
| `AT` | environment only | The control node's base URL, e.g. `http://127.0.0.1:8080`. The built-in default is a documentation address. |
| `ENV_FILE` | environment | Path of watch.env; default `/etc/tomoshibi/watch.env`. |
| `STATE`, `LOG` | environment | Default `/var/lib/tomoshibi-watch`, `/var/log/tomoshibi-watch.log` (trimmed past 1 MB). |
| `QUIET_FOR`, `REMIND_EVERY` | environment | Rounds before the first message (3), rounds between reminders (12). |
| `WATCH_GATEWAY`, `WATCH_ENV` | environment | The watch gateway's base URL and a file holding its `WATCH_TOKEN`. |

It reads `journalctl -u tomoshibi`, so the control node's unit must have that
name. Nothing arriving is the normal state, so test that something **would**
arrive: run a copy with a fault written in four times (silent, silent, sent,
silent), and read `/var/log/tomoshibi-watch.log` (`well` on a good round).

## Certificate expiry

| Certificate | Watched by |
| --- | --- |
| The relays' wildcard | Its renewal on the control node, then the hourly push (`offered the renewed certificate to the relays`). Check its date now and then: `openssl x509 -noout -enddate -in /etc/tomoshibi/certs/relay-wildcard.fullchain.pem`. |
| A bare-address relay's own | The control node every hour; under two days it logs `a relay is serving a certificate that expires soon` and the watchdog sends it. Fix the ACME client on that relay. |
| `meet.example.com` | Whatever watches your websites; the server does not. |

What a relay is actually serving, from anywhere:

```bash
openssl s_client -connect hk.relay.example.com:13377 -servername hk.relay.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -enddate
```

`no relay would take the certificate this hour` means the control node
reached no relay at all, so nothing knows what they serve.

## Logs

| Machine | Where |
| --- | --- |
| Control node, single machine | `journalctl -u tomoshibi` |
| Relay | `journalctl -u tomoshibi-relay` |
| viahk | `systemctl status viahk`; `/var/log/viahk-compare.log` where compare.py runs |
| Watchdog | `/var/log/tomoshibi-watch.log` |

The server's own lines are `slog` text (`time=... level=... msg=... key=value`).
LiveKit's lines follow `logging.json`. `logging.level` is `debug`, `info`,
`warn` or `error`. Administrator actions and enrolment attempts are audit
entries in the same journal. The API key is logged; secrets never are.

### Reading the log

What the server says, and what it means:

| Line | Meaning |
| --- | --- |
| `settings: this deployment` | The build and the settings this process runs with. The first line to read after any change. |
| `settings: what clients are told to dial` | The advertised media address (`node ip`), ports, codecs. A private address here on a public relay means `use_external_ip` or `node_ip` is wrong. |
| `settings: how each viewer's media is chosen` | Relays: whether the sender-side estimate and the 4000-packet window are in force. |
| `rtc.use_external_ip is false on a relay` | Clients will be handed an address only the relay can reach. |
| `no redis is configured` | Relays cannot route between themselves. |
| `a relay stopped answering and is no longer offered to clients` / `a relay is answering again` | Reachability changed (two failures to withdraw, one success to restore). |
| `most of the fleet did not answer this sweep` | Almost always the control node's own line. Readings are held. |
| `this node reaches a relay's signalling port but not its media port` | Firewall or security group on the media/probe port, or the control node's own path. Ask from elsewhere (`udpcheck`). |
| `a relay is serving a certificate that expires soon` | A bare-address relay's ACME client has stopped. |
| `a relay would not take the certificate; it will be offered again` | That relay was unreachable over HTTPS this hour, or refused (the reason is logged). |
| `the store is empty and there are copies of it beside it` | The deployment lost its data. Stop, restore the newest copy. |
| `could not copy the store` | No daily copy today. |
| `meet.relays in the configuration file is the starting value only` | The file's relay list is not the one in effect. Edit relays in the pages. |
| `who may open a room was changed from the management pages` | The store's policy differs from the file's. Normal. |
| `a room is placed on a relay that is not taking calls, and is going there anyway` | A placement points at a relay out of service. |
| `a room is placed on a relay this deployment does not have` | A placement points at a removed relay. Clear it in **Rooms**. |
| `refused to forward between relays kept apart` | A pair in **Never forwards with** was asked to forward; the call went to the holding relay. |
| `a relay signals through ...` | Signalling fell back from the named relay; see [chapter 6](cross-border.md#signals-through-media-here-signalling-elsewhere). |
| `this deployment has fewer than two relays with a place recorded` / `this relay has no place recorded` | A relay enrolled without distance-aware placement. Set **Where it is**. |
| `a relay's name was created and does not resolve to it` | The DNS record exists and something above it (a CNAME, another zone) answers first. |
| `failed to create the DNS record for a relay` | Cloudflare refused; the relay is otherwise ready. |
| `cannot be sequenced` (LiveKit) | Resend history too short for a lossy sharer; check `packet_buffer_size_video`. |
| `that is not a log level, so this is running at info` | `logging.level` is misspelt. |
| `rooms.opened_by lets anybody start a meeting on this deployment` on a **relay** | The configuration check runs on every role, and the default is `anyone`. A relay opens no rooms, so on a relay this says nothing. On a control node it means what it says. |

## Troubleshooting

| Symptom | Likely cause | Check, fix |
| --- | --- | --- |
| The page loads but the camera never starts | Not a secure page. | Serve it over HTTPS; only `localhost` is exempt. The startup log warns about plain HTTP on a network address. |
| A call connects and nobody hears or sees anything | UDP media port closed (host firewall or cloud security group), or the advertised address is wrong. | `udpcheck` to the probe port from outside; `settings: what clients are told to dial`; `use_external_ip: true`. |
| Calls work on one relay and not when people are on two | No redis, or redis unreachable from one relay. | Relay logs for redis errors; `redis-cli -h ... PING` from each relay. |
| Every join fails with 401 at the relay | The relay's key pair differs from the control node's. | Same `keys` everywhere. |
| `/admin` is 404 | No administrator in the store. | `dev/roster add`. |
| Sign-in answers 401 after editing `meet.admins` | The file is read on first start only. | `dev/roster` ([chapter 4](control-node.md#locked-out)). |
| Nobody's passphrase works any more, administrators included | The tripcode key was lost or replaced (a missing one is silently recreated). | Restore `tripcode.key` from backup. |
| The control node will not start: `no relays are listed under meet.relays` | The file's list is empty. | Keep at least one entry in the file. |
| `/install` answers 503 `no_enrolment` | No `meet.enrol.secret` or `domain`. | Configure enrolment, restart. |
| The install stops at "the control node refused this machine" | Wrong secret (403 `wrong_secret`), the prefix is taken (409 `relay_exists`), a bad prefix or address (400), too many attempts (429), or the control node cannot read the certificate (500 `no_certificate`). | The control node's log says which. |
| The install stops at "the certificate came back empty" | The control node has no certificate to hand out. | `meet.enrol.cert_file` / `key_file`, readable by the service. |
| The installed binary does not execute | Architecture differs from the control node's. | `meet.enrol.binary`, or install by hand. |
| A relay enrolled under the wrong address | The address was worked out through a proxy, or the machine has several. | Re-run with `ADDRESS=<ipv4>` and `REPLACE=1`, or fix the DNS record. |
| A relay shows unreachable on the pages and carries calls fine | The control node's own path to it. | Ask from elsewhere. A relay's state from one vantage point is a suspicion. |
| A relay is reachable and its media is not, only from the control node | The same. Reported, and the relay stays in service. | `udpcheck` from another machine. |
| A mainland relay stops answering after a while | It answered an HTTP probe and its domain was taken off the air. | `meet.silent: true`. |
| A mainland relay's WebSocket handshakes are reset | TLS interception. | **Signals through** another relay. |
| One relay name fails intermittently from some networks | Filtering by TLS name. | `snicheck`; dial it by address. |
| People on a distant relay sit in a room held somewhere they cannot reach | No `node_selector` on the relay (random node choice), or the pair needs keeping apart. | Locations on every relay, region lists in their files; **Never forwards with**. |
| Screen shares freeze for viewers on narrow lines | The relay runs without the measured media settings. | `settings: how each viewer's media is chosen`. |
| A relay was killed for memory | Meetings larger than its limit allows. | `GOMEMLIMIT` below `MemoryMax`; size by the largest meeting. |
| The download page says the apps are not available yet | Directory unreadable, no manifest line, file size or hash mismatch. | The log names the build and the reason. |
| Invitations open in the browser, not the app | The link statement is missing or names the app wrongly, or a redirect sits in front of it. | `curl https://meet.example.com/.well-known/apple-app-site-association` (and `assetlinks.json`). |
| The update check answers 403 | Not an app's user agent (`not_the_app`). | Expected for browsers. |
| Mainland viewers cannot watch YouTube | The YouTube relay switch is off. | **Rooms**, **Watching together**. |
| After a reboot a mainland relay's overseas calls got worse | The viahk rules were not persisted. | `viahk-install.sh show`; install through `viahk-install.sh`. |

## Diagnostic tools

Built as in [chapter 3](build.md#the-development-tools).

| Tool | Use |
| --- | --- |
| `tomoshibi version` | Which build a machine runs. |
| `tomoshibi rooms <db>` | Every room a store has seen, joins, last seen (service stopped, or a copy). |
| `roster <db> list`, `roster <db> add <trip> [name] [observe\|moderate]`, `roster <db> drop <trip>` | Administrators, directly in the store (service stopped). |
| `peekroom <db> <room>` | Where the store says a room is held and who hosts it. |
| `udpcheck [-tries n] host:port ...` | STUN to probe ports. Run from several places. |
| `turncheck host:port key secret [-self]`, or with a `peer:port` | TURN allocation, and whether traffic comes back. |
| `snicheck [-rounds n] address:port name ... -` | Which TLS names a path refuses. |
| `dev/crossrelay` | Where media goes without the join's forwarding ([chapter 6](cross-border.md#crossrelay-what-happens-without-the-join)). |
| `dev/twobrowsers` | Two headless browsers with fake devices in a real call. |
