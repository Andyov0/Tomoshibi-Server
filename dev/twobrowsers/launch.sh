#!/bin/bash
# Headless browsers for driving a deployment, in a bundle that is not the
# person's own browser.
#
# Launching /Applications/Google Chrome.app headless registers with the same
# bundle as the Chrome the person uses. From then on the Dock icon activates
# the invisible test instance, and Chrome "will not open" until somebody
# finds the process. That happened twice. So this never touches that bundle:
# it uses Google Chrome for Testing — a separate app with its own identifier,
# which Playwright already keeps in its cache — and refuses to run otherwise.
#
#   dev/twobrowsers/launch.sh start 9361 9362   # one instance per port
#   dev/twobrowsers/launch.sh stop              # only what this started
#
# Every instance gets a fresh profile, fake devices, and a screen to share
# without a picker, which is what the scripts beside this file expect.
set -euo pipefail

PIDS=${TOMOSHIBI_BROWSER_PIDS:-/tmp/tomoshibi-browsers.pids}

browser() {
    if [ -n "${TOMOSHIBI_BROWSER:-}" ]; then
        echo "$TOMOSHIBI_BROWSER"
        return
    fi

    # The newest Chrome for Testing Playwright has fetched.
    local found
    found=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | sort -V | tail -1)

    if [ -z "$found" ]; then
        echo "no Google Chrome for Testing under ~/Library/Caches/ms-playwright; install one with: npx playwright install chromium" >&2
        exit 1
    fi

    echo "$found"
}

case "${1:-}" in
    start)
        shift
        BIN=$(browser)

        case "$BIN" in
            "/Applications/Google Chrome.app"*)
                echo "refusing to run the person's own Chrome headless" >&2
                exit 1
                ;;
        esac

        for port in "$@"; do
            profile=$(mktemp -d)
            "$BIN" --headless=new --remote-debugging-port="$port" --user-data-dir="$profile" \
                --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
                --auto-select-desktop-capture-source="Entire screen" --mute-audio \
                --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
            echo $! >> "$PIDS"
        done

        sleep 5

        for port in "$@"; do
            if curl -s --max-time 5 -o /dev/null "http://127.0.0.1:$port/json/version"; then
                echo "$port up"
            else
                echo "$port did not answer" >&2
            fi
        done
        ;;

    stop)
        # By PID, never by name: pkill -f matches its own command line, and a
        # name would match the person's browser.
        if [ -f "$PIDS" ]; then
            while read -r pid; do
                kill -9 "$pid" 2>/dev/null || true
            done < "$PIDS"
            rm -f "$PIDS"
        fi

        echo "stopped"
        ;;

    *)
        echo "usage: $0 start <port>... | stop" >&2
        exit 2
        ;;
esac
