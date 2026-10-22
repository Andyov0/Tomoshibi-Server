# Sending a mainland relay's overseas traffic through Hong Kong

## The problem

Somebody in mainland China joins a meeting held on a relay abroad. What should
happen is that their media enters the country they are in — on Guangzhou or
Shanghai — and crosses the border once, on a link that is paid for and watched.

What happens instead is that they are moved to Hong Kong and connect to it
directly from their browser, because the pair Guangzhou–Singapore is written
down as one that does not carry. Measured from Guangzhou, on the relays' own
probe port, eight packets each:

| path             | direct        | via Hong Kong |
| ---------------- | ------------- | ------------- |
| Guangzhou → HK   | 11–14 ms      | —             |
| Guangzhou → SG   | 339–356 ms    | ~45 ms        |
| Guangzhou → JP   | 117–231 ms, 1 lost | ~60 ms   |
| Guangzhou → LAX  | 158–165 ms    | ~156 ms       |

So the rule is right — the direct pairs are bad — and the remedy of moving
people to Hong Kong is not the only one available.

## Measured, both ways

Set up between Guangzhou and Hong Kong for one destination and taken down again.
The application was not told anything and did not change: it went on addressing
Singapore, and the kernel sent the packets to Hong Kong.

| from Guangzhou, to Singapore's probe port | median |
| ----------------------------------------- | ------ |
| direct                                     | 346 ms |
| through Hong Kong                          | 45 ms  |
| direct again, after taking it down         | 343 ms |

A relay with no rule for it — Tokyo — stayed at 118 ms throughout, which is what
says the change was the rule rather than the day.

## Why this is routing rather than a feature

A TURN client makes one allocation. The browser allocates on Guangzhou, the
media server sends to that allocation, and the packets go Guangzhou to Singapore
by whatever route Guangzhou has. There is no field in which to say "and pass
through Hong Kong on the way": the protocol has one hop of relaying and this
deployment already uses it.

But which route Guangzhou takes is Guangzhou's own business. Give it a tunnel to
Hong Kong and a route for the overseas relays' addresses through that tunnel,
and the path is browser → Guangzhou → Hong Kong → Singapore while the client
still sees one hop. Nothing above the kernel changes.

## What this costs, and what it does not

It moves traffic that is already crossing the border onto a link that is 14 ms
away and does not drop packets, instead of one that is 340 ms away. It does not
add a hop that was not there — the packets were already going to Singapore, by a
worse road.

It does add a dependency: the Hong Kong machine now carries every mainland
participant's media for overseas meetings, in both directions, and its bill and
its uptime become the bill and uptime of that path. That is a decision about a
machine rather than about a protocol.

## The path that only goes one way

Hong Kong Gomami and Shanghai Telecom were written down as a pair that does not
carry, and they are — but only in one direction. Shanghai Telecom reaches Hong
Kong in 44 ms and answers every packet; Hong Kong reaches Shanghai Telecom not
at all, zero of eight on every port tried.

The same trick fixes it, pointed the other way. Shanghai Tencent reaches
Shanghai Telecom in 6 ms, so Hong Kong sends what it has for Shanghai Telecom
through Shanghai Tencent, and the path that answered nothing now answers ten of
ten at 36 ms.

Worth noticing that this is a hub in the other direction: the mainland relays
send their overseas traffic through Hong Kong, and Hong Kong sends its Shanghai
Telecom traffic through Shanghai Tencent. Nothing about the scripts assumes
which side is which.

## Measuring it honestly

The first reading said Los Angeles gained nothing, and that reading was taken at
four in the morning. The paths this fleet crosses are congested on somebody
else's schedule, and the hour that decides whether a detour is worth having is
the hour it was not measured in.

`compare.py` measures both at once instead. Port 39218 has a rule and port 39219
does not, so on the same relay in the same minute one reading goes through Hong
Kong and the other goes the way it always did — the same weather for both.
A before-and-after separated by a day compares two afternoons and calls the
difference a result.

Running on Guangzhou as `viahk-compare`. At midday: Singapore 7.9x, Tokyo 1.9x
and the direct path already dropping a packet in six, Los Angeles 1.0x. Whether
Los Angeles stays at 1.0x through an evening is the question it is there to
answer.

## A hop that only works for traffic the machine made itself

Hong Kong reaches Shanghai Telecom through Shanghai Tencent, and that was set up
with the spoke script — which puts its rule in the `output` chain, where packets
this machine originated can still have their destination changed.

Forwarded packets never reach `output`. They go prerouting, forward,
postrouting. So the moment the overseas relays were pointed at Hong Kong for
their Shanghai Telecom traffic, every one of those packets was forwarded
straight at Shanghai Telecom by the route Hong Kong has, which is the route that
answers nothing — and three relays that had been reaching it at 348 ms went to
answering not at all.

The fix is in the mapping rather than in the chain: a packet arriving at Hong
Kong for Shanghai Telecom is sent on to Shanghai Tencent's port for it, not to
Shanghai Telecom. Two hops expressed as two mappings, which is what the hub is
for. Worth knowing before adding a third hop anywhere: `output` is for what a
machine says, `prerouting` is for what it passes on, and a rule in the wrong one
of those is invisible until something is forwarded.

## Applying it

Two scripts, one per end, one destination at a time.

    # On the Hong Kong machine, once per overseas relay:
    viahk-hub.sh 39501 198.51.100.31 39218

    # On each mainland relay, the same pairing from the other side:
    viahk.sh 198.51.100.10 198.51.100.31 39218 39501

Both are idempotent and both take `off`. There is no tunnel and nothing is
installed: nftables rewrites the destination on the way out and the source on
the way back, so what leaves a mainland machine is ordinary UDP to another of
ours on a port we chose. A tunnel would have been tidier and would also have
been a protocol with a handshake somebody can fingerprint, which on a machine
rented in mainland China is a reason not to have one.

Verify with `dev/udpcheck` from the mainland relay before and after: the numbers
in the table above are what a working setup looks like.

## Reading the record

`compare.py` runs on Guangzhou as `viahk-compare`, every two minutes, writing to
the journal and to `/var/log/viahk-compare.log`. The file as well as the journal
because the journal on these machines is already gigabytes and rotates on a
schedule of its own; a record that disappears before it is read is not a record.

`report.py` folds it by hour, which is the whole point — the question is not what
the average is but which hours the detour earns its keep in, and an average over
a day hides exactly that. A path no better for twenty hours and twice as good
for four is worth having, and its mean says 1.2x.

Loss is printed beside the milliseconds rather than folded into them. A path
answering five of six is not a slower path; it is a call that stutters, and the
two want different decisions.
