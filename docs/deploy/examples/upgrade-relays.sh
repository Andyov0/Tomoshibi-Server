#!/bin/bash
# Put one new binary on a list of relays, the binary and nothing else.
#
# An example written for this guide; read it before running it. Three steps:
#
#   stage  copy the binary to every relay and check its SHA-256 there;
#          nothing is swapped unless every relay staged it
#   wait   until nobody is in a call anywhere in the fleet: a relay showing
#          no clients can still be forwarding somebody's media through its
#          TURN server to the relay holding their meeting
#   swap   a few relays at a time; each keeps tomoshibi.old and puts it back
#          if its unit is not active (on the expected build) ten seconds
#          after the restart
#
# Run from the machine you deploy from, with SSH access as root to each relay
# and the control node's management API reachable:
#
#   CONTROL=https://meet.example.com CRED_FILE=~/.config/tomoshibi/observer.env \
#     upgrade-relays.sh ./tomoshibi root@hk.relay.example.com root@203.0.113.31
#
# Environment:
#   CONTROL    the control node, as this machine reaches it        (required)
#   CRED_FILE  WATCH_NAME= and WATCH_PASSPHRASE= of a read-only
#              administrator                                        (required)
#   PARALLEL   relays swapped at once                               5
#   EXPECT     what `tomoshibi version` must start with afterwards,
#              for example the commit's first twelve characters     (unset: not checked)
#   EVERY      seconds between idle checks                          120
#   TRIES      idle checks before giving up                         360
#   FORCE=1    swap without waiting for the fleet to be idle
#
# A re-enrolment (REPLACE=1) also replaces the binary, but it rewrites
# relay.yaml whole and loses everything added to it by hand; this does not
# touch the configuration.
set -uo pipefail

BINARY=${1:-}
[ $# -ge 2 ] || { echo "usage: upgrade-relays.sh <binary> <ssh-target> [<ssh-target> ...]" >&2; exit 2; }
shift

CONTROL=${CONTROL:-}
CRED_FILE=${CRED_FILE:-}
PARALLEL=${PARALLEL:-5}
EXPECT=${EXPECT:--}
EVERY=${EVERY:-120}
TRIES=${TRIES:-360}

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "$*" >&2; exit 1; }

[ -f "$BINARY" ] || die "no binary at $BINARY"
[ -n "$CONTROL" ] || die "set CONTROL to the control node's address"
[ -r "$CRED_FILE" ] || [ "${FORCE:-}" = 1 ] || die "set CRED_FILE to a file holding WATCH_NAME and WATCH_PASSPHRASE"

# sha256sum on Linux, shasum on a Mac.
sum_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

SUM=$(sum_of "$BINARY")
STAGED="/usr/local/bin/tomoshibi.staged-$(printf '%s' "$SUM" | cut -c1-12)"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say "binary $BINARY, sha256 $SUM"

# ---------- stage ----------

stage_one() {
    local host=$1 there
    scp -q -o BatchMode=yes -o ConnectTimeout=20 "$BINARY" "$host:$STAGED" </dev/null ||
        { echo "$host: copy failed"; return 1; }
    there=$($SSH -n "$host" "chmod 0755 '$STAGED' && sha256sum < '$STAGED' | cut -d' ' -f1")
    [ "$there" = "$SUM" ] || { echo "$host: the copy there does not match"; return 1; }
    echo "$host: staged"
}

i=0
for host in "$@"; do
    { stage_one "$host" 2>&1 | tail -1; } >"$WORK/stage.$i" &
    i=$((i + 1))
    [ $((i % PARALLEL)) -eq 0 ] && wait
done
wait
cat "$WORK"/stage.*
missing=$(cat "$WORK"/stage.* | grep -cv ': staged$')
[ "$missing" = 0 ] || die "$missing relay(s) not staged; nothing swapped (the staged copies stay)"

# ---------- wait for an empty fleet ----------

cookie=""

sign_in() {
    local name pass
    name=$(grep -m1 '^WATCH_NAME=' "$CRED_FILE" | cut -d= -f2-)
    pass=$(grep -m1 '^WATCH_PASSPHRASE=' "$CRED_FILE" | cut -d= -f2-)
    [ -n "$name" ] && [ -n "$pass" ] || return 1

    cookie=$(NAME="$name" PASS="$pass" python3 -c \
        'import json, os; print(json.dumps({"name": os.environ["NAME"], "passphrase": os.environ["PASS"]}))' |
        curl -s --max-time 15 -D - -o /dev/null -H 'Content-Type: application/json' \
            --data-binary @- "$CONTROL/api/admin/session" |
        tr -d '\r' | awk 'tolower($1) == "set-cookie:" { sub(/;.*/, "", $2); print $2; exit }')
    [ -n "$cookie" ]
}

people() {
    [ -n "$cookie" ] || sign_in || { echo unknown; return; }

    curl -s --max-time 30 -H "Cookie: $cookie" "$CONTROL/api/admin/now" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    print("unknown"); sys.exit()
asked, answered = d.get("asked"), d.get("answered")
print(d.get("clients", "unknown") if asked and asked == answered else "unknown")
'
}

if [ "${FORCE:-}" != 1 ]; then
    empty=0
    for round in $(seq 1 "$TRIES"); do
        n=$(people)
        [ "$n" = unknown ] && cookie=""
        if [ "$n" = 0 ]; then empty=$((empty + 1)); else empty=0; fi
        [ $((round % 15)) = 1 ] && say "people in calls across the fleet: $n"
        [ "$empty" -ge 2 ] && break
        sleep "$EVERY"
    done
    [ "$empty" -ge 2 ] || die "the fleet was never empty on two checks in a row; nothing swapped"
    say "fleet empty twice; swapping"
fi

# ---------- swap ----------

# Runs on the relay. Arguments: the staged file, its sum, the expected build
# (or "-" for any).
read -r -d '' SWAP <<'REMOTE'
set -u
staged=$1 want=$2 expect=$3
bin=/usr/local/bin/tomoshibi

# Whichever unit is running: tomoshibi-relay on a relay, tomoshibi on a
# machine that is also the control node. Asked, never assumed.
unit=""
for u in tomoshibi-relay tomoshibi; do
    if [ "$(systemctl is-active "$u" 2>/dev/null)" = active ]; then unit=$u; break; fi
done
[ -n "$unit" ] || { echo "not running before this started; left alone"; exit 1; }

[ -f "$staged" ] && [ "$(sha256sum < "$staged" | cut -d' ' -f1)" = "$want" ] ||
    { echo "the staged binary is missing or changed"; exit 1; }

cp -a "$bin" "$bin.old" || { echo "could not keep the old binary"; exit 1; }
install -m 0755 "$staged" "$bin.new" && mv -f "$bin.new" "$bin" ||
    { echo "could not put the binary in place"; exit 1; }

systemctl restart "$unit"
sleep 10

now=$("$bin" version 2>/dev/null)
right=yes
[ "$expect" = - ] || case "$now" in "$expect"*) ;; *) right="" ;; esac

if [ "$(systemctl is-active "$unit")" = active ] && [ -n "$right" ]; then
    rm -f "$staged"
    echo "swapped ($unit): $now"
    exit 0
fi

install -m 0755 "$bin.old" "$bin.new" && mv -f "$bin.new" "$bin"
systemctl restart "$unit"
sleep 5
echo "did not come back on the new build; put the old one back ($(systemctl is-active "$unit"))"
exit 1
REMOTE

swap_one() {
    local host=$1 answer
    answer=$($SSH "$host" "bash -s -- '$STAGED' '$SUM' '$EXPECT'" <<<"$SWAP" 2>&1 | tail -1)
    echo "$host: $answer"
}

i=0
for host in "$@"; do
    swap_one "$host" >"$WORK/swap.$i" 2>&1 &
    i=$((i + 1))
    [ $((i % PARALLEL)) -eq 0 ] && wait
done
wait
cat "$WORK"/swap.*
bad=$(cat "$WORK"/swap.* | grep -cv ': swapped (')
say "swapped $(( $# - bad )) of $#"

if [ "${FORCE:-}" != 1 ]; then
    sleep 20
    say "people in calls across the fleet afterwards: $(people)"
fi

[ "$bad" = 0 ]
