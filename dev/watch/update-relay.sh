#!/bin/bash
# Put a new binary on one relay, and put the old one back if it does not start.
#
# The binary and nothing else. The documented way to update a relay is to run
# the enrolment again with REPLACE=1, and that rewrites relay.yaml whole — so it
# takes away everything added by hand afterwards. On this fleet that is the
# probe port on all ten machines, the region and node selector on each, and
# `silent` on the mainland ones, which is the setting that stops a machine being
# identified as a website and taken off the air.
#
# Re-enrolment is right for a machine being brought up. For a machine that is
# already running and configured, replacing the file it executes is the whole of
# the change, and leaves nothing to put back.
#
# Works on a control node too, where the unit is called `tomoshibi` rather than
# `tomoshibi-relay`. That was worth an outage of its own: with the name written
# in, this asked a running control node whether `tomoshibi-relay` was active,
# was told it was not, and refused to touch it — reporting the machine as down
# while it was serving meetings. So the unit is asked for rather than assumed.
#
# Run from the repository root, with the binary already built:
#
#   dev/watch/update-relay.sh <ssh-target> [/path/to/binary]
#
# Exits non-zero if the relay did not come back, having already rolled back.
set -uo pipefail

TARGET=${1:-}
BINARY=${2:-/tmp/relay-bin}

[ -n "$TARGET" ] || { echo "usage: update-relay.sh <ssh-target> [binary]" >&2; exit 2; }
[ -f "$BINARY" ] || { echo "no binary at $BINARY" >&2; exit 2; }

say() { printf '  %s\n' "$*"; }

printf '\n=== %s ===\n' "$TARGET"

# Whichever of the two this machine runs. Asked, not guessed — and the one that
# is *running*, not merely the one whose unit file is present. The control node
# has both files: it was a relay once, and the dead unit was left behind. Taking
# the first that existed found that corpse and declared the machine down.
UNIT=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$TARGET" '
for u in tomoshibi-relay tomoshibi; do
    [ "$(systemctl is-active "$u" 2>/dev/null)" = active ] && { echo "$u"; exit 0; }
done
# Nothing running: fall back to whichever file is there, so the message
# afterwards is about a service that is down rather than about no service.
for u in tomoshibi-relay tomoshibi; do
    systemctl cat "$u" >/dev/null 2>&1 && { echo "$u"; exit 0; }
done
exit 1' 2>/dev/null)

[ -n "$UNIT" ] || { echo "  no tomoshibi unit on this machine" >&2; exit 1; }
say "unit:   $UNIT"

# What is there now, so the comparison afterwards is against something rather
# than against an expectation.
before=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$TARGET" \
"systemctl is-active $UNIT 2>/dev/null; /usr/local/bin/tomoshibi version 2>/dev/null || echo '(no version command)'" 2>&1 | tr '\n' ' ')
say "before: $before"

case "$before" in
    active*) ;;
    *) echo "  not running before this started; leaving it alone" >&2; exit 1 ;;
esac

scp -q -o ConnectTimeout=20 "$BINARY" "$TARGET:/usr/local/bin/tomoshibi.new" || {
    echo "  could not copy the binary" >&2; exit 1; }

ssh -o ConnectTimeout=25 -o BatchMode=yes "$TARGET" "UNIT=$UNIT bash -s" <<'REMOTE'
chmod +x /usr/local/bin/tomoshibi.new

# Kept beside it rather than in a backups directory: the way back has to be
# obvious to somebody reading the machine at three in the morning, and one
# directory listing is more obvious than a path they have to be told.
cp -a /usr/local/bin/tomoshibi /usr/local/bin/tomoshibi.old

mv /usr/local/bin/tomoshibi.new /usr/local/bin/tomoshibi
systemctl restart "$UNIT"
REMOTE
[ $? -eq 0 ] || { echo "  the swap failed" >&2; exit 1; }

# Long enough for the store lock to be let go of and the media server to bind.
sleep 10

after=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$TARGET" \
"systemctl is-active $UNIT 2>/dev/null; /usr/local/bin/tomoshibi version 2>/dev/null" 2>&1 | tr '\n' ' ')
say "after:  $after"

case "$after" in
    active*)
        say "ok"
        exit 0
        ;;
esac

# Back, and said plainly. A relay left down is worse than a relay left old.
echo "  did not come back; rolling back" >&2

ssh -o ConnectTimeout=25 -o BatchMode=yes "$TARGET" "
mv /usr/local/bin/tomoshibi.old /usr/local/bin/tomoshibi
systemctl restart $UNIT
sleep 5
systemctl is-active $UNIT
" 2>&1 | sed 's/^/  rollback: /' >&2

exit 1
