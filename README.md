# 📡 Wallet Radar

A find-my-style **hot/cold Bluetooth radar** that runs in your browser. It listens for BLE
broadcasts — including the **Find My network frames** that AirTags and Find My wallet cards
emit — and guides you to the tracker with a live proximity radar, warmer/colder trend,
Geiger-counter clicks that speed up as you close in, and vibration (Android).

No dependencies, no build step, nothing leaves your network.

## Quick start

Clone this repo, then:

```bash
node server.js
```

Requires Node 16+ and nothing else — zero dependencies, no install step. The terminal prints two URLs:

- `http://localhost:4747` — open on this computer
- `http://<your-LAN-IP>:4747` — open on a phone on the same Wi-Fi

Want to feel the UI before doing Bluetooth setup? Open `http://localhost:4747/?demo=1`
for a simulated hunt with fake signals.

## One-time Bluetooth setup (2 minutes)

Browsers gate BLE *scanning* behind a flag. The app detects what your browser supports and
its **Help & setup** panel walks you through it, but in short:

| Device | What to do |
|---|---|
| **Laptop/desktop** (Chrome/Edge) | `chrome://flags/#enable-experimental-web-platform-features` → Enabled → Relaunch. `localhost` needs nothing else. **macOS caveat:** Chrome on Macs often accepts the scan permission but never delivers passive-scan results (a long-standing Chrome gap) — if “Start scanning” times out, use **＋ Add one device** instead (picker mode, works on Macs; tracking is identical). macOS must also allow the browser Bluetooth access (System Settings → Privacy & Security → Bluetooth). |
| **Android phone** (Chrome) | Same flag as above, **plus** `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add `http://<your-LAN-IP>:4747` (needed because the page is served over plain HTTP on your LAN). |
| **iPhone/iPad** | Apple blocks Web Bluetooth in all iOS browsers. Use a laptop or Android device — or try the free “Bluefy – Web BLE Browser” app (its “Add one device” picker mode works; full scanning varies by version). |

## Finding a Find My wallet card — the crucial trick

Find My trackers are **silent while connected to their owner's iPhone**, and if Find My
shows the item as seen "Now", it *is* connected. Before hunting:

1. Turn **off Bluetooth on the iPhone the card is paired to** (Settings → Bluetooth — the
   real switch, not Control Center).
2. Wait 1–2 minutes; the card starts broadcasting and appears with a green **Find My** badge.
3. Tap **🎯 Track strongest Find My signal** and walk the house slowly. Warmer ▲ = keep
   going; Colder ▼ = turn back. Trackers rotate their Bluetooth address every ~15 minutes,
   which is why the auto mode follows the *strongest Find My broadcast* instead of a fixed
   address.

Hunting tips: pause 3–5 s per spot (the signal is noisy — trust the trend, not blips), rotate
in place (your body blocks signal), and remember cushions/drawers/metal muffle it — "Very
close" can still mean buried. For better distance numbers, hold a known tracker ~1 m away and
tap **Calibrate at 1 m**.

## What it can and can't do

- ✅ Detect and identify Find My-network broadcasts (Apple manufacturer frame `0x12`), Tile,
  Samsung tags, Eddystone beacons, and any other BLE advertiser.
- ✅ Live smoothed signal strength (median + EMA filter), distance estimate, trend, sparkline.
- ❌ It cannot make the card beep (Apple keeps that command private to Find My) and cannot
  give compass direction (that requires Ultra-Wideband hardware, which cards lack).

## Development

```bash
node test.mjs   # unit tests for the signal/parsing logic (no deps)
```

- `server.js` — zero-dependency static file server, binds `0.0.0.0`, prints LAN URLs.
- `public/core.js` — pure logic: Apple TLV frame parsing, RSSI median+EMA filter, trend,
  log-distance path-loss estimate, proximity bands. Shared by app and tests.
- `public/app.js` — Web Bluetooth wiring (`requestLEScan` passive scan with
  `watchAdvertisements` fallback), radar UI, audio/vibration, wake lock, demo mode.
