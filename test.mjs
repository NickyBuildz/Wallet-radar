// Unit tests for the pure signal logic in public/core.js.
// Run with:  node test.mjs   (no dependencies)

import assert from 'node:assert/strict';
import {
  APPLE_COMPANY_ID,
  parseAppleFrames,
  summarizeAdvert,
  RssiFilter,
  estimateDistance,
  proximityPercent,
  bandFor,
  BANDS,
  formatDistance,
  clickIntervalMs,
  agoText,
} from './public/core.js';

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const dv = (...bytes) => {
  const u8 = new Uint8Array(bytes);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
};

/* ------------------------------------------------------------- distance */

t('estimateDistance: rssi equal to txAt1m is exactly 1 m', () => {
  assert.equal(estimateDistance(-59, -59, 2.0), 1);
});

t('estimateDistance: -20 dB below txAt1m at n=2 is 10 m', () => {
  assert.ok(Math.abs(estimateDistance(-79, -59, 2.0) - 10) < 1e-9);
});

t('estimateDistance: capped at 99 m and null on bad input', () => {
  assert.equal(estimateDistance(-140, -59, 2.0), 99);
  assert.equal(estimateDistance(NaN), null);
  assert.equal(estimateDistance(undefined), null);
});

t('proximityPercent: clamps to [0,100], midpoint correct', () => {
  assert.equal(proximityPercent(-42), 100);
  assert.equal(proximityPercent(-30), 100);
  assert.equal(proximityPercent(-98), 0);
  assert.equal(proximityPercent(-120), 0);
  assert.equal(proximityPercent(-70), 50); // (-70+98)/56 = 0.5
  assert.equal(proximityPercent(NaN), 0);
});

t('bandFor: bands are ordered closest-first and boundaries hold', () => {
  assert.equal(bandFor(0.3).key, 'here');
  assert.equal(bandFor(0.61).key, 'hot');
  assert.equal(bandFor(2).key, 'warm');
  assert.equal(bandFor(7).key, 'cool');
  assert.equal(bandFor(50).key, 'cold');
  assert.equal(bandFor(NaN), null);
  for (let i = 1; i < BANDS.length; i++) {
    assert.ok(BANDS[i].max > BANDS[i - 1].max, 'bands ascend');
  }
});

t('formatDistance: feet + meters, em dash on bad input', () => {
  assert.match(formatDistance(1), /3\.3 ft · 1\.0 m/);
  assert.equal(formatDistance(NaN), '—');
});

t('clickIntervalMs: 1100 ms far, 90 ms on top, monotonic', () => {
  assert.equal(clickIntervalMs(0), 1100);
  assert.equal(clickIntervalMs(100), 90);
  assert.equal(clickIntervalMs(50), 595);
  assert.ok(clickIntervalMs(30) > clickIntervalMs(60));
  assert.equal(clickIntervalMs(NaN), 1100);
});

t('agoText: buckets', () => {
  assert.equal(agoText(500), 'now');
  assert.equal(agoText(5000), '5s ago');
  assert.equal(agoText(120000), '>1 min ago');
  assert.equal(agoText(-5), '—');
});

/* ----------------------------------------------------------- rssi filter */

t('RssiFilter: median rejects a single outlier packet', () => {
  const f = new RssiFilter();
  [-70, -71, -95, -70, -69].forEach((v, i) => f.push(v, i * 100));
  assert.ok(f.value > -78, `expected > -78, got ${f.value}`);
  assert.equal(f.history.length, 5);
});

t('RssiFilter: ignores non-finite pushes', () => {
  const f = new RssiFilter();
  f.push(-70, 0);
  const before = f.value;
  f.push(NaN, 100);
  f.push(undefined, 200);
  assert.equal(f.value, before);
  assert.equal(f.history.length, 1);
});

t('RssiFilter: trend positive when rising, negative when falling', () => {
  const rising = new RssiFilter();
  for (let i = 0; i <= 30; i++) rising.push(-90 + i, i * 100);
  assert.ok(rising.trend(4000, 3000) > 5, `rising trend ${rising.trend(4000, 3000)}`);

  const falling = new RssiFilter();
  for (let i = 0; i <= 30; i++) falling.push(-60 - i, i * 100);
  assert.ok(falling.trend(4000, 3000) < -5, `falling trend ${falling.trend(4000, 3000)}`);
});

t('RssiFilter: trend is 0 with fewer than 2 samples', () => {
  const f = new RssiFilter();
  assert.equal(f.trend(4000, 0), 0);
  f.push(-70, 0);
  assert.equal(f.trend(4000, 0), 0);
});

t('RssiFilter: history bounded by historyLimit', () => {
  const f = new RssiFilter({ historyLimit: 10 });
  for (let i = 0; i < 50; i++) f.push(-70, i);
  assert.equal(f.history.length, 10);
});

/* ---------------------------------------------------------- apple frames */

t('parseAppleFrames: recognises a Find My (0x12) frame', () => {
  const payload = [0x12, 0x19, ...new Array(25).fill(0)];
  const frames = parseAppleFrames(dv(...payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 0x12);
  assert.equal(frames[0].length, 25);
  assert.equal(frames[0].truncated, false);
  assert.equal(frames[0].label, 'Find My');
});

t('parseAppleFrames: multiple TLVs, truncated tail flagged without throwing', () => {
  const payload = [0x10, 0x02, 0x00, 0x00, 0x12, 0x19, 0x01, 0x02, 0x03];
  const frames = parseAppleFrames(dv(...payload));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, 0x10);
  assert.equal(frames[0].truncated, false);
  assert.equal(frames[1].type, 0x12);
  assert.equal(frames[1].truncated, true);
});

t('parseAppleFrames: empty / tiny / absent input is safe', () => {
  assert.deepEqual(parseAppleFrames(dv()), []);
  assert.deepEqual(parseAppleFrames(dv(0xff)), []);
  assert.deepEqual(parseAppleFrames(null), []);
  assert.deepEqual(parseAppleFrames(undefined), []);
});

t('summarizeAdvert: flags Apple + Find My from manufacturer data', () => {
  const mfg = new Map([[APPLE_COMPANY_ID, dv(0x12, 0x19, ...new Array(25).fill(0))]]);
  const s = summarizeAdvert({ manufacturerData: mfg, serviceUuids: [] });
  assert.equal(s.apple, true);
  assert.equal(s.findMy, true);
  assert.ok(s.labels.includes('Find My'));
});

t('summarizeAdvert: non-Apple company is not flagged', () => {
  const mfg = new Map([[0x0057, dv(0x12, 0x19, ...new Array(25).fill(0))]]);
  const s = summarizeAdvert({ manufacturerData: mfg, serviceUuids: [] });
  assert.equal(s.apple, false);
  assert.equal(s.findMy, false);
});

t('summarizeAdvert: service UUID hints (Tile), case-insensitive', () => {
  const s = summarizeAdvert({
    serviceUuids: ['0000FEED-0000-1000-8000-00805F9B34FB'],
  });
  assert.ok(s.labels.includes('Tile'));
});

t('summarizeAdvert: tolerates missing/undefined input', () => {
  assert.deepEqual(summarizeAdvert(), { apple: false, findMy: false, labels: [] });
  assert.deepEqual(summarizeAdvert({}), { apple: false, findMy: false, labels: [] });
});

console.log(`\n${passed} checks passed ✔`);
