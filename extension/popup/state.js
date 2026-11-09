// Данные окна и переходы: вкладки внизу и вложенные экраны поверх вкладки (SPEC-POPUP.md).
// Окно только показывает данные из chrome.storage и шлёт команды фону (lib/format.js, send).

import { normalize } from '../lib/storage.js';
import { $, el, setIcon } from './ui.js';

// S — всё, что показывает окно. site — открытая вкладка браузера: { host, tabId } (только http(s));
// full — окно развёрнуто на всю вкладку (popup.html?full).
export const S = { view: normalize(), status: null, site: null, full: false };

const dataSubs = new Set();
export const onData = (fn) => dataSubs.add(fn);

export async function loadData() {
  const [local, session] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get('status')]);
  S.view = normalize(local);
  S.status = session.status || null;
  for (const fn of dataSubs) fn();
  renderVisible();
}

export const currentServer = () => S.view.servers.find((s) => s.id === S.view.currentServerId) || null;
export const serverById = (id) => S.view.servers.find((s) => s.id === id) || null;
export const isFav = (s) => S.view.favorites.includes(s.key);
export const vpnOn = () => S.view.enabled && currentServer() !== null;

// --- вкладки ---

const tabs = new Map(); // имя → render()
let active = null;

export function defineTab(name, render) {
  tabs.set(name, render);
}

export const activeTab = () => active;

export function showTab(name) {
  if (!tabs.has(name)) name = 'home';
  closeAllScreens();
  active = name;
  for (const t of document.querySelectorAll('.tabbar .tab')) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`panel-${t.dataset.tab}`).hidden = !on;
  }
  $('content').scrollTop = 0;
  if (S.full) history.replaceState(null, '', `${location.pathname}${location.search}#${name}`);
  tabs.get(name)();
}

// renderVisible — после изменения данных: видимая вкладка и открытые экраны.
export function renderVisible() {
  if (active) tabs.get(active)();
  for (const sc of stack) sc.render();
}

// --- вложенные экраны: выбор сервера, добавление, подписка, диагностика ---

const stack = [];

// openScreen({ title, sub, actions, build(screen), render(screen) }) — экран поверх вкладки,
// вверху стрелка «назад» (и Esc). build — один раз, render — при каждом изменении данных.
export function openScreen({ title, sub = '', actions = [], build = null, render = null, className = '' }) {
  const back = el('button', { type: 'button', className: 'icon-btn back', title: 'Назад (Esc)' });
  back.setAttribute('aria-label', 'Назад');
  setIcon(back, 'back');
  const titleEl = el('h2', { className: 'screen-title', textContent: title });
  const subEl = el('span', { className: 'screen-sub', textContent: sub });
  const body = el('div', { className: 'screen-body' });
  const sec = el('section', { className: `screen ${className}`.trim() },
    el('header', { className: 'screen-head' }, back, el('div', { className: 'screen-titles' }, titleEl, subEl), ...actions),
    body);
  sec.setAttribute('role', 'dialog');
  sec.setAttribute('aria-label', title);
  sec.tabIndex = -1; // фокус — на сам экран: так клавиатура и чтение с экрана начинают с него
  const screen = {
    sec,
    body,
    onClose: null,
    setTitle: (t) => { titleEl.textContent = t; sec.setAttribute('aria-label', t); },
    setSub: (t) => { subEl.textContent = t; },
    render: () => render?.(screen),
  };
  back.addEventListener('click', closeScreen);
  if (stack.length) stack[stack.length - 1].sec.inert = true;
  else for (const id of ['content', 'top']) $(id).inert = true;
  stack.push(screen);
  $('screens').append(sec);
  build?.(screen);
  screen.render();
  sec.focus();
  return screen;
}

export function closeScreen() {
  const sc = stack.pop();
  if (!sc) return;
  sc.sec.remove();
  sc.onClose?.();
  if (stack.length) {
    const top = stack[stack.length - 1];
    top.sec.inert = false;
    top.sec.focus();
  } else {
    for (const id of ['content', 'top']) $(id).inert = false;
  }
}

export function closeAllScreens() {
  while (stack.length) closeScreen();
}

export const screenOpen = () => stack.length > 0;
