#!/bin/bash
# Send this relay's traffic to the overseas relays through Hong Kong.
#
# No tunnel and no new software. The kernel rewrites the destination on the way
# out and the source on the way back, so what leaves this machine is ordinary
# UDP to another of ours on a port we chose. A tunnel would have been tidier and
# would also have been a protocol with a handshake somebody can fingerprint,
# which on a machine rented in mainland China is a reason not to have one.
#
#   viahk.sh <hub-ip> <dest-ip>:<dest-port>:<hub-port> ...
#   viahk.sh off
#
# Built whole and replaced whole, so running it again is how the machine is kept
# right rather than a way to end up with two of everything.
set -euo pipefail

TABLE="viahk"

if [ "${1:-}" = "off" ]; then
    if command -v nft >/dev/null && nft list table ip "$TABLE" >/dev/null 2>&1; then
        nft delete table ip "$TABLE" && echo "removed"
    elif command -v iptables >/dev/null; then
        # Flushed by name, so nothing else in the nat table is touched.
        iptables -t nat -D OUTPUT -j VIAHK_OUT 2>/dev/null || true
        iptables -t nat -D POSTROUTING -j VIAHK_POST 2>/dev/null || true
        for chain in VIAHK_OUT VIAHK_POST; do
            iptables -t nat -F "$chain" 2>/dev/null || true
            iptables -t nat -X "$chain" 2>/dev/null || true
        done
        echo "removed"
    else
        echo "nothing to remove"
    fi
    exit 0
fi

[ $# -ge 2 ] || { echo "usage: viahk.sh <hub-ip> <dest-ip>:<dest-port>:<hub-port> ..." >&2; exit 2; }

HUB="$1"; shift

# nftables where it exists, iptables where it does not. One relay in this fleet
# has only iptables and installing a package on it to match the others would be
# a change to that machine made for the tidiness of this script.
if command -v nft >/dev/null; then
    KIND=nft
elif command -v iptables >/dev/null && iptables -t nat -L -n >/dev/null 2>&1; then
    KIND=iptables
else
    echo "neither nftables nor an iptables nat table is available" >&2
    exit 1
fi

out=""
for spec in "$@"; do
    IFS=: read -r dest dport hport <<<"$spec"
    [ -n "$dest" ] && [ -n "$dport" ] && [ -n "$hport" ] || {
        echo "bad mapping: $spec" >&2; exit 2; }

    out+="        ip daddr ${dest} udp dport ${dport} dnat to ${HUB}:${hport}"$'\n'
done

if [ "$KIND" = iptables ]; then
    # Own chains, hooked once, emptied and refilled. Editing the built-in chains
    # directly is how a machine ends up with yesterday's rules underneath
    # today's and no way to tell which is in force.
    for chain in VIAHK_OUT VIAHK_POST; do
        iptables -t nat -N "$chain" 2>/dev/null || iptables -t nat -F "$chain"
    done

    iptables -t nat -C OUTPUT -j VIAHK_OUT 2>/dev/null || iptables -t nat -I OUTPUT 1 -j VIAHK_OUT
    iptables -t nat -C POSTROUTING -j VIAHK_POST 2>/dev/null || iptables -t nat -I POSTROUTING 1 -j VIAHK_POST

    for spec in "$@"; do
        IFS=: read -r dest dport hport <<<"$spec"
        iptables -t nat -A VIAHK_OUT -p udp -d "$dest" --dport "$dport" \
            -j DNAT --to-destination "${HUB}:${hport}"
    done

    iptables -t nat -A VIAHK_POST -d "$HUB" -j MASQUERADE

    echo "via ${HUB} (iptables):"
    iptables -t nat -S VIAHK_OUT | grep DNAT | sed 's/^/  /'
    exit 0
fi

# Emptied before it is filled, for the same reason the hub is: nft merges.
nft delete chain ip "$TABLE" output 2>/dev/null || true
nft delete chain ip "$TABLE" postrouting 2>/dev/null || true

nft -f - <<EOF
table ip ${TABLE} {
    chain output {
        # -100 rather than the name dstnat, which nftables only accepts on
        # prerouting. Same number, and output is where a packet this machine
        # originated can still have its destination changed.
        type nat hook output priority -100; policy accept;

${out}    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # Leaves as this machine, so the hub answers somewhere with a route
        # back. Conntrack undoes both rewrites on the way in, so the relay
        # process sees the overseas address it addressed and never learns any
        # of this happened.
        ip daddr ${HUB} masquerade
    }
}
EOF

echo "via ${HUB}:"
nft list chain ip "$TABLE" output | grep dnat | sed 's/^/  /'
