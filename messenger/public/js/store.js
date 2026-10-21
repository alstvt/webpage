// Локальное хранилище в IndexedDB. Всё, кроме соли и параметров PBKDF2, хранится зашифрованным
// ключом, производным от пароля. Без пароля база — набор случайных байтов.

import {
  deriveVaultKey,
  encryptJSON,
  decryptJSON,
  importIdentity,
  generateIdentity,
  randomBytes,
  toB64,
  PBKDF2_ITERATIONS,
} from './crypto.js';

const DB_NAME = 'vault-messenger';
const KV = 'kv';
const META = 'account';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(KV);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

async function raw(mode, fn) {
  const tx = (await db()).transaction(KV, mode);
  return req(fn(tx.objectStore(KV)));
}

const rawGet = (k) => raw('readonly', (s) => s.get(k));
const rawPut = (k, v) => raw('readwrite', (s) => s.put(v, k));
const rawKeys = () => raw('readonly', (s) => s.getAllKeys());

export async function accountId() {
  return (await rawGet(META))?.id ?? null;
}

export class Vault {
  constructor(key, identity) {
    this.key = key;
    this.identity = identity;
    this.queue = Promise.resolve();
  }

  async get(name, fallback = null) {
    const box = await rawGet('d:' + name);
    return box ? decryptJSON(this.key, box, name) : fallback;
  }

  // Записи сериализуются, чтобы параллельные обновления одной записи не теряли данные.
  set(name, value) {
    this.queue = this.queue.then(async () => rawPut('d:' + name, await encryptJSON(this.key, value, name)));
    return this.queue;
  }

  async update(name, fallback, fn) {
    let result;
    this.queue = this.queue.then(async () => {
      const box = await rawGet('d:' + name);
      const cur = box ? await decryptJSON(this.key, box, name) : fallback;
      result = fn(cur) ?? cur;
      await rawPut('d:' + name, await encryptJSON(this.key, result, name));
    });
    await this.queue;
    return result;
  }

  async remove(name) {
    this.queue = this.queue.then(() => raw('readwrite', (s) => s.delete('d:' + name)));
    return this.queue;
  }

  async names(prefix) {
    return (await rawKeys())
      .filter((k) => typeof k === 'string' && k.startsWith('d:' + prefix))
      .map((k) => k.slice(2));
  }

  /** Резервная копия: зашифрованная личность + контакты + группы (без истории). */
  async exportBackup() {
    const meta = await rawGet(META);
    const data = {};
    for (const name of ['contacts', 'groups', 'settings']) {
      const box = await rawGet('d:' + name);
      if (box) data[name] = box;
    }
    return { app: 'vault-messenger', v: 1, ...meta, data };
  }
}

export async function createAccount(password) {
  const salt = toB64(randomBytes(16));
  const key = await deriveVaultKey(password, salt);
  const identity = await generateIdentity();
  const meta = {
    id: identity.id,
    salt,
    iterations: PBKDF2_ITERATIONS,
    identity: await encryptJSON(key, identity.bundle, 'identity'),
  };
  await rawPut(META, meta);
  return new Vault(key, identity);
}

async function unlockMeta(meta, password) {
  const key = await deriveVaultKey(password, meta.salt, meta.iterations);
  let bundle;
  try {
    bundle = await decryptJSON(key, meta.identity, 'identity');
  } catch {
    throw new Error('wrong_password');
  }
  const identity = await importIdentity(bundle);
  if (identity.id !== meta.id) throw new Error('corrupt');
  return new Vault(key, identity);
}

export async function unlock(password) {
  const meta = await rawGet(META);
  if (!meta) throw new Error('no_account');
  return unlockMeta(meta, password);
}

export async function restoreBackup(backup, password) {
  if (backup?.app !== 'vault-messenger' || backup.v !== 1) throw new Error('bad_backup');
  const meta = { id: backup.id, salt: backup.salt, iterations: backup.iterations, identity: backup.identity };
  const vault = await unlockMeta(meta, password);
  await wipe();
  await rawPut(META, meta);
  for (const [name, box] of Object.entries(backup.data || {})) await rawPut('d:' + name, box);
  return vault;
}

export async function wipe() {
  await raw('readwrite', (s) => s.clear());
}
