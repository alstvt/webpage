import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server.js';
import {
  generateIdentity,
  importIdentity,
  importPublicKeys,
  seal,
  open,
  signText,
  normalizeId,
  formatId,
  deriveVaultKey,
  encryptJSON,
  decryptJSON,
  toB64,
  randomBytes,
} from '../public/js/crypto.js';

let srv;
let url;

before(async () => {
  srv = createServer();
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${srv.server.address().port}`;
});

after(() => {
  for (const ws of srv.wss.clients) ws.terminate();
  srv.server.close();
});

/** Клиент: подключается, проходит вход по подписи, копит входящие сообщения. */
function client(identity, { authOverride } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    const c = {
      ws,
      inbox,
      send: (o) => ws.send(JSON.stringify(o)),
      next(type) {
        const i = inbox.findIndex((m) => m.t === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res) => waiters.push({ type, res }));
      },
      close: () => ws.close(),
    };
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'challenge') {
        c.nonce = m.nonce;
        const sig = await signText(identity, 'vault-auth-v1:' + m.nonce);
        c.send({ t: 'auth', id: identity.id, sign: identity.signB64, dh: identity.dhB64, sig, ...authOverride });
        return;
      }
      if (m.t === 'auth') return m.ok ? resolve(c) : reject(new Error(m.error));
      const w = waiters.findIndex((x) => x.type === m.t);
      if (w >= 0) waiters.splice(w, 1)[0].res(m);
      else inbox.push(m);
    });
    ws.on('error', reject);
  });
}

const lookup = (identity) => async (id) => (id === identity.id ? importPublicKeys(identity.signB64, identity.dhB64) : null);

test('ID детерминированно выводится из ключей и переживает экспорт', async () => {
  const a = await generateIdentity();
  const again = await importIdentity(JSON.parse(JSON.stringify(a.bundle)));
  assert.equal(again.id, a.id);
  assert.equal(a.id.length, 20);
  assert.equal(normalizeId(formatId(a.id).toLowerCase()), a.id);
  assert.equal(normalizeId('short'), null);
});

test('сквозное шифрование: только получатель читает, подпись проверяется', async () => {
  const [alice, bob, eve] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  const bobKeys = await importPublicKeys(bob.signB64, bob.dhB64);
  const env = await seal(alice, bobKeys, { k: 'text', text: 'привет' });

  assert.ok(!env.includes('привет'));
  assert.ok(!env.includes(alice.id), 'отправитель не виден снаружи');

  const msg = await open(bob, env, lookup(alice));
  assert.equal(msg.text, 'привет');
  assert.equal(msg.from, alice.id);
  assert.equal(msg.to, bob.id);

  await assert.rejects(open(eve, env, lookup(alice)), 'чужой ключ не расшифрует');

  const tampered = JSON.parse(env);
  const ct = Buffer.from(tampered.c, 'base64');
  ct[5] ^= 1;
  tampered.c = ct.toString('base64');
  await assert.rejects(open(bob, JSON.stringify(tampered), lookup(alice)), 'изменённый шифротекст отвергается');

  // Ева выдаёт себя за Алису: подписывает своим ключом, но в сообщении from=Алиса
  const forged = await seal({ ...eve, id: alice.id }, bobKeys, { k: 'text', text: 'фальшивка' });
  await assert.rejects(open(bob, forged, lookup(alice)), /bad signature/);
});

test('локальное хранилище: AES-GCM ключ из пароля', async () => {
  const salt = toB64(randomBytes(16));
  const key = await deriveVaultKey('correct horse', salt, 1000);
  const box = await encryptJSON(key, { a: 1 }, 'contacts');
  assert.deepEqual(await decryptJSON(key, box, 'contacts'), { a: 1 });
  await assert.rejects(decryptJSON(key, box, 'groups'), 'запись нельзя подставить под другое имя');
  const wrong = await deriveVaultKey('wrong', salt, 1000);
  await assert.rejects(decryptJSON(wrong, box, 'contacts'));
});

test('сервер: вход, поиск ключей, офлайн-доставка, подтверждение', async () => {
  const [alice, bob] = await Promise.all([generateIdentity(), generateIdentity()]);
  const a = await client(alice);
  const b0 = await client(bob);
  b0.close();

  a.send({ t: 'keys', req: 'r1', id: formatId(bob.id) });
  const keys = await a.next('keys');
  assert.equal(keys.id, bob.id);
  const bobKeys = await importPublicKeys(keys.sign, keys.dh);
  assert.equal(bobKeys.id, bob.id, 'клиент проверяет ID по ключам');

  const payload = await seal(alice, bobKeys, { k: 'text', text: 'ты офлайн?' });
  a.send({ t: 'send', id: 'm1', to: bob.id, payload });
  assert.equal((await a.next('sent')).ok, true);

  const b = await client(bob);
  const msg = await b.next('msg');
  assert.equal((await open(bob, msg.payload, lookup(alice))).text, 'ты офлайн?');
  b.send({ t: 'ack', ids: [msg.id] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(srv.store.data.queues[bob.id], undefined, 'после подтверждения сервер забывает сообщение');

  // онлайн-доставка
  a.send({ t: 'send', id: 'm2', to: bob.id, payload });
  assert.equal((await b.next('msg')).id, 'm2');
  assert.equal((await a.next('sent')).id, 'm2');

  a.send({ t: 'send', id: 'm3', to: 'AAAAAAAAAAAAAAAAAAAA', payload });
  assert.equal((await a.next('sent')).error, 'not_found');

  a.close();
  b.close();
});

test('сервер: нельзя войти с чужим ID или без подписи', async () => {
  const [alice, mallory] = await Promise.all([generateIdentity(), generateIdentity()]);
  await (await client(alice)).close();
  await assert.rejects(client(mallory, { authOverride: { id: alice.id } }), /id_mismatch/);
  await assert.rejects(client(alice, { authOverride: { sig: toB64(randomBytes(64)) } }), /bad_signature/);
});

test('сервер: до входа ничего нельзя', async () => {
  const ws = new WebSocket(url);
  const reply = await new Promise((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'keys', req: 'x', id: 'A' }));
      else resolve(m);
    });
  });
  assert.equal(reply.error, 'unauthenticated');
  ws.close();
});

test('сервер: удаление аккаунта по подписи', async () => {
  const id = await generateIdentity();
  const c = await client(id);
  c.send({ t: 'delete', sig: await signText(id, 'vault-delete-v1:' + c.nonce) });
  assert.equal((await c.next('deleted')).ok, true);
  assert.equal(srv.store.user(id.id), null);
});
