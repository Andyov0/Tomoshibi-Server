# 4. The control node

[Back to the guide](../../DEPLOY.md)

The control node serves the web client, the join API and the management
pages, signs every token, and holds the store. It starts no media server. A
single machine (`role: full`) is installed the same way, with
[full.yaml](examples/full.yaml) in place of control.yaml and without the
enrolment and relay steps.

## 1. Install the binary

```bash
install -m 0755 tomoshibi /usr/local/bin/tomoshibi
tomoshibi version
```

## 2. Directories and permissions

```bash
install -d -m 0755 /etc/tomoshibi
groupadd -f tomoshibi-certs
install -d -m 0750 -g tomoshibi-certs /etc/tomoshibi/certs
```

- **`/etc/tomoshibi` must stay readable** (755). The service runs as a
  systemd dynamic user and reads its configuration from there; tightening the
  directory to 700 stops it starting with `permission denied` on a file whose
  own mode looks fine.
- Private keys the process reads itself (`meet.tls_key`, or the relays'
  wildcard at `meet.enrol.key_file`) go in `/etc/tomoshibi/certs`, mode 640,
  group `tomoshibi-certs`. The unit adds that group to the service.
- The store, the tripcode key, their copies and the apps directory live under
  `/var/lib/tomoshibi`, which systemd creates as the service's state
  directory.

## 3. Secrets

```bash
tomoshibi keygen            # the API key pair, shared with every relay
openssl rand -hex 32        # an enrolment secret
```

`keygen` prints a `keys:` block ready to paste. The pair is one secret, not
two: the same process signs and verifies with it. Keep both values out of any
repository (see [chapter 10](security.md)).

## 4. The configuration

Start from [control.yaml](examples/control.yaml) and save it as
`/etc/tomoshibi/control.yaml`. Every key is described in the
[configuration reference](configuration.md). The decisions to make:

- **`keys`**: the pair from `keygen`.
- **`redis`**: the address and password **relays** will use. The control node
  does not connect to redis; enrolment hands these to new relays.
- **`meet.listen`**: `127.0.0.1:8080` behind nginx on the same machine.
- **`meet.trust_proxy` and `meet.proxies`**: 1 behind nginx alone, 2 behind a
  CDN and nginx.
- **`meet.relay_policy`**: `probe` for a fleet spread over regions (needs
  redis on the relays), `sticky` to keep every meeting on one relay.
- **`meet.relays`**: **at least one entry, on every start.** A control node
  with an empty list refuses to start (`no relays are listed under
  meet.relays`), even though after the first start the store, not the file,
  holds the real list. Give it the first relay you are about to enrol, named
  with the prefix you will enrol it with; the enrolment then asks whether to
  take that entry over (answer `y`, or pass `REPLACE=1`), and keeps its
  settings.
- **`meet.enrol`**: secret, `domain`, `public_url`, ports, `probe_port`, the
  wildcard's `cert_file` and `key_file`, `redis_addr`, and the Cloudflare
  token and zone. Without a secret and a domain, relays are added by hand.
- **`meet.rooms`**: who may open a new room and who may enter one. For a
  deployment on the open internet, `opened_by: accounts` or `admins`, and
  `joined_by: invited` (the default).
- **`meet.source_url`**: your fork's address.

## 5. The first administrator

Administrators are listed by the **signature** their passphrase produces (the
"trip"), never by the passphrase. The file's list is read **only on the
store's first start**, so make the first one before starting the service:

```bash
tomoshibi admin new /etc/tomoshibi/control.yaml
```

```
passphrase  7mrdz-nlq32
trip        5dtfc2ouiu
```

The passphrase goes into a password manager; it is stored nowhere and cannot
be recovered. The trip goes into the file:

```yaml
meet:
  admins:
    - trip: 5dtfc2ouiu
      name: adam
      can: [moderate]
```

`admin new` needs the configuration because a trip only means something
against one deployment's tripcode key; it loads the whole file (so the file
must already be valid) and **creates the tripcode key** at
`meet.tripcode_key` if it does not exist yet. That key is then the
deployment's for good.

Running it as root before the first start leaves `/var/lib/tomoshibi` owned
by root. The reference control node's unit is the example's,
`DynamicUser=yes` with `StateDirectory=tomoshibi`, and what systemd documents
for that pair is this (systemd.exec(5), the paragraphs under
`RuntimeDirectory=`, which `StateDirectory=` shares):

- under `DynamicUser=`, the state directory is created below
  `/var/lib/private`, and a symbolic link makes it appear as
  `/var/lib/tomoshibi`;
- when the directory already exists and its owner does not match the
  service's, the directory and every file below it have their ownership
  changed recursively at start; when the owner already matches, what is below
  is left as it is;
- on systemd versions that use id-mapped mounts for this, the directories are
  owned by "nobody" on the host and mapped to the service's user inside it.

What the page does not describe is a `/var/lib/tomoshibi` that root created as
a plain directory before the unit ever started. (To be confirmed on your
systemd version: that such a directory is taken over, moved below
`/var/lib/private`, and given to the dynamic user.) If the service then fails
with `permission denied` on the key or the store, use the other order instead,
which does not depend on it:

```bash
systemctl start tomoshibi && systemctl stop tomoshibi   # the service makes its own state
tomoshibi admin new /etc/tomoshibi/control.yaml           # the key exists now; only prints
/tmp/roster /var/lib/tomoshibi/meet.db add <trip> <name>  # dev/roster, built for this machine (chapter 3)
systemctl start tomoshibi
```

`tomoshibi admin trip <config> '<passphrase>'` works the trip out from an
existing passphrase, for example to list somebody who already joins calls
with one. Their trip is also printed beside their name in every call, and the
management pages copy it (right-click their picture, **Copy the signature**).

## 6. The service and the proxy

```bash
cp docs/deploy/examples/tomoshibi.service /etc/systemd/system/tomoshibi.service
systemctl daemon-reload
systemctl enable --now tomoshibi
journalctl -u tomoshibi -n 60 -o cat
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/health    # 204
```

Then nginx from [nginx-meet.conf](examples/nginx-meet.conf) with the
certificate for `meet.example.com`, or `meet.tls_cert` / `meet.tls_key` on the
process itself (then `meet.listen: ":443"` and no proxy; leave `trust_proxy`
off). Port 443 is privileged: the example unit grants no capabilities, so
add `AmbientCapabilities=CAP_NET_BIND_SERVICE` to its `[Service]` section, or
listen on a high port.

Keep the unit name `tomoshibi`: the watchdog reads `journalctl -u tomoshibi`.

## 7. The first start, read from the log

A healthy control node says, among other things (abridged; the real lines are
`key=value` pairs after `msg=`):

```
control: client, joins and management; media is held on the relays below  relays=1 policy=probe
adopted the administrators from the configuration file; the management pages are what change them from here
adopted the relays from the configuration file; the management pages are what change them from here
rooms  opened by=accounts administrators=1
relays can enrol themselves  domain=relay.example.com port=13377 "names DNS"=true
settings: this deployment  build=... listen=127.0.0.1:8080 ... "api key"=API...
```

The API key is logged and the secret never is. Warnings worth acting on at
this point:

| Warning | Meaning |
| --- | --- |
| `meet.source_url is not set` | The join page links to no source. |
| `no cloudflare credentials for enrolment` | Relays will enrol and wait for somebody to point their names. |
| `redis is configured on loopback, which no relay can reach` | Set `meet.enrol.redis_addr`. |
| `no redis is configured` | Relays cannot route between themselves. |
| `rooms.opened_by lets anybody start a meeting` / `rooms.joined_by is "anyone"` | The file chose an open door on purpose, or by accident. |
| `meet.admins in the configuration file is the starting value only` | Normal after the first start, if the file still lists somebody the pages removed. |

## The management pages

`https://meet.example.com/admin`. Sign in with the administrator's **name and
passphrase** (`name#passphrase` in the passphrase field works too). Where no
administrator exists, `/admin` does not exist at all.

Every passphrase tried anywhere (the join screen, the account sign-in, the
management sign-in) spends from one budget per address. Administrators'
actions, and every enrolment attempt, are written to the service log as audit
entries.

| Panel | What it does | Capability to change |
| --- | --- | --- |
| **Now** | The fleet's rooms, people, tracks, bandwidth, packet loss and CPU, summed over the relays that answered. | (read only) |
| **Rooms** | Rooms in progress and rooms the store has seen; participants and their devices; mute, remove, close; move a room to another machine or **Hold the next call here**; send one person in through another relay; forget a name. Also the deployment's room policies (**New rooms**, **Joining a room**) and the watch-together relay switches. | `rooms`; `settings` for the policies and switches |
| **Accounts** | Accounts, their passphrases, avatars, scopes (the `@` button), permissions, blocking. | `accounts`; the Emby permission needs `moderate` |
| **Relays** | Every relay with its reachability and latency from the control node; add one by address or by machine (the install command); edit its record; order; take out of service; remove. | `relays` |
| **Apps** | The apps' lobby notice and feature switches ([chapter 8](native-apps.md#remote-configuration-remotejson)). | `settings` |
| **Admins** | Administrators and their capabilities; change your own passphrase. | `moderate` |
| **Runtime** | What this process is running with: the file's values beside the store's, the build, the listener. | (read only) |

Signing up is never self-service. Accounts are made here and handed to people
like any other credential.

## The store

`meet.database`, a bbolt file. It admits one process at a time, so any tool
that reads it (`tomoshibi rooms`, `dev/roster`, `dev/peekroom`) needs the
service stopped or a copy.

It holds the administrators, the accounts and their permissions, the relay
definitions and every field set on them, the invitations and arranged
meetings, the room policies and switches, where each room is held and
operators' placements, the testers each account invited, and six months of
readings for the trend. Nothing in it needs migrating between versions: a
record a build cannot read is treated as absent.

Stopping the control node does not end calls in progress; it stops anybody
new joining while it is down.

### Backups

The server copies the store once a day to `<database>.YYYY-MM-DD` beside
itself and keeps seven. Off-machine backups are yours. What to back up:

| What | Where | Why |
| --- | --- | --- |
| The store's daily copies | `/var/lib/tomoshibi/meet.db.*` | Administrators, accounts, relays and their settings exist nowhere else. The file holds three of a relay's many fields and is read on first start only. |
| **The tripcode key** | `/var/lib/tomoshibi/tripcode.key` | **Not copied by the server.** Lost or replaced, every signature changes: no administrator, account or host passphrase works, and nothing says why. A missing file is silently replaced with a new one. Keep it somewhere the store's copies are not: one file derives the signatures and the other holds them. |
| The configuration | `/etc/tomoshibi/control.yaml` | Holds the API secret and the enrolment secret. |
| Certificates and the App Store Connect key | `/etc/tomoshibi/certs/`, the `.p8` | Reissuable, but tedious. |
| The apps directory | `/var/lib/tomoshibi/apps/` | Builds, `apps.json`, `remote.json`. Rebuildable from your release artifacts. |
| The watchdog credential | `/etc/tomoshibi/watch.env` | |

### Restoring

```bash
systemctl stop tomoshibi
cp -a /var/lib/tomoshibi/meet.db /var/lib/tomoshibi/meet.db.broken
cp -a /var/lib/tomoshibi/meet.db.2026-10-21 /var/lib/tomoshibi/meet.db
systemctl start tomoshibi
```

A store truncated to nothing opens without an error. If there are copies
beside it, the server logs `the store is empty and there are copies of it
beside it` at error level, before it adopts anything from the file; the
watchdog sends that at once.

### Locked out

Editing `meet.admins` on a deployment that has started once does nothing: no
error, no warning, and a sign-in that answers 401. Write to the store instead:

```bash
systemctl stop tomoshibi
tomoshibi admin trip /etc/tomoshibi/control.yaml '<the passphrase>'   # prints the trip
/tmp/roster /var/lib/tomoshibi/meet.db list
/tmp/roster /var/lib/tomoshibi/meet.db add <trip> <name>              # observe and moderate
systemctl start tomoshibi
```

`roster ... add <trip> <name> observe` makes a read-only administrator, which
is what a monitoring credential should be.

## Commands

```
tomoshibi [serve] [config.yaml]    serve the client, the API, and the media
tomoshibi version                  which build this is
tomoshibi keygen                   a fresh API key and secret
tomoshibi rooms <database>         the rooms a store has seen (service stopped)
tomoshibi admin new [config.yaml]  a new administrator passphrase and its trip
tomoshibi admin trip [config.yaml] <passphrase>
                                   the trip an existing passphrase gives
```

A file argument to `admin` is recognised by existing; a path that does not
exist is refused rather than taken as a passphrase.
