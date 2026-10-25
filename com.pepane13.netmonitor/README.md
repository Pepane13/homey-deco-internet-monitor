# Deco & Internet Monitor — local Deco Wi-Fi, ISP box and Internet monitoring for Homey

Homey Pro app (SDK 3) that monitors a home network locally, without any cloud service: Internet quality (probes and speed tests), the French ISP boxes (Orange / Sosh Livebox 4-7, Bouygues Telecom Bbox, SFR Box) and TP-Link Deco mesh Wi-Fi. Read-only: the app never changes any setting on the box or the Deco. Dependency-free (Node.js built-ins only).

## Devices

| Driver | Measurements (Insights) | Flow triggers |
|---|---|---|
| **Internet quality** | Status, connectivity, latency, jitter, packet loss, LAN latency to the box, DNS time, download / upload / latency (speed test), outages and downtime today | Internet down (cause: `internet` / `lan`), Internet back (duration), speed test finished / failed, quality degraded / back to normal |
| **Internet box** (provider chosen before pairing) | Internet link, public IP, connection and box uptime, line state; real-time down / up traffic (Livebox, Bbox); Rx / Tx optical power (Livebox); native speed test (Livebox) | Fibre down / back, connection renewed, box rebooted, public IP changed, fibre signal low / back to normal |
| **Deco node** (one per node) | Online, clients on the node, client download / upload traffic and "Average traffic" tile indicator (rolling mean, window configurable); main Deco: clients total / 2.4 GHz / 5 GHz / wired, CPU, memory, Internet as seen by the Deco; wireless satellites: backhaul signal and speed | Node offline / online, backhaul weak / back to normal, device connected / disconnected |

Conditions: Internet available, quality good, fibre link up, Deco online, a device (name, IP or MAC) connected anywhere on the mesh. Actions: run a speed test (plain, or advanced card returning the results as tokens).

## Design notes

- **Probes** — Homey apps cannot send ICMP, so latency is the TCP handshake time to several anycast targets (default `1.1.1.1:443`, `8.8.8.8:443`, `9.9.9.9:443`). Internet is down only when *every* target fails during N consecutive rounds (N configurable), which removes false positives from a single unreachable endpoint. The box is probed separately to tell a LAN fault from an Internet outage. Jitter is computed per target, then the median is taken (samples to different servers are not comparable).
- **Alerts** — every threshold must be crossed N times in a row to raise an alert and to clear it (hysteresis). Latency samples taken while a speed test saturates the line are recorded but not evaluated. Download / upload thresholds are kept per speed-test source (Livebox: 500 / 400 Mbit/s, Homey: 60 / 60 Mbit/s by default); a source change restarts the speed alert counters.
- **Speed test** — two sources. *Livebox* (default when a Livebox device is paired): the box's native test (`AutoDiag:executeDiagnostics` `speedService`, results from `SpeedTest:getWANResults`), measured by the box towards Orange servers, so the full line speed is measured. *Homey*: binary-free test against Cloudflare's public speed endpoints (`/__down`, `/__up`), 4 parallel streams, 1 s of TCP slow start discarded; capped at ~94 Mbit/s on Homey Pro (Early 2023), whose Ethernet adapter is 100 Mbit/s. In automatic mode the Homey test is the fallback when the Livebox test fails. The Deco speed test is only reachable through the TP-Link cloud, so it is not used.
- **Livebox 5** — Sagemcom `sysbus` JSON API (`/ws`, `createContext` login, `X-Context` header). WAN status, ONT GPON MIBs (optical power), DHCP uptime, `getNetDevStats` counters. The 32-bit traffic counters wrap every ~34 s at 1 Gbit/s, so they are read every 10 s; a jump above 2.5 Gbit/s is treated as a counter reset.
- **Bbox** — REST API `/api/v1` (`wan/ip`, `wan/ip/stats`, `device`) over HTTPS with the box's self-signed certificate; read from the LAN without login, admin password used only on HTTP 401 (`BBOX_ID` cookie). A refused password is never retried, since each failed login extends the Bbox lockout. 64-bit traffic counters.
- **SFR Box** — XML API `/api/1.0/?method=` (`wan.getInfo`, `system.getInfo`, `ftth.getInfo`), public on the LAN; token + HMAC-SHA256 login only if a firmware requires it. No traffic counters or optical power in this API.
- **Deco** — LuCI JSON API of the main Deco: RSA PKCS#1 v1.5 (password and request signature, implemented with `BigInt`), AES-128-CBC payloads, `sysauth` cookie + `stok`. The Deco accepts **only the owner account** and a single owner session: all Deco devices share one session and one polling loop (`lib/decohub.js`), and each login logs the owner out of the Deco mobile app — use a manager account in the app. Firmwares that only expose the legacy encrypted web session (HTTP 401 on `/login?form=keys`, seen on some Deco S7) are reported as unsupported. Each node's settings show its IP, role, MAC, model and firmware; client rates (`down_speed` / `up_speed`, kbit/s) are summed per node.
- Self-signed HTTPS certificates are accepted only for private (RFC 1918) addresses, never for Internet hosts.

## Repository content

| Path | Purpose |
|---|---|
| `com.pepane13.netmonitor/` | Homey app "Deco & Internet Monitor" |
| `com.pepane13.netmonitor/lib/boxes.js` | Provider registry (Orange, Sosh, Bouygues, SFR) |
| `com.pepane13.netmonitor/lib/livebox.js` | Livebox 4-7 sysbus client |
| `com.pepane13.netmonitor/lib/bbox.js` | Bbox REST client |
| `com.pepane13.netmonitor/lib/sfrbox.js` | SFR Box XML client |
| `com.pepane13.netmonitor/lib/deco.js` | TP-Link Deco client (RSA + AES) |
| `com.pepane13.netmonitor/lib/decohub.js` | Shared Deco session and polling |
| `com.pepane13.netmonitor/lib/probe.js` | TCP / DNS probes |
| `com.pepane13.netmonitor/lib/speedtest.js` | Cloudflare speed test |
| `com.pepane13.netmonitor/lib/monitor.js` | Outage tracker, threshold watch, counter rates (pure, unit-tested) |
| `tools/build-manifest.js` | Generates `app.json` (single source of truth): `node tools/build-manifest.js` |
| `test/protocol.test.js` | Protocol tests against local fake Livebox / Deco / speed servers: `node test/protocol.test.js` |
| `test/device.test.js` | Device tests (Homey mock + fakes): `node test/device.test.js` |

## Install (development)

```
cd com.pepane13.netmonitor
homey app validate --level publish
homey app install
```

Then add the devices in Homey: *Internet quality* (no settings), *Internet box* (choose the provider, then IP and password if needed), *Deco node* (main Deco IP and owner password, then select the nodes).

## Credits

Protocol knowledge from [LiveboxMonitor](https://github.com/p-dor/LiveboxMonitor) (Livebox sysbus), [bbox-cli](https://github.com/hadamrd/bbox-cli) (Bbox API), [sfrbox-api](https://github.com/hacf-fr/sfrbox-api) (SFR Box API) and [ha-tplink-deco](https://github.com/amosyuen/ha-tplink-deco) (Deco LuCI API). No code copied; reimplemented in dependency-free JavaScript.

## License

GPL-3.0-or-later
