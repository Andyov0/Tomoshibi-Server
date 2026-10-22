# Examples

Files referred to by the [deployment guide](../../../DEPLOY.md). Every name
under `example.com`, every address in `203.0.113.0/24`, `198.51.100.0/24` or
`10.0.0.0/8`, and everything in angle brackets is a placeholder. The three
YAML files load with the server's strict loader once their placeholders are
filled in (the administrator trips are written so that an unreplaced one is
refused at startup).

| File | Install as | Chapter |
| --- | --- | --- |
| [full.yaml](full.yaml) | `/etc/tomoshibi/meet.yaml` on a single machine | [4](../control-node.md) |
| [control.yaml](control.yaml) | `/etc/tomoshibi/control.yaml` on the control node | [4](../control-node.md) |
| [relay.yaml](relay.yaml) | `/etc/tomoshibi/relay.yaml` on a relay set up by hand (enrolment writes its own) | [5](../relays.md) |
| [tomoshibi.service](tomoshibi.service) | `/etc/systemd/system/` on the control node or single machine | [4](../control-node.md) |
| [tomoshibi-relay.service](tomoshibi-relay.service) | `/etc/systemd/system/` on a relay set up by hand | [5](../relays.md) |
| [gomemlimit.conf](gomemlimit.conf) | `/etc/systemd/system/tomoshibi-relay.service.d/` | [5](../relays.md#memory-limits) |
| [nginx-meet.conf](nginx-meet.conf) | `/etc/nginx/conf.d/` on the control node | [2](../prepare.md#a-reverse-proxy-or-a-cdn-in-front-of-the-control-node) |
| [redis.conf](redis.conf) | merged into the shared redis's configuration | [6](../cross-border.md#rotating-the-redis-password) |
| [apps.json](apps.json) | the apps directory (`meet.apps.mac_dir`) | [8](../native-apps.md#appsjson) |
| [remote.json](remote.json) | the apps directory | [8](../native-apps.md#remote-configuration-remotejson) |
| [watch.env](watch.env) | `/etc/tomoshibi/watch.env`, mode 600 | [9](../operations.md#monitoring-and-alerts) |
| [watch.cron](watch.cron) | `/etc/cron.d/tomoshibi-watch` | [9](../operations.md#monitoring-and-alerts) |
| [tomoshibi-alerts.service](tomoshibi-alerts.service) | `/etc/systemd/system/` on the machine holding the bot token | [9](../operations.md#monitoring-and-alerts) |
| [upgrade-control.sh](upgrade-control.sh) | run on the control node | [9](../operations.md#upgrading-the-control-node) |
| [upgrade-relays.sh](upgrade-relays.sh) | run from the machine you deploy from | [9](../operations.md#upgrading-relays) |

The JSON examples carry dummy hashes and sizes; a line whose file does not
match them is simply not offered.
