package admin

// installTemplate is the script a new relay runs.
//
// Written for /bin/sh, because a machine minutes into its life may have nothing
// else, and with every step visible because anybody about to run this as root
// should be able to read all of it.
//
// Held as a template rather than served from a file so that a relay's install
// cannot be broken by a file that failed to deploy alongside the binary — which
// is the one failure this whole path exists to remove.
//
// The %% sequences are printf escapes: this string is filled in by Fprintf with
// the deployment's own values, and everything the shell should see as a literal
// percent is doubled.
const installTemplate = `#!/bin/sh
# Add this machine to the meeting deployment as a relay.
#
# One command on a fresh machine, and this does the five things that otherwise
# have to agree by hand: fetch the binary, claim the deployment's credentials
# and certificate, write the configuration, point a DNS name at this machine,
# and start the service.
#
#     bash <(curl -fLSs https://example/install) <prefix> <secret>
#
# The prefix may be left off, in which case it is asked for.
#
# The copy downloaded from the management pages carries the enrolment secret, and
# anybody holding that copy can add a relay to this deployment — treat it as the
# credential it is. The copy served at the public address carries none, and reads
# the secret from ENROL instead.
set -eu

CONTROL="%s"
DOMAIN="%s"

# Both of the things this needs, in the order somebody would type them:
#
#     bash <(curl -fLSs $CONTROL/install) <prefix> <secret>
#
# Process substitution rather than a pipe, and that is not a style choice. A
# script read from a pipe has the download on its standard input, so the prompt
# below reads the rest of itself and the whole thing goes wrong in a way that
# looks like the prompt was skipped. This way stdin is still the terminal, which
# is what makes the interactive form work at all.
#
# The secret falls back to what was built in. The copy downloaded from the
# management pages has it, because those are behind a session; the copy served
# at the public address does not, so it travels in the operator's own command
# and nothing that logs a URL ever sees it.
PREFIX="${1:-${PREFIX:-}}"
SECRET="${2:-${ENROL:-%s}}"
LISTEN_PORT=%d
UDP_PORT=%d
TCP_PORT=%d
PROBE_PORT=%d

# Whether this machine answers anything but a WebSocket upgrade.
#
# Set for a relay on a network that decides what a machine is by asking it: a
# mainland Chinese host is probed with an ordinary HTTPS request, and any answer
# at all identifies the port as a website, which an unregistered domain may not
# be. Off elsewhere, where a machine that answers is a machine that can be
# diagnosed.
#
# Passed as an environment variable rather than asked for, so the ordinary
# install stays one line:  SILENT=1 sh install.sh <prefix>
SILENT="${SILENT:-}"

say() { printf '\n\033[1m%%s\033[0m\n' "$1"; }
die() { printf '\nerror: %%s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root"
command -v curl >/dev/null 2>&1 || die "curl is needed and is not installed"
[ -n "$SECRET" ] || die "this needs the deployment's enrolment secret as its second argument; the management pages print the whole command"

# The prefix names this relay: in the zone above, and on the management pages.
#
# Checked against the deployment before anything else happens. A prefix already
# in use, typed by mistake, would move an existing relay's name to this machine
# while the relay it belonged to went on holding calls at an address that no
# longer reached it — and nothing anywhere would say so.
replace=false

ask_prefix() {
    while :; do
        if [ -n "${PREFIX:-}" ]; then
            prefix="$PREFIX"
        else
            printf 'Prefix for this relay (it becomes <prefix>.%%s): ' "$DOMAIN"
            read -r prefix </dev/tty
        fi

        prefix=$(printf '%%s' "$prefix" | tr 'A-Z' 'a-z' | tr -d '[:space:]')

        if [ -z "$prefix" ]; then
            printf '  a prefix is needed
'
            unset PREFIX
            continue
        fi

        # Lowercase letters, digits and dashes, not starting or ending in one.
        if ! printf '%%s' "$prefix" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
            printf '  %%s cannot be a name: use lowercase letters, digits and dashes
' "$prefix"
            unset PREFIX
            continue
        fi

        answer=$(curl -fsS --max-time 15 -X POST "$CONTROL/api/enrol/taken"             -H 'Content-Type: application/json'             -d "{\"secret\":\"$SECRET\",\"prefix\":\"$prefix\"}" 2>/dev/null || true)

        # An unquoted body made this JSON the shell had already eaten, so the
        # check answered nothing every time and every duplicate reached the
        # control node as a 409 with advice to try another name. The quoting is
        # fixed; the point of the check is that a prefix already in use would
        # otherwise move an existing relay's name onto this machine.
        case "$answer" in
            *'"taken":true'*)
                printf '
  %%s.%%s is already in use by another relay.
' "$prefix" "$DOMAIN"

                if [ -n "${REPLACE:-}" ]; then
                    printf '  REPLACE is set, so this machine will take it over.

'
                    replace=true
                    return
                fi

                printf '  Type another prefix, or "replace" to take it over
'
                printf '  (only do that if this machine is a rebuild of that one).
'
                printf '  Replace %%s? [y/N] ' "$prefix"
                read -r confirm </dev/tty

                case "$confirm" in
                    y|Y|yes|YES)
                        replace=true
                        return
                        ;;
                esac

                unset PREFIX
                continue
                ;;
            *'"taken":false'*)
                return
                ;;
            *)
                # The control node could not be asked. Carrying on rather than
                # stopping: the enrolment below refuses a taken prefix anyway,
                # and this check exists to ask nicely rather than to be the
                # thing that enforces it.
                printf '  (could not check whether %%s is free; carrying on)
' "$prefix"
                return
                ;;
        esac
    done
}

ask_prefix
region="${REGION:-}"

# The address browsers will reach this machine on. Asked of the outside rather
# than read from an interface: the machines that make good relays are frequently
# behind NAT, and the interface address is not the one to publish.
#
# Not fatal when it cannot be worked out. Several of the networks worth putting
# a relay on cannot reach a public echo service at all — which is a property of
# where the machine is rather than a problem with the machine — and the control
# node is about to see this connection's source address anyway. Empty means "you
# tell me", and it is right more often than a guess from an interface would be.
say "Working out this machine's address"

# Asked over DNS first, and never through a proxy.
#
# A machine whose outbound 443 is blocked — which every mainland host this has
# been run on so far has been — needs a proxy to reach the control node at all.
# An address echoer asked through that proxy answers with the proxy's address,
# and the relay is then enrolled under somebody else's IP with a DNS name
# pointed at a machine that is not it. It looks like a working install right up
# until the first call. Letting the control node use the address it sees does
# not help either: what it sees is also the proxy.
#
# DNS is the way out. Port 53 is open on every one of these hosts even where 80
# and 443 are not, the query is UDP and so cannot be carried by an HTTP proxy at
# all, and the answer is this machine's own address by construction.
address="${ADDRESS:-}"

if [ -z "$address" ]; then
    for resolver in resolver1.opendns.com resolver2.opendns.com; do
        # Filtered to something that is only an address, and strictly.
        #
        # dig prints its troubles on standard output alongside the answer — a
        # resolver that timed out over IPv6 contributes a line of prose — and a
        # previous version stripped whitespace from the lot and posted the
        # result as this machine's address. The control node refused it, which
        # is the good outcome; the bad one was available.
        if command -v dig >/dev/null 2>&1; then
            address=$(dig -4 +short +time=3 +tries=1 myip.opendns.com "@$resolver" 2>/dev/null \
                | grep -Eo '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' | head -n 1)
        elif command -v nslookup >/dev/null 2>&1; then
            address=$(nslookup myip.opendns.com "$resolver" 2>/dev/null \
                | awk '/^Address: /{print $2}' \
                | grep -Eo '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' | tail -n 1)
        fi

        [ -n "$address" ] && break
    done
fi

# And only then over HTTP, with the proxy refused for the reason above.
if [ -z "$address" ]; then
    for echoer in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
        address=$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
            curl -fsS --noproxy '*' --max-time 6 "$echoer" 2>/dev/null \
            | grep -Eo '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' | head -n 1 || true)

        [ -n "$address" ] && break
    done
fi

if [ -n "$address" ]; then
    printf '  %%s\n' "$address"
else
    printf '  could not ask the outside; the control node will use the address it sees\n'
fi

say "Claiming this deployment's configuration"
package=$(curl -fsS --max-time 30 -X POST "$CONTROL/api/enrol" \
    -H 'Content-Type: application/json' \
    -d "{\"secret\":\"$SECRET\",\"prefix\":\"$prefix\",\"region\":\"$region\",\"address\":\"$address\",\"replace\":$replace}") \
    || die "the control node refused this machine. If it said the prefix is in use, run this again and pick another"

# Read with sed rather than a JSON parser, because a machine this new may have
# neither python nor jq, and installing one to read six fields is a dependency
# for the sake of elegance.
value() { printf '%%s' "$package" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

host=$(value host)
[ -n "$host" ] || die "the control node's answer could not be read: $package"

api_key=$(value apiKey)
api_secret=$(value apiSecret)
redis_addr=$(value redisAddr)
redis_pass=$(value redisPassword)
named=$(printf '%%s' "$package" | sed -n 's/.*"named":\([a-z]*\).*/\1/p')
node=$(value node)

# Where every relay is, rendered by the control node. Without it the media
# server here falls back to choosing a node at random, and somebody joining
# through this machine can be put into a room held on one they cannot reach.
selector=$(printf '%%s' "$package" | sed -n 's/.*"selector":"\([^"]*\)".*/\1/p' | sed 's/\\n/\
/g')

printf '  name  %%s\n  host  %%s\n' "$prefix" "$host"

say "Fetching the binary"
curl -fsS --max-time 600 -o /usr/local/bin/tomoshibi.new "$CONTROL/download/tomoshibi" \
    || die "could not fetch the binary"
chmod +x /usr/local/bin/tomoshibi.new
mv /usr/local/bin/tomoshibi.new /usr/local/bin/tomoshibi

say "Writing the certificate"
mkdir -p /etc/tomoshibi/certs

# The PEM arrives with its newlines escaped, as JSON requires. Turned back with
# sed rather than printf %%b, which would also interpret anything else that
# looks like an escape inside a certificate.
printf '%%s' "$package" | sed -n 's/.*"cert":"\(.*\)","key".*/\1/p' | sed 's/\\n/\
/g' > /etc/tomoshibi/certs/relay.fullchain.pem

printf '%%s' "$package" | sed -n 's/.*"key":"\(.*\)","listenPort".*/\1/p' | sed 's/\\n/\
/g' > /etc/tomoshibi/certs/relay.key

[ -s /etc/tomoshibi/certs/relay.fullchain.pem ] || die "the certificate came back empty"
[ -s /etc/tomoshibi/certs/relay.key ] || die "the certificate key came back empty"
grep -q 'BEGIN CERTIFICATE' /etc/tomoshibi/certs/relay.fullchain.pem || die "what came back is not a certificate"

# The key stays readable by one group rather than by everybody. The service runs
# under a dynamic user, put in that group for the length of its run.
groupadd -f tomoshibi-certs 2>/dev/null || true
chgrp tomoshibi-certs /etc/tomoshibi/certs/relay.key /etc/tomoshibi/certs/relay.fullchain.pem 2>/dev/null || true
chmod 640 /etc/tomoshibi/certs/relay.key
chmod 644 /etc/tomoshibi/certs/relay.fullchain.pem

# The interface carrying traffic outward. Named so the media server does not
# offer docker bridges to browsers as places to send media — clients try them,
# wait, and fall back, paying a connection delay for addresses that could never
# work.
iface=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)

say "Writing the configuration"
{
    printf 'port: 7880\n'
    printf 'bind_addresses: ["127.0.0.1"]\n\n'
    printf 'rtc:\n'
    printf '  udp_port: %%s\n' "$UDP_PORT"
    printf '  tcp_port: %%s\n' "$TCP_PORT"
    printf '  # Decides the address advertised to clients. False hands out one only\n'
    printf '  # this machine can reach, and calls fail after appearing to connect.\n'
    printf '  use_external_ip: true\n'
    # How the media server decides what each viewer is sent, and how far back
    # it can resend. Both are measured rather than guessed, and RELAY.md has the
    # numbers. Left at the defaults, a viewer whose line could not carry a
    # full-size screen share was sent all of it anyway and froze for the whole
    # test, while the receive-side estimate the media server relies on by
    # default swung between almost nothing and an assumed 100 Mb/s. The
    # sender-side estimate let the same viewer settle on the 1080p layer. And
    # 500 packets of history is a tenth of a second of a 1440p share, shorter
    # than the round trip a resend needs from a sharer behind a tunnel; 4000 is
    # most of a second.
    #
    # Neither asks a sharer to send less. They choose which of the layers a
    # sharer already sends each viewer receives, and keep packets for longer.
    printf '  # Sender-side estimate and a longer resend window; RELAY.md says why.\n'
    printf '  packet_buffer_size_video: 4000\n'
    printf '  congestion_control:\n'
    printf '    enabled: true\n'
    printf '    use_send_side_bwe: true\n'
    if [ -n "$iface" ]; then
        printf '  interfaces:\n    includes: ["%%s"]\n' "$iface"
    fi
    printf '\nkeys:\n  %%s: %%s\n' "$api_key" "$api_secret"
    printf '\nredis:\n  address: "%%s"\n' "$redis_addr"
    [ -n "$redis_pass" ] && printf '  password: "%%s"\n' "$redis_pass"
    printf '\nlogging:\n  level: info\n'
    # What this machine calls the place it is in, and where the others are.
    # Both or neither: a region with no list is not compared against anything,
    # and a list not naming this machine's own region stops it starting.
    if [ -n "$node" ] && [ -n "$selector" ]; then
        printf '\nregion: %%s\n' "$node"
        printf '%%s\n' "$selector"
    fi
    printf '\nmeet:\n  role: relay\n'
    printf '  listen: ":%%s"\n' "$LISTEN_PORT"
    printf '  tls_cert: /etc/tomoshibi/certs/relay.fullchain.pem\n'
    printf '  tls_key: /etc/tomoshibi/certs/relay.key\n'
    # Where this machine answers STUN, so a browser can time one round trip over
    # the transport a call uses rather than three over the signalling socket.
    # Nothing written where the deployment has not chosen a port, rather than a
    # zero for somebody to puzzle over.
    [ "${PROBE_PORT:-0}" -gt 0 ] 2>/dev/null && printf '  probe_port: %%s\n' "$PROBE_PORT"
    [ -n "$SILENT" ] && printf '  silent: true\n'
    # Both of the above are conditional, so the block can end on a test that
    # failed. Under set -e the left side of an && is exempt and this is not
    # needed on the shell it was tried on, but shells differ on whether that
    # exemption reaches the group's own status, and the cost of being sure is
    # one character.
    :
} > /etc/tomoshibi/relay.yaml

# Readable by the group the service runs in, and by nobody else. The file holds
# the deployment's API secret and the redis password, so it is not world
# readable — and it is not 600 either, because the service runs under a dynamic
# user that is not root and would be refused its own configuration.
chgrp tomoshibi-certs /etc/tomoshibi/relay.yaml 2>/dev/null || true
chmod 640 /etc/tomoshibi/relay.yaml

say "Installing the service"
cat > /etc/systemd/system/tomoshibi-relay.service <<'UNIT'
[Unit]
Description=Tomoshibi relay (media only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/tomoshibi serve /etc/tomoshibi/relay.yaml
Restart=always
RestartSec=3
DynamicUser=yes
StateDirectory=tomoshibi
SupplementaryGroups=tomoshibi-certs
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now tomoshibi-relay

sleep 5
if ! systemctl is-active --quiet tomoshibi-relay; then
    printf '\n'
    journalctl -u tomoshibi-relay -n 20 --no-pager || true
    die "the relay did not start; the log above says why"
fi

say "Done"
printf '  name     %%s\n' "$prefix"
printf '  address  wss://%%s:%%s\n' "$host" "$LISTEN_PORT"
printf '  media    udp %%s, tcp %%s\n' "$UDP_PORT" "$TCP_PORT"

if [ "$named" = "true" ]; then
    printf '  dns      %%s -> %%s\n' "$host" "$address"
else
    printf '\n  The DNS record was not created. Point %%s at %%s before this relay can be used.\n' "$host" "$address"
fi

printf '\nIf this machine has a firewall or a cloud security group in front of it,\n'
printf 'open these:\n'
printf '  tcp %%s   signalling and the health endpoint\n' "$LISTEN_PORT"
printf '  udp %%s   media\n' "$UDP_PORT"
printf '  tcp %%s   media, for networks that drop udp\n\n' "$TCP_PORT"
`
