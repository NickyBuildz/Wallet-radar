// Wallet Radar — pure signal/parsing logic.
// No DOM and no Bluetooth APIs in this file: it is shared between the
// browser app (app.js) and the Node test suite (../test.mjs).

export const APPLE_COMPANY_ID = 0x004c;

// Apple BLE advertisement payloads are a sequence of TLV frames.
// Type 0x12 is the "Find My network" (offline finding) broadcast used by
// AirTags and third-party Find My accessories such as wallet tracking cards.
export const APPLE_FRAME_TYPES = {
  0x02: 'iBeacon',
  0x05: 'AirDrop',
  0x07: 'AirPods',
  0x09: 'AirPlay',
  0x0f: 'Nearby Action',
  0x10: 'Nearby Info',
  0x12: 'Find My',
};

export const FIND_MY_FRAME_TYPE = 0x12;

// 16-bit service UUIDs (in canonical 128-bit form) that identify common trackers.
export const SERVICE_HINTS = new Map([
  ['0000feed-0000-1000-8000-00805f9b34fb', 'Tile'],
  ['0000feaa-0000-1000-8000-00805f9b34fb', 'Eddystone beacon'],
  ['0000fe2c-0000-1000-8000-00805f9b34fb', 'Fast Pair'],
  ['0000fd5a-0000-1000-8000-00805f9b34fb', 'Samsung tag'],
  ['0000fd44-0000-1000-8000-00805f9b34fb', 'Apple NI'],
]);

/**
 * Parse Apple manufacturer data (a DataView) into TLV frames.
 * Never throws on malformed input; a frame whose declared length exceeds the
 * remaining bytes is flagged `truncated` and parsing stops.
 */
export function parseAppleFrames(view) {
  const frames = [];
  if (!view || typeof view.getUint8 !== 'function') return frames;
  let i = 0;
  while (i + 2 <= view.byteLength) {
    const type = view.getUint8(i);
    const length = view.getUint8(i + 1);
    const truncated = length > view.byteLength - (i + 2);
    frames.push({ type, length, truncated, label: APPLE_FRAME_TYPES[type] || null });
    if (truncated) break;
    i += 2 + length;
  }
  return frames;
}

/**
 * Summarize one advertisement's identity clues.
 * manufacturerData: Map<companyId, DataView> (as delivered by Web Bluetooth)
 * serviceUuids: array of canonical UUID strings.
 * Returns { apple, findMy, labels: [] }.
 */
export function summarizeAdvert({ manufacturerData, serviceUuids } = {}) {
  const summary = { apple: false, findMy: false, labels: [] };
  const add = (label) => {
    if (label && !summary.labels.includes(label)) summary.labels.push(label);
  };

  if (manufacturerData && typeof manufacturerData.forEach === 'function') {
    manufacturerData.forEach((view, companyId) => {
      if (companyId !== APPLE_COMPANY_ID) return;
      summary.apple = true;
      for (const frame of parseAppleFrames(view)) {
        if (frame.type === FIND_MY_FRAME_TYPE) summary.findMy = true;
        add(frame.label);
      }
    });
  }

  if (Array.isArray(serviceUuids)) {
    for (const uuid of serviceUuids) {
      add(SERVICE_HINTS.get(String(uuid).toLowerCase()));
    }
  }
  return summary;
}

/**
 * RSSI smoother: median-of-recent (kills single-packet outliers) feeding an
 * exponential moving average (smooth trend), with a timestamped history for
 * trend detection and sparklines.
 */
export class RssiFilter {
  constructor({ alpha = 0.25, medianWindow = 5, historyLimit = 400 } = {}) {
    this.alpha = alpha;
    this.medianWindow = medianWindow;
    this.historyLimit = historyLimit;
    this.raw = [];
    this.ema = null;
    this.history = []; // [{ t, v }]
  }

  push(rssi, t = 0) {
    if (!Number.isFinite(rssi)) return this.ema;
    this.raw.push(rssi);
    if (this.raw.length > this.medianWindow) this.raw.shift();
    const sorted = [...this.raw].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.ema = this.ema === null ? median : this.ema + this.alpha * (median - this.ema);
    this.history.push({ t, v: this.ema });
    if (this.history.length > this.historyLimit) this.history.shift();
    return this.ema;
  }

  get value() {
    return this.ema;
  }

  /** dB change across the trailing window: positive = signal rising = warmer. */
  trend(windowMs = 4000, now) {
    if (this.history.length < 2) return 0;
    const last = this.history[this.history.length - 1];
    const end = Number.isFinite(now) ? now : last.t;
    const cutoff = end - windowMs;
    let ref = this.history[0];
    for (const s of this.history) {
      if (s.t >= cutoff) {
        ref = s;
        break;
      }
    }
    if (last.t <= ref.t) return 0;
    return last.v - ref.v;
  }
}

/**
 * Log-distance path-loss estimate. txAt1m = expected RSSI at 1 m (calibratable),
 * pathLossExponent ~2.0 free space, ~2.2–3.0 indoors. Very rough by nature.
 */
export function estimateDistance(rssi, txAt1m = -59, pathLossExponent = 2.2) {
  if (!Number.isFinite(rssi)) return null;
  return Math.min(Math.pow(10, (txAt1m - rssi) / (10 * pathLossExponent)), 99);
}

/** Map RSSI to a 0–100 closeness percentage. */
export function proximityPercent(rssi, { min = -98, max = -42 } = {}) {
  if (!Number.isFinite(rssi)) return 0;
  const pct = ((rssi - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Ordered closest-first; bandFor picks the first entry with distance <= max.
export const BANDS = [
  { max: 0.6, key: 'here', label: 'Right here — dig around!' },
  { max: 1.5, key: 'hot', label: 'Very close' },
  { max: 4, key: 'warm', label: 'Close' },
  { max: 10, key: 'cool', label: 'In the area' },
  { max: Infinity, key: 'cold', label: 'Far / weak signal' },
];

export function bandFor(distance) {
  if (!Number.isFinite(distance)) return null;
  return BANDS.find((b) => distance <= b.max) || null;
}

export function formatDistance(d) {
  if (!Number.isFinite(d)) return '—';
  const ft = d * 3.28084;
  const ftText = ft < 10 ? ft.toFixed(1) : String(Math.round(ft));
  const mText = d < 10 ? d.toFixed(1) : String(Math.round(d));
  return `${ftText} ft · ${mText} m`;
}

/** Geiger-counter click spacing: 1.1 s when far, 90 ms when on top of it. */
export function clickIntervalMs(pct) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const maxMs = 1100;
  const minMs = 90;
  return Math.round(maxMs - (clamped / 100) * (maxMs - minMs));
}

export function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1500) return 'now';
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  return '>1 min ago';
}
