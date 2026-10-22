# 10. Security

[Back to the guide](../../DEPLOY.md)

What this deployment's secrets are, where they live, and the habits that keep
them there.

## The secrets, and what each one buys

| Secret | Where | Whoever holds it can |
| --- | --- | --- |
| The API key pair (`keys`) | Every node's configuration | Sign a token for any room as anybody, and act on every relay's API. It is the deployment. |
| The tripcode key | `meet.tripcode_key` on the control node | Derive every signature offline. Without it a passphrase can only be guessed through the rate-limited doors. |
| The enrolment secret (`meet.enrol.secret`), and every copy of the install command | The control node's configuration; the management pages | Enrol a machine, and receive the API pair, the redis password and the certificate's private key. |
| The relays' wildcard private key | The control node and every relay | Impersonate any relay name in that zone. |
| The redis password | Every relay, the control node, redis | Join the cluster's internal traffic. |
| Cloudflare token | The control node's configuration | Edit the zone's DNS records (scope it to that zone, DNS only). |
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
- **Do not paste the install command** into chats, tickets or shell history
  you keep. The public `/install` script carries no secret precisely so that
  the secret travels only in the operator's own command.
- **Logs are pasted into chats.** The server logs the API key and never the
  secret; keep it that way in anything you add.
- Before publishing anything, search it: IPv4 addresses outside the
  documentation ranges, your own domain names, home-directory paths,
  and anything that looks like a token.

## Passphrases and credentials

- Administrator passphrases come from `tomoshibi admin new`, which generates
  them. A passphrase somebody thought of falls to a guesser using many
  addresses in about a quarter of an hour; a generated one does not.
- Every passphrase door (join, account sign-in, management sign-in) shares one
  budget per address, and the management sign-in asks for the name too, so a
  guess has to be aimed at one person.
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
  TURN relay range to the other relays; LiveKit's 7880 on loopback only.
- **redis**: only from the relays. Without TLS (as in the reference
  deployment) its traffic, password included, is plain TCP: keep it on a
  private network or a tunnel where the path allows.
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
  limited, and wrong enrolment secrets are logged.
- A release build sends its App Store Connect token only to Apple.
- A watch-together relay only carries videos named by tickets the gateway
  issued, and only as media types.
- Rooms under a scope refuse everybody while the store is unavailable.
- `meet.silent` relays answer no prober.
