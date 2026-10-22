# Configuration reference

[Back to the guide](../../DEPLOY.md)

Every key this server reads, its default as the code sets it
(`internal/config/config.go`), and when it matters. Example files:
[full.yaml](examples/full.yaml), [control.yaml](examples/control.yaml),
[relay.yaml](examples/relay.yaml).

## How the file is read

One YAML document describes the whole process. The `meet` section is this
server's; everything else belongs to the embedded LiveKit media server. The
`meet` section is lifted out first and the rest is handed to LiveKit's own
loader.

**Both halves are strict.** An unknown key, a misspelt key or a key at the
wrong depth stops the server at startup with the key's name (`parse the meet
section: ...` or `load the media server configuration: ...`). A relay that
will not start is preferred to one running on a file that says one thing and
means another.

`tomoshibi serve <file>` (or `tomoshibi <file>`) runs it. With no file at all
the server starts with built-in defaults, which is only useful for trying it.

### Starting values

Four things are read from the file **only on the store's first start** and
live in the store from then on, changed through the management pages:

| Key | Adopted when | After that |
| --- | --- | --- |
| `meet.admins` | the store has never had an administrators list | Editing the file does nothing, silently. The way back in is `dev/roster`. |
| `meet.relays` | the store has never had a relay list | Editing the file does nothing; a warning at startup says the file's list is not the one in effect. |
| `meet.rooms.opened_by` | the store has never had a value | The runtime panel shows the file's value beside the one in force. |
| `meet.rooms.joined_by` | (read from the file until somebody sets it in the pages) | Once set in the pages, the store's value wins. |

### Which role reads what

`C` control, `R` relay, `F` full. A key written under a role that does not read
it is accepted and does nothing, which for `silent` is the costly kind of
silent failure.

## The `meet` section

| Key | Default | Roles | Meaning |
| --- | --- | --- | --- |
| `role` | `full` | all | `full`, `control` or `relay`. Anything else is refused. |
| `listen` | `":8080"` | all | The TCP listener for the client, the API and the signalling proxy. On a relay, the port browsers dial (`wss://<host>:<port>`). Behind a proxy on the same machine, `127.0.0.1:8080`. |
| `web_root` | empty | C F | Serve the client from a directory instead of the copy in the binary. Development only. |
| `database` | `meet.db` | C F | The store, a bbolt file. Relative paths are relative to the working directory. Copied daily beside itself. |
| `tripcode_key` | `tripcode.key` | C F | The key passphrase signatures are derived from. Created (mode 600) if missing, **silently**: a lost key means every administrator, account and host signature changes at once. Use an absolute path and back it up. |
| `public_url` | empty | F (C) | On a single machine, the address clients are told to open their signalling WebSocket to; needed when the request's own host is not the public one. On a control node the relays' URLs are used instead and this is only shown on the runtime panel. |
| `public_addresses` | empty | C | Addresses that are this machine although no interface carries them (NAT). Only used to recognise that a relay is this same machine and reach it locally: measured at twelve seconds per management call without it, eleven milliseconds with it. |
| `silent` | `false` | R | Close every connection that is neither a WebSocket upgrade nor a request with a bearer token, without answering. For relays on networks that probe for websites. Costs nothing the control node needs. |
| `probe_port` | `0` (off) | R F | UDP port answering STUN binding requests, so a browser or the control node can time one round trip. Not 3478. The relay record's "Measured at" (`host:port`) must also be set for clients to use it. |
| `tls_cert`, `tls_key` | empty | all | Serve this listener over TLS directly. Both or neither; loaded at startup (a mismatch is refused) and re-read on the next handshake after the files change. HTTP/2 is off on this listener, because WebSockets cannot be opened over it here. |
| `token_ttl` | `5m` | C F | How long a join token is valid. Spent on the next connect. |
| `join_rate` | `10` | C F | Joins per second allowed per caller address (sustained). |
| `join_burst` | `120` | C F | Joins a caller may make at once before the rate applies. Covers a large meeting arriving together. |
| `trust_proxy` | `false` | C F | Believe `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and the region headers. Only behind a proxy that sets them. |
| `proxies` | `0` (read as 1) | C F | How many proxies append to `X-Forwarded-For`; the caller is counted that many from the right. Refused if set without `trust_proxy`, or negative. |
| `admins` | empty | C F | Starting administrators; see below. Refused on a relay. With none at all, `/admin` does not exist. |
| `rooms` | see below | C F | Room policies. |
| `relays` | empty | C | Starting relay list; see below. **At least one entry is required on every start of a control node**, even after the store holds the real list. Refused on a relay. |
| `relay_policy` | `sticky` | C | How a client is matched to a relay: `sticky`, `probe`, `nearest`, `round_robin`. See [placement](relays.md#how-rooms-are-placed). |
| `link_mbits` | `0` (read as 1000) | C F | What a relay's network link is thought to carry, in Mb/s. Drives the bandwidth bars, the "busy" mark and the six-month plot's axis. Not measured. |
| `source_url` | empty | C F | Where the running code can be read; shown on the join page (AGPL section 13). Warned about at every start while empty. |
| `enrol` | see below | C | Relays bringing themselves up from a script. |
| `music` | empty | C F | The music library gateway. |
| `watch` | empty | C F | The watch-together gateway. |
| `apps` | empty | C F | Native apps. Ignored on a relay. |

### `meet.rooms`

| Key | Default | Meaning |
| --- | --- | --- |
| `opened_by` | `anyone` | Who may use a room name nobody has used before. `anyone`; `signed` (anybody who typed any passphrase); `accounts` (an account on this deployment); `admins` (an administrator's passphrase). The management pages offer only `accounts` and `admins`; the other two are logged as a warning at every start. `admins` with no administrators is read as `anyone`, and said so. A name already in use is never affected. |
| `joined_by` | `invited` | Who may enter a room that exists. `invited`: an invitation, an account, an administrator's passphrase, or being the host. `accounts`: an account and nothing else (read as `invited` while there are no accounts). `anyone`: whoever knows the name, which the pages do not offer and the log warns about at every start. |
| `remember` | `72h` | How long a room name is remembered after its last join: three days, the owner's choice. `0` keeps names forever; negative is refused. Also bounds how long an operator's placement of a room lasts. |

Rooms under a scope (`name@scope`) follow their own rule, membership of the
scope, and ignore both policies. See README.md, "Scopes".

### `meet.admins`

```yaml
admins:
  - trip: 5dtfc2ouiu        # from `tomoshibi admin new`
    name: adam              # asked for at sign-in, written in the audit log
    can: [moderate]
```

| Key | Meaning |
| --- | --- |
| `trip` | The signature the passphrase produces: ten characters, lowercase letters and the digits 2 to 7. Not the passphrase. |
| `name` | The name typed at sign-in beside the passphrase, and what the audit log says. |
| `can` | What this administrator may do, beyond watching. Empty means observe only. |

| Capability | Adds |
| --- | --- |
| (none) / `observe` | Reading: the overview, the trend, health checks, rooms and who is in them, the runtime panel, the remote notice and switches. |
| `rooms` | Closing a room, removing or muting somebody, moving and placing rooms and people, forgetting a name; running any room from inside a call; running rooms under a scope. |
| `accounts` | Making, renaming, blocking and removing accounts, their passphrases and permissions, except the Emby permission and the passphrase of an account holding it. |
| `relays` | Adding, editing, ordering and removing relays, and the install command, which carries the enrolment secret. |
| `settings` | Who may open and enter rooms; the Emby, YouTube and Bilibili relay switches; publishing the apps' notice and feature switches. |
| `moderate` | All four, plus the administrator list itself and the Emby permission. |

Duplicates, malformed trips and unknown capabilities are refused at startup.

### `meet.relays` (control node)

```yaml
relays:
  - name: hk
    url: wss://hk.relay.example.com:13377
    region: hk
```

| Key | Meaning |
| --- | --- |
| `name` | The relay's key: in logs, on the pages, and what a client sends back after measuring. Unique. Required under `probe`. |
| `url` | What a browser dials, `ws://` or `wss://`, handed to clients verbatim. Unique. |
| `region` | This deployment's own label for a place. Required for every relay under `nearest`, where it is compared with the client's region header. |

The rest of a relay's record (probe address, TURN address, location, flags)
exists only in the store and is set on the relay's page;
[chapter 5](relays.md#the-relay-record) lists it.

### `meet.enrol` (control node)

Absent a `secret` or a `domain`, enrolment is off: `/install`,
`/download/tomoshibi`, `/api/enrol` and `/api/enrol/taken` do not exist.

| Key | Default | Meaning |
| --- | --- | --- |
| `secret` | empty | What the install command must present. Long-lived and powerful: it buys the API secret, the redis password and the certificate key. Wrong guesses are rate limited with the sign-in budget. |
| `domain` | empty | Relays become `<prefix>.<domain>`. Not under a CNAME. |
| `public_url` | empty | Where a new relay reaches this node. Required in practice: the script, the binary and the enrolment API are fetched from it. |
| `listen_port` | `13377` | Every relay's `meet.listen`, and the port in its URL. |
| `udp_port` | `13378` | Every relay's `rtc.udp_port`. |
| `tcp_port` | `13379` | Every relay's `rtc.tcp_port`. |
| `probe_port` | `0` | Written into every new relay's `meet.probe_port`. Zero writes nothing. |
| `cert_file`, `key_file` | `meet.tls_cert`, `meet.tls_key` | The certificate handed to new relays and pushed hourly. Set explicitly on a control node behind a TLS-terminating proxy. |
| `redis_addr` | the top-level `redis.address` | Where relays reach redis. A loopback address there is warned about at startup. |
| `binary` | this process's own executable | What `/download/tomoshibi` serves. |
| `cloudflare_token`, `cloudflare_zone` | empty | Create and remove each relay's `A` record. Without them a warning at startup, and the operator points names by hand. |

### `meet.music` and `meet.watch`

| Key | Meaning |
| --- | --- |
| `music.url` | The music gateway, reachable from this server only; `http` or `https`. |
| `music.token` | Sent as `X-Music-Token` on every request; at least 24 characters. |
| `watch.url` | The watch-together gateway. |
| `watch.token` | Sent as `X-Watch-Token`; at least 24 characters. |
| `watch.direct_only` | `false`. True: nothing is relayed through this server except what the three store switches allow (Emby, YouTube, Bilibili bangumi). |

A URL without a token, a token without a URL, a short token, or an address
that is not one is refused at startup. See [chapter 7](features.md).

### `meet.apps`

| Key | Meaning |
| --- | --- |
| `mac_dir` | The directory with the Mac, Android and Windows builds, `apps.json` and `remote.json`. Named after the first platform; it holds all of them. Not a readable directory: warned, and the page says the apps are not available yet. |
| `android_package` | The Android application id, for `/.well-known/assetlinks.json`. |
| `android_certificates` | SHA-256 fingerprints of the Android signing keys, 32 colon-separated hex bytes, as `keytool -list -v` prints them. Set together with `android_package` or not at all. |
| `apple_app_ids` | `TEAMID.bundle.id` for the iOS and Mac apps, for `/.well-known/apple-app-site-association`. |
| `testflight.key_id`, `issuer`, `key_file`, `group` | The App Store Connect API key that invites testers. All four or no invitations (a partial set is warned about). A `key_file` that is not a readable P-256 key is refused at startup. |
| `testflight.public_link` | `https://testflight.apple.com/join/<code>`, offered to link holders who are not signed in. Anything else is refused. |

See [chapter 8](native-apps.md).

## LiveKit keys used by this project

The rest of the file is LiveKit's (the version in `go.mod`, v1.13.5). These are
the keys the examples and the enrolment use; LiveKit has more, and its loader
rejects anything it does not know.

| Key | Used for |
| --- | --- |
| `port` | LiveKit's own HTTP listener. Keep it on loopback with `bind_addresses: ["127.0.0.1"]`; signalling reaches it through `meet.listen`. |
| `bind_addresses` | See above. |
| `keys` | **Exactly one** `key: secret` pair. None is refused (`no API key`); several are refused, because this server signs with one. The same pair on the control node and every relay. `tomoshibi keygen` prints one. |
| `rtc.udp_port` | The one UDP port carrying every track. |
| `rtc.tcp_port` | Media over TCP. |
| `rtc.use_external_ip` | True on every relay and on a public single machine: the advertised address is discovered rather than read from an interface. A relay with it false is warned about at startup. |
| `rtc.node_ip` | Set the advertised address by hand when discovery cannot work. |
| `rtc.interfaces.includes` | Only offer addresses on these interfaces (the enrolment names the outward one, so docker bridges are not offered). |
| `rtc.packet_buffer_size_video` | Packets of video history kept for resends; 4000 on relays. Not `packet_buffer_size`, which no longer changes video. |
| `rtc.congestion_control.enabled`, `use_send_side_bwe` | `true`, `true` on relays: choose each viewer's layer from the browser's transport-wide feedback. |
| `redis.address`, `username`, `password`, `db`, `tls` | The shared redis. |
| `logging.level` | `debug`, `info`, `warn`, `error`. Anything else runs at `info` with a warning (`warning` is not a level). |
| `logging.json` | LiveKit's own lines as JSON. |
| `region`, `node_selector` | Distance-aware placement of rooms between the media servers; written by the enrolment when locations are known. |
| `turn.enabled`, `turn.udp_port`, `turn.relay_range_start`, `turn.relay_range_end` | LiveKit's built-in TURN server, for relays that forward calls held elsewhere. `relay_range_*` default to 30000-40000. A `turn.tls_port` would need `turn.domain` and a certificate; nothing here uses it. |

## What the server refuses at startup

Errors read as sentences that name the key and the way out. The common ones:

| Message begins | Fix |
| --- | --- |
| `no API key: add one under keys` / `N API keys configured` | One pair under `keys`. |
| `meet.role: "..." is not a role` | `full`, `control` or `relay`. |
| `meet.role is "control", which starts no media server of its own, and no relays are listed` | At least one entry under `meet.relays`. |
| `meet.role is "relay" and meet.relays is set` / `... administrators are listed` | Remove them from the relay's file. |
| `meet.relay_policy is "probe" ... has no name to send back` | Every relay needs a `name` under `probe`. |
| `meet.relay_policy is "nearest" ... meet.trust_proxy is false` | Set `trust_proxy` behind a proxy that writes the region header, or use `probe`. |
| `meet.proxies is N ... meet.trust_proxy is false` | Set both or neither. |
| `meet.relays[i] has no url` / `is not a WebSocket address` / `is listed twice` | Fix the entry. |
| `admins[i] has no trip` / `a trip is 10 characters` / `is listed twice` / `is not something an administrator can be allowed` | Fix the entry. |
| `rooms.opened_by: ... is not who a room can be opened by` | `anyone`, `signed`, `accounts` or `admins`. (The message lists three of the four.) |
| `rooms.joined_by: ... is not who may join a room` | `invited`, `accounts` or `anyone`. |
| `meet.tls_cert and meet.tls_key: ...` | The files do not load or do not match. |
| `meet.music.token is N characters and needs at least 24` (and the same for `meet.watch`) | A longer token. |
| `meet.apps.testflight.key_file: ...` | Name the `.p8` App Store Connect gave you, or remove the key. |
| `meet.apps.android_package ...` / `android_certificates[i] ...` / `apple_app_ids[i] ...` / `testflight.public_link ...` | Each message gives the form wanted. |

And what it warns about without refusing: see
[troubleshooting](operations.md#reading-the-log).
