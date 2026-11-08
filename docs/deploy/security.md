# 10. Security

[Back to the guide](../../DEPLOY.md)

What this deployment's secrets are, where they live, and the habits that keep
them there.

## The secrets, and what each one buys

| Secret | Where | Whoever holds it can |
| --- | --- | --- |
| The API key pair (`keys`) | Every node's configuration | Sign a token for any room as anybody (and join any unencrypted meeting unseen), and act on every relay's API. Not, any more, run rooms through the control node's host endpoints: those need the control node's proof in the token, and administrators need a session. Per-relay pairs would not narrow this, because the cluster trusts redis between nodes; see RELAY.md. |
| The tripcode key | `meet.tripcode_key` on the control node | Derive every signature offline. Without it a passphrase can only be guessed through the rate-limited doors. |
| An enrolment token, until it is used | Minted on the relays page by a `moderate` administrator; pasted once into the install script | Enrol one machine under one prefix (taking over that prefix if minted to), within thirty minutes, once, and receive the API pair, the redis password and the certificate's private key. |
| The relays' wildcard private key | The control node and every relay | Impersonate any relay name in that zone. |
| The redis password | Every relay, the control node, redis | Join the cluster's internal traffic, which carries every participant's grants between nodes unauthenticated: as good as the key pair. |
| Cloudflare token | The control node's configuration | Edit the zone's DNS records (scope it to that zone, DNS only). The control node itself writes and deletes only A records at a single label under `meet.enrol.domain` whose comment begins `Tomoshibi relay.` — the comment it writes on every record it creates — and never its own name. A hand-made record for an older relay is handed over by giving it that comment. |
| App Store Connect key (`.p8`) | The control node | Change the app's testers. |
| Gateway tokens (`meet.music.token`, `meet.watch.token`) | The control node, the gateways | Use somebody's music subscription; relay video on the deployment's bandwidth. |
| Bot token | The alert forwarder's machine only | Speak as the bot. |
| Administrator passphrases | Password managers | What their capabilities allow. |

## Keep them out of repositories

- **No real configuration in git.** Not control.yaml, relay.yaml, watch.env,
  `.p8` files, certificates, the store or the tripcode key. The repository's
  `.gitignore` already refuses `dev/*.db`, `dev/tripcode.key` and
  `dev/*.local.yaml`; keep real files outside the working tree altogether.
- **No real addresses or names in public files either.** This repository is
  public; its own documents use `example.com` names and the address ranges
  RFC 5737 reserves for documentation. A script
  that needs a real address reads it from an environment file on the machine
  (as `watch.sh` reads `SAY`), so the public copy never carries it.
- **Do not paste an enrolment token** into chats or tickets. The command
  carries none; the script asks for the token and reads it with the echo
  off, so it is in no shell history and no process list, and it is worth
  nothing once used or half an hour old. `meet.enrol.secret`, the old
  long-lived secret, is refused unless `accept_secret` is set: remove it from
  the configuration.
- **Logs are pasted into chats.** The server logs the API key and never the
  secret; keep it that way in anything you add.
- Before publishing anything, search it: IPv4 addresses outside the
  documentation ranges, your own domain names, home-directory paths,
  and anything that looks like a token.

## Passphrases and credentials

- Administrator passphrases come from `tomoshibi admin new`, which generates
  them. A passphrase somebody thought of falls to a guesser using many
  addresses in about a quarter of an hour; a generated one does not.
- Every passphrase door (join, account sign-in, management sign-in, and the
  two change-passphrase forms) is bounded: ten wrong answers a minute per
  address (an IPv6 /64 is one address) and a ceiling per door — thirty a
  minute, sixty at the join. The doors no longer share one budget: a spent
  join used to shut the management sign-in too, and the join is where
  ordinary traffic arrives. At the join, a passphrase this browser has used
  before and an account's passphrase are not charged, and a request from
  another site (`Sec-Fetch-Site` other than `same-origin`) is refused, so
  neither a busy hour nor somebody else's page can spend the ceiling. An
  attacker using every door at once gets their sum, which is a few times one
  door's rate; generated passphrases are out of reach at any of them. The
  management sign-in asks for the name too, so a guess has to be aimed at
  one person.
- Give administrators the narrowest capability that does their job
  (`rooms`, `accounts`, `relays`, `settings`); `moderate` is all of them plus
  the roster.
- A credential on a timer (the watchdog, the upgrade scripts) is read-only and
  belongs to nothing else. Re-check it by trying a write now and then.
- The join screen stores a passphrase in the browser's local storage, in the
  clear, by design (CLAUDE.md explains the trade). An administrator who types
  their administrator passphrase there leaves it in that browser.
- Rotating the API key pair means changing it on every node and restarting
  each, which ends the calls on every relay. (To be confirmed: there is no
  documented procedure; the enrolment hands out whatever pair the control
  node has.)
- Never replace the tripcode key. There is no rotation for it: a new key is a
  new signature for everybody.

## Firewalls

Open only what [chapter 2](prepare.md#ports) lists, per role, and narrow the
source wherever the other end is known:

- **Control node**: 80 and 443 to the world; `meet.listen` on loopback.
- **Relays**: the signalling, media, probe and TURN ports to the world; the
  TURN relay range to and from the other relays only, in both directions
  (the nftables table in [chapter 5](relays.md#turn-forwarding)), and
  `meet.turn_peers` listing the same relays; LiveKit's 7880 on loopback only.
- **redis**: only from the relays. Without TLS (as in the reference
  deployment) its traffic, password included, is plain TCP: keep it on a
  private network or a tunnel where the path allows. It is also the
  cluster's trust root — nodes hand each other participants' grants over it
  unauthenticated (RELAY.md) — so across a border, where `viahk` rewrites
  addresses and does not encrypt, the password and every signalling message
  are readable and alterable on the path. Not fixed in code: the remedy is
  TLS on redis (LiveKit's `redis.tls` block, and a `username` for an ACL user)
  or a WireGuard tunnel between the relays and redis, and a redis ACL user
  per relay limited to the commands the cluster uses.
- **viahk hub ports**: only from the mainland relays.
- **Gateways and the alert forwarder**: only from the control node, on a
  private network.
- Cloud security groups and host firewalls both count; keep them in step.

## SSH

- Keys only: `PasswordAuthentication no` and `KbdInteractiveAuthentication no`
  in `sshd_config`; root by key only (`PermitRootLogin prohibit-password`) or
  not at all.
- The upgrade scripts use `BatchMode=yes`, so they fail rather than prompt
  when a key is missing.
- Keep the SSH targets of your fleet in your own `~/.ssh/config`, not in
  scripts you publish.
- Do not leave keys or accounts on machines that are not yours.

## The server's own defences

Worth knowing, so they are not undone by accident:

- Relays serve no client, no join API and no management pages, by
  construction.
- `trust_proxy` is off by default; turning it on in front of nothing hands
  every caller a fresh rate-limit budget.
- Session cookies are `HttpOnly`, `SameSite=Strict`, `Secure` behind TLS, and
  writes from another origin are refused.
- Enrolment, TestFlight invitations and every passphrase door are rate
  limited. Enrolment tokens are one-time, per prefix and short-lived; a
  takeover of a prefix in use must be chosen when the token is minted; the
  address a name is pointed at must be public; every enrolment and refusal is
  logged with its source address and target address.
- A release build sends its App Store Connect token only to Apple.
- A watch-together relay only carries videos named by tickets the gateway
  issued, and only as media types.
- Rooms under a scope refuse everybody while the store is unavailable.
- `meet.silent` relays answer no prober: only an upgrade to `/rtc` and a
  bearer-token call to `/twirp/` get any reply, and a TLS handshake naming
  nothing the certificate covers fails instead of returning the wildcard.
- `/api/relays` tells a stranger only what measuring needs: no relay kept for
  administrators, probes as addresses rather than names, and never the
  address of a relay that signals through another.
- A guest's identity (the `g` kind, drawn from nothing) is kept across a
  reload only when the tab sends back the proof the join gave it with the
  identity; anybody else sending a guest's identity read off the roster gets
  a fresh one, so they cannot remove the guest by taking their place, and
  cannot take a pin an operator set for them. Apps that do not send the proof
  get a fresh guest identity on every join.
- The control node's host endpoints accept only join tokens it minted itself
  (a proof in the token's JWT ID), and treat nobody as an administrator
  without a session. Past its five minutes a join token is still accepted
  there while the identity it names is in that room (asked of the media
  servers, remembered ten seconds) and for at most a day after it was minted,
  so a host with only a passphrase runs the room for the whole meeting and a
  copied token is worth nothing once its owner has left.
