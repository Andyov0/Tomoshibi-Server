#!/bin/bash
# Replace a control node's binary once nobody is in a call, check that it came
# up, and put the old binary back if it did not.
#
# An example written for this guide; read it before running it. Run it ON the
# control node, as root, with the new binary already copied there and its
# SHA-256 worked out where it was built:
#
#   upgrade-control.sh /root/stage/tomoshibi.new <sha256>
#
# Restarting a control node ends no call (the relays hold them), but nobody
# can join while it is down, and a single machine (role full) does end its
# calls. So it waits for the fleet to be empty on two checks in a row.
#
# Environment, all optional:
#   CONF       configuration the service runs     /etc/tomoshibi/control.yaml
#   UNIT       systemd unit                       tomoshibi
#   WORKDIR    the unit's WorkingDirectory        /var/lib/tomoshibi
#   LOCAL      this node's own listener           http://127.0.0.1:8080
#   PUBLIC     the public address, for the checks afterwards, e.g.
#              https://meet.example.com           (unset: skipped)
#   CRED_FILE  holds WATCH_NAME= and WATCH_PASSPHRASE= of a read-only
#              administrator                      /etc/tomoshibi/watch.env
#   EVERY      seconds between idle checks        120
#   TRIES      idle checks before giving up       360 (twelve hours)
#   FORCE=1    do not wait for the fleet to be idle
set -uo pipefail

NEW=${1:-}
WANT=${2:-}
CONF=${CONF:-/etc/tomoshibi/control.yaml}
UNIT=${UNIT:-tomoshibi}
WORKDIR=${WORKDIR:-/var/lib/tomoshibi}
LOCAL=${LOCAL:-http://127.0.0.1:8080}
PUBLIC=${PUBLIC:-}
CRED_FILE=${CRED_FILE:-/etc/tomoshibi/watch.env}
EVERY=${EVERY:-120}
TRIES=${TRIES:-360}
BIN=/usr/local/bin/tomoshibi

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "$*" >&2; exit 1; }

[ -n "$NEW" ] && [ -n "$WANT" ] || die "usage: upgrade-control.sh <new binary> <its sha256>"
[ "$(id -u)" = 0 ] || die "run this as root"
[ -f "$NEW" ] || die "no file at $NEW"

# Absolute, because the configuration check below runs from another directory.
NEW="$(cd "$(dirname "$NEW")" && pwd)/$(basename "$NEW")"

have=$(sha256sum "$NEW" | cut -d' ' -f1)
[ "$have" = "$WANT" ] || die "the staged binary does not match the sum given; nothing changed"
chmod 0755 "$NEW"

# ---------- is anybody in a call ----------

cookie=""

# Signs in as the read-only administrator. The passphrase travels through the
# environment and standard input, never a command line another user could read.
sign_in() {
    local name pass
    [ -r "$CRED_FILE" ] || return 1
    name=$(grep -m1 '^WATCH_NAME=' "$CRED_FILE" | cut -d= -f2-)
    pass=$(grep -m1 '^WATCH_PASSPHRASE=' "$CRED_FILE" | cut -d= -f2-)
    [ -n "$name" ] && [ -n "$pass" ] || return 1

    cookie=$(NAME="$name" PASS="$pass" python3 -c \
        'import json, os; print(json.dumps({"name": os.environ["NAME"], "passphrase": os.environ["PASS"]}))' |
        curl -s --max-time 15 -D - -o /dev/null -H 'Content-Type: application/json' \
            --data-binary @- "$LOCAL/api/admin/session" |
        tr -d '\r' | awk 'tolower($1) == "set-cookie:" { sub(/;.*/, "", $2); print $2; exit }')
    [ -n "$cookie" ]
}

# How many people are in calls across the fleet, or "unknown" when not every
# relay answered: a relay that did not answer may be holding somebody.
people() {
    [ -n "$cookie" ] || sign_in || { echo unknown; return; }

    curl -s --max-time 30 -H "Cookie: $cookie" "$LOCAL/api/admin/now" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    print("unknown"); sys.exit()
if d.get("fleet"):
    asked, answered = d.get("asked"), d.get("answered")
    print(d.get("clients", "unknown") if asked and asked == answered else "unknown")
else:
    print(d.get("clients", "unknown"))
'
}

if [ "${FORCE:-}" != 1 ]; then
    empty=0
    for round in $(seq 1 "$TRIES"); do
        n=$(people)
        [ "$n" = unknown ] && cookie=""
        if [ "$n" = 0 ]; then empty=$((empty + 1)); else empty=0; fi
        [ $((round % 15)) = 1 ] && say "people in calls: $n"
        [ "$empty" -ge 2 ] && break
        sleep "$EVERY"
    done
    [ "$empty" -ge 2 ] || die "never empty on two checks in a row; nothing changed"
    say "empty twice; going ahead"
fi

# ---------- does the configuration load with the new binary ----------
#
# `admin trip` loads and checks the whole configuration (TLS files, the
# TestFlight key, the relay list) and reads the tripcode key. Run from the
# service's working directory so a relative tripcode_key resolves to the file
# the service uses rather than creating a new one somewhere else.
if ! out=$(cd "$WORKDIR" && "$NEW" admin trip "$CONF" configuration-check 2>&1 >/dev/null); then
    die "the configuration does not load with the new binary; nothing changed: $out"
fi

# ---------- swap ----------

stamp=$(date +%Y%m%d%H%M%S)
cp -a "$BIN" "$BIN.before-$stamp" || die "could not keep the old binary; nothing changed"

# Written beside and moved into place: the running process holds the file open.
install -m 0755 "$NEW" "$BIN.new" && mv -f "$BIN.new" "$BIN" || die "could not put the new binary in place"
systemctl restart "$UNIT"

ok=""
for second in $(seq 1 30); do
    sleep 1
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$LOCAL/api/health" || true)
    if systemctl is-active -q "$UNIT" && [ "$code" = 204 ]; then
        ok=yes
        break
    fi
done

if [ -z "$ok" ]; then
    say "did not come up; putting the old binary back"
    install -m 0755 "$BIN.before-$stamp" "$BIN.new" && mv -f "$BIN.new" "$BIN"
    systemctl restart "$UNIT"
    sleep 3
    journalctl -u "$UNIT" -n 30 --no-pager >&2 || true
    die "rolled back: $(systemctl is-active "$UNIT")"
fi

say "up after ${second}s: $("$BIN" version)"
say "the old binary is kept at $BIN.before-$stamp"

# ---------- from outside ----------

if [ -n "$PUBLIC" ]; then
    for path in / /api/health /apps; do
        say "$path -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC$path")"
    done
    # 200 or 404 (no build shelved) as an app; 403 not_the_app as a browser.
    say "update check as an app  -> $(curl -s -o /dev/null -w '%{http_code}' -A 'Tomoshibi/0.1.4 (Mac; check)' "$PUBLIC/api/apps/latest/mac")"
    say "update check as browser -> $(curl -s -o /dev/null -w '%{http_code}' -A 'Mozilla/5.0' "$PUBLIC/api/apps/latest/mac")"
fi
