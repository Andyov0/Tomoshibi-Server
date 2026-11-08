# 8. Native apps

[Back to the guide](../../DEPLOY.md)

The native apps (Mac, Windows, Linux, Android, iPhone and iPad) are built outside
this repository. What the server does for them:

| Address | For | Needs |
| --- | --- | --- |
| `/apps` | The download page | an account, signed in |
| the page an invitation or meeting link opens | Offers the app for the visitor's device before the meeting | a valid `?invite=` or `?meeting=` link |
| `GET /api/apps` | What the page shows | an account, or a valid link |
| `GET /api/apps/mac`, `/android`, `/windows`, `/linux-x86_64`, `/linux-aarch64` | The newest build itself, resumable | an account, or a valid link |
| `POST /api/apps/ios/invite` | Ask Apple to send a TestFlight invitation to an address | an account |
| `GET /api/apps/latest/{mac,android,windows,linux-x86_64,linux-aarch64,ios}` | An app asking for its newest version | the apps' user agent |
| `GET /api/apps/latest/{platform}/file` | The update itself, resumable | the apps' user agent |
| `GET /api/apps/remote` | Phrases, feature switches, numbers and a notice for the apps | the apps' user agent; see [below](#remote-configuration-remotejson) |
| `/.well-known/assetlinks.json` | Lets the Android app open this deployment's links | `meet.apps.android_*` |
| `/.well-known/apple-app-site-association` | Lets the iOS and Mac apps open invitation and meeting links | `meet.apps.apple_app_ids` |

None of it is served by a relay. Every part is optional: a part left out is a
section of the page that says the app is not available yet.

## The apps directory

```yaml
meet:
  apps:
    mac_dir: /var/lib/tomoshibi/apps
```

One directory holds the Mac disk images, the Android packages, the Windows
installers, the Linux AppImages, the manifest `apps.json` that names them, and
`remote.json`. The key is called `mac_dir` after the first platform it held;
renaming it would silently empty every deployment's download page.

- Both files are read **on every request**. Publishing a build is copying a
  file in and rewriting the manifest; nothing restarts.
- The service must be able to read the directory and its files. The
  management pages also **write** `remote.json` (the notice and the feature
  switches), so the directory must be writable by the service: keep it under
  `/var/lib/tomoshibi`, the unit's state directory, and after copying files in
  as root, give them back to the service (`chown -R --reference=/var/lib/tomoshibi
  /var/lib/tomoshibi/apps`).
- A directory the server cannot read is warned about at startup and leaves
  the Mac, Android, Windows and Linux sections saying "not available yet".

## `apps.json`

A list per platform. Example: [apps.json](examples/apps.json).

```json
{"mac":     [{"version": "0.1.4", "build": 2, "file": "Tomoshibi-0.1.4-2.dmg",
              "size": 84215808, "sha256": "<64 hex digits>", "sig": "<base64>",
              "notes": {"en": "...", "zh-Hans": "...", "zh-Hant": "...", "ja": "..."}}],
 "android": [{"version": "0.1.4", "file": "Tomoshibi-0.1.4.apk", "size": 31457280, "sha256": "..."}],
 "windows": [{"version": "0.1.4", "file": "Tomoshibi-Setup-0.1.4.exe", "size": 41943040, "sha256": "..."}],
 "linux-x86_64":  [{"version": "0.1.7", "file": "Tomoshibi-0.1.7-x86_64.AppImage", "size": 47185920, "sha256": "...", "sig": "..."}],
 "linux-aarch64": [{"version": "0.1.7", "file": "Tomoshibi-0.1.7-aarch64.AppImage", "size": 45088768, "sha256": "...", "sig": "..."}],
 "ios":     [{"version": "0.1.4", "build": "5", "notes": {"en": "..."}}]}
```

| Field | Platforms | Rule |
| --- | --- | --- |
| `version` | all | Required. Starts with a digit; then digits, letters, `.`, `+`, `-`; at most 32 characters. Compared part by part, numerically where both parts are numbers. |
| `file` | mac, android, windows, linux-x86_64, linux-aarch64 | A file name in the directory itself: no path, not starting with `.`, ending in `.dmg`, `.apk`, `.exe`, `-x86_64.AppImage` or `-aarch64.AppImage` respectively (compared in lower case). |
| `size` | every list but ios | The file's size in bytes, as a number. |
| `sha256` | every list but ios | 64 hexadecimal digits (upper case is accepted and read as lower). |
| `notes` | all, optional | What changed, by language tag (`en`, `zh-Hans`, `zh-Hant`, `ja`, ...), at most 2000 characters each. A note written wrongly costs that note, never the build. |
| `build` | all, optional | The build number (on Apple platforms its `CFBundleVersion`): digits only, at most nine, as a number or a string. Anything else is logged and read as none. |
| `sig` | every list but ios; optional to the server | The release key's signature of the line, base64 (see [Signed updates](#signed-updates)). Passed to the apps untouched; one that is not a string is logged and dropped, never costing the build. |

**The iOS list** has only `version`, `build` and `notes`. TestFlight installs
the iOS app, so the list only tells the app which version is newest there and
what changed; a `file`, `size`, `sha256` or `sig` written there is ignored, and
its `/file` address always answers `no_build`.

How a platform's build is chosen:

1. Every line that passes the rules above is a candidate; a line that does
   not is passed over and logged, and the rest of the list still counts.
2. The highest `version` wins; between equal versions the later line wins, so
   a manifest corrected by appending reads as meant. Keep one line per
   version: a later build of a version **replaces** its line.
3. It is offered only if its file exists, is a regular file, has exactly
   `size` bytes, and hashes to `sha256`. A file still being copied is the
   wrong size, so a half-uploaded build is never handed out; the next request
   finds it whole. There is no fallback to an older line: a newest line whose
   file fails is "not available yet". The hash is computed once per file and
   remembered by size and modification time.

Each platform's list is read on its own: a malformed Android line cannot take
the Mac build off the page. Only a manifest that is not JSON at all costs
every platform.

### Versions with builds

From app version 0.1.4 on, a small fix keeps the version and takes the next
build. The update check offers a line with `"build": 2` (or higher) as
`0.1.4.2`, and the page shows it as `0.1.4 (2)`; no build, or build 1, is
plain `0.1.4`. Older Mac apps are told what their installers expect: a Mac
from before 0.1.2 always gets the version with the build joined
(`0.1.4.1` for a first build), and a Mac on 0.1.2 or 0.1.3 gets the version
alone. The size, hash and file are the same build for everybody.

### Who gets a build

- **The download page and its endpoints**: an account signed in, or somebody
  holding a link the join would accept (`?invite=<token>` or
  `?meeting=<token>` in the address): not revoked, not expired, already open,
  made by somebody still in the scope, at a door that takes invitations.
  Downloads by link are logged with the room they were for, never the token.
  A request that presents a link spends from the join's rate limit, since the
  token is the whole of the check.
- **The update endpoints**: no account, because an app used as a guest has
  no session. They answer only a user agent beginning `Tomoshibi/`, which the
  apps send as `Tomoshibi/<version> (<Platform>; <system>; <model>)` with
  Platform one of `Mac`, `iPhone`, `iPad`, `Android`, `Windows`, `Linux`. That is no
  secret; it stops the address working as a download link pasted into a
  chat, which opens in a browser (`403 not_the_app`). The app checks size and
  hash again after downloading, and installs nothing that does not match;
  an app built with a release key also offers and installs nothing whose line
  the key did not sign ([Signed updates](#signed-updates)).

### Signed updates

The size and hash an app is told come from the same server as the file, so on
their own they only prove the file is the one the server meant. A server, or a
builds directory, that somebody else could write to would describe their own
file just as faithfully, and neither the Windows installer nor the Linux
AppImage is code-signed. So each Mac, Android, Windows and Linux line carries
`sig`: an Ed25519 signature by the
deployment's **release key**, which is kept off every server and used where the
builds are made. The apps carry the key's public half (built into their core
as `TOMOSHIBI_UPDATE_KEY`), and a release build for a real deployment cannot be
made without it.

What is signed is exactly these six lines, each ending in a newline:

```text
tomoshibi-update-v1
platform=<mac|android|windows|linux-x86_64|linux-aarch64>
version=<the version as offered: "version", plus "." and the build when "build" is above 1>
file=<the line's "file">
size=<the line's "size", in decimal>
sha256=<the line's "sha256", lower case>
```

The version is the one the update check tells every app from 0.1.4 on
(`0.1.4.2` for `"version": "0.1.4", "build": 2`), so the build is covered
through it; the notes are not signed and can be edited afterwards. A file name
must be letters, digits, `.`, `_`, `+` and `-` only, so that no value can carry
a newline into the lines.

The server does not check the signature and holds no key: `GET
/api/apps/latest/{platform}` passes the line's `sig` on untouched, with its
`file`, and leaves both out where the line has none (and always for iOS). An
app from before signatures ignores them; an app built with a key refuses, as a
failed check, a newest line that is unsigned or signed for anything else, and
re-checks the signature against the downloaded bytes before installing. So:

- **Sign before shelving.** A build put on the shelf with an unsigned line,
  or a line edited after signing (anything but `notes`), is an update no keyed
  app will take. Renaming the file, or changing `build`, needs a new signature.
- **Order of rollout:** a server that passes `sig` on, then the lines signed,
  then apps built with the key. Apps built with the key and pointed at a server
  that drops `sig` are offered nothing.
- **Keep the private key.** Losing it means keyed apps can only be updated by
  hand-installing a build with a new key; leaking it means making a new one and
  shipping apps built with it.

### Publishing a build

The order that never hands anybody a broken file:

1. Upload the build into the directory under a name starting with `.` (such
   names are never offered), for example `.Tomoshibi-0.1.5.dmg.part`.
2. Check its SHA-256 and size on the server against the values from where it
   was built.
3. Write the new manifest beside the old one (`.apps.json.part`), with the
   line for the new build, signed with the release key where the build was
   made, against the file there ([Signed updates](#signed-updates)). Check
   every file line's signature with the public key before moving it into
   place.
4. Keep the old manifest (`cp -a apps.json apps.json.before-<date>`).
5. Move the build to its real name, then move the new manifest over
   `apps.json`. A rename is atomic, so a request reads either the old manifest
   or the new one.
6. Remove builds no line names any more.
7. Check as an app and as a browser:

   ```bash
   curl -s -A 'Tomoshibi/0.1.4 (Mac; check)' https://meet.example.com/api/apps/latest/mac
   # {"platform":"mac","version":"0.1.5","size":...,"sha256":"...","notes":{...},"file":"...","sig":"..."}
   curl -s -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' https://meet.example.com/api/apps/latest/mac
   # 403
   curl -s -A 'Tomoshibi/0.1.7 (Linux; check; x86_64)' https://meet.example.com/api/apps/latest/linux-x86_64
   curl -s -A 'Tomoshibi/0.1.7 (Linux; check; aarch64)' https://meet.example.com/api/apps/latest/linux-aarch64
   ```

Builds downloaded from the server log `handed over the Mac app ...` with the
version (and, for updates, the version the app came from), once per download
rather than per range.

### Windows

The Windows build is an `.exe` installer holding both x64 and ARM64, which
installs for the person running it without administrator rights. It is not
code-signed (the owner decided against buying a certificate, 2026-10-21), so
Windows shows "Windows protected your PC" until somebody presses past it; the
pages warn about this before it appears. An update the app installs itself is
run silently, with nothing from Windows in the way, which is why its line's
release-key signature ([Signed updates](#signed-updates)) is what the app
trusts it by.

### Linux

The Linux build is an AppImage, and there are two: one for x86-64 PCs in the
`linux-x86_64` list and one for ARM64 ones in `linux-aarch64`, because an
AppImage holds one processor's machine code where every other platform's file
holds all of its own. The app asks for the list of the processor it was built
for, and the list's name is the `platform` its line is signed for, so a line
moved to the other list fails its signature in the app; each list also takes
only a file whose name ends in its own processor's suffix, so a line pasted
into the wrong one is offered to nobody. A browser saves it as
`Tomoshibi-<version>-x86_64.AppImage` (or `-aarch64`), told its type is
`application/vnd.appimage`.

The download page offers both builds side by side, x86-64 first as the usual
one, because a browser cannot be relied on to say which processor it runs on.
It says, before the download, that the file has to be allowed to run as a
program; a browser saves it without that permission. The Linux app signs in
like the other apps and, like them, is not asked for the human check unless
`meet.turnstile.exempt_native_apps` is set to `false`. In `remote.json`,
`linux` names both processors' apps.

A server from before the Linux app answers `no_build` for both lists and
offers no Linux download, which is what the app and the page expect of it.

#### One command

For somebody who does not know which processor they have, the download page
and the invitation page also give one line to paste into a terminal:

```bash
curl -fsSL https://meet.example.com/linux.sh | sh
```

`/linux.sh` is served by this server without a sign-in (internal/app/linux.sh,
with the deployment's address written in from the request, as the pages see
it; a host that does not look like one is refused rather than written into a
script somebody runs). It answers `no_build` where there are no shelves. The
script, which never runs sudo and touches nothing outside the person's home
folder:

1. stops unless this is Linux, not root, and has a desktop: a graphical
   session, or one installed for somebody who came in over SSH (session files in
   `/usr/share/xsessions` or `/usr/share/wayland-sessions`, or a display
   manager). `--force` installs anyway;
2. picks `linux-x86_64` or `linux-aarch64` from `uname -m`, refuses other
   processors, a 32-bit system, musl and a C library older than 2.39, each in a
   sentence of its own;
3. asks `latest/linux-<processor>` as `Tomoshibi/installer-<n> (...)`, downloads
   the file, and installs it only if its size and SHA-256 match the line;
4. puts it at `~/.local/share/tomoshibi/Tomoshibi.AppImage`, a launcher at
   `~/.local/bin/tomoshibi`, and the desktop entry, icons and `tomoshibi://`
   handler the app writes itself (taken from the image), naming the image the
   way the app looks for it, so its first start does not ask to be added;
5. says how to install FUSE 3 for the distribution where it is missing.

Run again, it updates in place or says it is up to date; `--uninstall`
removes what it put there and keeps the settings. Its messages follow the
terminal's language (English, Chinese, Japanese).

To check it on a deployment, read it first, then try it on a desktop:

```bash
curl -fsSL https://meet.example.com/linux.sh | head -30
curl -fsSL https://meet.example.com/linux.sh | sh -s -- --help
```

## TestFlight invitations

The iOS app is installed through TestFlight, two ways: an invitation sent to
an address (for accounts), and the beta's public link (for link holders
without an account, and for accounts when no API key is configured).

```yaml
meet:
  apps:
    testflight:
      key_id: "<key id>"
      issuer: "<issuer id>"
      key_file: /etc/tomoshibi/asc-testflight.p8
      group: "<external beta group id>"
      public_link: https://testflight.apple.com/join/<code>
```

| Key | Where it comes from |
| --- | --- |
| `key_id` | App Store Connect, **Users and Access**, the API keys section: create a key with a role that may manage testers. Its key ID is shown beside it. |
| `issuer` | The issuer ID shown on the same page. |
| `key_file` | The `.p8` private key, downloadable **once** when the key is created. Store it on the control node readable by the service (640, group `tomoshibi-certs`). A file that is not a P-256 key is refused at startup. |
| `group` | The ID of an **external** beta group of the app, which is in the group's address in App Store Connect. |
| `public_link` | Optional. With the group's public link turned on, App Store Connect shows `https://testflight.apple.com/join/<code>`. Anything else is refused at startup. Its tester ceiling is set beside it in App Store Connect; lower it if the link travels further than meant. |

All of `key_id`, `issuer`, `key_file` and `group`, or no invitations (a
partial set is warned about and leaves invitations off). The minimum role for
the key is not stated in the code beyond "may manage testers". (To be
confirmed: the least-privileged App Store Connect role that can add external
testers.)

How it behaves:

- Each account may have **five** addresses invited, counted in the store. An
  address it invited before answers "already invited" and costs nothing.
- Rate limits: per caller address one a minute after a burst of ten; per
  account one a minute after a burst of five; one invitation in flight per
  account.
- A request to Apple that fails or times out (30 seconds) is
  `testflight_refused` on the page and the reason is in the log, with the
  address masked.
- Tokens to Apple are signed with the key, live ten minutes, and go only to
  `api.appstoreconnect.apple.com`; a release build cannot be pointed
  elsewhere.

### Trying it without Apple

`dev/ascstub` stands in for App Store Connect and checks every token's
signature against the key:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -pkeyopt ec_param_enc:named_curve -out /tmp/asc.p8
go run ./dev/ascstub /tmp/asc.p8 127.0.0.1:18990
go build -tags ascstub -o /tmp/tomoshibi-stub .
TOMOSHIBI_ASC_STUB=http://127.0.0.1:18990 /tmp/tomoshibi-stub serve <config naming /tmp/asc.p8>
```

Addresses decide the answer: `...+known@...` already in the group,
`...+elsewhere@...` in another group, `...+refuse@...` refused, anything else
new. The second `-pkeyopt` matters on a Mac, whose LibreSSL otherwise writes
explicit curve parameters that Go refuses.

## App links

So that invitation and meeting links open in the app rather than the browser.

**Android**: `/.well-known/assetlinks.json`, a `handle_all_urls` statement.

```yaml
meet:
  apps:
    android_package: com.example.tomoshibi
    android_certificates:
      - "<32 colon-separated hex bytes>"
```

The package is the app's `applicationId`. Each fingerprint is the SHA-256 of a
key the app is signed with, exactly as `keytool -list -v` prints it beside
`SHA256` (`keytool -list -v -keystore release.jks -alias <alias>`). List more
than one where the app is signed more than one way, for example your own key
and Google Play's app signing key. Lower case is accepted and rewritten; a
fingerprint without colons (as `apksigner` prints it) is refused with the
form wanted. Both keys or neither.

**Apple**: `/.well-known/apple-app-site-association`.

```yaml
meet:
  apps:
    apple_app_ids:
      - ABCDE12345.com.example.tomoshibi.ios
      - ABCDE12345.com.example.tomoshibi.mac
```

Each is the developer's ten-character team ID, a dot, and the bundle ID; one
per app. The statement claims only links at the root carrying `invite=` or
`meeting=`; a bare address or a room's own `#/room` address stays in the
browser. Apple's CDN fetches this file without a session and follows no
redirect, so make sure nothing in front of the control node redirects
`/.well-known/apple-app-site-association`.

Both answer 404 when not configured: a deployment without an app must not
claim one. The apps themselves must also declare the domain (the Associated
Domains entitlement on Apple platforms, intent filters on Android); that is
in the apps' own projects.

## Remote configuration (`remote.json`)

**Requires** a server built from the 2026-10-22 snapshot of this fork or
later, and native apps from version 0.1.4. Older servers have no
`remote.json` or `GET /api/apps/remote`; older apps do not ask.

Four kinds of change reach the apps without a release of them. The apps ask
for them, keep the last answer on the device, and use it when they cannot
reach the server.

`remote.json` lives in the apps directory beside `apps.json` and is read on
every request. Example: [remote.json](examples/remote.json).

```json
{ "phrases": { "<English sentence>": { "zh-Hans": "...", "zh-Hant": "...", "ja": "...", "en": "..." } },
  "switches": [ { "feature": "screen-share", "off": true, "platforms": ["android"],
                  "from": "0.1.4", "below": "0.1.5", "note": "..." } ],
  "params": [ { "name": "screen_share_max_fps", "value": 30, "platforms": ["android"] } ],
  "notice": { "id": "...", "level": "info", "text": { "zh-Hans": "..." }, "until": "2026-10-23T12:00:00Z" } }
```

### Sections

| Section | What | Edited |
| --- | --- | --- |
| `phrases` | Replacement wording for a sentence in the apps' dictionaries, keyed by the English sentence as the dictionaries key it, per language. The same for every app. | In the file. |
| `switches` | Features turned off on some platforms and versions, and on again in a narrower case. | In the file, or **Apps**, **Feature switches** (capability `settings`). |
| `params` | A few numbers the apps would otherwise have compiled in. | In the file. |
| `notice` | One notice in the apps' lobby, in their languages, until a time or until it is taken down. | In the file, or **Apps**, **Lobby notice** (capability `settings`). |

### Switches

| Field | Meaning |
| --- | --- |
| `feature` | One of `screen-share`, `background-blur`, `watch-together`, `music` (the jukebox), `app-updates` (the apps offering their own next version). |
| `off` | `true` turns it off where the rule holds; `false` turns it back on. |
| `platforms` | Any of `mac`, `iphone`, `ipad`, `ios` (iPhone and iPad together), `android`, `windows`, `linux` (both processors). Absent or empty: every platform. |
| `from` | The rule holds for this version and later. Optional. |
| `below` | The rule holds for versions earlier than this one. Optional. |
| `note` | Why, for whoever reads the file or the page. Never sent to an app. |

Versions compare as the update check compares them. Where two rules name the
same feature, the **later rule in the list wins**, which is how a feature
turned off for a run of versions is turned back on for one.

### Params

| Name | Meaning |
| --- | --- |
| `screen_share_max_fps` | Highest frame rate of a screen share. |
| `screen_share_max_height` | Highest height of a screen share, in pixels. |
| `screen_share_hot_fps` | The frame rate a device that is running hot falls back to; 0 for none. |
| `update_check_hours` | How often the apps look for a newer version. |

Each param may carry `platforms`, as a switch does; the later one wins.

### Notice

| Field | Meaning |
| --- | --- |
| `id` | Required: a notice without one is not sent. Identifies this notice; a new id is a new notice, shown again to somebody who closed the last. At most 64 characters. |
| `level` | `info` or `warning`. |
| `text` | By language. At most 500 characters per language. |
| `until` | When it stops being shown, RFC 3339. Optional: without it, until taken down. |

### How it is read

- In pieces: a section written wrongly costs that section, a rule or phrase
  written wrongly costs that rule or phrase, never the rest. A missing comma
  in a phrase must not hold back an urgent notice beside it.
- **Refused rather than guessed**, because each would widen a rule: an unknown
  platform (`andriod`), an unknown field (`platfroms`), a version that is not
  one. Read as nothing, they would have turned a feature off for everybody.
- Names outside the lists above are still sent (a newer app may know them);
  the management pages offer only the listed ones.
- The management pages replace only their own section and keep the rest of
  the file byte for byte; they write a new file and rename it into place, and
  refuse to write over a file that is not JSON.
- `GET /api/apps/remote` answers only the apps' user agent, works out what
  holds for the app asking (its platform and version from the user agent), and
  carries a revision that is also its `ETag`; an app sending it back in
  `If-None-Match` gets `304`.

## Pointing the apps at a deployment

The deployment's address is part of the native apps' build; see the Tomoshibi
Native repository. Updates, TestFlight invitations, `remote.json` and app links
reach a deployment only through apps built for it.
