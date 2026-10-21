// Криптография мессенджера. Чистый WebCrypto — модуль работает и в браузере, и в Node.js (сервер
// использует отсюда только проверку ID и подписи).
//
// Личность пользователя = две пары ключей P-256:
//   sign — ECDSA, подпись сообщений и вход на сервер;
//   dh   — ECDH, получение зашифрованных сообщений.
// ID = хэш SHA-256 от обоих публичных ключей, поэтому ID «самоудостоверяющий»: сервер не может
// подменить ключи собеседника — клиент всегда пересчитывает ID из полученных ключей.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

export const PBKDF2_ITERATIONS = 600_000;

// ---------- кодирование ----------

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(n = 16) {
  return toB64(randomBytes(n)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- ID ----------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: без I, L, O, U
export const ID_LENGTH = 20; // 100 бит

function base32(bytes, length) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export async function deriveId(signRaw, dhRaw) {
  const digest = await subtle.digest('SHA-256', concat(te.encode('vault-id-v1'), signRaw, dhRaw));
  return base32(new Uint8Array(digest), ID_LENGTH);
}

/** Приводит введённый пользователем ID к каноническому виду или возвращает null. */
export function normalizeId(input) {
  if (typeof input !== 'string') return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== ID_LENGTH) return null;
  for (const c of s) if (!B32.includes(c)) return null;
  return s;
}

export function formatId(id) {
  return id.match(/.{1,5}/g).join('-');
}

// ---------- публичные ключи ----------

export async function importPublicKeys(signB64, dhB64) {
  const signRaw = fromB64(signB64);
  const dhRaw = fromB64(dhB64);
  const [sign, dh, id] = await Promise.all([
    subtle.importKey('raw', signRaw, ECDSA, false, ['verify']),
    subtle.importKey('raw', dhRaw, ECDH, false, []),
    deriveId(signRaw, dhRaw),
  ]);
  return { id, sign, dh, signB64, dhB64 };
}

export async function verify(publicSignKey, signature, data) {
  try {
    return await subtle.verify(SIG, publicSignKey, signature, data);
  } catch {
    return false;
  }
}

// ---------- личность ----------

export async function generateIdentity() {
  const [sign, dh] = await Promise.all([
    subtle.generateKey(ECDSA, true, ['sign', 'verify']),
    subtle.generateKey(ECDH, true, ['deriveBits']),
  ]);
  const [signJwk, dhJwk] = await Promise.all([
    subtle.exportKey('jwk', sign.privateKey),
    subtle.exportKey('jwk', dh.privateKey),
  ]);
  return importIdentity({ v: 1, sign: signJwk, dh: dhJwk });
}

/**
 * Импортирует личность из JWK. Приватные ключи импортируются как неизвлекаемые (extractable=false):
 * даже вредоносный скрипт на странице не сможет их выгрузить. JWK хранится только в зашифрованном виде.
 */
export async function importIdentity(bundle) {
  const clean = (jwk, priv) => {
    const { kty, crv, x, y, d } = jwk;
    return priv ? { kty, crv, x, y, d } : { kty, crv, x, y };
  };
  const [signPriv, dhPriv, signPub, dhPub] = await Promise.all([
    subtle.importKey('jwk', clean(bundle.sign, true), ECDSA, false, ['sign']),
    subtle.importKey('jwk', clean(bundle.dh, true), ECDH, false, ['deriveBits']),
    subtle.importKey('jwk', clean(bundle.sign, false), ECDSA, true, ['verify']),
    subtle.importKey('jwk', clean(bundle.dh, false), ECDH, true, []),
  ]);
  const [signRaw, dhRaw] = await Promise.all([
    subtle.exportKey('raw', signPub),
    subtle.exportKey('raw', dhPub),
  ]);
  const signB64 = toB64(signRaw);
  const dhB64 = toB64(dhRaw);
  return {
    id: await deriveId(new Uint8Array(signRaw), new Uint8Array(dhRaw)),
    signPriv,
    dhPriv,
    signPub,
    dhPub,
    signB64,
    dhB64,
    bundle,
  };
}

export async function signText(identity, text) {
  return toB64(await subtle.sign(SIG, identity.signPriv, te.encode(text)));
}

// ---------- сквозное шифрование сообщений ----------

async function sealKey(sharedBits, ephRaw, recipient) {
  const salt = await subtle.digest('SHA-256', concat(ephRaw, fromB64(recipient.dhB64)));
  const ikm = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('vault-seal-v1:' + recipient.id) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Шифрует сообщение для получателя.
 * Схема: эфемерный ECDH(P-256) + HKDF-SHA256 → AES-256-GCM. Внутри — тело и подпись ECDSA
 * отправителя. Сервер видит только ID получателя; отправитель спрятан внутри шифротекста.
 * Новый эфемерный ключ на каждое сообщение: утечка ключа отправителя не раскрывает его
 * прошлые отправленные сообщения.
 */
export async function seal(identity, recipient, message) {
  const body = te.encode(JSON.stringify({ ...message, from: identity.id, to: recipient.id }));
  const sig = new Uint8Array(await subtle.sign(SIG, identity.signPriv, body));
  const inner = te.encode(JSON.stringify({ b: toB64(body), s: toB64(sig) }));

  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient.dh }, eph.privateKey, 256);
  const key = await sealKey(shared, ephRaw, recipient);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(recipient.id) },
    key,
    inner,
  );
  return JSON.stringify({ v: 1, e: toB64(ephRaw), n: toB64(iv), c: toB64(ct) });
}

/**
 * Расшифровывает и проверяет конверт. lookupKeys(id) должен вернуть проверенные публичные ключи
 * отправителя (см. importPublicKeys). Бросает исключение, если что-то не сходится.
 */
export async function open(identity, envelope, lookupKeys) {
  const env = JSON.parse(envelope);
  if (env.v !== 1) throw new Error('unsupported envelope');
  const ephRaw = fromB64(env.e);
  const ephPub = await subtle.importKey('raw', ephRaw, ECDH, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: ephPub }, identity.dhPriv, 256);
  const key = await sealKey(shared, ephRaw, identity);
  const inner = JSON.parse(
    td.decode(
      await subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(env.n), additionalData: te.encode(identity.id) },
        key,
        fromB64(env.c),
      ),
    ),
  );
  const body = fromB64(inner.b);
  const message = JSON.parse(td.decode(body));
  if (message.to !== identity.id) throw new Error('wrong recipient');
  if (!normalizeId(message.from) || message.from !== normalizeId(message.from)) throw new Error('bad sender');
  const sender = await lookupKeys(message.from);
  if (!sender || sender.id !== message.from) throw new Error('unknown sender');
  if (!(await verify(sender.sign, fromB64(inner.s), body))) throw new Error('bad signature');
  return message;
}

// ---------- локальное хранилище: шифрование паролем ----------

export async function deriveVaultKey(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(key, value, aad = '') {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) },
    key,
    te.encode(JSON.stringify(value)),
  );
  return { n: toB64(iv), c: toB64(ct) };
}

export async function decryptJSON(key, box, aad = '') {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(box.n), additionalData: te.encode(aad) },
    key,
    fromB64(box.c),
  );
  return JSON.parse(td.decode(pt));
}
