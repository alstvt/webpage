// Логика мессенджера: контакты, группы, история, отправка и приём. Без DOM.
//
// Имена контактов и групп — только локальные заметки и названия, которые шифруются вместе с остальными
// данными. Серверу никогда не передаётся ничего, кроме ID получателя и шифротекста.

import { seal, open, importPublicKeys, normalizeId, randomToken } from './crypto.js';

const MAX_TEXT = 4000;
const MAX_HISTORY = 3000;
const MAX_GROUP = 200;

export const chatKeyDM = (id) => 'dm:' + id;
export const chatKeyGroup = (gid) => 'g:' + gid;

export class Messenger extends EventTarget {
  constructor(vault, conn) {
    super();
    this.vault = vault;
    this.conn = conn;
    this.me = vault.identity.id;
    this.keyCache = new Map();
    this.openChats = new Map(); // кэш истории
  }

  async init() {
    [this.contacts, this.groups, this.peers, this.chats, this.outbox, this.settings] = await Promise.all([
      this.vault.get('contacts', {}),
      this.vault.get('groups', {}),
      this.vault.get('peers', {}),
      this.vault.get('chats', {}),
      this.vault.get('outbox', []),
      this.vault.get('settings', {}),
    ]);
    this.settings = { theme: 'system', lock: 15, ttl: 0, ...this.settings };
    this.conn.addEventListener('message', (e) => this.onEnvelope(e.detail));
    this.conn.addEventListener('status', (e) => e.detail && this.flushOutbox());
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------- имена ----------

  nameOf(id) {
    if (id === this.me) return 'Вы';
    const c = this.contacts[id];
    return c?.name || id.slice(0, 5) + '…' + id.slice(-4);
  }

  chatTitle(key) {
    if (key.startsWith('dm:')) return this.nameOf(key.slice(3));
    return this.groups[key.slice(2)]?.name || 'Группа';
  }

  // ---------- ключи ----------

  async keysFor(id) {
    if (this.keyCache.has(id)) return this.keyCache.get(id);
    let rec = this.peers[id];
    if (!rec) {
      const res = await this.conn.fetchKeys(id);
      if (res.error) throw new Error('not_found');
      rec = { sign: res.sign, dh: res.dh };
    }
    const keys = await importPublicKeys(rec.sign, rec.dh);
    // ID — хэш ключей: если сервер подсунул чужие ключи, хэш не совпадёт.
    if (keys.id !== id) throw new Error('key_mismatch');
    if (!this.peers[id]) {
      this.peers[id] = rec;
      await this.vault.set('peers', this.peers);
    }
    this.keyCache.set(id, keys);
    return keys;
  }

  // ---------- контакты ----------

  async addContact(input, name) {
    const id = normalizeId(input);
    if (!id) throw new Error('bad_id');
    if (id === this.me) throw new Error('self');
    await this.keysFor(id);
    this.contacts[id] = { ...this.contacts[id], id, name: name.trim().slice(0, 64), unknown: false, blocked: false };
    await this.saveContacts();
    await this.touchChat(chatKeyDM(id), null);
    return id;
  }

  async renameContact(id, name) {
    if (!this.contacts[id]) return;
    this.contacts[id].name = name.trim().slice(0, 64);
    this.contacts[id].unknown = false;
    await this.saveContacts();
  }

  async setBlocked(id, blocked) {
    this.contacts[id] = { id, name: '', ...this.contacts[id], blocked, unknown: false };
    await this.saveContacts();
  }

  async saveContacts() {
    await this.vault.set('contacts', this.contacts);
    this.emit('contacts');
  }

  // ---------- история ----------

  async history(key) {
    if (!this.openChats.has(key)) this.openChats.set(key, await this.vault.get('chat:' + key, []));
    const list = this.openChats.get(key);
    const ttl = this.settings.ttl;
    if (ttl) {
      const cutoff = Date.now() - ttl;
      if (list.length && list[0].ts < cutoff) {
        const kept = list.filter((m) => m.ts >= cutoff);
        this.openChats.set(key, kept);
        await this.vault.set('chat:' + key, kept);
        return kept;
      }
    }
    return list;
  }

  async appendMessage(key, msg) {
    const list = await this.history(key);
    if (list.some((m) => m.id === msg.id && m.from === msg.from)) return false;
    list.push(msg);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    await this.vault.set('chat:' + key, list);
    await this.touchChat(key, msg);
    this.emit('message', { key, msg });
    return true;
  }

  async touchChat(key, msg) {
    const c = this.chats[key] || { unread: 0, ts: Date.now(), last: '' };
    if (msg) {
      c.ts = msg.ts;
      c.last = msg.system ? msg.text : (msg.out ? 'Вы: ' : key.startsWith('g:') ? this.nameOf(msg.from) + ': ' : '') + msg.text;
      if (!msg.out && !msg.system && this.activeChat !== key) c.unread++;
    }
    this.chats[key] = c;
    await this.vault.set('chats', this.chats);
    this.emit('chats');
  }

  async markRead(key) {
    this.activeChat = key;
    if (this.chats[key]?.unread) {
      this.chats[key].unread = 0;
      await this.vault.set('chats', this.chats);
      this.emit('chats');
    }
  }

  async deleteChat(key) {
    delete this.chats[key];
    this.openChats.delete(key);
    await this.vault.remove('chat:' + key);
    await this.vault.set('chats', this.chats);
    this.emit('chats');
  }

  async applyTtl() {
    if (!this.settings.ttl) return;
    for (const key of Object.keys(this.chats)) {
      this.openChats.delete(key);
      await this.history(key);
    }
    this.emit('chats');
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    await this.vault.set('settings', this.settings);
    if ('ttl' in patch) await this.applyTtl();
  }

  // ---------- отправка ----------

  async sealFor(to, body) {
    const keys = await this.keysFor(to);
    return { to, id: randomToken(16), payload: await seal(this.vault.identity, keys, body) };
  }

  async enqueue(envelopes, chatKey, msgId) {
    for (const e of envelopes) this.outbox.push({ ...e, chatKey, msgId });
    await this.vault.set('outbox', this.outbox);
    await this.flushOutbox();
  }

  async flushOutbox() {
    if (this.flushing || !this.conn.ready) return;
    this.flushing = true;
    try {
      const done = new Set();
      const failed = new Set();
      for (const e of [...this.outbox]) {
        try {
          const res = await this.conn.send(e.to, e.id, e.payload);
          if (res.ok || res.error === 'not_found') {
            done.add(e);
            if (!res.ok && e.chatKey) failed.add(e.chatKey + '|' + e.msgId);
          }
        } catch {
          break; // офлайн — попробуем при следующем подключении
        }
      }
      this.outbox = this.outbox.filter((e) => !done.has(e));
      await this.vault.set('outbox', this.outbox);
      const pending = new Set(this.outbox.map((e) => e.chatKey + '|' + e.msgId));
      for (const e of done) {
        if (!e.chatKey) continue;
        const tag = e.chatKey + '|' + e.msgId;
        if (pending.has(tag)) continue;
        await this.setStatus(e.chatKey, e.msgId, failed.has(tag) ? 'failed' : 'sent');
      }
    } finally {
      this.flushing = false;
    }
  }

  async setStatus(key, msgId, status) {
    const list = await this.history(key);
    const m = list.find((x) => x.id === msgId && x.out);
    if (!m || m.status === status) return;
    m.status = status;
    await this.vault.set('chat:' + key, list);
    this.emit('status', { key, msg: m });
  }

  isMember(gid) {
    const g = this.groups[gid];
    return !!g && !g.removed && g.members.includes(this.me);
  }

  recipients(key) {
    if (key.startsWith('dm:')) return [key.slice(3)];
    const g = this.groups[key.slice(2)];
    return g ? g.members.filter((id) => id !== this.me) : [];
  }

  async sendText(key, text) {
    text = text.trim();
    if (!text) return;
    if (text.length > MAX_TEXT) throw new Error('too_long');
    if (key.startsWith('g:') && !this.isMember(key.slice(2))) throw new Error('not_member');
    const msg = { id: randomToken(12), from: this.me, ts: Date.now(), text, out: true, status: 'sending' };
    const body = { k: 'text', mid: msg.id, ts: msg.ts, text };
    if (key.startsWith('g:')) body.gid = key.slice(2);
    await this.appendMessage(key, msg);
    const to = this.recipients(key);
    if (!to.length) return this.setStatus(key, msg.id, 'sent');
    const envelopes = [];
    for (const id of to) {
      try {
        envelopes.push(await this.sealFor(id, body));
      } catch {
        /* у участника нет ключей — пропускаем его */
      }
    }
    if (!envelopes.length) return this.setStatus(key, msg.id, 'failed');
    await this.enqueue(envelopes, key, msg.id);
  }

  // ---------- группы ----------

  async broadcastGroup(group, extraRecipients = []) {
    const body = { k: 'group', mid: randomToken(12), ts: Date.now(), group };
    const to = new Set([...group.members, ...extraRecipients]);
    to.delete(this.me);
    const envelopes = [];
    for (const id of to) {
      try {
        envelopes.push(await this.sealFor(id, body));
      } catch {
        /* пропускаем */
      }
    }
    await this.enqueue(envelopes, null, null);
  }

  async systemNote(gid, text) {
    await this.appendMessage(chatKeyGroup(gid), { id: randomToken(12), from: this.me, ts: Date.now(), text, system: true });
  }

  async validateMembers(ids) {
    const out = [];
    for (const raw of ids) {
      const id = normalizeId(raw);
      if (!id) throw new Error('bad_id');
      if (id === this.me || out.includes(id)) continue;
      await this.keysFor(id);
      out.push(id);
    }
    return out;
  }

  async createGroup(name, memberIds) {
    const members = [this.me, ...(await this.validateMembers(memberIds))];
    if (members.length > MAX_GROUP) throw new Error('too_many');
    const group = { id: randomToken(16), name: name.trim().slice(0, 64), owner: this.me, members, ver: 1 };
    this.groups[group.id] = group;
    await this.vault.set('groups', this.groups);
    await this.systemNote(group.id, 'Группа создана');
    this.emit('groups');
    await this.broadcastGroup(group);
    return group.id;
  }

  async updateGroup(gid, fn, note) {
    const g = this.groups[gid];
    if (!g || g.removed || g.owner !== this.me) throw new Error('not_owner');
    const before = g.members;
    const next = { ...g, ...fn(g), ver: g.ver + 1 };
    if (next.members.length > MAX_GROUP) throw new Error('too_many');
    this.groups[gid] = next;
    await this.vault.set('groups', this.groups);
    if (note) await this.systemNote(gid, note);
    this.emit('groups');
    // удалённые участники тоже получают новую версию — так они узнают, что их исключили
    await this.broadcastGroup(next, before.filter((id) => !next.members.includes(id)));
  }

  async addMembers(gid, ids) {
    const add = await this.validateMembers(ids);
    const fresh = add.filter((id) => !this.groups[gid].members.includes(id));
    if (!fresh.length) return;
    await this.updateGroup(gid, (g) => ({ members: [...g.members, ...fresh] }), `Добавлены: ${fresh.map((id) => this.nameOf(id)).join(', ')}`);
  }

  async removeMember(gid, id) {
    await this.updateGroup(gid, (g) => ({ members: g.members.filter((x) => x !== id) }), `${this.nameOf(id)} исключён(а)`);
  }

  async renameGroup(gid, name) {
    await this.updateGroup(gid, () => ({ name: name.trim().slice(0, 64) }), `Новое название: ${name.trim()}`);
  }

  async leaveGroup(gid) {
    const g = this.groups[gid];
    if (!g) return;
    if (g.removed) {
      delete this.groups[gid];
      await this.vault.set('groups', this.groups);
      await this.deleteChat(chatKeyGroup(gid));
      this.emit('groups');
      return;
    }
    const body = { k: 'leave', mid: randomToken(12), ts: Date.now(), gid };
    const envelopes = [];
    for (const id of g.members.filter((x) => x !== this.me)) {
      try {
        envelopes.push(await this.sealFor(id, body));
      } catch {
        /* пропускаем */
      }
    }
    delete this.groups[gid];
    await this.vault.set('groups', this.groups);
    await this.deleteChat(chatKeyGroup(gid));
    this.emit('groups');
    await this.enqueue(envelopes, null, null);
  }

  // ---------- приём ----------

  async onEnvelope({ id, payload }) {
    try {
      const msg = await open(this.vault.identity, payload, (from) => this.keysFor(from));
      await this.handle(msg);
    } catch (err) {
      console.warn('Отброшено сообщение:', err.message);
    }
    this.conn.ack([id]);
  }

  async handle(m) {
    const from = m.from;
    if (this.contacts[from]?.blocked) return;
    const ts = Math.min(Number(m.ts) || Date.now(), Date.now() + 60_000);

    if (m.k === 'text') {
      if (typeof m.text !== 'string' || !m.text || m.text.length > MAX_TEXT) return;
      let key;
      if (m.gid) {
        const g = this.groups[m.gid];
        if (!g || g.removed || !g.members.includes(from)) return;
        key = chatKeyGroup(m.gid);
      } else {
        if (!this.contacts[from]) {
          this.contacts[from] = { id: from, name: '', unknown: true, blocked: false };
          await this.saveContacts();
        }
        key = chatKeyDM(from);
      }
      await this.appendMessage(key, { id: String(m.mid), from, ts, text: m.text, out: false });
      return;
    }

    if (m.k === 'group') {
      const g = m.group;
      if (!g || typeof g.id !== 'string' || !Array.isArray(g.members) || g.members.length > MAX_GROUP) return;
      const members = g.members.map(normalizeId);
      if (members.some((x) => !x)) return;
      const local = this.groups[g.id];
      if (local?.removed) return;
      // Принимаем изменения только от владельца и только более новые версии (защита от повторов).
      if (local ? local.owner !== from || g.ver <= local.ver : g.owner !== from) return;
      if (g.owner !== from || !Number.isInteger(g.ver)) return;
      if (!members.includes(this.me)) {
        if (local && !local.removed) {
          this.groups[g.id] = { ...local, removed: true, ver: g.ver };
          await this.vault.set('groups', this.groups);
          await this.systemNote(g.id, 'Вас исключили из группы');
          this.emit('groups');
        }
        return;
      }
      const next = { id: g.id, name: String(g.name || 'Группа').slice(0, 64), owner: from, members, ver: g.ver };
      this.groups[g.id] = next;
      await this.vault.set('groups', this.groups);
      if (!local) await this.systemNote(g.id, `${this.nameOf(from)} добавил(а) вас в группу`);
      else if (local.name !== next.name) await this.systemNote(g.id, `Новое название: ${next.name}`);
      this.emit('groups');
      return;
    }

    if (m.k === 'leave') {
      const g = this.groups[m.gid];
      if (!g || g.removed || !g.members.includes(from)) return;
      g.members = g.members.filter((x) => x !== from);
      if (g.owner === from) {
        // владелец ушёл: детерминированно назначаем нового, одинаково у всех участников
        g.owner = [...g.members].sort()[0];
      }
      await this.vault.set('groups', this.groups);
      await this.systemNote(g.id, `${this.nameOf(from)} покинул(а) группу`);
      this.emit('groups');
    }
  }
}
