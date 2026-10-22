#!/usr/bin/env python3
"""Direct against through Hong Kong, on the same machine at the same minute.

Written because a single reading said Los Angeles gained nothing from going
through Hong Kong, and that reading was taken at four in the morning. The paths
this fleet crosses are congested on somebody else's schedule, and the hour that
decides whether a detour is worth having is the hour it was not measured in.

The comparison is live rather than before-and-after. Two ports on the same
relay: one has a rule sending it through Hong Kong and one does not, so both
readings are taken through the same weather. A before-and-after separated by a
day compares two different afternoons and calls the difference a result.

Prints a line per round. Left running it is the record; the interesting column
is the ratio, and the interesting hour is whichever one it moves in.
"""

import os
import socket
import statistics
import sys
import time

# port 39218 has the rule and 39219 does not, so one goes through Hong Kong and
# the other goes the way it always did.
VIA, DIRECT = 39218, 39219

RELAYS = [
    ("SG", "198.51.100.31"),
    ("JP", "198.51.100.32"),
    ("LAX", "198.51.100.33"),
]


def ask(host, port, tries=6):
    """Median round trip, and how many came back."""
    got = []

    for _ in range(tries):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(2)

        packet = bytearray(20)
        packet[0:2] = b"\x00\x01"
        packet[4:8] = b"\x21\x12\xa4\x42"
        packet[8:20] = os.urandom(12)

        started = time.time()
        try:
            sock.sendto(bytes(packet), (host, port))
            reply, _ = sock.recvfrom(128)
            if len(reply) >= 20 and reply[1] == 1:
                got.append((time.time() - started) * 1000)
        except OSError:
            pass
        finally:
            sock.close()

        time.sleep(0.05)

    return (statistics.median(got) if got else None), len(got), tries


def main():
    every = int(sys.argv[1]) if len(sys.argv) > 1 else 300

    while True:
        parts = [time.strftime("%Y-%m-%dT%H:%M:%S%z")]

        for name, address in RELAYS:
            via, viaOk, n = ask(address, VIA)
            direct, directOk, _ = ask(address, DIRECT)

            if via is None or direct is None:
                parts.append(f"{name}=via:{viaOk}/{n} direct:{directOk}/{n}")
                continue

            parts.append(
                f"{name}={via:.0f}/{direct:.0f}ms"
                f"({direct / via:.1f}x {viaOk}/{n},{directOk}/{n})"
            )

        line = " ".join(parts)
        print(line, flush=True)

        # And to a file, because the journal on these machines is already
        # gigabytes and rotates on its own schedule. A record that disappears
        # before it is read is not a record.
        try:
            with open("/var/log/viahk-compare.log", "a") as kept:
                kept.write(line + "\n")
        except OSError:
            pass

        time.sleep(every)


if __name__ == "__main__":
    main()
