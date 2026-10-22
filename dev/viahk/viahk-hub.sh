#!/bin/bash
# The Hong Kong end: take what the mainland relays send and put it on the wire.
#
# One port per overseas relay, because that is the whole of the mapping — a
# packet arriving on this port is for that machine. Several mainland relays may
# use the same port; conntrack tells them apart by where they came from.
#
#   viahk-hub.sh <hub-port>:<dest-ip>:<dest-port> ...
#   viahk-hub.sh off
set -euo pipefail

TABLE="viahk"

if [ "${1:-}" = "off" ]; then
    nft delete table ip "$TABLE" 2>/dev/null && echo "removed" || echo "nothing to remove"
    rm -f /etc/sysctl.d/99-viahk.conf
    # Put the running value back too. Removing only the file leaves a machine
    # forwarding until its next reboot, which is the kind of leftover found
    # months later by somebody wondering why.
    sysctl -qw net.ipv4.ip_forward=0
    exit 0
fi

[ $# -ge 1 ] || { echo "usage: viahk-hub.sh <hub-port>:<dest-ip>:<dest-port> ..." >&2; exit 2; }

command -v nft >/dev/null || { echo "nftables is not installed" >&2; exit 1; }

# Forwarding, written down as well as set. A machine that forwards until its
# next reboot is a machine whose relays work until its next reboot.
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-viahk.conf
sysctl -qw net.ipv4.ip_forward=1

pre=""; post=""
for spec in "$@"; do
    IFS=: read -r hport dest dport <<<"$spec"
    [ -n "$hport" ] && [ -n "$dest" ] && [ -n "$dport" ] || {
        echo "bad mapping: $spec" >&2; exit 2; }

    pre+="        udp dport ${hport} dnat to ${dest}:${dport}"$'\n'
    post+="        ip daddr ${dest} udp dport ${dport} masquerade"$'\n'
done

# Emptied before it is filled. `nft -f` with a table block merges into whatever
# is already there, so running this twice gave two of every rule — which is not
# an error, and matters the day somebody reads the table to find out what a
# machine is doing. Deleting only the chains this owns leaves the spoke rules,
# which live in the same table under a different chain.
nft delete chain ip "$TABLE" prerouting 2>/dev/null || true
nft delete chain ip "$TABLE" hubpost 2>/dev/null || true

nft -f - <<EOF
table ip ${TABLE} {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

${pre}    }

    # Its own chain rather than the one the spoke uses, so each end of this can
    # be rebuilt without flushing the other's rules out from under it.
    chain hubpost {
        type nat hook postrouting priority srcnat; policy accept;

        # Sent on as this machine, so the far end replies here and conntrack can
        # put the answer back on the path it came from. Without it the far end
        # would answer a mainland address it has no route to and no reason to
        # accept.
${post}    }
}
EOF

echo "forwarding:"
nft list chain ip "$TABLE" prerouting | grep dnat | sed 's/^/  /'
