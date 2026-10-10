# nibepi-backend

The core of NibePi: everything between a Nibe heat pump and Node-RED. It speaks
the wire protocol, decodes and encodes registers, keeps a register database per
pump model, persists configuration, and optionally publishes to MQTT.

This is a library, not an application. It is installed as a dependency of
[node-red-contrib-nibepi](https://github.com/fnordpojk/node-red-contrib-nibepi),
which wraps it as Node-RED nodes.

Originally written by Fredrik Anerdin as
[anerdins/nibepi](https://github.com/anerdins/nibepi). Upstream development
stopped after 1.2.1; this fork continues from there. The npm package is still
named `nibepi`.

## The four repositories

| repo | what it is |
|---|---|
| **nibepi-backend** | this one: transport, protocol, register database, MQTT |
| [node-red-contrib-nibepi](https://github.com/fnordpojk/node-red-contrib-nibepi) | the Node-RED nodes |
| [nibepi-flow](https://github.com/fnordpojk/nibepi-flow) | the flows and dashboard built on those nodes |
| [nibepi-docker](https://github.com/fnordpojk/nibepi-docker) | container packaging for all of it |

## How it reaches the pump

Three transports, chosen with `connection.enable` in the config:

| mode | how | ports |
|---|---|---|
| `serial` | RS485 adapter on a serial port | — |
| `nibegw` | UDP frames from a NibeGW gateway | listens on 9999/udp; sends reads to 10000, writes to 10001 |
| `tcp` | Modbus TCP, for S-series (`connection.series: "sSeries"`) | as configured |

The `nibegw` mode works with the original
[NibeGW](https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.nibeheatpump)
hardware gateway and with
[elupus/esphome-nibe](https://github.com/elupus/esphome-nibe) on an ESP32. With
esphome-nibe, `read_port` and `write_port` must be `10000` and `10001`, and the
host running NibePi must appear in its `source:` list, or its requests are
dropped without a reply.

## Supported pumps

Register maps ship for:

- **F-series** — F370, F470, F730, F750, F1145, F1155, F1245, F1255, F1345, F1355
- **VVM** — VVM225, VVM310, VVM320, VVM325, VVM500, VVM S320
- **SMO** — SMO40
- **S-series** — S1255
- **Rebadged and OEM units** — HMA60, SHK200S, STAR12, Tehowatti Air, VPK8R
- **RMU40** room units as an accessory (S1–S4)

These are exports of Nibe's own register lists: they describe what a model
*can* expose, not what your unit answers. That depends on firmware and on which
accessories are fitted, and a register the pump does not have simply never
replies.

## Requirements

- Node.js 20 or newer
- An RS485 adapter, a NibeGW gateway, or Modbus TCP, depending on the transport
- On a Raspberry Pi: a 64-bit-capable board, so Zero 2 W or newer. Node.js no
  longer publishes 32-bit ARM builds.

## Configuration

State lives in `/etc/nibepi`:

| file | holds |
|---|---|
| `config.json` | connection, MQTT, logging, the polled register list, per-feature settings |
| `graph.json` | saved graph history |
| `vv_ai_profile.json` | the VV-AI hot water profile |

`default.json` in this repo is the template used when no config exists yet.

**`NIBEPI_DOCKER`** — set it to `1` when running in a container. Without it the
core assumes a bare Raspberry Pi with a read-only root filesystem and brackets
every config write in `sudo mount -o remount,rw /`. In a container that fails
and the write is lost silently. It can also be set as `system.docker` in the
config; the environment variable wins.

## Gateway mode: leases over MQTT

For control logic running elsewhere (a Home Assistant component), registers
are written through *leases* that fall back by themselves. `T` is
`mqtt.topic`, by default `nibe/modbus/`.

| topic | direction | payload |
|---|---|---|
| `T lease/<reg>/set` | → gateway | `{"value": -2, "ttl": 900, "owner": "ha"}`, not retained |
| `T lease/<reg>/release` | → gateway | anything, not retained |
| `T lease/<reg>/state` | gateway →, retained | `active, restoring, value, written, expires, baseline, neutral, owner, error` |
| `T gateway/state` | gateway →, retained, per minute | `version, leases, raw_set, core, lastData` |

- Only registers in the lease table can be leased: curve offsets 47011/47010
  (-10..10, restore to `home.adjust_s1`/`_s2`), 47041, 47134, 48132, and the
  cut-off frequency registers 48659–48664. `gateway.leases` in the config
  overrides entries (`{"<reg>": {"min", "max", "neutral", "min_interval"}}`,
  `null` removes one).
- The first request reads the current value from the pump as the baseline
  and persists it. The value is written when it changes, at most once per
  `min_interval` (the last value wins). `ttl` is clamped to 60..3600 s.
- Without renewal the lease expires and the register is restored to its
  neutral value, or else to the baseline; release does the same at once. A
  failed restore is retried with backoff.
- While leased, every other writer is refused: plain `T<reg>/set` and
  Node-RED (`setData` gets `Register <reg> is leased by <owner>`).
- `gateway.raw_set` limits plain `T<reg>/set`: `"all"` (default), `"none"`,
  or a list of registers.
- After a restart, a persisted baseline starts a grace lease of 900 s: renew
  within it, or the register is restored.

`node gateway.js` (`npm run gateway`) runs the backend without Node-RED:
core, MQTT, leases and `/dev/shm/nibepi-health.json`, logging to stdout. It
uses the same `/etc/nibepi/config.json`. Stopping it does not release
leases; the grace lease covers the restart.

## Enabling Modbus in the pump

Nothing works until the pump is told to talk. On the pump's own display:

1. Hold the **Back** button for about 7 seconds to reveal the service menu.
2. Go to **5.2 System settings** (on some models there is one more menu level).
3. Near the bottom of the list, tick **Modbus**.
4. The pump may show a red alarm until NibePi answers it, which can take a
   couple of minutes on first start.

For where to land the wires (12 V, A, B, GND) — it differs between models —
see Nibe's own documentation:
<https://www.nibe.fi/nibedocuments/15050/031725-6.pdf>

Photographs of the physical install are in the
[original repository](https://github.com/anerdins/nibepi).

## License

MIT, as upstream. See [LICENSE](LICENSE).
