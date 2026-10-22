# Putting what this notices in front of a person

Everything this deployment works out, it writes to a journal. A relay whose
media port has stopped answering, a certificate two days from running out, a
store that opened empty, a copy that could not be written: each says so once,
correctly, on one machine among eleven, where nobody is reading. That is not
noticing.

Two pieces, on two machines, because the token stays where it already was.

> **The addresses below are documentation addresses.** RFC 5737 reserves
> `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24` for exactly this, and
> the names end in `.example`. What a deployment actually runs is in its
> management pages, and this repository is public.
>
> The two machines really do share a private subnet and the port really is
> the one below; only the addresses are stand-ins.


## What runs where

| | |
| --- | --- |
| `watch.sh` → `/usr/local/bin/tomoshibi-watch` on the control node | Reads the fleet and the journal every five minutes. Decides whether anything is worth saying. Holds no token. |
| `hermes-relay.py` → `/usr/local/bin/tomoshibi-hermes-relay` on the Hermes machine | Takes text on the private network and says it as Hermes, in the channel Hermes already uses. |

`SAY` and `WORD` both come from `/etc/tomoshibi/watch.env` — the address in
this repository is a documentation one, because the repository is public and a
script carrying the real address of the machine that speaks as the bot would be
publishing it. Set `SAY=http://<hermes>:49771/say` there.

The two share a private subnet and nothing else reaches it. The listener is bound
to the private address only, and a shared word in
`/etc/tomoshibi/watch.env` keeps a stray probe on that subnet from becoming a
message.

The control node never holds the bot token. It posts text; the machine that
already had the token does the talking. A control node somebody takes is one
that can send messages, not one that hands over the ability to speak as the bot.

It reads Hermes's own `/root/.hermes/.env` — its bot, its home channel. An
earlier version of this read a different project's alert file that happened to
be on the same machine, which would have tied this deployment's alerts to
somebody else's credential and sent them wherever that project had decided.

## What it says, and when it does not

Only what cannot fix itself, which is the standing rule for alerts here. A relay
that goes quiet for one sweep comes back. A control node whose own line drops
sees the whole fleet fail at once and holds its readings rather than acting on
them — there is a guard in `internal/app/reachable.go` written from fourteen
hours of measurements that says so. Neither is worth a message.

So a fault has to survive three rounds — fifteen minutes, longer than any
self-healing here — before anything is sent, and one that persists is repeated
hourly rather than every five minutes. A message from this should mean
something; somebody who has learnt to swipe them away has been trained by the
wrong messages.

| Sent | From |
| --- | --- |
| Relays not answering | `/api/admin/relays`, and only relays that are enabled — one taken out of service was taken out by somebody. |
| The control node reaches a relay's signalling but not its media port | The journal. The most common way a relay here breaks and invisible to every other check — but it is one vantage point, and one relay on this fleet answers UDP from everywhere except the control node while carrying calls perfectly. Ask from another machine before touching anything. |
| A certificate runs out within two days | The journal. No quiet window: it is already a warning about something two days ahead that will not fix itself. |
| The store opened empty and there are copies beside it | The journal. Sent immediately and every time, because it means the deployment has lost its relays, accounts and administrators. |
| The store could not be copied | The journal. There will be nothing to restore from. |
| The watchdog itself cannot sign in | Its own attempt. The one fault here that had to be found by a person: the account behind the credential was renamed, signing in checks the name as well as the passphrase, and sixty runs across five hours wrote a line to a log nobody reads and then reported "well" — because everything they could still check was fine, and what they could still check was the journal. A watchdog that has gone blind reads as good news. It can still say so: the machine that speaks holds its own token and knows nothing about this deployment's management API. |

Recovery is said once, for the faults that were said once. Being told something
is broken and never told it is better is how a person learns to distrust both.

## The credential

A read-only administrator, in `/etc/tomoshibi/watch.env`, mode 600. Nothing here
changes anything, and a credential on a cron job that could close every meeting
on the deployment is a credential worth stealing.

It stopped being read-only twice, by accident and from the other end: the
account was given `moderate` because a person needed it for something else, and
the cron job silently inherited that. The second time went unnoticed for long
enough that it was found while looking for something else entirely, which is
what this drift is like — nothing fails, and the only symptom is a credential
on a timer that can end every meeting on the deployment.

There is a fingerprint worth knowing. `roster` writes either `[observe]` or
`[observe moderate]` and cannot produce anything else, so an entry reading
`[moderate]` on its own was not written by it — `PATCH /api/admin/admins/{trip}`
takes the list verbatim, and that endpoint is the management pages. A capability
that arrived from a screen is one nobody recorded a reason for. Whoever this credential belongs to should belong to
nothing else — a second account costs one `roster` line, and sharing one means
every later change to it arrives here without anybody deciding that it should.
Checked by trying rather than by reading the roster: signing in works, the reads
work, and the writes answer 403. Point the writes at a name nothing has — a
check that would take a relay out of service if it were wrong about the
capability is a check that takes a relay out of service on the day it matters.

`dev/roster` mints one:

```bash
tomoshibi admin trip /etc/tomoshibi/control.yaml '<passphrase>'
systemctl stop tomoshibi
roster /var/lib/tomoshibi/meet.db add <trip> watch observe
systemctl start tomoshibi
```

The `observe` at the end matters. Without it roster gives both capabilities,
which is right for the reason roster exists — being locked out — and wrong for
this.

**`/etc/tomoshibi` must stay readable.** The service runs under a dynamic user
and reads its configuration from there, so tightening the directory to 700 stops
it starting, with `permission denied` on a file whose own mode looks fine. That
happened while this was being installed.

## Checking it

Nothing arriving is the ordinary state, so the thing to test is that something
would arrive:

```bash
# The relay, end to end. Says {"sent": true} and a message appears.
curl -s -X POST http://192.0.2.11:49771/say \
  -H 'Content-Type: application/json' \
  -d '{"text":"test","word":"<the word from watch.env>"}'

# The threshold. A copy of the script with a fault written in, run four times:
# silent, silent, sent, silent — the fourth is waiting for the hourly reminder.
tail /var/log/tomoshibi-watch.log
```

Rehearsed that way before it was scheduled: three rounds to the first message,
recovery said once, and both halves seen arriving.
