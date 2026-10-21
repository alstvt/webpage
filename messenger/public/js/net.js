// Соединение с сервером-ретранслятором: вход по подписи, автопереподключение, запросы ключей.

import { signText, randomToken } from './crypto.js';

export class Connection extends EventTarget {
  constructor(identity, url) {
    super();
    this.identity = identity;
    this.url = url;
    this.ws = null;
    this.ready = false;
    this.pending = new Map(); // req/msgId -> {resolve, reject, timer}
    this.backoff = 500;
    this.closed = false;
    this.nonce = null;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
  }

  setStatus(ready) {
    this.ready = ready;
    this.dispatchEvent(new CustomEvent('status', { detail: ready }));
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.setStatus(false);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('offline'));
      }
      this.pending.clear();
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }

  async onMessage(m) {
    switch (m.t) {
      case 'challenge': {
        this.nonce = m.nonce;
        const sig = await signText(this.identity, 'vault-auth-v1:' + m.nonce);
        this.raw({ t: 'auth', id: this.identity.id, sign: this.identity.signB64, dh: this.identity.dhB64, sig });
        break;
      }
      case 'auth':
        if (m.ok) {
          this.backoff = 500;
          this.setStatus(true);
        } else {
          this.dispatchEvent(new CustomEvent('auth-error', { detail: m.error }));
        }
        break;
      case 'msg':
        this.dispatchEvent(new CustomEvent('message', { detail: m }));
        break;
      case 'keys':
        this.settle(m.req, m);
        break;
      case 'sent':
        this.settle('s:' + m.id, m);
        break;
      case 'deleted':
        this.settle('delete', m);
        break;
    }
  }

  raw(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  request(key, obj, timeout = 10000) {
    if (!this.ready) return Promise.reject(new Error('offline'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error('timeout'));
      }, timeout);
      this.pending.set(key, { resolve, reject, timer });
      this.raw(obj);
    });
  }

  settle(key, value) {
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve(value);
  }

  fetchKeys(id) {
    const req = randomToken(8);
    return this.request(req, { t: 'keys', req, id });
  }

  send(to, id, payload) {
    return this.request('s:' + id, { t: 'send', to, id, payload });
  }

  ack(ids) {
    if (ids.length) this.raw({ t: 'ack', ids });
  }

  async deleteAccount() {
    const sig = await signText(this.identity, 'vault-delete-v1:' + this.nonce);
    return this.request('delete', { t: 'delete', sig });
  }
}
