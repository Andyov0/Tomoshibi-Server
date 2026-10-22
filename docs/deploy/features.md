# 7. Optional features

[Back to the guide](../../DEPLOY.md)

Most features need nothing beyond the server itself. Two need a gateway, a
separate program this repository does not contain, which the server talks to
with a shared token.

| Feature | Needs | Configured in |
| --- | --- | --- |
| Accounts, scopes (`room@team`), invitations, knocking, arranged meetings, chat, avatars | nothing | the management pages |
| Sealed calls (end-to-end encryption by a shared word) | nothing; not available in Safari | nothing: the word is typed on the join screen and never reaches the server |
| Music library ("jukebox") | a music gateway | `meet.music` |
| Watching together (video links, Emby, YouTube, Bilibili) | a watch-together gateway | `meet.watch`, three switches in the pages |

## Account permissions

What an account may use is ticked per account under **Accounts**. Defaults
apply to an account whose record says nothing:

| Permission | Default | Allows |
| --- | --- | --- |
| `watch` | on | Starting a watch-together showing and resolving links. |
| `emby` | **off** | Choosing films from a media server's library and having this deployment relay them. Only an administrator with `moderate` can grant or take it away. |
| `music` | on | The music library and opening a jukebox. |
| `arrange` | on | Arranging a meeting for later. |
| `invite` | on | Standing links into the rooms of one's own scopes. |
| `open` | on | Opening a room nobody has used before. |

Somebody without `music` or `watch` still hears and sees what others play:
that travels through the call.

## The gateways in general

Both gateways are the same shape on this side:

- The server passes a signed-in person's request on to
  `<url>/<path>`, with the query as it came, and the token in a header:
  `X-Music-Token` or `X-Watch-Token`. The browser is shown the server's own
  paths and never the gateway's address.
- `url` must be `http://` or `https://`; `token` at least 24 characters.
  Both or neither, checked at startup.
- The gateway should be reachable **from the control node only** (a private
  network, or a firewall rule), and must check the token on every request: a
  guessable token lets anything on its network spend somebody's subscription
  or the deployment's bandwidth.
- Requests time out after 100 seconds unless they are streams.
- An unset gateway is a feature the client does not offer.

(To be confirmed: the gateways' own source, deployment and configuration are
not in this repository. What follows is the contract this server holds them
to.)

## Music library

```yaml
meet:
  music:
    url: http://10.0.0.30:18300
    token: "<at least 24 characters>"
```

Somebody signed in with the `music` permission may search a library and play
a track into the call as shared sound, losslessly where the track is. The
server passes on five paths, `GET /api/music/{path}`:

| Path | What the gateway answers |
| --- | --- |
| `sources` | Which libraries there are, and whether each is signed in. |
| `search` | Tracks in one of them. |
| `track` | A track's format: codec, rate, bits, channels. |
| `audio` | The audio itself, streamed, with `Range` passed through. |
| `link` | A playlist or song link as somebody shared it, and its tracks. |

Which services the gateway reaches, and on whose subscription, is the
gateway's business.

## Watching together

```yaml
meet:
  watch:
    url: http://10.0.0.30:18400
    token: "<at least 24 characters>"
    direct_only: true
```

Somebody signed in with `watch` pastes a link; everybody in the call watches
it, each in their own browser, kept at the same moment by whoever started it.
The server passes on five paths, `GET /api/watch/{path}`:

| Path | Who may ask | What the gateway answers |
| --- | --- | --- |
| `ready` | signed in, `watch` | Whether there is a gateway. |
| `resolve` | signed in, `watch` | What a pasted link plays, filed under a ticket. |
| `library` | signed in, `watch` and `emby` | The media servers (Emby) the deployment has an account on: browsing, search, posters. |
| `info` | anybody in the call, guests included | What a ticket plays: title, length, where it is. |
| `media` | anybody in the call | A ticket's video, playlists and segments, **relayed** for a viewer who cannot fetch them. |

`info` and `media` take only a ticket the gateway issued when somebody signed
in resolved a link (valid six hours), so nobody in a call can make everybody
else's browser fetch an address of their choosing. Relayed answers are only
ever sent as media types (video, audio, playlists, subtitles, a few image
types for posters), never as a page.

### What is relayed

Relaying a video means every byte of it, for every viewer who needs it,
through the control node (and through any CDN in front of it).

- `direct_only: false` (the default): everything the gateway can relay is
  relayed for whoever needs it, except a media server's film, which still
  needs the chooser to hold the `emby` permission and the Emby switch on.
- `direct_only: true`: every video plays from where each viewer is, or not at
  all, and the viewer who cannot reach it is told so. A source that plays only
  through the relay is refused when it is pasted. Three exceptions, each a
  switch in the store, set in **Rooms**, **Watching together**
  (capability `settings`):

| Switch | Starts | Relays |
| --- | --- | --- |
| Emby films (`watch.emby_relay`) | off | A film from a media server chosen by somebody holding `emby`. Such films play only through the relay, because the media server's addresses carry the deployment's account. With the switch off they cannot play at all. |
| YouTube (`watch.youtube_relay`) | off | YouTube, for viewers who cannot reach it (as in mainland China), on nobody's grant. Everybody else plays it directly. |
| Bilibili bangumi (`watch.bangumi_relay`) | **on** | Bilibili's licensed series and films, for everybody, since members-only episodes and anything above 720p play only that way. Relays nothing unless the gateway was started with `RELAY_BANGUMI`. Ordinary Bilibili videos and other pasted links are never relayed. |

A film's relay is tied to whoever chose it: taking away their `emby`
permission stops it.

### The gateway's health, for the watchdog

`dev/watch/watch.sh` can ask the watch gateway for checks only it can make
(a sign-in it uses has expired, a source has stopped answering):

- `GET <WATCH_GATEWAY>/health` with header `X-Watch-Token: <WATCH_TOKEN>`;
- answered with `{"checks": {"<kind>": {"ok": true|false|null, "bad": "<message>", "good": "<message>"}}}`.

`null` means the gateway could not tell, and leaves the count alone. The
watchdog knows none of the checks by name, so the gateway can add one without
the script changing. `WATCH_GATEWAY` (default: a documentation address, so set
it) and `WATCH_ENV` (default `/opt/watch/watch.env`, a file holding
`WATCH_TOKEN=`) are environment variables of the watchdog.

## Features without configuration

These are described in README.md and need no service:

- **Accounts.** Made by an administrator; there is no self-service sign-up.
  Sessions last thirty days unused and ninety in all, and survive restarts.
- **Scopes.** A label on accounts; `standup@acme` admits only members of
  `acme` (and administrators, invitations, and passphrases of members), on
  every join. Members run the scope's rooms. While the store is down nobody
  can enter a scoped room, by design.
- **Invitations and standing links.** *Invite somebody* in a call makes a link
  that lasts until the meeting ends, a day at most; members make standing
  links on `/account`.
- **Knocking.** Somebody without the right to enter can knock, and the host
  answers.
- **Arranged meetings.** A meeting for later, with a link that opens a waiting
  screen and, at the start, the room, optionally placed on a chosen relay.
- **Sealed calls.** Frames are encrypted in the browser with a key from the
  room name and a word everybody types; the relay forwards what it cannot
  read. Not in Safari; a reload forgets the word.

## Not available

- **Recording and telephony.** Both exist in the media server and neither is
  wired up; recording would need a second service.
- **Metrics endpoints.** No `/metrics`, statsd or OpenTelemetry. The readings
  are for the management pages and the six-month trend.
