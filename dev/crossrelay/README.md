# Two people, two relays, one room

What this answers: when somebody dials relay A and the room is held on relay B,
where does their media actually go?

Run against the live fleet, because the answer is about real networks and
localhost has none.

```
# A token per person. The key and secret are the deployment's own.
go build -o /tmp/mint ./dev/crossrelay
/tmp/mint "$KEY" "$SECRET" myroom alice > /tmp/a.txt
/tmp/mint "$KEY" "$SECRET" myroom bob   > /tmp/b.txt

# The page needs livekit-client beside it.
cp web/node_modules/livekit-client/dist/livekit-client.esm.mjs dev/crossrelay/
(cd dev/crossrelay && python3 -m http.server 8877 &)

# One browser per relay.
chrome --headless=new --remote-debugging-port=9341 --user-data-dir=$(mktemp -d) \
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  "http://127.0.0.1:8877/page.html?url=wss%3A%2F%2Fhk.example%3A39217&token=$(cat /tmp/a.txt)"
```

Then read `window.__room.serverInfo` and the peer connection's remote candidate
in each browser.

## What it found, and the thing to be careful about

Both people got into the room and exchanged media — frames decoded at both ends,
three simulcast layers going out. But the one who dialled Guangzhou had
`serverInfo.region` of `hk-gomami` and a remote candidate of the Hong Kong
relay: their media crossed the border, to the machine holding the room, and the
relay they picked carried none of it.

That is correct for what this page does and is **not** how the product behaves.
This mints a LiveKit token directly and connects to a relay, which skips the
join endpoint — and the join endpoint is the entire mechanism that keeps
somebody on the relay they chose. It reads the room's holder, mints TURN
credentials on the relay the person dialled, and hands those back so their media
enters through it and is forwarded on.

So this measures the floor rather than the product: what happens with the
forwarding layer absent. Useful for exactly that — it shows the layer is
load-bearing rather than decorative — and misleading if read as the product
being broken.

The forwarding layer itself is covered by unit tests in
`internal/app/forward_test.go`, which were checked by removing the layer and
watching three of them fail, and by making `pairable` always true and watching
the rule that keeps two named relays apart fail in both directions.
