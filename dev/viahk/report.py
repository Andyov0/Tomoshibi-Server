#!/usr/bin/env python3
"""What the day said about going through Hong Kong.

Reads what compare.py wrote and folds it by hour, because the question is not
what the average is — it is which hours the detour earns its keep in, and an
average over a day hides exactly that. A path that is no better for twenty hours
and twice as good for four is worth having, and its mean says 1.2x.

Loss is reported beside the milliseconds and not folded into them. A path
answering five of six is not a slower path; it is a call that stutters, and the
two want different decisions.
"""

import collections
import re
import sys

# 2026-08-24T12:19:45+0800 SG=48/344ms(7.1x 6/6,5/6) JP=... LAX=...
ROW = re.compile(r"^(\d{4}-\d\d-\d\dT(\d\d):\d\d:\d\d\S*)\s+(.*)$")
ONE = re.compile(r"(\w+)=(\d+)/(\d+)ms\(([\d.]+)x (\d+)/(\d+),(\d+)/(\d+)\)")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/var/log/viahk-compare.log"

    byHour = collections.defaultdict(lambda: collections.defaultdict(list))

    for line in open(path):
        row = ROW.match(line.strip())
        if not row:
            continue

        hour = row.group(2)

        for name, via, direct, _, viaOk, viaN, directOk, directN in ONE.findall(row.group(3)):
            byHour[name][hour].append(
                (int(via), int(direct), int(viaOk) / int(viaN), int(directOk) / int(directN))
            )

    if not byHour:
        print("nothing recorded yet")
        return 1

    for name in ("SG", "JP", "LAX"):
        hours = byHour.get(name)
        if not hours:
            continue

        print(f"\n{name}")
        print(f"  {'hour':<6}{'via HK':>9}{'direct':>9}{'gain':>7}   loss via / direct   samples")

        for hour in sorted(hours):
            rows = hours[hour]
            via = sorted(r[0] for r in rows)[len(rows) // 2]
            direct = sorted(r[1] for r in rows)[len(rows) // 2]
            viaLoss = 100 * (1 - sum(r[2] for r in rows) / len(rows))
            directLoss = 100 * (1 - sum(r[3] for r in rows) / len(rows))

            mark = "  " if direct < via * 1.25 else " *"

            print(
                f"  {hour}:00{via:>8}ms{direct:>7}ms"
                f"{direct / via:>6.1f}x{mark}"
                f"{viaLoss:>8.0f}% /{directLoss:>5.0f}%"
                f"{len(rows):>10}"
            )

    print("\n* marks an hour where the detour was worth more than a quarter.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
