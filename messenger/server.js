// Сервер-ретранслятор. Он ничего не знает о переписке: хранит только публичные ключи по ID
// и очередь зашифрованных конвертов для тех, кто офлайн. Отправитель конверта серверу не известен —
// он записан внутри шифротекста.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { importPublicKeys, verify, fromB64, normalizeId, randomToken } from './public/js/crypto.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const LIMITS = {
  frameBytes: 96 * 1024,
  payloadChars: 64 * 1024,
  queuePerUser: 2000,
  queueTtlMs: 30 * 24 * 3600 * 1000,
  registrationsPerIpHour: 20,
  burst: 60, // сообщений сразу
  refillPerSec: 20, // затем сообщений в секунду
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---------- хранилище ----------

class Store {
  constructor(file) {
    this.file = file;
    this.data = { users: {}, queues: {} };
    if (file && fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.timer = null;
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }, 200);
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  user(id) {
    return Object.hasOwn(this.data.users, id) ? this.data.users[id] : null;
  }

  queue(id) {
    if (!Object.hasOwn(this.data.queues, id)) this.data.queues[id] = [];
    return this.data.queues[id];
  }

  purgeExpired() {
    const cutoff = Date.now() - LIMITS.queueTtlMs;
    for (const [id, q] of Object.entries(this.data.queues)) {
      const kept = q.filter((m) => m.ts > cutoff);
      if (kept.length) this.data.queues[id] = kept;
      else delete this.data.queues[id];
    }
    this.save();
  }
}

// ---------- HTTP ----------

// connect-src явно перечисляет ws:/wss: своего хоста: не все браузеры считают их частью 'self'.
function csp(req) {
  const host = /^[a-z0-9.:[\]-]+$/i.test(req.headers.host || '') ? req.headers.host : 'localhost';
  return (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    `connect-src 'self' ws://${host} wss://${host}; manifest-src 'self'; base-uri 'none'; ` +
    "form-action 'none'; frame-ancestors 'none'"
  );
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Security-Policy': csp(req),
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

// ---------- WebSocket ----------

export function createServer({ dataFile = null } = {}) {
  const store = new Store(dataFile);
  const online = new Map(); // id -> Set<ws>
  const registrations = new Map(); // ip -> [timestamps]

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: LIMITS.frameBytes });

  const send = (ws, obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  const deliverTo = (ws, item) => send(ws, { t: 'msg', id: item.id, payload: item.payload, ts: item.ts });
  const deliver = (id, item) => (online.get(id) || []).forEach((ws) => deliverTo(ws, item));

  function allowRegistration(ip) {
    const now = Date.now();
    const recent = (registrations.get(ip) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= LIMITS.registrationsPerIpHour) return false;
    recent.push(now);
    registrations.set(ip, recent);
    return true;
  }

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      ws.close(1008, 'origin');
      return;
    }
    const ip = req.socket.remoteAddress;
    const nonce = randomToken(32);
    let me = null;
    let authing = false;
    let tokens = LIMITS.burst;
    let last = Date.now();
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));

    send(ws, { t: 'challenge', nonce });

    ws.on('message', async (raw, isBinary) => {
      const now = Date.now();
      tokens = Math.min(LIMITS.burst, tokens + ((now - last) / 1000) * LIMITS.refillPerSec);
      last = now;
      if (--tokens < 0) return ws.close(1008, 'rate');
      if (isBinary) return ws.close(1003, 'binary');

      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return ws.close(1007, 'json');
      }
      if (!m || typeof m.t !== 'string') return;

      try {
        if (m.t === 'auth') {
          if (me || authing) return;
          authing = true;
          const keys = await importPublicKeys(String(m.sign), String(m.dh));
          const fail = (error) => {
            authing = false;
            send(ws, { t: 'auth', ok: false, error });
          };
          if (keys.id !== m.id) return fail('id_mismatch');
          const ok = await verify(keys.sign, fromB64(String(m.sig)), new TextEncoder().encode('vault-auth-v1:' + nonce));
          if (!ok) return fail('bad_signature');
          const existing = store.user(keys.id);
          if (!existing) {
            if (!allowRegistration(ip)) return fail('rate');
            store.data.users[keys.id] = { sign: keys.signB64, dh: keys.dhB64 };
            store.save();
          }
          me = keys.id;
          if (!online.has(me)) online.set(me, new Set());
          online.get(me).add(ws);
          send(ws, { t: 'auth', ok: true });
          for (const item of store.data.queues[me] || []) deliverTo(ws, item);
          return;
        }

        if (!me) return send(ws, { t: 'error', error: 'unauthenticated' });

        switch (m.t) {
          case 'keys': {
            const id = normalizeId(m.id);
            const u = id && store.user(id);
            return send(ws, u ? { t: 'keys', req: m.req, id, sign: u.sign, dh: u.dh } : { t: 'keys', req: m.req, id, error: 'not_found' });
          }
          case 'send': {
            const to = normalizeId(m.to);
            const msgId = typeof m.id === 'string' && m.id.length <= 64 ? m.id : null;
            if (!msgId || typeof m.payload !== 'string' || m.payload.length > LIMITS.payloadChars) {
              return send(ws, { t: 'sent', id: m.id, ok: false, error: 'invalid' });
            }
            if (!to || !store.user(to)) return send(ws, { t: 'sent', id: msgId, ok: false, error: 'not_found' });
            const q = store.queue(to);
            if (q.length >= LIMITS.queuePerUser) return send(ws, { t: 'sent', id: msgId, ok: false, error: 'queue_full' });
            const item = { id: msgId, payload: m.payload, ts: now };
            if (!q.some((x) => x.id === msgId)) {
              q.push(item);
              store.save();
              deliver(to, item);
            }
            return send(ws, { t: 'sent', id: msgId, ok: true });
          }
          case 'ack': {
            const ids = new Set(Array.isArray(m.ids) ? m.ids.slice(0, 500) : []);
            const q = store.data.queues[me];
            if (q) {
              const kept = q.filter((x) => !ids.has(x.id));
              if (kept.length) store.data.queues[me] = kept;
              else delete store.data.queues[me];
              store.save();
            }
            return;
          }
          case 'delete': {
            const u = store.user(me);
            const keys = await importPublicKeys(u.sign, u.dh);
            const ok = await verify(keys.sign, fromB64(String(m.sig)), new TextEncoder().encode('vault-delete-v1:' + nonce));
            if (!ok) return send(ws, { t: 'deleted', ok: false });
            delete store.data.users[me];
            delete store.data.queues[me];
            store.save();
            const sockets = online.get(me) || new Set();
            send(ws, { t: 'deleted', ok: true });
            for (const s of sockets) s.close(1000, 'deleted');
            return;
          }
          case 'ping':
            return send(ws, { t: 'pong' });
        }
      } catch {
        if (!me) authing = false;
        send(ws, { t: 'error', error: 'bad_request' });
      }
    });

    ws.on('close', () => {
      if (!me) return;
      const set = online.get(me);
      set?.delete(ws);
      if (set && !set.size) online.delete(me);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 30_000);
  const purge = setInterval(() => store.purgeExpired(), 3600_000);

  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(purge);
    store.flush();
  });

  return { server, wss, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { server, store } = createServer({ dataFile: path.join(dataDir, 'db.json') });
  server.listen(port, () => console.log(`Vault messenger: http://localhost:${port}`));
  const stop = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
