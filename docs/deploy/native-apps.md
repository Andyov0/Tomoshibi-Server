# 8. Native apps

[Back to the guide](../../DEPLOY.md)

The native apps (Mac, Windows, Android, iPhone and iPad) are built outside
this repository. What the server does for them:

| Address | For | Needs |
| --- | --- | --- |
| `/apps` | The download page | an account, signed in |
| the page an invitation or meeting link opens | Offers the app for the visitor's device before the meeting | a valid `?invite=` or `?meeting=` link |
| `GET /api/apps` | What the page shows | an account, or a valid link |
| `GET /api/apps/mac`, `/android`, `/windows` | The newest build itself, resumable | an account, or a valid link |
| `POST /api/apps/ios/invite` | Ask Apple to send a TestFlight invitation to an address | an account |
| `GET /api/apps/latest/{mac,android,windows,ios}` | An app asking for its newest version | the apps' user agent |
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
installers, the manifest `apps.json` that names them, and `remote.json`. The
key is called `mac_dir` after the first platform it held; renaming it would
silently empty every deployment's download page.

- Both files are read **on every request**. Publishing a build is copying a
  file in and rewriting the manifest; nothing restarts.
- The service must be able to read the directory and its files. The
  management pages also **write** `remote.json` (the notice and the feature
  switches), so the directory must be writable by the service: keep it under
  `/var/lib/tomoshibi`, the unit's state directory, and after copying files in
  as root, give them back to the service (`chown -R --reference=/var/lib/tomoshibi
  /var/lib/tomoshibi/apps`).
- A directory the server cannot read is warned about at startup and leaves
  the Mac, Android and Windows sections saying "not available yet".

## `apps.json`

A list per platform. Example: [apps.json](examples/apps.json).

```json
{"mac":     [{"version": "0.1.4", "build": 2, "file": "Tomoshibi-0.1.4-2.dmg",
              "size": 84215808, "sha256": "<64 hex digits>",
              "notes": {"en": "...", "zh-Hans": "...", "zh-Hant": "...", "ja": "..."}}],
 "android": [{"version": "0.1.4", "file": "Tomoshibi-0.1.4.apk", "size": 31457280, "sha256": "..."}],
 "windows": [{"version": "0.1.4", "file": "Tomoshibi-Setup-0.1.4.exe", "size": 41943040, "sha256": "..."}],
 "ios":     [{"version": "0.1.4", "build": "5", "notes": {"en": "..."}}]}
```

| Field | Platforms | Rule |
| --- | --- | --- |
| `version` | all | Required. Starts with a digit; then digits, letters, `.`, `+`, `-`; at most 32 characters. Compared part by part, numerically where both parts are numbers. |
| `file` | mac, android, windows | A file name in the directory itself: no path, not starting with `.`, ending in `.dmg`, `.apk` or `.exe` respectively. |
| `size` | mac, android, windows | The file's size in bytes, as a number. |
| `sha256` | mac, android, windows | 64 hexadecimal digits (upper case is accepted and read as lower). |
| `notes` | all, optional | What changed, by language tag (`en`, `zh-Hans`, `zh-Hant`, `ja`, ...), at most 2000 characters each. A note written wrongly costs that note, never the build. |
| `build` | all, optional | The build number (on Apple platforms its `CFBundleVersion`): digits only, at most nine, as a number or a string. Anything else is logged and read as none. |

**The iOS list** has only `version`, `build` and `notes`. TestFlight installs
the iOS app, so the list only tells the app which version is newest there and
what changed; a `file`, `size` or `sha256` written there is ignored, and its
`/file` address always answers `no_build`.

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
  Platform one of `Mac`, `iPhone`, `iPad`, `Android`, `Windows`. That is no
  secret; it stops the address working as a download link pasted into a
  chat, which opens in a browser (`403 not_the_app`). The app checks size and
  hash again after downloading, and installs nothing that does not match.

### Publishing a build

The order that never hands anybody a broken file:

1. Upload the build into the directory under a name starting with `.` (such
   names are never offered), for example `.Tomoshibi-0.1.5.dmg.part`.
2. Check its SHA-256 and size on the server against the values from where it
   was built.
3. Write the new manifest beside the old one (`.apps.json.part`), with the
   line for the new build.
4. Keep the old manifest (`cp -a apps.json apps.json.before-<date>`).
5. Move the build to its real name, then move the new manifest over
   `apps.json`. A rename is atomic, so a request reads either the old manifest
   or the new one.
6. Remove builds no line names any more.
7. Check as an app and as a browser:

   ```bash
   curl -s -A 'Tomoshibi/0.1.4 (Mac; check)' https://meet.example.com/api/apps/latest/mac
   # {"platform":"mac","version":"0.1.5","size":...,"sha256":"...","notes":{...}}
   curl -s -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' https://meet.example.com/api/apps/latest/mac
   # 403
   ```

Builds downloaded from the server log `handed over the Mac app ...` with the
version (and, for updates, the version the app came from), once per download
rather than per range.

### Windows

The Windows build is an `.exe` installer holding both x64 and ARM64, which
installs for the person running it without administrator rights. It is not
code-signed (the owner decided against buying a certificate, 2026-10-21), so
Windows shows "Windows protected your PC" until somebody presses past it; the
pages warn about this before it appears.

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
| `platforms` | Any of `mac`, `iphone`, `ipad`, `ios` (iPhone and iPad together), `android`, `windows`. Absent or empty: every platform. |
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
