# nibepi-backend: NibePi gateway

An RS485/MQTT gateway for Nibe heat pumps. It sits on the pump's RS485 bus
(directly or through a NibeGW), decodes and encodes registers, polls the ones
you ask for and publishes them over MQTT, and writes values back after
validating them. It runs as a single process, `node gateway.js`, usually in
Docker on a Raspberry Pi. The reference install is a Nibe F1255.

The gateway contains no control logic. Price, indoor, weather and hot water
control live in the Home Assistant component
[nibepi-ha](https://github.com/greberg/nibepi-ha), which talks to the gateway
over MQTT only. Registers that Home Assistant controls are held through
**leases**. When Home Assistant stops renewing a lease, the gateway restores
the register by itself.

The gateway does the following:

- speaks the Nibe RS485 protocol and answers the pump as an RMU40 room unit
  when no real one is fitted (`system.rmu_emulation`)
- decodes registers from the per-model tables in `models/`
- validates every write against the register's type and the model's
  min/max, then queues it in order, one entry per register
- supervises the core process and restarts it with backoff
- runs a bus watchdog that restarts a core that gets no frames for 5 minutes
- publishes bus health once a minute
- publishes a health file for the Docker `HEALTHCHECK`
- serves a read-only status page on the LAN (`NIBEPI_UI_PORT`)
- can publish Home Assistant MQTT discovery for the polled registers
- applies leases and a raw `/set` policy

## Running

```sh
npm ci
npm start                 # node gateway.js
```

Docker image: `ghcr.io/greberg/nibepi-gateway`. Mount a writable volume for
the config directory, pass the serial device through, and configure the rest
with environment variables:

```sh
docker run -d --name nibepi --restart unless-stopped \
  --device /dev/serial0:/dev/ttyAMA0 \
  -v /opt/nibepi/etc/nibepi:/etc/nibepi \
  -e NIBEPI_MQTT_HOST=192.168.1.10 -e NIBEPI_MQTT_USER=nibepi -e NIBEPI_MQTT_PASS=... \
  ghcr.io/greberg/nibepi-gateway
```

Logs go to stdout/stderr (`docker logs nibepi`). On `SIGTERM` the gateway
does the following before it exits:

- writes any pending config save
- publishes `offline`
- stops the core

Active leases are not released on stop. Their baselines are persisted, and
the next start gives the owner one TTL to renew them (see *Leases*).

Requirements:

- Node.js 20 or newer
- an RS485 adapter or a NibeGW
- on a Raspberry Pi, a 64-bit-capable board (Zero 2 W or newer)

## Configuration

Configuration comes from `config.json` in the config directory, with
environment variables on top.

On the first start, when there is no `config.json`, the gateway creates one
from `default.json`. Every save is atomic: the new file is written and
fsynced, and the previous file is kept as `config.json.bak`. An unreadable
`config.json` is replaced by the `.bak` copy. If that is unreadable too, the
gateway uses the defaults and keeps the broken file as
`config.json.corrupt-<timestamp>`.

### Environment

Environment values override `config.json` **in memory only**. They are never
written back, so a password passed as `NIBEPI_MQTT_PASS` does not end up on
disk. An empty variable counts as unset. An invalid value stops the gateway
with an error.

| variable | config key | default |
|---|---|---|
| `NIBEPI_CONFIG_DIR` | directory holding `config.json` | `/etc/nibepi` |
| `NIBEPI_CONNECTION` | `connection.enable`: `serial` or `nibegw` | `serial` |
| `NIBEPI_SERIAL_PORT` | `serial.port` | `/dev/ttyAMA0` |
| `NIBEPI_NIBEGW_HOST` | `nibegw.host`: the NibeGW / esphome-nibe device | |
| `NIBEPI_NIBEGW_PORT` | `nibegw.port`: local UDP port the NibeGW sends to | `9999` |
| `NIBEPI_MQTT_HOST` | `mqtt.host`; setting it turns MQTT on | (MQTT off) |
| `NIBEPI_MQTT_PORT` | `mqtt.port` | `1883` |
| `NIBEPI_MQTT_USER` | `mqtt.user` | |
| `NIBEPI_MQTT_PASS` | `mqtt.pass` | |
| `NIBEPI_MQTT_TOPIC` | `mqtt.topic`; a trailing `/` is added if missing | `nibe/modbus/` |
| `NIBEPI_RAW_SET` | `gateway.raw_set`: `all`, `none` or `47011,47041,...` | `all` |
| `NIBEPI_LOG_LEVEL` | `error`, `warn`, `info`, `debug`, `trace` (raw bus frames) | `info` |
| `NIBEPI_LOG_FILE` | also append the log to this file, rotated at 5 MB | (off) |
| `NIBEPI_HEALTH_FILE` | health file path | `/dev/shm/nibepi-health.json` |
| `NIBEPI_UI_PORT` | status page port; empty or `0` turns it off (not a config key) | off (`8080` in the Docker image) |
| `NIBEPI_UI_BIND` | address the status page listens on | `0.0.0.0` |
| `NIBEPI_BUILD` | build id shown on the status page and in `gateway/state` (not a config key; the image sets it to `<date>-<backend commit>`) | (none) |
| `NIBEPI_UI_USER`, `NIBEPI_UI_PASS` | HTTP Basic auth for the status page; set both or neither | (no auth) |

### config.json

| key | meaning |
|---|---|
| `connection.enable` | `serial` (RS485 adapter) or `nibegw` (UDP from a NibeGW) |
| `serial.port` | serial device, e.g. `/dev/ttyAMA0` |
| `nibegw.host`, `nibegw.port` | NibeGW host, and the local UDP port it sends to. Older configs that put the host in `serial.port` still work. |
| `mqtt.host`, `port`, `user`, `pass`, `topic` | broker and topic prefix. MQTT is on when `host` is set, unless `mqtt.enable` is `false`. |
| `mqtt.discovery` | `true` publishes Home Assistant MQTT discovery for the polled registers |
| `registers` | registers polled continuously, managed through `T<reg>/add` and `/remove` |
| `home.adjust_s1`, `home.adjust_s2` | neutral curve offset for system 1/2, the restore target of the 47011/47010 leases |
| `system.rmu_emulation` | `false` never answers the pump as RMU40; use it when a physical RMU40 is on the bus |
| `system.pump`, `system.firmware`, `system.id` | written by the gateway: the cached model, firmware and discovery id |
| `gateway.raw_set` | what a plain `T<reg>/set` may write, see below |
| `gateway.leases` | overrides of the lease table, see below |
| `gateway.baselines` | written by the gateway: baselines of active leases, kept across restarts |

Keys the gateway doesn't know are ignored and kept as they are. This includes
the Node-RED-era settings, such as `price`, `hotwater`, `indoor`, `weather`
and `log`.

## MQTT

`T` is the topic prefix (`mqtt.topic`, default `nibe/modbus/`). The full
contract, including the rationale for leases, is in
`docs/ha-migration.md` in the workspace repository.

| topic | direction | payload |
|---|---|---|
| `T<reg>` | gateway → | value in engineering units, e.g. `21.5` (mapped text for registers with a value map) |
| `T<reg>/raw` | gateway → | raw value |
| `T<reg>/json` | gateway → | JSON: `register, titel, data, raw_data, unit, timestamp, ...` |
| `T<reg>/get` | → gateway | any; reads the register once |
| `T<reg>/add`, `T<reg>/remove` | → gateway | any; adds the register to or removes it from continuous polling |
| `T<reg>/set` | → gateway | value in engineering units; validated, and subject to `raw_set` and leases |
| `Tadjust_s1/set`, `Tadjust_s2/set` | → gateway | sets `home.adjust_s1/_s2`, the neutral curve offset |
| `Tadjust_s1/get`, `Tadjust_s2/get` | → gateway | publishes the current value on `Tadjust_s1` / `Tadjust_s2` |
| `Tstatus` | gateway →, retained | `online` / `offline` (also the last will) |
| `Tbus_health` | gateway →, per minute | JSON: `ok, chksum, no_respond, errors, timestamp` |
| `Tlease/<reg>/set` | → gateway, **not retained** | `{"value": -2, "ttl": 900, "owner": "ha"}` |
| `Tlease/<reg>/release` | → gateway, not retained | anything |
| `Tlease/<reg>/state` | gateway →, retained | `active, restoring, value, written, expires, baseline, neutral, neutral_from, owner, error` |
| `Tgateway/state` | gateway →, retained, per minute | `version, build, leases, raw_set, core, lastData` |
| `homeassistant/device/nibepi_<id>/config` | gateway →, retained | discovery, when `mqtt.discovery` is `true` |

### Leases

- **Leasable registers.** Only registers in the lease table can be leased:
  - curve offsets 47011 and 47010 (-10..10; they restore to
    `home.adjust_s1` / `_s2`)
  - hot water comfort mode 47041 and hot water period 47134
  - stop temperature HW luxury 47047 (45..70 °C, one decimal; restores the
    baseline), raised by Home Assistant's legionella guard
  - temporary lux 48132
  - the cut-off frequency registers 48659–48664
  - the RMU40 room temperature 10060/10160/10260/10360 for systems 1–4 (see
    below)

  To change the table, set `gateway.leases` to
  `{"<reg>": {"min", "max", "neutral", "neutral_from", "min_interval"}}`.
  Entries merge over the defaults, and `null` removes one. `neutral_from` is
  a register that is read fresh from the pump at restore time and written.
- **First request.** The gateway reads the current value from the pump as the
  baseline and persists it. A `neutral_from` lease needs no baseline.
- **Writes.** A value is written only when it changes, at most once per
  `min_interval`; the last value wins. `ttl` is clamped to 60..3600 s.
- **Expiry and release.** Without renewal the lease expires, and the gateway
  restores the register to its neutral value or else to the baseline.
  `release` restores it at once. A failed restore is retried with backoff.
- **Other writers.** While a register is leased, the gateway refuses plain
  `T<reg>/set` for it.
- **Restarts.** After a restart, a persisted baseline starts a grace lease
  of 900 s. Renew it within that time, or the register is restored.
- **Before the model is known.** Until the pump has announced its model,
  requests are rejected with `Heatpump is not ready yet.`; retry on the next
  tick.

**RMU40 room temperature.** Home Assistant can feed a room sensor to the
pump through the emulated RMU40 room unit, by leasing 10060 (system 1) with
the temperature in °C, one decimal, 5..35. The register exists only after the
pump has polled that RMU40 (menu 5.2, and `system.rmu_emulation` on); until
then the lease is rejected with `RMU40 S1 is not connected: ...`, and with
`RMU40 S1 is read-only ...` when another RMU40 answers. On expiry or release
the gateway reads the room sensor setpoint (47398 for system 1) and writes
it: room temperature equal to the setpoint means no room correction, so the
pump never keeps acting on a frozen reading.

### Raw `/set` policy

`gateway.raw_set` (or `NIBEPI_RAW_SET`) controls plain `T<reg>/set`:

- `"all"` (the default): any read/write register the model allows
- `"none"`: no plain writes; recommended once nibepi-ha is in use
- a list of registers: only those

A leased register always refuses plain writes.

## Health file

Every minute the gateway writes `NIBEPI_HEALTH_FILE` (default
`/dev/shm/nibepi-health.json`) atomically:

```json
{"ts": 1760100000000, "core": "up", "model": "F1255", "lastData": 1760099990000,
 "restarts": 0, "busHealth": {"ok": 120, "chksum": 0, "no_respond": 0, "errors": 0, "timestamp": 1760099960000},
 "controllers": {}}
```

`core` is `starting`, `up` or `down`. A `HEALTHCHECK` can check that `ts` and
`lastData` are recent. `/dev/shm` does not exist on macOS, so set
`NIBEPI_HEALTH_FILE` when running there.

## Status page

With `NIBEPI_UI_PORT` set (the Docker image sets `8080`), the gateway serves
a read-only status page at `http://<pi>:8080/`. It shows the following, and
refreshes every 5 seconds while the tab is visible:

- **Connection:** core state and restarts, serial port or NibeGW, pump
  model and firmware, age of the last data from the pump, MQTT broker,
  topic and user, connect history and last error, and the `raw_set` policy
- **Bus health:** the last minute, and sparklines of OK frames and errors
  over the last hour
- **Virtual RMU40:** per system, whether the pump polls it and whether
  NibePi answers (`emulated`) or stays silent (`read-only`: another RMU40
  answers, or `system.rmu_emulation` is `false`), the last pump poll, the
  room temperature register (10060, ...), the last write to it and its lease
- **Leases:** every leasable register, with a countdown to expiry
- **Recent errors and warnings:** kept in memory (the last 200 warnings and
  errors, and the last 500 lines at info and above), filterable
- **Key values:** BT1, BT2, BT3, BT6, BT7, BT50, curve offset 47011 and
  priority 43086, when they are polled

A banner shows when the core is down, MQTT is disconnected, or the pump has
sent nothing for 10 minutes.

| endpoint | returns |
|---|---|
| `GET /` | the page: one file, no external resources, works offline |
| `GET /api/status` | the snapshot as JSON |
| `GET /api/log?level=warn&limit=200` | kept log lines, newest first; `level` is `info`, `warn` or `error`, `limit` at most 500 |
| `GET /healthz` | `200` when the pump has answered in the last 10 minutes (the `HEALTHCHECK` rule), else `503`. No auth. |

The page changes nothing: every endpoint is `GET`. The MQTT and UI
passwords never appear in it. The status JSON only says whether a password
is set, and both passwords are masked in every log line (on stdout and in
the file too). Without `NIBEPI_UI_USER`/`NIBEPI_UI_PASS` anyone who can reach
the port can read it, so keep it on the LAN and don't forward it to the
internet. Basic auth over plain HTTP is not encrypted. For access from
outside, put it behind a VPN or an HTTPS reverse proxy.

## Connecting to the pump

| mode | how |
|---|---|
| `serial` | RS485 adapter on a serial port, 9600 baud |
| `nibegw` | UDP from a NibeGW. The gateway listens on `nibegw.port` (9999) and sends reads to 10000 and writes to 10001 on the NibeGW host. |

The `nibegw` mode works with the original
[NibeGW](https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.nibeheatpump)
and with [elupus/esphome-nibe](https://github.com/elupus/esphome-nibe). For
esphome-nibe, set `read_port` and `write_port` to `10000` and `10001`, and
add the gateway's host to its `source:` list. Otherwise esphome-nibe drops
the requests without replying.

To enable Modbus on the pump, use the pump's own display:

1. Hold **Back** for about 7 seconds to reveal the service menu.
2. Go to **5.2 System settings**. On some models there is one more menu
   level.
3. Tick **Modbus**, near the bottom of the list. The pump may show an alarm
   until the gateway answers it, which can take a couple of minutes.

For wiring (12 V, A, B, GND), see Nibe's documentation:
<https://www.nibe.fi/nibedocuments/15050/031725-6.pdf>

## Supported pumps

Register tables ship for these models:

- F370, F470, F730, F750
- F1145, F1155, F1245, F1255, F1345, F1355
- VVM225, VVM310, VVM320, VVM325, VVM500, VVM S320
- SMO40, HMA60, SHK200S, STAR12, Tehowatti Air, VPK8R
- RMU40 S1–S4

The tables describe what a model *can* expose. A register that your pump's
firmware or accessories don't provide never replies. S-series pumps (Modbus
TCP) are no longer supported; see *History*.

## History

The gateway was the backend of the Node-RED version of NibePi. Node-RED is
retired: node-red-contrib-nibepi and nibepi-flow are archived. Everything that
only the Node-RED version needed was removed from this repository:

- graph saving
- the Node-RED integration
- the read-only SD card handling
- the Modbus TCP core for S-series pumps
- per-plugin settings

The last state before the cleanup is tagged **`nodered-final`**, so every
removed file is still recoverable:

```sh
git show nodered-final:modbus-client.js
git checkout nodered-final -- lib/saveGraph.js
```

NibePi was originally written by Fredrik Anerdin as
[anerdins/nibepi](https://github.com/anerdins/nibepi). This repository is a
fork of [fnordpojk/nibepi-backend](https://github.com/fnordpojk/nibepi-backend).
The relationship is one-way: fixes from fnordpojk's upstream are pulled in
here, but nothing is sent back. The npm package is still named `nibepi`.

## License

MIT, as upstream. See [LICENSE](LICENSE).
