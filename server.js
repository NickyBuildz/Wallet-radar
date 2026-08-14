// Wallet Radar — zero-dependency static server.
// Run with:  node server.js   (Node 16+, nothing to install)
// Binds 0.0.0.0 so your phone can reach it over the same Wi-Fi network.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_PORT = Number(process.env.PORT) || 4747;
const MAX_PORT_TRIES = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = path.normalize(path.join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let data;
    try {
      data = await fs.readFile(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    } catch {
      /* response already closed */
    }
  }
});

function lanAddresses() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

function banner(port) {
  const lines = [
    '',
    '  \u{1F4E1} Wallet Radar is running',
    '',
    `  On this computer:   http://localhost:${port}`,
  ];
  const ips = lanAddresses();
  if (ips.length) {
    lines.push('  On your phone (same Wi-Fi):');
    for (const ip of ips) lines.push(`      http://${ip}:${port}`);
  } else {
    lines.push('  (No LAN address detected — connect this machine to Wi-Fi/Ethernet to reach it from a phone.)');
  }
  lines.push(
    '',
    '  First time on a phone? Tap "Help & setup" in the app — Bluetooth in the',
    '  browser needs a one-time Chrome flag (2 minutes, instructions inside).',
    '  Try the UI with fake signals first: add ?demo=1 to the URL.',
    '',
    '  Press Ctrl+C to stop.',
    ''
  );
  console.log(lines.join('\n'));
}

function start(port, triesLeft) {
  const onError = (err) => {
    if (err && err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`Port ${port} is busy, trying ${port + 1}…`);
      start(port + 1, triesLeft - 1);
    } else {
      console.error('Could not start server:', err && err.message ? err.message : err);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    banner(port);
  });
}

start(DEFAULT_PORT, MAX_PORT_TRIES);
