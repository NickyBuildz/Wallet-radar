// Wallet Radar — browser app: Web Bluetooth wiring + UI.
// All pure signal logic lives in core.js so it can be unit-tested in Node.

import {
  RssiFilter,
  summarizeAdvert,
  estimateDistance,
  proximityPercent,
  bandFor,
  BANDS,
  formatDistance,
  clickIntervalMs,
  agoText,
} from './core.js';

/* ---------------------------------------------------------------- helpers */

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const AUTO_TRACK_ON_LOAD = params.get('track') === '1';

/* ------------------------------------------------------------ capability */

const ua = navigator.userAgent || '';
const isIOS =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS pretends to be a Mac
const isMac = !isIOS && /Mac/i.test(navigator.platform || ua);

const support = {
  secure: window.isSecureContext === true,
  bluetooth: 'bluetooth' in navigator,
  scanning: !!(navigator.bluetooth && typeof navigator.bluetooth.requestLEScan === 'function'),
  watching:
    typeof BluetoothDevice !== 'undefined' &&
    'watchAdvertisements' in BluetoothDevice.prototype,
  vibrate: typeof navigator.vibrate === 'function',
  ios: isIOS,
};

/* ----------------------------------------------------------------- state */

const devices = new Map(); // id -> record
let mode = null; // null | 'scan' | 'watch' | 'demo'
let leScan = null;
const watchedDevices = [];
let scanStartedAt = null;
let lastAdvertAt = null;
let scanError = null; // persistent, user-visible reason the last scan attempt failed
let bannerForce = false; // show "Try passive scan anyway" in the problem banner
let bannerReload = false; // show "Reload page" in the problem banner (wedged tab)
let adapterAvailable = null; // getAvailability() result: true/false, null = unknown

let tracking = null; // { auto: bool, targetId: string|null }
let lastBandIdx = null;
let lastPct = 0;
let trackingFresh = false;

let audioOn = false;
let audioCtx = null;
let nextClickAt = 0;
let vibrateOn = true;

let wakeLock = null;
let demoTimer = null;
let demoTick = 0;

const DEFAULT_SETTINGS = { txAt1m: -59, pathLoss: 2.2, findMyOnly: false };
let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem('walletRadarSettings') || '{}');
  settings = { ...DEFAULT_SETTINGS, ...saved };
} catch {
  /* private mode etc. */
}
function saveSettings() {
  try {
    localStorage.setItem('walletRadarSettings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------- elements */

const els = {
  statusPill: $('status-pill'),
  btnHelp: $('btn-help'),

  screenSetup: $('screen-setup'),
  supportList: $('support-list'),
  setupInstructions: $('setup-instructions'),
  btnRecheck: $('btn-recheck'),

  screenScan: $('screen-scan'),
  btnScan: $('btn-scan'),
  btnAddDevice: $('btn-add-device'),
  btnStop: $('btn-stop'),
  btnAuto: $('btn-auto'),
  chkFindMyOnly: $('chk-findmy-only'),
  deviceList: $('device-list'),
  scanEmpty: $('scan-empty'),
  scanStalled: $('scan-stalled'),
  scanStalledText: $('scan-stalled-text'),
  btnRestartScan: $('btn-restart-scan'),
  btnForceScan: $('btn-force-scan'),
  btnReloadPage: $('btn-reload-page'),
  scanCounts: $('scan-counts'),
  tipCard: $('tip-card'),
  btnTipDismiss: $('btn-tip-dismiss'),
  noStreamBanner: $('no-stream-banner'),
  adapterNote: $('adapter-note'),

  screenTrack: $('screen-track'),
  btnBack: $('btn-back'),
  trackName: $('track-name'),
  trackBadges: $('track-badges'),
  radar: $('radar'),
  trackDistance: $('track-distance'),
  trackBand: $('track-band'),
  trackRssi: $('track-rssi'),
  trackRaw: $('track-raw'),
  trackTrend: $('track-trend'),
  trackAgo: $('track-ago'),
  spark: $('spark'),
  btnSound: $('btn-sound'),
  btnVibrate: $('btn-vibrate'),
  btnCalibrate: $('btn-calibrate'),
  calibratePanel: $('calibrate-panel'),
  inpTx: $('inp-tx'),
  inpN: $('inp-n'),
  nOut: $('n-out'),
  btnCal1m: $('btn-cal-1m'),
  trackHint: $('track-hint'),

  modalHelp: $('modal-help'),
  helpContent: $('help-content'),
  btnHelpClose: $('btn-help-close'),

  toast: $('toast'),
  footerDemoLink: $('footer-demo-link'),
};

const DEFAULT_EMPTY_HTML = els.scanEmpty.innerHTML;
let emptyStateFiltered = false;

/* ----------------------------------------------------------------- toast */

let toastTimer = null;
function showToast(msg, ms = 6000) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function explainError(err) {
  const name = err && err.name;
  if (name === 'TimeoutError') {
    return isMac
      ? 'Chrome took the scan permission but never started delivering results — a known Chrome-on-macOS gap in passive scanning. Reload this page (the stuck request jams this tab’s Bluetooth), then use “＋ Add one device” and pick the strongest unnamed entry — add several if unsure; Find My ones get badged automatically.'
      : 'The scan never started (timed out), and the stuck request can jam this tab’s Bluetooth. Reload the page, then try again — or use “＋ Add one device” instead; tracking works the same.';
  }
  if (name === 'NotAllowedError') {
    return 'Bluetooth permission was blocked. Tap the button again and choose “Allow”. If no prompt appears, check this site’s permissions in browser settings.';
  }
  if (name === 'SecurityError') {
    return 'The browser refused Bluetooth on this origin. Open “Help & setup” — you likely need the “treat insecure origin as secure” flag for this address.';
  }
  if (name === 'NotSupportedError' || name === 'TypeError') {
    return 'This browser can’t stream Bluetooth advertisements. Open “Help & setup” for the one-time Chrome flag (or use a laptop / Android phone).';
  }
  if (name === 'InvalidStateError') {
    return 'Bluetooth is off or unavailable. Turn on Bluetooth on THIS device, then try again.';
  }
  return `Bluetooth error: ${err && err.message ? err.message : err}`;
}

/* --------------------------------------------------------------- screens */

function screenTo(name) {
  els.screenSetup.classList.toggle('hidden', name !== 'setup');
  els.screenScan.classList.toggle('hidden', name !== 'scan');
  els.screenTrack.classList.toggle('hidden', name !== 'track');
  document.body.dataset.screen = name;
  if (name === 'track') sizeSparkline();
}

function setStatusPill() {
  let text = 'Idle';
  let cls = '';
  if (mode === 'demo') {
    text = 'Demo';
    cls = 'on';
  } else if (mode === 'scan') {
    text = 'Scanning';
    cls = 'on';
  } else if (mode === 'watch') {
    text = `Watching ${watchedDevices.length}`;
    cls = 'on';
  }
  els.statusPill.textContent = text;
  els.statusPill.classList.toggle('live', cls === 'on');
}

/* -------------------------------------------------------- advert intake */

function upsertAdvert({ id, name, rssi, txPower, manufacturerData, uuids }) {
  const now = performance.now();
  lastAdvertAt = now;
  let rec = devices.get(id);
  if (!rec) {
    rec = {
      id,
      name: null,
      filter: new RssiFilter(),
      lastSeen: 0,
      lastRaw: null,
      txPower: null,
      summary: { apple: false, findMy: false, labels: [] },
      findMyEver: false,
      firstSeen: now,
    };
    devices.set(id, rec);
  }
  if (name) rec.name = name;
  if (Number.isFinite(rssi)) {
    rec.lastRaw = rssi;
    rec.filter.push(rssi, now);
    rec.lastSeen = now;
  }
  if (Number.isFinite(txPower)) rec.txPower = txPower;

  const summary = summarizeAdvert({ manufacturerData, serviceUuids: uuids });
  if (summary.apple) rec.summary.apple = true;
  if (summary.findMy) {
    rec.summary.findMy = true;
    rec.findMyEver = true; // sticky: Find My frames alternate with others
  }
  for (const label of summary.labels) {
    if (!rec.summary.labels.includes(label)) rec.summary.labels.push(label);
  }
}

function onAdvert(event) {
  try {
    upsertAdvert({
      id: event.device && event.device.id ? event.device.id : 'unknown',
      name: event.name || (event.device && event.device.name) || null,
      rssi: event.rssi,
      txPower: event.txPower,
      manufacturerData: event.manufacturerData,
      uuids: event.uuids,
    });
  } catch (err) {
    console.error('advert handling failed', err);
  }
}

/* -------------------------------------------------------------- scanning */

const SCAN_START_TIMEOUT_MS = 8000;

// requestLEScan is known to hang forever on some platforms (notably Chrome on
// macOS): the permission chip appears, the user allows, and the promise never
// settles. Race it against a timeout so the UI can fail loudly with a
// workaround instead of freezing. onLate handles a success that arrives after
// we already gave up, so a zombie result can be disposed of.
function withTimeout(promise, ms, onLate) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new DOMException('Timed out', 'TimeoutError'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (settled) {
          if (onLate) onLate(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    );
  });
}

async function startScanning(force = false) {
  if (DEMO) {
    startDemo();
    return;
  }
  if (!support.scanning) {
    scanError =
      'Scanning isn’t enabled in this browser yet — open Help & setup and follow the laptop/desktop steps (one Chrome flag, then a full Relaunch).';
    showToast(scanError);
    renderList();
    openHelp();
    return;
  }
  // On macOS, Chrome's passive scan is broken in a dangerous way: the request
  // hangs forever AND blocks every later Bluetooth request in this tab (which
  // makes the picker button look dead too). So on Macs we don't even try
  // unless the user explicitly forces it — the picker is the Mac path.
  if (isMac && !force) {
    scanError =
      'Chrome on macOS can’t passive-scan (a long-standing Chrome gap; trying can even jam this tab’s Bluetooth until reload). “＋ Add one device” is the Mac path — it opens Chrome’s device picker, and tracking works identically.';
    bannerForce = true;
    bannerReload = false;
    showToast('On Macs, use “＋ Add one device” — Chrome’s passive scanning is broken on macOS.', 7000);
    renderList();
    return;
  }
  els.btnScan.disabled = true;
  els.statusPill.textContent = 'Starting…';
  try {
    leScan = await withTimeout(
      navigator.bluetooth.requestLEScan({
        acceptAllAdvertisements: true,
        keepRepeatedDevices: true,
      }),
      SCAN_START_TIMEOUT_MS,
      (scan) => {
        // Late success after we already gave up — don't leak a zombie scan.
        try {
          scan.stop();
        } catch {
          /* ignore */
        }
      }
    );
    // remove-then-add so a restarted scan never double-registers the listener
    navigator.bluetooth.removeEventListener('advertisementreceived', onAdvert);
    navigator.bluetooth.addEventListener('advertisementreceived', onAdvert);
    scanError = null;
    bannerForce = false;
    bannerReload = false;
    mode = 'scan';
    scanStartedAt = performance.now();
    renderControls();
    showToast('Scanning started — devices appear below as they broadcast.', 4000);
  } catch (err) {
    console.error(err);
    scanError = explainError(err);
    bannerForce = false;
    // A timed-out request stays pending inside Chrome and blocks all further
    // Bluetooth calls in this tab — only a page reload clears it.
    bannerReload = err && err.name === 'TimeoutError';
    showToast(scanError, 9000);
    renderControls();
    renderList();
  }
}

async function addWatchedDevice() {
  try {
    showToast('Opening Chrome’s device picker…', 2500);
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
    if (watchedDevices.includes(device)) {
      await device.watchAdvertisements();
      showToast('Already watching that device — re-armed it.');
      return;
    }
    if (typeof device.watchAdvertisements !== 'function') {
      showToast(
        'This browser can pick a device but can’t stream its signal strength (watchAdvertisements missing). Use Chrome on a laptop or Android — see Help & setup.'
      );
      return;
    }
    device.addEventListener('advertisementreceived', onAdvert);
    await device.watchAdvertisements();
    watchedDevices.push(device);
    if (mode !== 'scan') mode = 'watch';
    scanError = null;
    scanStartedAt = scanStartedAt || performance.now();
    renderControls();
    showToast(
      `Watching “${device.name || 'unnamed device'}” — its signal shows in the list below. Add as many as you like; Find My broadcasts get badged automatically.`,
      6000
    );
  } catch (err) {
    // Only a genuine chooser dismissal is silent. Chrome also uses
    // NotFoundError for "a request is already in progress" (a wedged tab) —
    // swallowing that made this button look dead.
    if (err && err.name === 'NotFoundError' && /cancel/i.test(err.message || '')) return;
    console.error(err);
    if (err && /already in progress|pending/i.test(err.message || '')) {
      scanError =
        'Chrome says another Bluetooth request is still stuck in this tab (a jammed scan attempt does this). Reload the page, then tap ＋ Add one device first.';
    } else {
      scanError = explainError(err);
    }
    bannerForce = false;
    bannerReload = true; // reload is the safe generic remedy for a wedged tab
    showToast(scanError, 9000);
    renderList();
  }
}

function stopScanning() {
  scanError = null;
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
  if (leScan) {
    try {
      leScan.stop();
    } catch {
      /* already stopped */
    }
    leScan = null;
  }
  for (const device of watchedDevices) {
    try {
      if (typeof device.unwatchAdvertisements === 'function') device.unwatchAdvertisements();
    } catch {
      /* ignore */
    }
  }
  watchedDevices.length = 0;
  mode = null;
  scanStartedAt = null;
  renderControls();
}

async function restartScan() {
  if (DEMO) {
    startDemo();
    return;
  }
  if (mode === 'watch' || (!leScan && watchedDevices.length)) {
    for (const device of watchedDevices) {
      try {
        await device.watchAdvertisements();
      } catch (err) {
        console.error(err);
      }
    }
    showToast('Re-armed watched devices.');
    return;
  }
  if (leScan) {
    try {
      leScan.stop();
    } catch {
      /* ignore */
    }
    leScan = null;
  }
  await startScanning();
}

/* ------------------------------------------------------------------ demo */

function demoMfg(frameType, len) {
  const bytes = new Uint8Array(2 + len);
  bytes[0] = frameType;
  bytes[1] = len;
  return new Map([[0x004c, new DataView(bytes.buffer)]]);
}

function startDemo() {
  if (demoTimer) clearInterval(demoTimer);
  mode = 'demo';
  scanStartedAt = performance.now();
  demoTick = 0;
  demoTimer = setInterval(() => {
    demoTick += 1;
    const t = (demoTick * 350) / 1000; // seconds since demo scan start
    const noise = () => (Math.random() - 0.5) * 7;

    // Your "wallet": starts far, walks closer over ~30 s, then hovers nearby.
    const walletRssi = Math.max(
      -95,
      Math.min(-42, -86 + Math.min(38, t * 1.25) + Math.sin(t / 4) * 2.5 + noise())
    );
    upsertAdvert({
      id: 'demo-wallet-card',
      name: null,
      rssi: walletRssi,
      manufacturerData: demoMfg(0x12, 0x19),
      uuids: [],
    });

    if (demoTick % 2 === 0) {
      upsertAdvert({
        id: 'demo-airtag-keys',
        name: null,
        rssi: -89 + Math.sin(t / 6) * 2 + noise() * 0.5,
        manufacturerData: demoMfg(0x12, 0x19),
        uuids: [],
      });
      upsertAdvert({
        id: 'demo-speaker',
        name: 'Kitchen Speaker',
        rssi: -70 + noise() * 0.6,
        manufacturerData: demoMfg(0x10, 0x05),
        uuids: [],
      });
    }
    if (demoTick % 3 === 0) {
      upsertAdvert({
        id: 'demo-headphones',
        name: 'JBL Flip 6',
        rssi: -76 + noise() * 0.6,
        uuids: [],
      });
    }
  }, 350);
  renderControls();
}

/* ------------------------------------------------------------- scan list */

function visibleDevices() {
  const now = performance.now();
  const out = [];
  for (const rec of devices.values()) {
    const age = now - rec.lastSeen;
    const isTarget = tracking && !tracking.auto && tracking.targetId === rec.id;
    if (age > 60000 && !isTarget) {
      devices.delete(rec.id);
      continue;
    }
    if (settings.findMyOnly && !rec.findMyEver) continue;
    out.push(rec);
  }
  out.sort((a, b) => (b.filter.value ?? -999) - (a.filter.value ?? -999));
  return out;
}

function badgesHtml(rec) {
  let html = '';
  if (rec.findMyEver) html += '<span class="badge badge-findmy">Find My</span>';
  if (rec.summary.apple) html += '<span class="badge badge-apple">Apple</span>';
  for (const label of rec.summary.labels) {
    if (label === 'Find My') continue;
    html += `<span class="badge">${esc(label)}</span>`;
  }
  return html;
}

function renderList() {
  if (document.body.dataset.screen !== 'scan') return;
  const now = performance.now();
  const list = visibleDevices();

  let findMyCount = 0;
  for (const rec of devices.values()) if (rec.findMyEver) findMyCount += 1;
  els.scanCounts.textContent = devices.size
    ? `${devices.size} device${devices.size === 1 ? '' : 's'} heard · ${findMyCount} Find My`
    : '';

  // If the Find My filter is hiding everything that was heard, say so —
  // otherwise a working scan looks broken.
  const hiddenByFilter = list.length === 0 && devices.size > 0 && settings.findMyOnly;
  if (hiddenByFilter) {
    els.scanEmpty.textContent = `${devices.size} device${
      devices.size === 1 ? ' is' : 's are'
    } being hidden by the “Find My only” filter — uncheck it above to see everything broadcasting.`;
    emptyStateFiltered = true;
  } else if (emptyStateFiltered) {
    emptyStateFiltered = false;
    els.scanEmpty.innerHTML = DEFAULT_EMPTY_HTML;
  }
  els.scanEmpty.classList.toggle(
    'hidden',
    !hiddenByFilter && (list.length > 0 || mode === null)
  );

  const rows = list
    .map((rec) => {
      const smoothed = rec.filter.value;
      const pct = proximityPercent(smoothed);
      const dist = estimateDistance(smoothed, settings.txAt1m, settings.pathLoss);
      const stale = now - rec.lastSeen > 10000;
      const name = rec.name ? esc(rec.name) : '<span class="unnamed">Unnamed device</span>';
      return `
      <div class="device-row${stale ? ' dim' : ''}" data-id="${esc(rec.id)}" role="button" tabindex="0">
        <div class="row-main">
          <div class="row-name">${name} ${badgesHtml(rec)}</div>
          <div class="row-sub">${esc(rec.id.slice(0, 8))} · seen ${agoText(now - rec.lastSeen)}</div>
        </div>
        <div class="row-signal">
          <div class="rssi-num">${smoothed === null ? '—' : Math.round(smoothed) + ' dBm'}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="row-dist">~${formatDistance(dist)}</div>
        </div>
      </div>`;
    })
    .join('');
  els.deviceList.innerHTML = rows;

  // Problem / stall banner. A failed scan attempt stays on screen until the
  // next attempt succeeds — a vanished toast is easy to miss.
  let stallText = null;
  if (scanError) {
    stallText = scanError;
  } else if (mode && mode !== 'demo' && scanStartedAt) {
    if (!lastAdvertAt && now - scanStartedAt > 8000) {
      stallText = isMac
        ? 'Scan is on but nothing is coming through — on macOS Chrome this is a known gap in passive scanning. Use “＋ Add one device” instead (Help & setup has the picker workflow).'
        : 'No broadcasts heard yet. Is Bluetooth turned on for this device? Trackers also go silent while connected to their owner’s phone — see Help & setup.';
    } else if (lastAdvertAt && now - lastAdvertAt > 6000) {
      stallText =
        'The signal stream went quiet (browsers pause scans when the tab is hidden). Tap Restart to resume.';
    }
  }
  if (stallText) els.scanStalledText.textContent = stallText;
  els.scanStalled.classList.toggle('hidden', !stallText);
  els.btnForceScan.classList.toggle('hidden', !(stallText && bannerForce));
  els.btnReloadPage.classList.toggle('hidden', !(stallText && bannerReload));
  els.btnRestartScan.classList.toggle('hidden', !!(bannerForce || bannerReload));
}

/* -------------------------------------------------------------- tracking */

function startTracking(targetId, { auto = false } = {}) {
  tracking = { auto, targetId: auto ? null : targetId };
  lastBandIdx = null;
  nextClickAt = 0;
  screenTo('track');
  acquireWakeLock();
  updateTracker();
}

function stopTracking() {
  tracking = null;
  trackingFresh = false;
  releaseWakeLock();
  screenTo(mode === null && !support.bluetooth && !DEMO ? 'setup' : 'scan');
}

function currentTarget() {
  if (!tracking) return null;
  const now = performance.now();
  if (!tracking.auto) return devices.get(tracking.targetId) || null;
  let best = null;
  for (const rec of devices.values()) {
    if (!rec.findMyEver) continue;
    if (now - rec.lastSeen > 8000) continue;
    if (rec.filter.value === null) continue;
    if (!best || rec.filter.value > best.filter.value) best = rec;
  }
  return best;
}

function setRadar(pct, state) {
  // 210 (blue, far) -> 0 (red, on top of it)
  const hue = Math.round(210 - (pct / 100) * 210);
  const period = Math.round(2600 - (pct / 100) * 2100);
  els.radar.style.setProperty('--hue', String(hue));
  els.radar.style.setProperty('--period', `${period}ms`);
  els.radar.classList.toggle('searching', state !== 'live');
}

function updateTracker() {
  if (!tracking || document.body.dataset.screen !== 'track') return;
  const now = performance.now();
  const rec = currentTarget();

  if (tracking.auto) {
    els.trackName.textContent = rec
      ? `Auto · strongest Find My (${rec.id.slice(0, 8)})`
      : 'Auto · strongest Find My';
  } else {
    const base = rec && rec.name ? rec.name : 'Unnamed device';
    els.trackName.textContent = `${base} · ${String(tracking.targetId).slice(0, 8)}`;
  }
  els.trackBadges.innerHTML = rec ? badgesHtml(rec) : '';

  if (!rec || rec.filter.value === null) {
    trackingFresh = false;
    setRadar(0, 'searching');
    els.trackDistance.textContent = '—';
    els.trackBand.textContent = tracking.auto
      ? 'Listening for Find My broadcasts…'
      : 'Waiting for a signal…';
    els.trackRssi.textContent = '—';
    els.trackRaw.textContent = '—';
    els.trackTrend.textContent = '—';
    els.trackTrend.className = 'stat-value';
    els.trackAgo.textContent = '—';
    els.trackHint.innerHTML =
      mode === null
        ? '⚠️ <b>No scan is running</b> (the pill top-right says Idle). Tap Back, then <b>Start scanning</b> — it should turn green and say Scanning.'
        : 'Tip: trackers stay <b>silent while connected to their owner’s iPhone</b>. Turn OFF Bluetooth on that iPhone (Settings → Bluetooth) and the card starts broadcasting within a minute or two.';
    return;
  }

  const sinceSeen = now - rec.lastSeen;
  const lost = sinceSeen > 6000;
  const smoothed = rec.filter.value;
  const pct = proximityPercent(smoothed);
  const dist = estimateDistance(smoothed, settings.txAt1m, settings.pathLoss);
  const band = bandFor(dist);
  const trendDb = rec.filter.trend(4000, now);

  lastPct = pct;
  trackingFresh = !lost;

  els.trackRssi.textContent = `${Math.round(smoothed)} dBm`;
  els.trackRaw.textContent = rec.lastRaw === null ? '—' : `${Math.round(rec.lastRaw)} dBm`;
  els.trackAgo.textContent = agoText(sinceSeen);

  if (trendDb > 2) {
    els.trackTrend.textContent = '▲ Warmer';
    els.trackTrend.className = 'stat-value warmer';
  } else if (trendDb < -2) {
    els.trackTrend.textContent = '▼ Colder';
    els.trackTrend.className = 'stat-value colder';
  } else {
    els.trackTrend.textContent = '▬ Steady';
    els.trackTrend.className = 'stat-value';
  }

  if (lost) {
    setRadar(pct, 'searching');
    els.trackDistance.textContent = '—';
    els.trackBand.textContent = 'Signal lost…';
    els.trackHint.innerHTML =
      tracking.auto
        ? 'Walk back toward where the signal was strongest. Trackers rotate their address every ~15 min and pause between broadcasts — Auto mode will re-acquire. Still nothing after ~30 s? Go Back and tap Restart scan (browsers pause scanning while the screen is off).'
        : 'Trackers rotate their Bluetooth address every ~15 min, so a locked device can vanish and reappear under a new ID. <button class="linkish" data-action="go-auto">Switch to Auto (strongest Find My)</button>';
    return;
  }

  setRadar(pct, 'live');
  els.trackDistance.textContent = `~${formatDistance(dist)}`;
  els.trackBand.textContent = band ? band.label : '';

  const bandIdx = band ? BANDS.indexOf(band) : null;
  if (bandIdx !== null && lastBandIdx !== null && bandIdx < lastBandIdx) {
    if (vibrateOn && support.vibrate) {
      navigator.vibrate(band.key === 'here' ? [70, 50, 70] : 45);
    }
  }
  if (bandIdx !== null) lastBandIdx = bandIdx;

  if (band && band.key === 'here') {
    els.trackHint.textContent =
      'You’re on top of it — check cushions, drawers, pockets, under and inside things within arm’s reach.';
  } else if (band && (band.key === 'hot' || band.key === 'warm')) {
    els.trackHint.textContent =
      'Sweep slowly and pause 3–5 s in each spot; your body blocks signal, so turn around too.';
  } else {
    els.trackHint.textContent =
      'Walk the house slowly. Watch the trend: ▲ warmer means keep going, ▼ colder means turn back.';
  }

  drawSparkline(rec, pct);
}

/* ------------------------------------------------------------- sparkline */

let sparkWidth = 0;
function sizeSparkline() {
  const dpr = window.devicePixelRatio || 1;
  const w = els.spark.clientWidth || 300;
  const h = els.spark.clientHeight || 64;
  if (w !== sparkWidth || els.spark.height !== Math.round(h * dpr)) {
    sparkWidth = w;
    els.spark.width = Math.round(w * dpr);
    els.spark.height = Math.round(h * dpr);
  }
}

function drawSparkline(rec, pct) {
  sizeSparkline();
  const ctx = els.spark.getContext('2d');
  if (!ctx) return;
  const W = els.spark.width;
  const H = els.spark.height;
  ctx.clearRect(0, 0, W, H);

  const now = performance.now();
  const windowMs = 60000;
  const pts = rec.filter.history.filter((s) => now - s.t <= windowMs);
  if (pts.length < 2) return;

  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  min -= 2;
  max += 2;

  const x = (t) => ((t - (now - windowMs)) / windowMs) * W;
  const y = (v) => H - ((v - min) / (max - min)) * (H - 8) - 4;

  const hue = Math.round(210 - (pct / 100) * 210);
  ctx.lineWidth = Math.max(2, (window.devicePixelRatio || 1) * 1.5);
  ctx.strokeStyle = `hsl(${hue} 90% 62%)`;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(p.t), y(p.v));
    else ctx.lineTo(x(p.t), y(p.v));
  });
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.fillStyle = `hsl(${hue} 90% 70%)`;
  ctx.beginPath();
  ctx.arc(x(last.t), y(last.v), Math.max(3, (window.devicePixelRatio || 1) * 2.5), 0, Math.PI * 2);
  ctx.fill();
}

/* ----------------------------------------------------------------- audio */

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return true;
}

function playClick(pct) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 440 + (pct / 100) * 880;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.08);
}

setInterval(() => {
  if (!audioOn || !audioCtx || !tracking || !trackingFresh) return;
  if (document.body.dataset.screen !== 'track') return;
  const now = performance.now();
  if (now >= nextClickAt) {
    playClick(lastPct);
    nextClickAt = now + clickIntervalMs(lastPct);
  }
}, 60);

/* ------------------------------------------------------------- wake lock */

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    /* not critical */
  }
}
function releaseWakeLock() {
  try {
    if (wakeLock) wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracking) acquireWakeLock();
});

/* ------------------------------------------------------------------ help */

function copyText(text, sourceEl) {
  const done = () => {
    if (sourceEl) {
      const prev = sourceEl.textContent;
      sourceEl.textContent = 'Copied ✓';
      setTimeout(() => {
        sourceEl.textContent = prev;
      }, 1400);
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}
function legacyCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch {
    showToast('Copy failed — long-press the text to copy it manually.');
  }
}

function chip(text) {
  return `<span class="copy-chip"><code>${esc(text)}</code><button class="chip-btn" data-copy="${esc(
    text
  )}">Copy</button></span>`;
}

function buildHelpHtml() {
  const origin = location.origin;
  const flagExp = 'chrome://flags/#enable-experimental-web-platform-features';
  const flagInsecure = 'chrome://flags/#unsafely-treat-insecure-origin-as-secure';
  const check = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '❓');
  return `
  <h3>🔎 This browser, right now</h3>
  <ul>
    <li>${check(support.secure)} Secure context</li>
    <li>${check(support.bluetooth)} Web Bluetooth API</li>
    <li>${check(support.scanning)} Passive scanning${
      support.scanning ? '' : ' — <b>this is what “Start scanning” needs: the Chrome flag below + full Relaunch</b>'
    }</li>
    <li>${check(support.watching)} Per-device watching</li>
    <li>${check(adapterAvailable)} Bluetooth adapter reachable${
      adapterAvailable === false
        ? ' — <b>turn Bluetooth on, and on a Mac allow this browser under System Settings → Privacy &amp; Security → Bluetooth</b>'
        : ''
    }</li>
  </ul>

  <h3>📱 Android phone (best mobile option)</h3>
  <ol>
    <li>In Chrome, open ${chip(flagExp)} → set <b>Experimental Web Platform features</b> to <b>Enabled</b>.</li>
    <li>Because this page is served over your Wi-Fi (not HTTPS), also open ${chip(
      flagInsecure
    )} → set to <b>Enabled</b> and paste this page's address into its text box: ${chip(origin)}</li>
    <li>Tap <b>Relaunch</b>, come back here, hit <b>Start scanning</b>, and allow Bluetooth scanning when prompted.</li>
  </ol>

  <h3>💻 Laptop / desktop (Chrome or Edge)</h3>
  <ol>
    <li>Open ${chip(flagExp)} → <b>Enabled</b> → hit the blue <b>Relaunch</b> button (Chrome must fully restart for it to take effect). <code>localhost</code> needs no other setup.</li>
    <li><b>Mac only:</b> macOS must also allow Chrome to use Bluetooth — System Settings → Privacy &amp; Security → <b>Bluetooth</b> → make sure your browser is listed and ON, then relaunch it.</li>
    <li><b>Mac reality check:</b> Chrome on macOS can't passive-scan (a long-standing Chrome gap), and a stuck scan attempt even jams this tab's other Bluetooth calls until you reload. Not your fault, nothing to fix: on Macs this app skips passive scanning and the path is <b>＋ Add one device</b>, workflow below. Tracking works identically. If any button ever seems dead, reload the page first.</li>
    <li>A laptop you carry room-to-room works great as the radar.</li>
  </ol>

  <h3>🖱 The “＋ Add one device” picker (works on Macs)</h3>
  <ol>
    <li>First make the tracker broadcast: turn OFF Bluetooth on the iPhone it's paired to and wait 1–2 minutes.</li>
    <li>Tap <b>＋ Add one device</b>. Chrome opens a picker of everything currently broadcasting, with live signal bars. (If no picker appears, reload the page — Cmd+R — and tap it again before anything else.)</li>
    <li>Your tracker shows as an <i>unnamed / unknown device</i>. With the tracker nearby it'll be among the strongest entries. Unsure which? Add several, one at a time — anything sending Find My frames gets the green <span class="badge badge-findmy">Find My</span> badge in the list within seconds.</li>
    <li>Then tap <b>🎯 Track strongest Find My signal</b> (or tap a row to lock it) and hunt as usual.</li>
  </ol>

  <h3>🍎 iPhone &amp; iPad</h3>
  <p>Apple doesn't allow Web Bluetooth in Safari or in any iOS browser, so this page can't reach Bluetooth on an iPhone. Your options:</p>
  <ul>
    <li>Use a <b>laptop</b> (carry it around) or any <b>Android</b> phone/tablet on the same Wi-Fi.</li>
    <li>Or try the free <b>“Bluefy – Web BLE Browser”</b> app and open this same address in it. Bluefy supports the device-picker mode (<b>Add one device</b> button); full background scanning support varies by version.</li>
  </ul>

  <h3>🔑 Make your tracker card broadcast (important!)</h3>
  <p>Find My trackers go <b>silent while connected to their owner's iPhone</b> — and yours shows as connected (“Now”) in Find My. While you hunt:</p>
  <ol>
    <li>Turn <b>OFF Bluetooth on the iPhone the card is paired to</b> (Settings → Bluetooth — the real switch, not just Control Center).</li>
    <li>Wait 1–2 minutes. The card starts broadcasting Find My frames, which show up here with a <span class="badge badge-findmy">Find My</span> badge.</li>
    <li>Keep that iPhone's Bluetooth off until you've found the wallet, then turn it back on.</li>
  </ol>

  <h3>📡 Reading the signal</h3>
  <ul>
    <li>Signal strength (RSSI) is noisy — trust the 5–10 second <b>trend</b>, not single blips.</li>
    <li>Move slowly, pause 3–5 s per spot. Your body blocks signal: rotate in place and watch for a jump.</li>
    <li>Couch cushions, drawers, metal and appliances muffle the signal — “Very close” can still mean buried.</li>
    <li>Distance is a rough estimate. Calibrate: hold a known tracker ~1 m / 3 ft away and tap <b>Calibrate at 1 m</b>.</li>
    <li>Trackers rotate their Bluetooth address every ~15 min — <b>Auto (strongest Find My)</b> mode handles that.</li>
  </ul>

  <h3>⚠️ What this can't do</h3>
  <ul>
    <li>It can't make the card beep (Apple keeps that private to Find My) and can't give compass direction (that needs Ultra Wideband hardware). It's a hot/cold signal-strength radar — which is exactly what works for a card buried in a couch.</li>
  </ul>`;
}

function openHelp() {
  els.helpContent.innerHTML = buildHelpHtml();
  if (typeof els.modalHelp.showModal === 'function') {
    if (!els.modalHelp.open) els.modalHelp.showModal();
  } else {
    els.modalHelp.setAttribute('open', '');
  }
}
function closeHelp() {
  if (typeof els.modalHelp.close === 'function' && els.modalHelp.open) els.modalHelp.close();
  else els.modalHelp.removeAttribute('open');
}

/* ------------------------------------------------------------- setup view */

function renderSupportChecklist() {
  const rows = [
    ['Secure context (needed for Web Bluetooth)', support.secure],
    ['Web Bluetooth API available', support.bluetooth],
    ['Passive scanning (requestLEScan)', support.scanning],
    ['Per-device watching (watchAdvertisements)', support.watching],
  ];
  els.supportList.innerHTML = rows
    .map(
      ([label, ok]) =>
        `<li class="${ok ? 'ok' : 'bad'}"><span>${ok ? '✅' : '❌'}</span> ${esc(label)}</li>`
    )
    .join('');
  els.setupInstructions.innerHTML = buildHelpHtml();
}

function renderControls() {
  const running = mode !== null;

  // Keep the scan button clickable even when scanning is unsupported —
  // clicking then explains exactly what's missing instead of doing nothing.
  els.btnScan.disabled = running && mode !== 'watch';
  els.btnScan.textContent = DEMO ? '▶ Start demo scan' : '▶ Start scanning';
  els.btnAddDevice.classList.toggle('hidden', DEMO || !support.watching);
  els.btnStop.classList.toggle('hidden', !running);
  els.noStreamBanner.classList.toggle('hidden', DEMO || support.scanning || !support.bluetooth);
  setStatusPill();
}

/* ------------------------------------------------------------------ init */

function bindEvents() {
  els.btnHelp.addEventListener('click', openHelp);
  els.btnHelpClose.addEventListener('click', closeHelp);
  els.modalHelp.addEventListener('click', (e) => {
    if (e.target === els.modalHelp) closeHelp();
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (btn) copyText(btn.getAttribute('data-copy'), btn);
  });

  els.btnRecheck.addEventListener('click', () => location.reload());

  // Wrapped: the click event must not leak into startScanning's force param.
  els.btnScan.addEventListener('click', () => startScanning());
  els.btnAddDevice.addEventListener('click', addWatchedDevice);
  els.btnStop.addEventListener('click', stopScanning);
  els.btnRestartScan.addEventListener('click', restartScan);
  els.btnForceScan.addEventListener('click', () => startScanning(true));
  els.btnReloadPage.addEventListener('click', () => location.reload());
  els.btnAuto.addEventListener('click', async () => {
    // Tracking is useless without a running scan — start one automatically.
    if (mode === null) {
      await startScanning();
      if (mode === null) return; // scan didn't start; the reason is shown on screen
    }
    startTracking(null, { auto: true });
  });

  els.chkFindMyOnly.checked = !!settings.findMyOnly;
  els.chkFindMyOnly.addEventListener('change', () => {
    settings.findMyOnly = els.chkFindMyOnly.checked;
    saveSettings();
    renderList();
  });

  els.deviceList.addEventListener('click', (e) => {
    const row = e.target.closest ? e.target.closest('.device-row') : null;
    if (row && row.dataset.id) startTracking(row.dataset.id, { auto: false });
  });
  els.deviceList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest ? e.target.closest('.device-row') : null;
    if (row && row.dataset.id) {
      e.preventDefault();
      startTracking(row.dataset.id, { auto: false });
    }
  });

  els.btnTipDismiss.addEventListener('click', () => {
    els.tipCard.classList.add('hidden');
    try {
      localStorage.setItem('walletRadarTipDismissed', '1');
    } catch {
      /* ignore */
    }
  });

  els.btnBack.addEventListener('click', stopTracking);

  els.btnSound.addEventListener('click', () => {
    if (!audioOn) {
      if (!ensureAudio()) {
        showToast('Audio isn’t available in this browser.');
        return;
      }
      audioOn = true;
      nextClickAt = 0;
    } else {
      audioOn = false;
    }
    els.btnSound.textContent = audioOn ? '🔊 Sound on' : '🔇 Sound off';
    els.btnSound.classList.toggle('active', audioOn);
  });

  if (!support.vibrate) els.btnVibrate.classList.add('hidden');
  els.btnVibrate.addEventListener('click', () => {
    vibrateOn = !vibrateOn;
    els.btnVibrate.textContent = vibrateOn ? '📳 Vibrate on' : '📴 Vibrate off';
    els.btnVibrate.classList.toggle('active', vibrateOn);
    if (vibrateOn && support.vibrate) navigator.vibrate(30);
  });

  els.btnCalibrate.addEventListener('click', () => {
    els.calibratePanel.classList.toggle('hidden');
  });
  els.inpTx.value = String(settings.txAt1m);
  els.inpTx.addEventListener('change', () => {
    const v = Number(els.inpTx.value);
    if (Number.isFinite(v) && v <= -30 && v >= -80) {
      settings.txAt1m = v;
      saveSettings();
    } else {
      els.inpTx.value = String(settings.txAt1m);
    }
  });
  els.inpN.value = String(settings.pathLoss);
  els.nOut.textContent = Number(settings.pathLoss).toFixed(1);
  els.inpN.addEventListener('input', () => {
    settings.pathLoss = Number(els.inpN.value);
    els.nOut.textContent = settings.pathLoss.toFixed(1);
    saveSettings();
  });
  els.btnCal1m.addEventListener('click', () => {
    const rec = currentTarget();
    if (!rec || rec.filter.value === null) {
      showToast('No live signal to calibrate against — start tracking something first.');
      return;
    }
    settings.txAt1m = Math.max(-80, Math.min(-30, Math.round(rec.filter.value)));
    els.inpTx.value = String(settings.txAt1m);
    saveSettings();
    showToast(`Calibrated: ${settings.txAt1m} dBm now means ~1 m / 3 ft.`);
  });

  els.trackHint.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('[data-action="go-auto"]') : null;
    if (btn && tracking) {
      tracking.auto = true;
      tracking.targetId = null;
    }
  });

  window.addEventListener('resize', () => {
    if (document.body.dataset.screen === 'track') sizeSparkline();
  });
}

async function init() {
  bindEvents();
  renderControls();

  els.footerDemoLink.textContent = DEMO ? 'Exit demo mode' : 'Try demo mode (fake signals)';
  els.footerDemoLink.href = DEMO ? location.pathname : '?demo=1';

  let tipDismissed = false;
  try {
    tipDismissed = localStorage.getItem('walletRadarTipDismissed') === '1';
  } catch {
    /* ignore */
  }
  els.tipCard.classList.toggle('hidden', tipDismissed);

  if (!DEMO && (!support.bluetooth || !support.secure)) {
    renderSupportChecklist();
    screenTo('setup');
  } else {
    screenTo('scan');
  }

  if (!DEMO && support.bluetooth && navigator.bluetooth.getAvailability) {
    try {
      adapterAvailable = await navigator.bluetooth.getAvailability();
      els.adapterNote.classList.toggle('hidden', adapterAvailable);
    } catch {
      /* leave hidden */
    }
  }

  setInterval(renderList, 400);
  setInterval(updateTracker, 200);

  if (DEMO) {
    startDemo();
    if (AUTO_TRACK_ON_LOAD) {
      setTimeout(() => startTracking(null, { auto: true }), 1600);
    }
  }
}

init().catch((err) => {
  console.error(err);
  showToast(`Startup error: ${err && err.message ? err.message : err}`);
});
