import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './src/db.js';
import { createContentLoader } from './src/content.js';
import { createRateLimiter } from './src/auth.js';
import { handleApi } from './src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const CONTENT_DIR = path.join(__dirname, 'content');
const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 by default so friends on the network can join; HOST=127.0.0.1 to
// lock it to this machine only.
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const db = createDb(DATA_FILE);
const contentLoader = createContentLoader(CONTENT_DIR);

// Guests live here — memory only, never written to db.json.
const mem = {
  guests: {},            // playerId -> player
  sessions: new Map(),   // token  -> { playerId, createdAt, expiresAt }
};

const ctx = {
  db,
  mem,
  rateLimit: createRateLimiter(),
  // Hot-reloaded view of content/*.json (checked every ~2s).
  get content() {
    return contentLoader.get();
  },
};

// --- static files ----------------------------------------------------------

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/\0/g, '');
  const resolved = path.normalize(path.join(root, decoded));
  // Path-traversal guard: the resolved path must stay inside the root.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function serveStatic(req, res, pathname) {
  let filePath = safeJoin(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    let stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath);
    }

    const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      etag,
      // HTML must never go stale or a reload after an update shows the old game.
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:system-ui;background:#0b0e17;color:#e6e9f0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>404</h1><p>That page does not exist. <a style="color:#7c9cff" href="/">Back to the game</a>.</p></div>');
  }
}

// --- server ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Permissive CORS so the game can also be opened from file:// or another
  // origin during development. Same-origin in production ignores this.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url, ctx);
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖ Port ${PORT} is already in use.`);
    console.error(`    Try another one:  PORT=8080 node server.js\n`);
    process.exit(1);
  }
  console.error('[server]', err.message);
});

// --- shutdown --------------------------------------------------------------

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[server] ${signal} received — flushing database…`);
  try {
    await db.flush();
    console.log('[db] saved. Goodbye!');
  } catch (e) {
    console.error('[db] flush failed:', e.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// Safety net: persist every 15s even if the process is killed hard.
setInterval(() => db.save().catch(() => {}), 15000).unref();

// Fail fast on broken content files at startup.
contentLoader.get();

server.listen(PORT, HOST, () => {
  const players = Object.keys(db.data.players).length;
  const nets = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        V A I X I T E ’ S   R N G   V 2        ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log(`  ➜  Local:   http://localhost:${PORT}`);
  for (const ip of nets) console.log(`  ➜  Network: http://${ip}:${PORT}`);
  console.log(`  ➜  Database: ${path.relative(__dirname, DATA_FILE)} (${players} account${players === 1 ? '' : 's'})`);
  console.log('  ➜  Content:  content/*.json (hot-reload, edit anytime)');
  console.log('  ➜  Stop:    Ctrl+C');
  console.log('');
});
