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
#     bash <(curl -fLSs https://example/install) <prefix>
#
# It then asks for the enrolment token, which the relays page mints for this
# one prefix: it works once, for half an hour. The prefix may be left off, in
# which case it is asked for too.
#
# Nothing in this script is a secret, and that is the point of it being public.
set -eu

# Everything written from here on is readable by root alone until it is
# deliberately opened up. The certificate's key and the configuration holding
# the deployment's credentials were written under the default mask and then
# narrowed, which left both readable by every user on the machine for the
# moments in between -- on a first install, whenever those moments happened to
# include somebody looking.
umask 077

CONTROL="%s"
# The zone relays are named in is not written here. This script is served to
# anybody, and the domain is the one thing in it that ties every relay's name to
# this deployment; the machine learns its full name from the control node once
# its token has been accepted.

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
# The token is not one of them. It used to be the second argument, which put it
# in the shell's history on every relay ever brought up and in the process list
# for as long as the install ran -- and it was a secret that never expired.
PREFIX="${1:-${PREFIX:-}}"
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

# Refused rather than read, so that nobody's history gains a token because an
# old command said to type it there.
[ -z "${2:-}" ] || die "the enrolment token is no longer an argument: run the command without it and paste the token when asked"

# Somewhere for the control node's answers that is not a shell variable printed
# on the way out. Removed however this ends.
# And the terminal's echo given back, in case this was interrupted at the
# prompt that turns it off.
work=$(mktemp -d)
trap 'stty echo </dev/tty 2>/dev/null || true; rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

# The token: from ENROL if somebody set it, from standard input when that is
# not a terminal (bash <(...) <prefix> < token-file), and otherwise asked for on
# the terminal with the echo off.
SECRET="${ENROL:-}"
if [ -z "$SECRET" ]; then
    if [ ! -t 0 ]; then
        IFS= read -r SECRET || true
    elif [ -r /dev/tty ]; then
        printf 'Enrolment token (from the relays page; it is not shown as you type): ' >/dev/tty
        stty -echo </dev/tty 2>/dev/null || true
        IFS= read -r SECRET </dev/tty || true
        stty echo </dev/tty 2>/dev/null || true
        printf '\n' >/dev/tty
    fi
fi
SECRET=$(printf '%%s' "$SECRET" | tr -d '[:space:]')
[ -n "$SECRET" ] || die "this needs an enrolment token: mint one for this prefix on the relays page"

# Whatever the shell, the body goes to curl on its standard input rather than
# as an argument, which is how a token stays out of the process list: printf is
# built into every shell this runs under, so the only command line holding the
# token is the shell's own memory.
#
# Answers the HTTP status, 000 where nothing answered, and never fails: under
# set -e an assignment from a command that fails ends the script on the spot.
ask() {
    rm -f "$work/answer"
    printf '%%s' "$2" | curl -sS --max-time 30 -o "$work/answer" -w '%%{http_code}' \
        -X POST "$CONTROL$1" -H 'Content-Type: application/json' --data-binary @- 2>/dev/null \
        || true
}

# Only the reason the control node gave, never its whole answer. An answer
# printed in full is a terminal's scrollback holding the deployment's
# credentials, and the code is all anybody needs to act on.
reason() { sed -n 's/.*"error":"\([a-z_]*\)".*/\1/p' "$work/answer" 2>/dev/null; }

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
            printf 'Prefix for this relay: '
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

        code=$(ask /api/enrol/taken "{\"secret\":\"$SECRET\",\"prefix\":\"$prefix\"}")

        # An unquoted body made this JSON the shell had already eaten, so the
        # check answered nothing every time and every duplicate reached the
        # control node as a 409 with advice to try another name. The quoting is
        # fixed; the point of the check is that a prefix already in use would
        # otherwise move an existing relay's name onto this machine.
        #
        # Whether this machine may take it over is no longer asked here. The
        # administrator who minted the token decided that on the relays page,
        # because the machine asking is the one party whose word on a takeover
        # is worth nothing.
        case "$code:$(cat "$work/answer" 2>/dev/null)" in
            200:*'"replace":true'*)
                printf '\n  %%s is in use, and this token was minted to take it over.\n\n' "$prefix"
                replace=true
                return
                ;;
            200:*'"taken":true'*)
                die "$prefix is already in use by another relay, and this token does not take it over. Mint one that does, on the relays page, if this machine is a rebuild of that one"
                ;;
            200:*'"taken":false'*)
                return
                ;;
            403:*)
                case "$(reason)" in
                    wrong_prefix) die "this token was minted for another prefix" ;;
                    *) die "the control node did not accept the token: it may have been used, withdrawn, or have expired" ;;
                esac
                ;;
            *)
                # The control node could not be asked. Carrying on rather than
                # stopping: the enrolment below refuses a taken prefix anyway,
                # and this check exists to ask nicely rather than to be the
                # thing that enforces it.
                printf '  (could not check whether %%s is free; carrying on)\n' "$prefix"
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
code=$(ask /api/enrol "{\"secret\":\"$SECRET\",\"prefix\":\"$prefix\",\"region\":\"$region\",\"address\":\"$address\",\"replace\":$replace}")

case "$code" in
    200) ;;
    000|'') die "the control node could not be reached" ;;
    *)
        case "$(reason)" in
            relay_exists) die "$prefix is already in use, and this token does not take it over" ;;
            wrong_secret) die "the control node did not accept the token: it may have been used, withdrawn, or have expired" ;;
            wrong_prefix) die "this token was minted for another prefix" ;;
            wrong_source) die "this token was minted for a machine at another address" ;;
            bad_address) die "the control node will not point a name at $address: it is not a public IPv4 address. Set ADDRESS to this machine's public address" ;;
            too_many_attempts) die "too many attempts from here; wait a minute and run this again" ;;
            *) die "the control node refused this machine ($code $(reason))" ;;
        esac
        ;;
esac

package=$(cat "$work/answer")
rm -f "$work/answer"

# Read with sed rather than a JSON parser, because a machine this new may have
# neither python nor jq, and installing one to read six fields is a dependency
# for the sake of elegance.
value() { printf '%%s' "$package" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

host=$(value host)
[ -n "$host" ] || die "the control node's answer could not be read"

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
want=$(value binarySha256)
[ -n "$want" ] || die "the control node did not say what the binary should hash to, so it cannot be checked"

curl -fsS --max-time 600 -o /usr/local/bin/tomoshibi.new "$CONTROL/download/tomoshibi" \
    || die "could not fetch the binary"

# Checked before it is made executable, against what the control node said it
# is serving. Whatever answered the download -- a proxy that cached an older
# build, a transfer cut short -- used to be installed as a service and run.
if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum /usr/local/bin/tomoshibi.new | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 /usr/local/bin/tomoshibi.new | cut -d' ' -f1)
elif command -v openssl >/dev/null 2>&1; then
    got=$(openssl dgst -sha256 /usr/local/bin/tomoshibi.new | sed 's/.*= *//')
else
    rm -f /usr/local/bin/tomoshibi.new
    die "nothing here can check the binary (sha256sum, shasum or openssl)"
fi

if [ "$got" != "$want" ]; then
    rm -f /usr/local/bin/tomoshibi.new
    die "the binary downloaded is not the one the control node is serving (sha256 $got, expected $want)"
fi

chmod 755 /usr/local/bin/tomoshibi.new
mv /usr/local/bin/tomoshibi.new /usr/local/bin/tomoshibi

say "Writing the certificate"
# Both directories are walked by the service, which runs as a user made up at
# start and given the group below. Opened explicitly, because the mask above
# would otherwise make them root's alone and the relay could not reach its own
# certificate.
mkdir -p /etc/tomoshibi/certs
chmod 755 /etc/tomoshibi /etc/tomoshibi/certs

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

chmod 644 /etc/systemd/system/tomoshibi-relay.service

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
