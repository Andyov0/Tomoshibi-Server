#!/bin/bash
# What this deployment notices, put in front of a person.
#
# Everything below is something the server already works out and writes to its
# journal, where nobody is reading. A relay whose media port has stopped
# answering, a certificate two days from running out, a store that has been
# emptied — each of them says so once, correctly, to a log on one machine among
# eleven. That is not noticing.
#
# Only what cannot fix itself. A relay that goes quiet for a sweep comes back; a
# control node whose own line drops sees the whole fleet fail at once and holds
# its readings rather than acting on them. Both are ordinary and neither is
# worth a message. So a fault has to survive several rounds before anything is
# sent, and a fault that persists is repeated at an hour rather than every five
# minutes — the point is that a message from this means something, and a person
# who has learnt to swipe them away has been trained by the wrong messages.
#
# Run from cron on the control node, every five minutes:
#
#   */5 * * * * /usr/local/bin/tomoshibi-watch
#
# The bot token is not here and never comes here. This posts text to the Hermes
# machine over the private network and that machine, which already holds the
# token, does the talking.
set -uo pipefail

AT=${AT:-http://127.0.0.1:8080}
# Where to post, which is a property of the deployment rather than of this
# script. Read from the same file as the credential, because the address in this
# repository is a documentation one — the repository is public, and a script
# carrying the real address of the machine that speaks as the bot would be
# publishing it.
#
# This bit me: the substitution went into the copy already installed on the
# control node, so its alerts were being posted to an address nobody answers,
# and the next thing worth saying would have gone nowhere. Reading it from the
# environment file is what makes the two independent.
SAY=${SAY:-}
WORD=${WORD:-}

STATE=${STATE:-/var/lib/tomoshibi-watch}
LOG=${LOG:-/var/log/tomoshibi-watch.log}

# How many rounds a fault has to survive before anybody hears about it, and how
# often to repeat one that will not go away. Three rounds is fifteen minutes,
# which is longer than any of the self-healing this deployment does.
QUIET_FOR=${QUIET_FOR:-3}
REMIND_EVERY=${REMIND_EVERY:-12}

# Where the session for the management API comes from. A read-only
# administrator is enough and is what should be used: nothing here changes
# anything.
ENV_FILE=${ENV_FILE:-/etc/tomoshibi/watch.env}

# The word this and the relay on the Hermes machine share, kept beside the
# management credential rather than in the crontab, where a `ps` would show it.
if [ -f "$ENV_FILE" ]; then
    [ -z "$WORD" ] && WORD=$(grep -m1 '^WORD=' "$ENV_FILE" | cut -d= -f2-)
    [ -z "$SAY" ] && SAY=$(grep -m1 '^SAY=' "$ENV_FILE" | cut -d= -f2-)
fi

mkdir -p "$STATE"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# Documented rather than defaulted, because a default here would be a real
# address in a public repository or an unreachable one on a real machine.
#
# Below the definition of log, which it used to be above: shell functions have
# to exist before they are called, so this warning went to "command not found"
# on stderr and never reached the log it names. A script that cannot send
# anything, silently — which is the same shape of fault as the one the block
# further down was added for.
if [ -z "$SAY" ]; then
    log "SAY is not set in $ENV_FILE, so nothing can be sent"
fi

# The log is written every five minutes for ever.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
    tail -c 200000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

say() {
    local body
    body=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "word": sys.argv[2]}))' \
        "$1" "$WORD" 2>/dev/null) || return 1

    curl -s --max-time 20 -o /dev/null -X POST "$SAY" \
        -H 'Content-Type: application/json' --data-binary "$body"
}

# One counter per kind of fault, so that a relay being down does not silence a
# certificate that is about to expire.
#
# Returns 0 when this round is worth saying out loud.
worth_saying() {
    local kind=$1 wrong=$2
    local file="$STATE/$kind"
    local seen=0

    [ -f "$file" ] && seen=$(cat "$file" 2>/dev/null || echo 0)

    if [ "$wrong" -eq 0 ]; then
        # Recovered. Said once, because "it is better" is worth as much as "it
        # is broken" to somebody who was told the first thing.
        if [ "$seen" -ge "$QUIET_FOR" ]; then
            rm -f "$file"
            return 2
        fi

        rm -f "$file"
        return 1
    fi

    seen=$((seen + 1))
    echo "$seen" > "$file"

    [ "$seen" -lt "$QUIET_FOR" ] && return 1
    [ "$seen" -eq "$QUIET_FOR" ] && return 0
    [ $(( (seen - QUIET_FOR) % REMIND_EVERY )) -eq 0 ] && return 0

    return 1
}

session() {
    [ -f "$ENV_FILE" ] || return 1

    local name secret
    name=$(grep -m1 '^WATCH_NAME=' "$ENV_FILE" | cut -d= -f2-)
    secret=$(grep -m1 '^WATCH_PASSPHRASE=' "$ENV_FILE" | cut -d= -f2-)
    [ -n "$name" ] && [ -n "$secret" ] || return 1

    python3 - "$AT" "$name" "$secret" <<'PY'
import json, sys, urllib.request
at, name, secret = sys.argv[1:4]
body = json.dumps({"name": name, "passphrase": secret}).encode()
request = urllib.request.Request(
    at + "/api/admin/session", data=body, headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(request, timeout=15) as answer:
        for header in answer.headers.get_all("Set-Cookie") or []:
            print(header.split(";")[0])
            break
except Exception:
    sys.exit(1)
PY
}

COOKIE=$(session) || COOKIE=""

# ---------- this script's own eyesight ----------
#
# Said out loud, and it is the one fault here that had to be found by a person.
#
# The credential in watch.env stopped working — the account behind it was
# renamed, and signing in checks the name as well as the passphrase — and this
# went on for five hours across sixty runs. Every one of them wrote the line
# below to a log nobody reads and then reported "well", because everything it
# could still check was fine. What it could still check was the journal; the
# whole fleet was invisible to it and it said so to nobody.
#
# A watchdog that cannot see is worse than no watchdog, because the silence
# reads as good news. It cannot fix itself and it is not a blip, so it goes
# through the same three rounds as everything else and is then said.
#
# It can still be said: the machine that speaks holds its own token and knows
# nothing about this deployment's management API, so losing one has no bearing
# on the other.
blind=0
[ -z "$COOKIE" ] && blind=1

worth_saying blind "$blind"
case $? in
    0) say "Tomoshibi: the watchdog cannot sign in to the management API. It is reading the journal only, so nothing about the relays is being checked." ;;
    2) say "Tomoshibi: the watchdog can sign in again." ;;
esac

if [ -z "$COOKIE" ]; then
    log "could not sign in to the management API; only the log is being read"
fi

# ---------- the fleet ----------
#
# Read from the management API rather than by asking each relay, because that is
# the reading the control node acts on: a relay this node cannot reach is one it
# will not send anybody to, whatever the relay itself thinks.
FLEET=""
if [ -n "$COOKIE" ]; then
    FLEET=$(curl -s --max-time 20 -H "Cookie: $COOKIE" "$AT/api/admin/relays" 2>/dev/null)
fi

DOWN=""

if [ -n "$FLEET" ]; then
    DOWN=$(python3 - <<'PY' "$FLEET"
import json, sys
try:
    relays = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
if isinstance(relays, dict):
    relays = relays.get("relays", [])
# Out of service on purpose is not a fault. Somebody took it out.
print(", ".join(
    r.get("name", "?") for r in relays
    if r.get("enabled") and not r.get("reachable")))
PY
)
fi

# ---------- what the server said ----------
#
# The journal, for the things that have no endpoint: a certificate about to run
# out on a machine this node cannot renew for, a store that opened empty, a copy
# that could not be written. Each is a line the server already writes.
recent() {
    journalctl -u tomoshibi --since '-6min' --no-pager 2>/dev/null | grep -c "$1" || true
}

CERT=$(recent 'serving a certificate that expires soon')
EMPTY=$(recent 'the store is empty and there are copies')
NOCOPY=$(recent 'could not copy the store')
# ---------- media ports, which need the recovery read as well ----------
#
# Counting the failures alone made this permanently true.
#
# The control node's UDP probe to a relay fails and comes back about two hundred
# times a day, and each episode is over in half a minute — a cross-border path
# losing packets for a moment, not a machine with a closed port. But a window
# six minutes wide almost always contains one of those, so a check that only
# counted failures never saw a fleet in good health: the counter climbed past
# the three-round threshold on the first day and stayed there, and this was sent
# every hour, for ever, about relays that were carrying calls the whole time.
#
# That is the exact way to teach somebody to swipe these away.
#
# So the recovery line is read too, and what is counted is relays whose *last*
# word in the window was a failure. A failure followed by "answering again" is a
# blip and says nothing. The window is wider than before for the same reason:
# short enough and a real outage looks like a blip, so fifteen minutes, which is
# still well inside the three rounds this has to survive to be said at all.
# Written in awk alone rather than with a sed backreference: the first attempt
# used one to pull the relay's name out, and backreferences inside a pattern are
# not portable — it matched nothing at all and the function answered nought for
# every input, including a relay that had failed and never come back. It looked
# right on the machine, because nought was also the true answer at that moment.
still_without_media() {
    journalctl -u tomoshibi --since '-15min' --no-pager 2>/dev/null | awk '
        {
            if ($0 ~ /but not its media port/)            state = "bad"
            else if ($0 ~ /media port is answering again/) state = "ok"
            else next

            if (match($0, /relay="[^"]*"/))
                name = substr($0, RSTART + 7, RLENGTH - 8)
            else if (match($0, /relay=[^ ]+/))
                name = substr($0, RSTART + 6, RLENGTH - 6)
            else next

            last[name] = state
        }
        END {
            missing = 0
            for (name in last) if (last[name] == "bad") missing++
            print missing
        }'
}

NOMEDIA=$(still_without_media)

# ---------- the watch gateway's own checks ----------
#
# Things only that gateway can see -- a sign-in it uses that has run out, a
# source it reads that has stopped answering it -- said in its own words: it
# answers /health with each check, whether it holds (true, false, or null where
# it could not tell), and what to say when it breaks and when it is back. This
# script knows none of them by name, so the gateway can add one without this
# file changing, and none of it is here for a public repository to publish.
#
# Null is not false: a check the gateway could not run says nothing, and the
# count for it is left as it was rather than started or cleared.
WATCH_GATEWAY=${WATCH_GATEWAY:-http://127.0.0.1:18400}
WATCH_ENV=${WATCH_ENV:-/opt/watch/watch.env}
gateway_checks() {
    [ -r "$WATCH_ENV" ] || return 0
    local token
    token=$(grep -m1 '^WATCH_TOKEN=' "$WATCH_ENV" | cut -d= -f2-)
    [ -n "$token" ] || return 0
    curl -s --max-time 30 -H "X-Watch-Token: $token" "$WATCH_GATEWAY/health" |
        python3 -c '
import json, sys
try:
    checks = json.load(sys.stdin)["checks"]
except (ValueError, KeyError, TypeError):
    sys.exit(0)
for kind, check in checks.items():
    state = {True: "ok", False: "bad"}.get(check.get("ok"), "unknown")
    say = check.get("bad" if state == "bad" else "good", "").replace("\t", " ").replace("\n", " ")
    print(f"{kind}\t{state}\t{say}")
' 2>/dev/null
}
GATEWAY_CHECKS=$(gateway_checks)

# ---------- deciding ----------
trouble=0
lines=""

add() { lines="${lines}$1"$'\n'; trouble=1; }

if [ -n "$DOWN" ]; then
    worth_saying relays 1 && add "🔴 <b>Relays not answering</b>: ${DOWN}"
    log "relays down: $DOWN"
else
    worth_saying relays 0
    [ $? -eq 2 ] && say "🟢 <b>Every relay is answering again</b>"
fi

if [ "${NOMEDIA:-0}" -gt 0 ]; then
    worth_saying media 1 && add "🟠 <b>The control node reaches a relay's signalling port but not its media port</b> — either what is allowed through to that port changed, or the path from the control node does not carry UDP. Ask from another machine before touching it: one relay here is reachable from everywhere except this node, and carries calls perfectly."
    log "media port unreachable on some relay"
else
    worth_saying media 0
    [ $? -eq 2 ] && say "🟢 <b>Media ports are answering again</b>"
fi

if [ "${CERT:-0}" -gt 0 ]; then
    # No self-healing window for this one: it is already a warning about
    # something that will not fix itself, said two days ahead.
    worth_saying cert 1 && add "🔴 <b>A relay's certificate runs out within two days</b> and this node cannot renew it. Look at the acme client on that machine."
    log "certificate expiring on a relay"
else
    worth_saying cert 0
fi

if [ "${EMPTY:-0}" -gt 0 ]; then
    add "🔴 <b>The store opened empty and there are copies beside it</b> — this deployment held relays, accounts and administrators and no longer does. Stop the service and put back the newest copy."
    log "store opened empty"
fi

if [ "${NOCOPY:-0}" -gt 0 ]; then
    worth_saying backup 1 && add "🟠 <b>The store could not be copied</b> — there will be nothing to restore from."
    log "backup failed"
else
    worth_saying backup 0
fi

while IFS=$'\t' read -r kind state text; do
    [ -n "$kind" ] || continue
    case "$state" in
        bad)
            worth_saying "gateway-$kind" 1 && add "$text"
            log "watch gateway: $kind is failing"
            ;;
        ok)
            worth_saying "gateway-$kind" 0
            [ $? -eq 2 ] && say "$text"
            ;;
    esac
done <<< "$GATEWAY_CHECKS"

if [ "$trouble" -eq 0 ]; then
    log "well"
    exit 0
fi

say "$(printf '%s\n%s' "$lines" "$(date '+%F %T')")"
exit 1
