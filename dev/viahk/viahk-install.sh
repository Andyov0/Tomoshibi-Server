#!/bin/bash
# Make a machine's viahk mapping survive a reboot.
#
# The scripts set nftables rules at the moment they are run and nothing else.
# That is the whole of what was wrong: a mainland relay rebooted for a kernel
# upgrade or a power cut came back with no rules, its overseas traffic went back
# to 340 ms and started dropping packets, and every check stayed green — the
# machine is up, the signalling port answers, the media port answers, and the
# only symptom is that people say the meeting is bad today. The measured 7.9x
# improvement is undone by one reboot and nothing anywhere says so.
#
# So the arguments are written down and replayed at boot. A unit rather than an
# @reboot cron line, because a unit can say it needs the network first and
# because `systemctl status viahk` is where somebody will look.
#
#   viahk-install.sh spoke <hub-ip> <dest-ip>:<dest-port>:<hub-port> ...
#   viahk-install.sh hub <hub-port>:<dest-ip>:<dest-port> ...
#   viahk-install.sh show
#   viahk-install.sh off
#
# Both roles can be installed on one machine, and one of them is: Shanghai
# Tencent sends its own overseas traffic through Hong Kong and carries Hong
# Kong's Shanghai Telecom traffic the last six milliseconds. The two scripts own
# different chains of the same table — output and postrouting against prerouting
# and hubpost — so each can be rebuilt without flushing the other's rules out
# from under it. Installing one role leaves the other's arguments alone.
#
# The arguments are exactly the ones the underlying script takes, and they are
# applied now as well as at boot, so this replaces running it by hand rather
# than being a second step after it.
set -euo pipefail

WHERE="/usr/local/lib/viahk"
UNIT="/etc/systemd/system/viahk.service"

usage() {
    cat >&2 <<'EOF'
usage: viahk-install.sh spoke <hub-ip> <dest>:<port>:<hub-port> ...
       viahk-install.sh hub <hub-port>:<dest>:<dest-port> ...
       viahk-install.sh show
       viahk-install.sh off
EOF
    exit 2
}

[ $# -ge 1 ] || usage

case "$1" in
    show)
        echo "installed:"
        for role in spoke hub; do
            [ -s "$WHERE/$role.args" ] && printf '  %-6s %s\n' "$role" "$(cat "$WHERE/$role.args" | tr -d '\n')"
        done
        [ -s "$WHERE/spoke.args" ] || [ -s "$WHERE/hub.args" ] || echo "  (nothing)"
        echo
        systemctl --no-pager --lines=0 status viahk.service 2>&1 | head -3 || true

        # Counted from whichever the machine actually uses. Some of these
        # relays have no nftables at all and the script falls back to iptables;
        # counting only `nft` reported those as having nothing, which is a
        # reading that sends somebody to fix a machine that is fine.
        echo "rules:"
        if nft list table ip viahk >/dev/null 2>&1; then
            printf '  nftables %s\n' "$(nft list table ip viahk | grep -cE 'dnat to|masquerade')"
        elif iptables -t nat -S VIAHK_OUT >/dev/null 2>&1 || iptables -t nat -S VIAHK_PRE >/dev/null 2>&1; then
            printf '  iptables %s\n' "$(( $(iptables -t nat -S VIAHK_OUT 2>/dev/null | grep -c DNAT) + $(iptables -t nat -S VIAHK_PRE 2>/dev/null | grep -c DNAT) ))"
        else
            printf '  (none)\n'
        fi

        exit 0
        ;;

    off)
        systemctl disable --now viahk.service 2>/dev/null || true
        rm -f "$UNIT"
        systemctl daemon-reload

        # Both shapes, because this does not remember which were installed and
        # the wrong one is a no-op. Before the argument files go, since the
        # scripts are what remove the rules.
        [ -x "$WHERE/viahk.sh" ] && "$WHERE/viahk.sh" off || true
        [ -x "$WHERE/viahk-hub.sh" ] && "$WHERE/viahk-hub.sh" off || true

        rm -f "$WHERE/spoke.args" "$WHERE/hub.args"

        echo "removed"
        exit 0
        ;;

    spoke) script="viahk.sh" ;;
    hub)   script="viahk-hub.sh" ;;
    *)     usage ;;
esac

role="$1"
shift

[ $# -ge 1 ] || usage

here="$(cd "$(dirname "$0")" && pwd)"
for one in viahk.sh viahk-hub.sh; do
    [ -f "$here/$one" ] || { echo "$one is not beside this one" >&2; exit 1; }
done

install -d "$WHERE"

# Skipped where this is already running from the place it installs to, which is
# what happens every time somebody re-runs it on a machine to change the
# mapping. `install` refuses to copy a file onto itself, and under `set -e` that
# ended the script before it wrote the arguments — so the unit kept the old
# mapping and the summary printed nothing to say so.
if [ "$here" != "$WHERE" ]; then
    install -m 0755 "$here/viahk.sh" "$here/viahk-hub.sh" "$WHERE/"
fi

# Quoted, so an argument with anything surprising in it survives the round trip
# through the file. Only this role's file is touched.
: > "$WHERE/$role.args"
for one in "$@"; do
    printf '%q ' "$one" >> "$WHERE/$role.args"
done
printf '\n' >> "$WHERE/$role.args"

# One ExecStart per role that has arguments. A machine with both gets both, in a
# fixed order so that reading the unit tells somebody what will happen.
starts=""
for pair in "spoke viahk.sh" "hub viahk-hub.sh"; do
    set -- $pair
    [ -s "$WHERE/$1.args" ] || continue
    starts+="ExecStart=/bin/bash -c '$WHERE/$2 \$(cat $WHERE/$1.args)'"$'\n'
done

cat > "$UNIT" <<EOF
[Unit]
Description=Route traffic through the viahk mappings this machine was given
# After the network rather than merely wanting it: the rules name addresses, and
# a machine that applies them before it has a route applies them to nothing.
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# The rules live in the kernel rather than in this process, so there is nothing
# to keep running and nothing to supervise. RemainAfterExit is what makes the
# unit read as active afterwards rather than as a job that finished.
RemainAfterExit=yes
${starts}ExecStop=$WHERE/viahk.sh off
ExecStop=$WHERE/viahk-hub.sh off

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable viahk.service >/dev/null 2>&1

# Restarted rather than started, so that installing the second role applies both
# and a machine is never left with the unit describing more than it has done.
systemctl restart viahk.service

echo
systemctl --no-pager --lines=0 status viahk.service | head -3
echo
echo "replayed at every boot, from $WHERE:"
for one in spoke hub; do
    [ -s "$WHERE/$one.args" ] && printf '  %-6s %s\n' "$one" "$(cat "$WHERE/$one.args" | tr -d '\n')"
done

# A successful install exits zero.
#
# Without this it did not: the loop above ends on a test, and a machine with
# only one role installed ends on the test for the other, which fails. So the
# script printed everything it was supposed to and then exited non-zero, and
# the second half of `install.sh spoke ... && install.sh hub ...` never ran.
# The machine was left with one role, its unit describing one role, and a
# summary on screen saying so — which reads exactly like having typed one
# command.
exit 0
