#!/usr/bin/env python3
"""Take a line of text on the private network and put it in front of a person.

Runs on the Hermes machine, which is where the bot already lives, and speaks as
that bot to the channel it already uses. The control node does not get a copy of
the token: it posts text here and this posts to Telegram, so the token stays on
the one machine that had it, and a control node somebody takes is one that can
send messages rather than one that hands over the ability to speak as the bot.

Reads Hermes's own .env. An earlier version of this read a different project's
alert file that happened to sit on the same machine, which would have made this
deployment's alerts depend on a credential belonging to something else — and
put them in front of whoever that project had decided to tell.

Bound to the private address only. The two machines share 192.0.2.0/24 and
nothing else reaches it; a listener on the public address would be an
unauthenticated way to make the bot say anything.

The recipient comes from Hermes's configuration and never from the request. An
alert carries what is wrong and where to look at it, so being able to name its
own destination would make it a way to have the bot say anything to anybody.
"""

import http.server
import json
import os
import socketserver
import sys
import urllib.parse
import urllib.request

LISTEN = os.environ.get("LISTEN", "192.0.2.11")
PORT = int(os.environ.get("PORT", "49771"))

# Hermes's own configuration: its bot, and the channel it already talks in.
ENV = os.environ.get("ENV_FILE", "/root/.hermes/.env")

# Taken from the same file rather than written here, so that moving Hermes's
# channel moves these too. Never taken from the request: an alert says what is
# wrong and how to look at it, and it must not become sendable elsewhere by
# anything a caller says.
CHAT_ID = os.environ.get("CHAT_ID", "")
THREAD_ID = os.environ.get("THREAD_ID", "")

# A shared word, so that something else on the private network cannot make the
# bot speak by accident. Not a secret worth much — anything on this subnet is
# already inside — but it keeps a stray probe from becoming a message.
WORD = os.environ.get("WORD", "")


def setting(name: str) -> str:
    try:
        with open(ENV, encoding="utf-8") as file:
            for line in file:
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except OSError as err:
        print(f"cannot read {ENV}: {err}", file=sys.stderr)

    return ""


def where() -> tuple[str, str]:
    """The channel to talk in, and the thread within it if there is one."""
    return (
        CHAT_ID or setting("TELEGRAM_HOME_CHANNEL"),
        THREAD_ID or setting("TELEGRAM_HOME_CHANNEL_THREAD_ID"),
    )


def send(text: str) -> bool:
    held = setting("TELEGRAM_BOT_TOKEN")
    chat, thread = where()

    if not held or not chat:
        return False

    asked = {"chat_id": chat, "parse_mode": "HTML", "text": text[:4000]}
    if thread:
        asked["message_thread_id"] = thread

    body = urllib.parse.urlencode(asked).encode()

    try:
        with urllib.request.urlopen(
            f"https://api.telegram.org/bot{held}/sendMessage", data=body, timeout=20
        ) as answer:
            return answer.status == 200
    except Exception as err:  # noqa: BLE001 — any failure here is one failure to send
        print(f"telegram: {err}", file=sys.stderr)
        return False


class Handler(http.server.BaseHTTPRequestHandler):
    # The default logs every request to stderr with a timestamp of its own,
    # which in a unit means two timestamps per line.
    def log_message(self, *_args):
        return

    def do_POST(self):  # noqa: N802 — the base class names it
        if self.path != "/say":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > 8192:
            self.send_error(413)
            return

        raw = self.rfile.read(length)

        try:
            asked = json.loads(raw)
        except ValueError:
            self.send_error(400)
            return

        if WORD and asked.get("word") != WORD:
            self.send_error(403)
            return

        text = str(asked.get("text") or "").strip()
        if not text:
            self.send_error(400)
            return

        sent = send(text)

        self.send_response(200 if sent else 502)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"sent": sent}).encode())


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print(f"listening on {LISTEN}:{PORT}", flush=True)

    with Server((LISTEN, PORT), Handler) as httpd:
        httpd.serve_forever()
