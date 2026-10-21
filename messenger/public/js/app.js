// Интерфейс. Весь пользовательский текст попадает в DOM только через textContent — без innerHTML.

import { formatId, normalizeId } from './crypto.js';
import { accountId, createAccount, unlock, restoreBackup, wipe } from './store.js';
import { Connection } from './net.js';
import { Messenger, chatKeyDM, chatKeyGroup } from './core.js';

// ---------- DOM-помощники ----------

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const ICONS = {
  chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>',
  group: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5a6.5 6.5 0 0 1 3 5.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  send: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.6-3.4 8.4-8 9-4.6-.6-8-4.4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  leave: '<path d="M15 4h4v16h-4M10 16l-4-4 4-4M6 12h10"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  userplus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name]; // только константы из ICONS
  return svg;
}

function fillIcons(root) {
  for (const el of root.querySelectorAll('[data-icon]')) el.replaceChildren(icon(el.dataset.icon));
}

function hue(id) {
  let x = 0;
  for (const c of id) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

function avatar(id, name, cls = '') {
  const words = (name || '').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const letters = (words.length ? words.slice(0, 2).map((w) => [...w][0]).join('') : id.slice(0, 2)).toUpperCase();
  return h('span', { class: 'avatar ' + cls, style: { '--av': `hsl(${hue(id)} 55% 52%)` } }, letters);
}

function groupAvatar(gid, cls = '') {
  const el = h('span', { class: 'avatar ' + cls, style: { '--av': `hsl(${hue(gid)} 45% 48%)` } });
  el.append(icon('group'));
  return el;
}

const timeFmt = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: '2-digit' });
const wdFmt = new Intl.DateTimeFormat('ru', { weekday: 'short' });

function listTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (now - d < 6 * 86400_000) return wdFmt.format(d);
  return shortFmt.format(d);
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  if (d.toDateString() === new Date(now - 86400_000).toDateString()) return 'Вчера';
  return dayFmt.format(d);
}

function toast(text) {
  const el = h('div', { class: 'toast' }, text);
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch {
    toast('Не удалось скопировать');
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// ---------- модальные окна ----------

function modal(build, onClose) {
  const root = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const backdrop = h('div', { class: 'modal-backdrop' });
  const sheet = h('div', { class: 'sheet' });
  root.append(backdrop, sheet);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    root.classList.add('closing');
    sheet.addEventListener('animationend', () => root.remove(), { once: true });
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && root === $('#modal-root').lastElementChild && close();
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', close);
  sheet.append(...[build(close)].flat());
  $('#modal-root').append(root);
  requestAnimationFrame(() => sheet.querySelector('input:not([type=checkbox]), textarea')?.focus());
  return close;
}

function confirmDialog(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    modal(
      (close) => [
        h('h3', {}, title),
        h('p', {}, text),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn ghost', onclick: close }, 'Отмена'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => ((ok = true), close()) }, okLabel),
        ),
      ],
      () => resolve(ok),
    );
  });
}

// ---------- тема ----------

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('vault-theme', theme);
  } catch {
    /* хранилище недоступно */
  }
}

try {
  applyTheme(localStorage.getItem('vault-theme') || 'system');
} catch {
  /* хранилище недоступно */
}

// ---------- вход и регистрация ----------

const authEl = $('#auth');

function authScreen(...kids) {
  authEl.replaceChildren(h('div', { class: 'auth-card' }, ...kids));
  fillIcons(authEl);
  requestAnimationFrame(() => authEl.querySelector('input')?.focus());
}

const logo = () => h('div', { class: 'logo', 'data-icon': 'shield' });

function showWelcome() {
  authScreen(
    logo(),
    h('h2', {}, 'Vault'),
    h('p', {}, 'Приватный мессенджер. Ни телефона, ни почты — только ID, который создаётся на вашем устройстве.'),
    h(
      'div',
      { class: 'stack' },
      h('button', { class: 'btn primary', onclick: showCreate }, 'Создать аккаунт'),
      h('button', { class: 'btn', onclick: showRestore }, 'Восстановить из резервной копии'),
    ),
  );
}

function passwordError(p1, p2) {
  if (p1.length < 8) return 'Пароль — минимум 8 символов';
  if (p1 !== p2) return 'Пароли не совпадают';
  return '';
}

function showCreate() {
  const p1 = h('input', { class: 'field', type: 'password', placeholder: 'Пароль', autocomplete: 'new-password' });
  const p2 = h('input', { class: 'field', type: 'password', placeholder: 'Повторите пароль', autocomplete: 'new-password' });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn primary' }, 'Создать');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const msg = passwordError(p1.value, p2.value);
        err.textContent = msg;
        if (msg) return;
        authScreen(logo(), h('h2', {}, 'Создаём ключи'), h('p', {}, 'Ключи шифрования генерируются прямо на этом устройстве'), h('div', { class: 'spinner' }));
        await nextFrame();
        const vault = await createAccount(p1.value);
        showNewId(vault);
      },
    },
    p1,
    p2,
    err,
    btn,
    h('button', { class: 'btn ghost', type: 'button', onclick: showWelcome }, 'Назад'),
  );
  authScreen(
    logo(),
    h('h2', {}, 'Новый аккаунт'),
    h('p', {}, 'Пароль шифрует ключи и переписку на этом устройстве. Его нельзя восстановить — запомните его.'),
    form,
  );
}

function showNewId(vault) {
  const id = formatId(vault.identity.id);
  authScreen(
    logo(),
    h('h2', {}, 'Ваш ID готов'),
    h('p', {}, 'Это ваш единственный идентификатор. Передайте его тем, с кем хотите общаться.'),
    h(
      'div',
      { class: 'id-card' },
      h('small', {}, 'Ваш ID'),
      h('span', { class: 'id-value' }, id),
      h('button', { class: 'copy-btn', onclick: () => copy(id) }, icon('copy'), 'Скопировать'),
    ),
    h('div', { class: 'stack' }, h('button', { class: 'btn primary', onclick: () => startApp(vault) }, 'Начать')),
    h('p', { class: 'hint' }, 'Совет: сохраните резервную копию в настройках, чтобы не потерять аккаунт.'),
  );
}

async function showUnlock() {
  const id = await accountId();
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn primary' }, 'Разблокировать');
  let attempts = 0;
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!pass.value) return;
        btn.disabled = true;
        err.textContent = '';
        btn.textContent = 'Проверяем…';
        await nextFrame();
        try {
          const vault = await unlock(pass.value);
          await startApp(vault);
        } catch {
          attempts++;
          // нарастающая задержка после неудачных попыток
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempts * 250, 8000)));
          err.textContent = 'Неверный пароль';
          form.classList.remove('shake');
          void form.offsetWidth;
          form.classList.add('shake');
          pass.select();
          btn.disabled = false;
          btn.textContent = 'Разблокировать';
        }
      },
    },
    pass,
    err,
    btn,
    h(
      'button',
      {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => {
          if (await confirmDialog('Выйти из аккаунта?', 'Все данные на этом устройстве будут удалены. Без резервной копии аккаунт не восстановить.', 'Удалить данные', true)) {
            await wipe();
            location.reload();
          }
        },
      },
      'Другой аккаунт',
    ),
  );
  authScreen(
    logo(),
    h('h2', {}, 'Vault заблокирован'),
    h('p', { class: 'mono-id' }, formatId(id)),
    form,
  );
}

function showRestore() {
  const file = h('input', { class: 'field', type: 'file', accept: '.json,application/json' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Пароль от копии', autocomplete: 'current-password' });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn primary' }, 'Восстановить');
  authScreen(
    logo(),
    h('h2', {}, 'Восстановление'),
    h('p', {}, 'Выберите файл резервной копии и введите пароль, с которым она была создана.'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const f = file.files[0];
          if (!f) return (err.textContent = 'Выберите файл');
          btn.disabled = true;
          try {
            const backup = JSON.parse(await f.text());
            const vault = await restoreBackup(backup, pass.value);
            await startApp(vault);
          } catch (ex) {
            err.textContent = ex.message === 'wrong_password' ? 'Неверный пароль' : 'Файл повреждён или не подходит';
            btn.disabled = false;
          }
        },
      },
      file,
      pass,
      err,
      btn,
      h('button', { class: 'btn ghost', type: 'button', onclick: showWelcome }, 'Назад'),
    ),
  );
}

// ---------- основное приложение ----------

let app; // Messenger
let conn;
let activeKey = null;
let currentTab = 'chats';
const TABS = ['chats', 'groups', 'settings'];
const TAB_TITLES = { chats: 'Чаты', groups: 'Группы', settings: 'Настройки' };

async function startApp(vault) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  conn = new Connection(vault.identity, `${proto}//${location.host}`);
  app = new Messenger(vault, conn);
  await app.init();
  applyTheme(app.settings.theme);

  authEl.hidden = true;
  authEl.replaceChildren();
  $('#main').hidden = false;
  fillIcons($('#main'));
  $('#add-btn').replaceChildren(icon('plus'));

  conn.addEventListener('status', (e) => {
    $('#net').classList.toggle('on', e.detail);
    $('#net').title = e.detail ? 'Подключено' : 'Нет соединения';
  });
  conn.addEventListener('auth-error', (e) => toast(e.detail === 'rate' ? 'Слишком много регистраций, попробуйте позже' : 'Ошибка входа на сервер'));

  app.addEventListener('chats', scheduleLists);
  app.addEventListener('contacts', () => {
    scheduleLists();
    renderSettings();
    if (activeKey) renderChatHead();
  });
  app.addEventListener('groups', () => {
    scheduleLists();
    if (activeKey?.startsWith('g:')) renderChatHead();
  });
  app.addEventListener('message', (e) => {
    if (e.detail.key === activeKey) appendMessage(e.detail.msg, true);
  });
  app.addEventListener('status', (e) => {
    if (e.detail.key !== activeKey) return;
    const node = $(`#messages [data-mid="${CSS.escape(e.detail.msg.id)}"]`);
    if (node) node.replaceWith(messageNode(e.detail.msg, false));
  });

  bindMain();
  renderLists();
  renderSettings();
  setTab('chats', false);
  setupAutoLock();
  setInterval(async () => {
    if (!app.settings.ttl) return;
    await app.applyTtl();
    if (activeKey) renderMessages();
  }, 60_000);
  await app.applyTtl();
  conn.start();
}

function bindMain() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('#add-btn').addEventListener('click', () => (currentTab === 'groups' ? createGroupDialog() : addContactDialog()));
  $('#search').addEventListener('input', scheduleLists);
  $('#back').addEventListener('click', () => (history.state?.chat ? history.back() : closeChat()));
  window.addEventListener('popstate', () => activeKey && closeChat());
  $('#chat-who').addEventListener('click', () => activeKey && infoDialog());

  const input = $('#input');
  const send = $('#send');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 160) + 'px';
    send.disabled = !input.value.trim();
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || !activeKey) return;
    input.value = '';
    autosize();
    try {
      await app.sendText(activeKey, text);
    } catch (ex) {
      input.value = text;
      autosize();
      toast(ex.message === 'too_long' ? 'Слишком длинное сообщение' : 'Не удалось отправить');
    }
  });
  autosize();
}

function setTab(tab, animate = true) {
  currentTab = tab;
  const i = TABS.indexOf(tab);
  const track = $('#track');
  const ind = $('#tab-indicator');
  if (!animate) {
    track.style.transition = ind.style.transition = 'none';
    requestAnimationFrame(() => (track.style.transition = ind.style.transition = ''));
  }
  track.style.transform = `translateX(${(-i * 100) / 3}%)`;
  ind.style.transform = `translateX(${i * 100}%)`;
  for (const b of $('#tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#tab-title').textContent = TAB_TITLES[tab];
  $('#add-btn').classList.toggle('hide', tab === 'settings');
  $('#add-btn').setAttribute('aria-label', tab === 'groups' ? 'Создать группу' : 'Добавить контакт');
  $('.search').hidden = tab === 'settings';
}

// ---------- списки ----------

let listsQueued = false;
function scheduleLists() {
  if (listsQueued) return;
  listsQueued = true;
  requestAnimationFrame(() => {
    listsQueued = false;
    renderLists();
  });
}

function listItem(key, avatarEl, title, last, ts, unread) {
  return h(
    'li',
    { class: 'item' + (key === activeKey ? ' active' : ''), 'data-key': key, onclick: () => openChat(key) },
    avatarEl,
    h(
      'div',
      { class: 'item-body' },
      h('div', { class: 'item-row' }, h('span', { class: 'item-title' }, title), ts ? h('span', { class: 'item-time' }, listTime(ts)) : null),
      h('div', { class: 'item-row' }, h('span', { class: 'item-last' }, last), unread ? h('span', { class: 'unread' }, unread > 99 ? '99+' : unread) : null),
    ),
  );
}

function matches(q, ...fields) {
  return !q || fields.some((f) => f && f.toLowerCase().includes(q));
}

let renderedOnce = false;
function renderLists() {
  const q = $('#search').value.trim().toLowerCase();
  const qId = q.replace(/[\s-]/g, '');

  // личные чаты: все контакты + все, кто писал
  const dmIds = new Set(Object.keys(app.contacts));
  for (const key of Object.keys(app.chats)) if (key.startsWith('dm:')) dmIds.add(key.slice(3));
  const dms = [...dmIds]
    .map((id) => ({ id, key: chatKeyDM(id), c: app.contacts[id], meta: app.chats[chatKeyDM(id)] }))
    .filter((x) => !(x.c?.blocked && !x.meta))
    .filter((x) => matches(q, x.c?.name) || matches(qId, x.id.toLowerCase()))
    .sort((a, b) => (b.meta?.ts || 0) - (a.meta?.ts || 0));

  const chatsList = $('#list-chats');
  chatsList.replaceChildren(
    ...dms.map((x) =>
      listItem(
        x.key,
        avatar(x.id, x.c?.name),
        x.c?.unknown ? 'Неизвестный' : app.nameOf(x.id),
        x.c?.blocked ? 'Заблокирован' : x.meta?.last || formatId(x.id),
        x.meta?.last ? x.meta.ts : null,
        x.meta?.unread,
      ),
    ),
  );
  if (!dms.length) {
    chatsList.append(
      h(
        'li',
        { class: 'empty-list' },
        q ? 'Ничего не найдено' : 'Чатов пока нет. Добавьте собеседника по его ID.',
        q ? null : h('div', {}, h('button', { class: 'btn primary', onclick: addContactDialog }, 'Добавить контакт')),
      ),
    );
  }

  const groups = Object.values(app.groups)
    .map((g) => ({ g, key: chatKeyGroup(g.id), meta: app.chats[chatKeyGroup(g.id)] }))
    .filter((x) => matches(q, x.g.name))
    .sort((a, b) => (b.meta?.ts || 0) - (a.meta?.ts || 0));
  const groupsList = $('#list-groups');
  groupsList.replaceChildren(
    ...groups.map((x) =>
      listItem(x.key, groupAvatar(x.g.id), x.g.name, x.meta?.last || `${x.g.members.length} участн.`, x.meta?.ts, x.meta?.unread),
    ),
  );
  if (!groups.length) {
    groupsList.append(
      h(
        'li',
        { class: 'empty-list' },
        q ? 'Ничего не найдено' : 'Групп пока нет.',
        q ? null : h('div', {}, h('button', { class: 'btn primary', onclick: createGroupDialog }, 'Создать группу')),
      ),
    );
  }

  // анимация появления только при первом показе, а не при каждом обновлении
  if (renderedOnce) for (const li of document.querySelectorAll('.list .item')) li.style.animation = 'none';
  renderedOnce = true;

  const sum = (prefix) => Object.entries(app.chats).reduce((a, [k, c]) => a + (k.startsWith(prefix) ? c.unread || 0 : 0), 0);
  const unreadDm = sum('dm:');
  const unreadG = sum('g:');
  setBadge('chats', unreadDm);
  setBadge('groups', unreadG);
  document.title = unreadDm + unreadG ? `(${unreadDm + unreadG}) Vault` : 'Vault';
}

function setBadge(tab, n) {
  const b = $(`#tabs button[data-tab="${tab}"] .badge`);
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
}

// ---------- чат ----------

async function openChat(key) {
  if (activeKey === key) return;
  const wasOpen = !!activeKey;
  activeKey = key;
  await app.markRead(key);
  renderChatHead();
  await renderMessages();
  $('#chat').classList.add('has-chat');
  for (const li of document.querySelectorAll('.list .item')) li.classList.toggle('active', li.dataset.key === key);
  if (matchMedia('(max-width: 760px)').matches) {
    if (!wasOpen) history.pushState({ chat: 1 }, '');
  } else {
    $('#input').focus();
  }
}

function closeChat() {
  activeKey = null;
  app.activeChat = null;
  $('#chat').classList.remove('has-chat');
  for (const li of document.querySelectorAll('.list .item.active')) li.classList.remove('active');
}

function renderChatHead() {
  if (!activeKey) return;
  const isGroup = activeKey.startsWith('g:');
  const id = activeKey.slice(isGroup ? 2 : 3);
  const banner = $('#banner');
  const composer = $('#composer');
  banner.hidden = true;
  composer.classList.remove('locked');
  for (const el of composer.children) el.hidden = false;
  composer.querySelector('.locked-text')?.remove();

  const lock = (text) => {
    composer.classList.add('locked');
    for (const el of composer.children) el.hidden = true;
    composer.append(h('span', { class: 'locked-text' }, text));
  };

  if (isGroup) {
    const g = app.groups[id];
    $('#chat-avatar').replaceWith(Object.assign(groupAvatar(id, 'sm'), { id: 'chat-avatar' }));
    $('#chat-title').textContent = g?.name || 'Группа';
    $('#chat-sub').textContent = g ? `${g.members.length} участн. · сквозное шифрование` : '';
    $('#chat-sub').classList.remove('mono');
    if (!g || !app.isMember(id)) lock('Вы больше не участник этой группы');
  } else {
    const c = app.contacts[id];
    $('#chat-avatar').replaceWith(Object.assign(avatar(id, c?.name, 'sm'), { id: 'chat-avatar' }));
    $('#chat-title').textContent = c?.unknown ? 'Неизвестный' : app.nameOf(id);
    $('#chat-sub').textContent = formatId(id);
    $('#chat-sub').classList.add('mono');
    if (c?.blocked) lock('Контакт заблокирован');
    else if (c?.unknown) {
      banner.hidden = false;
      banner.replaceChildren(
        h('span', {}, 'Этого ID нет в ваших контактах. Убедитесь, что знаете собеседника.'),
        h('button', { class: 'btn primary', onclick: () => renameDialog(id) }, 'Добавить'),
        h('button', { class: 'btn danger', onclick: () => blockContact(id) }, 'Заблокировать'),
      );
    }
  }
}

let lastRenderedDay = null;

function messageNode(m, animate) {
  if (m.system) return h('div', { class: 'sys' + (animate ? ' new' : '') }, m.text);
  const isGroup = activeKey.startsWith('g:');
  const meta = h('span', { class: 'msg-meta' }, timeFmt.format(new Date(m.ts)));
  if (m.out) meta.append(icon(m.status === 'sent' ? 'check' : m.status === 'failed' ? 'alert' : 'clock'));
  const el = h(
    'div',
    {
      class: 'msg' + (m.out ? ' out' : '') + (m.status === 'failed' ? ' failed' : '') + (animate ? ' new' : ''),
      'data-mid': m.id,
      title: m.status === 'failed' ? 'Не доставлено: получатель не найден' : null,
    },
    isGroup && !m.out ? h('span', { class: 'msg-author', style: { '--av': `hsl(${hue(m.from)} 55% 52%)` } }, app.nameOf(m.from)) : null,
    m.text,
    meta,
  );
  return el;
}

function dayNode(ts) {
  return h('div', { class: 'day' }, dayLabel(ts));
}

async function renderMessages() {
  const box = $('#messages');
  const list = await app.history(activeKey);
  const frag = document.createDocumentFragment();
  lastRenderedDay = null;
  for (const m of list) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastRenderedDay) {
      frag.append(dayNode(m.ts));
      lastRenderedDay = day;
    }
    frag.append(messageNode(m, false));
  }
  box.replaceChildren(frag);
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m, animate) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const day = new Date(m.ts).toDateString();
  if (day !== lastRenderedDay) {
    box.append(dayNode(m.ts));
    lastRenderedDay = day;
  }
  box.append(messageNode(m, animate));
  if (nearBottom || m.out) requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }));
  app.markRead(activeKey);
}

// ---------- диалоги ----------

function errorText(code) {
  return (
    {
      bad_id: 'Неверный формат ID',
      self: 'Это ваш собственный ID',
      not_found: 'Пользователь с таким ID не найден',
      offline: 'Нет соединения с сервером',
      timeout: 'Сервер не отвечает',
      key_mismatch: 'Ключи не совпадают с ID — возможна атака',
      too_many: 'Слишком много участников',
      not_owner: 'Только владелец группы может это сделать',
    }[code] || 'Что-то пошло не так'
  );
}

function addContactDialog() {
  modal((close) => {
    const idIn = h('input', { class: 'field', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX', autocomplete: 'off', spellcheck: 'false', style: { 'font-family': 'var(--mono)' } });
    const nameIn = h('input', { class: 'field', placeholder: 'Имя (видно только вам)', maxlength: 64, autocomplete: 'off' });
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn primary' }, 'Добавить');
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const id = normalizeId(idIn.value);
          if (!id) return (err.textContent = errorText('bad_id'));
          btn.disabled = true;
          try {
            await app.addContact(id, nameIn.value);
            close();
            setTab('chats');
            openChat(chatKeyDM(id));
          } catch (ex) {
            err.textContent = errorText(ex.message);
            btn.disabled = false;
          }
        },
      },
      h('h3', {}, 'Новый контакт'),
      h('p', {}, 'Введите ID собеседника. Имя хранится только у вас и никуда не отправляется.'),
      h('div', { class: 'stack' }, idIn, nameIn, err),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Отмена'), btn),
    );
  });
}

function contactPicker(exclude = []) {
  const ids = Object.values(app.contacts)
    .filter((c) => !c.blocked && !c.unknown && !exclude.includes(c.id))
    .sort((a, b) => app.nameOf(a.id).localeCompare(app.nameOf(b.id)));
  const box = h(
    'div',
    { class: 'pick' },
    ids.map((c) => h('label', {}, h('input', { type: 'checkbox', value: c.id }), avatar(c.id, c.name, 'sm'), h('span', {}, app.nameOf(c.id)))),
  );
  if (!ids.length) box.append(h('div', { class: 'empty-list' }, 'Нет доступных контактов'));
  const extra = h('textarea', { class: 'field', rows: 2, placeholder: 'Или ID через запятую', spellcheck: 'false' });
  return {
    nodes: [box, extra],
    value: () => [
      ...[...box.querySelectorAll('input:checked')].map((i) => i.value),
      ...extra.value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean),
    ],
  };
}

function createGroupDialog() {
  modal((close) => {
    const nameIn = h('input', { class: 'field', placeholder: 'Название группы', maxlength: 64 });
    const picker = contactPicker();
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn primary' }, 'Создать');
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          if (!nameIn.value.trim()) return (err.textContent = 'Введите название');
          const ids = picker.value();
          if (!ids.length) return (err.textContent = 'Выберите хотя бы одного участника');
          btn.disabled = true;
          try {
            const gid = await app.createGroup(nameIn.value, ids);
            close();
            setTab('groups');
            openChat(chatKeyGroup(gid));
          } catch (ex) {
            err.textContent = errorText(ex.message);
            btn.disabled = false;
          }
        },
      },
      h('h3', {}, 'Новая группа'),
      h('p', {}, 'Сервер не знает о группе: её состав и сообщения передаются только в зашифрованном виде.'),
      h('div', { class: 'stack' }, nameIn, ...picker.nodes, err),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Отмена'), btn),
    );
  });
}

function renameDialog(id) {
  modal((close) => {
    const nameIn = h('input', { class: 'field', placeholder: 'Имя', maxlength: 64, value: app.contacts[id]?.name || '' });
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          await app.renameContact(id, nameIn.value);
          close();
        },
      },
      h('h3', {}, 'Имя контакта'),
      h('p', {}, 'Видно только вам.'),
      nameIn,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Отмена'), h('button', { class: 'btn primary' }, 'Сохранить')),
    );
  });
}

async function blockContact(id) {
  if (!(await confirmDialog('Заблокировать?', 'Сообщения от этого ID будут отбрасываться на вашем устройстве.', 'Заблокировать', true))) return;
  await app.setBlocked(id, true);
  renderChatHead();
}

function row(iconName, label, opts = {}) {
  return h(
    opts.onclick ? 'button' : 'div',
    { class: 'row' + (opts.danger ? ' danger' : ''), onclick: opts.onclick },
    iconName ? icon(iconName) : null,
    h('span', { class: 'row-label' }, label, opts.sub ? h('small', {}, opts.sub) : null),
    opts.right || null,
  );
}

function infoDialog() {
  const key = activeKey;
  if (key.startsWith('dm:')) {
    const id = key.slice(3);
    modal((close) => {
      const c = app.contacts[id];
      return [
        h('div', { class: 'my-id' }, avatar(id, c?.name), h('h3', {}, c?.unknown ? 'Неизвестный' : app.nameOf(id))),
        h('div', { class: 'id-card' }, h('small', {}, 'ID'), h('span', { class: 'id-value' }, formatId(id)), h('button', { class: 'copy-btn', onclick: () => copy(formatId(id)) }, icon('copy'), 'Скопировать')),
        h('p', { class: 'hint' }, 'ID — это отпечаток ключей шифрования. Если он совпадает с тем, что назвал вам собеседник лично, переписку никто не подменит.'),
        h(
          'div',
          { class: 'card', style: { 'margin-top': '14px' } },
          row('userplus', c && !c.unknown ? 'Изменить имя' : 'Добавить в контакты', { onclick: () => (close(), renameDialog(id)) }),
          c?.blocked
            ? row('block', 'Разблокировать', { onclick: async () => (await app.setBlocked(id, false), close(), renderChatHead()) })
            : row('block', 'Заблокировать', { danger: true, onclick: () => (close(), blockContact(id)) }),
          row('trash', 'Удалить чат и контакт', {
            danger: true,
            onclick: async () => {
              close();
              if (!(await confirmDialog('Удалить чат?', 'История и контакт будут удалены с этого устройства.', 'Удалить', true))) return;
              delete app.contacts[id];
              await app.saveContacts();
              await app.deleteChat(key);
              closeChat();
            },
          }),
        ),
      ];
    });
    return;
  }

  const gid = key.slice(2);
  modal((close) => {
    const g = app.groups[gid];
    if (!g) return [h('h3', {}, 'Группа'), h('p', {}, 'Группа больше недоступна.')];
    const owner = g.owner === app.me && !g.removed;
    const members = [...g.members].sort((a, b) => (a === g.owner ? -1 : b === g.owner ? 1 : app.nameOf(a).localeCompare(app.nameOf(b))));
    return [
      h('div', { class: 'my-id' }, groupAvatar(gid), h('h3', {}, g.name), h('p', { class: 'hint' }, `${g.members.length} участн.`)),
      h('div', { class: 'group-title' }, 'Участники'),
      h(
        'div',
        {},
        members.map((id) =>
          h(
            'div',
            { class: 'member' },
            avatar(id, app.contacts[id]?.name, 'sm'),
            h('span', { class: 'row-label' }, app.nameOf(id), h('small', {}, formatId(id))),
            id === g.owner ? h('span', { class: 'tag' }, 'владелец') : null,
            owner && id !== app.me
              ? h(
                  'button',
                  {
                    class: 'icon-btn',
                    'aria-label': 'Исключить',
                    onclick: async () => {
                      close();
                      if (await confirmDialog('Исключить участника?', app.nameOf(id) + ' больше не будет получать сообщения группы.', 'Исключить', true)) {
                        await app.removeMember(gid, id).catch((ex) => toast(errorText(ex.message)));
                      }
                    },
                  },
                  icon('close'),
                )
              : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'card', style: { 'margin-top': '14px' } },
        owner ? row('userplus', 'Добавить участников', { onclick: () => (close(), addMembersDialog(gid)) }) : null,
        owner ? row('chat', 'Переименовать', { onclick: () => (close(), renameGroupDialog(gid)) }) : null,
        row('leave', g.removed ? 'Удалить группу' : 'Покинуть группу', {
          danger: true,
          onclick: async () => {
            close();
            if (!(await confirmDialog(g.removed ? 'Удалить группу?' : 'Покинуть группу?', 'История группы будет удалена с этого устройства.', g.removed ? 'Удалить' : 'Покинуть', true))) return;
            await app.leaveGroup(gid);
            closeChat();
          },
        }),
      ),
    ];
  });
}

function addMembersDialog(gid) {
  modal((close) => {
    const picker = contactPicker(app.groups[gid].members);
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn primary' }, 'Добавить');
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const ids = picker.value();
          if (!ids.length) return (err.textContent = 'Никто не выбран');
          btn.disabled = true;
          try {
            await app.addMembers(gid, ids);
            close();
          } catch (ex) {
            err.textContent = errorText(ex.message);
            btn.disabled = false;
          }
        },
      },
      h('h3', {}, 'Добавить участников'),
      h('p', {}, 'Новые участники не увидят прежнюю переписку.'),
      h('div', { class: 'stack' }, ...picker.nodes, err),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Отмена'), btn),
    );
  });
}

function renameGroupDialog(gid) {
  modal((close) => {
    const nameIn = h('input', { class: 'field', maxlength: 64, value: app.groups[gid].name });
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!nameIn.value.trim()) return;
          await app.renameGroup(gid, nameIn.value).catch((ex) => toast(errorText(ex.message)));
          close();
        },
      },
      h('h3', {}, 'Название группы'),
      h('p', {}, 'Новое название увидят все участники.'),
      nameIn,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Отмена'), h('button', { class: 'btn primary' }, 'Сохранить')),
    );
  });
}

function blockedDialog() {
  modal((close) => {
    const blocked = Object.values(app.contacts).filter((c) => c.blocked);
    return [
      h('h3', {}, 'Заблокированные'),
      h('p', {}, blocked.length ? 'Сообщения от этих ID отбрасываются.' : 'Список пуст.'),
      blocked.map((c) =>
        h(
          'div',
          { class: 'member' },
          avatar(c.id, c.name, 'sm'),
          h('span', { class: 'row-label' }, c.name || 'Без имени', h('small', {}, formatId(c.id))),
          h('button', { class: 'btn', onclick: async () => (await app.setBlocked(c.id, false), close(), renderSettings()) }, 'Разблокировать'),
        ),
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: close }, 'Закрыть')),
    ];
  });
}

// ---------- настройки ----------

function segmented(options, value, onChange) {
  const thumb = h('span', { class: 'thumb', style: { width: `calc((100% - 6px) / ${options.length})` } });
  const box = h('div', { class: 'segmented' }, thumb);
  const set = (v) => {
    const i = options.findIndex((o) => o[0] === v);
    thumb.style.transform = `translateX(${i * 100}%)`;
    for (const b of box.querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === v);
  };
  for (const [v, label] of options) {
    box.append(
      h('button', {
        'data-v': v,
        onclick: () => {
          set(v);
          onChange(v);
        },
      }, label),
    );
  }
  set(value);
  return box;
}

function select(options, value, onChange) {
  const s = h('select', { onchange: () => onChange(Number(s.value)) }, options.map(([v, label]) => h('option', { value: v }, label)));
  s.value = String(value);
  return s;
}

function renderSettings() {
  const id = formatId(app.me);
  const blockedCount = Object.values(app.contacts).filter((c) => c.blocked).length;
  const el = h(
    'div',
    { class: 'settings' },
    h(
      'div',
      { class: 'card my-id' },
      avatar(app.me, ''),
      h('small', { class: 'hint' }, 'Ваш ID'),
      h('span', { class: 'id-value' }, id),
      h('button', { class: 'copy-btn', onclick: () => copy(id) }, icon('copy'), 'Скопировать'),
      h('p', { class: 'hint' }, 'По этому ID вас найдут. Больше о вас никто ничего не знает.'),
    ),

    h('div', { class: 'group-title' }, 'Оформление'),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        segmented(
          [
            ['system', 'Авто'],
            ['light', 'Светлая'],
            ['dark', 'Тёмная'],
          ],
          app.settings.theme,
          (v) => {
            applyTheme(v);
            app.saveSettings({ theme: v });
          },
        ),
      ),
    ),

    h('div', { class: 'group-title' }, 'Безопасность'),
    h(
      'div',
      { class: 'card' },
      row('lock', 'Автоблокировка', {
        sub: 'При бездействии',
        right: select(
          [
            [1, '1 мин'],
            [5, '5 мин'],
            [15, '15 мин'],
            [60, '1 час'],
            [0, 'Никогда'],
          ],
          app.settings.lock,
          (v) => {
            app.saveSettings({ lock: v });
            resetLockTimer();
          },
        ),
      }),
      row('timer', 'Автоудаление сообщений', {
        sub: 'На этом устройстве',
        right: select(
          [
            [0, 'Выкл'],
            [3600_000, '1 час'],
            [86400_000, '1 день'],
            [7 * 86400_000, '7 дней'],
            [30 * 86400_000, '30 дней'],
          ],
          app.settings.ttl,
          async (v) => {
            await app.saveSettings({ ttl: v });
            if (activeKey) renderMessages();
          },
        ),
      }),
      row('block', 'Заблокированные', { sub: blockedCount ? `${blockedCount}` : 'Нет', onclick: blockedDialog }),
    ),

    h('div', { class: 'group-title' }, 'Данные'),
    h(
      'div',
      { class: 'card' },
      row('download', 'Резервная копия', { sub: 'Ключи, контакты и группы, зашифрованы паролем', onclick: exportBackup }),
      row('lock', 'Заблокировать сейчас', { onclick: lockNow }),
      row('trash', 'Удалить аккаунт', { danger: true, onclick: deleteAccount }),
    ),
    h(
      'p',
      { class: 'hint', style: { 'text-align': 'center', 'margin-top': '18px' } },
      'Vault 1.0 · ECDH P-256 · AES-256-GCM · ECDSA',
    ),
  );
  $('#settings').replaceChildren(el);
}

async function exportBackup() {
  const backup = await app.vault.exportBackup();
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `vault-backup-${app.me.slice(0, 5)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Копия сохранена. Для восстановления нужен пароль');
}

function lockNow() {
  conn?.stop();
  location.reload(); // ключи живут только в памяти страницы — перезагрузка стирает их
}

async function deleteAccount() {
  if (!(await confirmDialog('Удалить аккаунт?', 'ID будет удалён с сервера, а все данные — с этого устройства. Это действие необратимо.', 'Удалить навсегда', true))) return;
  try {
    const res = await conn.deleteAccount();
    if (!res.ok) throw new Error();
  } catch {
    toast('Нужно соединение с сервером');
    return;
  }
  conn.stop();
  await wipe();
  location.reload();
}

// ---------- автоблокировка ----------

let lockTimer = null;
function resetLockTimer() {
  clearTimeout(lockTimer);
  const min = app?.settings.lock;
  if (min) lockTimer = setTimeout(lockNow, min * 60_000);
}

function setupAutoLock() {
  let last = 0;
  const bump = () => {
    const now = Date.now();
    if (now - last < 5000) return; // не трогаем таймер на каждое движение
    last = now;
    resetLockTimer();
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, bump, { passive: true });
  resetLockTimer();
}

// ---------- запуск ----------

(async () => {
  if (!window.isSecureContext || !crypto.subtle) {
    authScreen(logo(), h('h2', {}, 'Нужен HTTPS'), h('p', {}, 'Шифрование доступно только по защищённому соединению (HTTPS или localhost).'));
    return;
  }
  if (await accountId()) showUnlock();
  else showWelcome();
})();
