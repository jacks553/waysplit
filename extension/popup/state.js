// Данные окна и переходы: вкладки внизу и вложенные экраны поверх вкладки (SPEC-POPUP.md).
// Окно только показывает данные из chrome.storage и шлёт команды фону (lib/format.js, send).

import { normalize } from '../lib/storage.js';
import { siteData } from '../lib/sitedomains.js';
import { t, usePageLanguage } from '../lib/i18n.js';
import { $, el, setIcon, toast } from './ui.js';

// S — всё, что показывает окно. site — открытая вкладка браузера: { host, tabId } (только http(s));
// full — окно развёрнуто на всю вкладку (popup.html?full).
// siteNew — { id вкладки: [новые «домены сайта»] }: подсказка «обновите вкладку» на «Главной».
// ruDomains — домены переключателя «Российские сайты — без VPN» (набор из lib/domain-sets.json):
// по ним окно показывает маршрут сайта так же, как его решит PAC.
export const S = { view: normalize(), status: null, site: null, full: false, siteNew: {}, ruDomains: [] };

let ruLoading = null; // файл самого расширения — читается один раз
const loadRu = () => (ruLoading ??= fetch(chrome.runtime.getURL('lib/domain-sets.json')).then((r) => r.json()).then((j) => siteData(j).ruDirect, () => []));

export async function loadData() {
  const [local, session, ru] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(['status', 'siteNew']), loadRu()]);
  S.ruDomains = ru;
  S.view = normalize(local);
  S.status = session.status || null;
  S.siteNew = session.siteNew || {};
  updateLight();
  // Язык сменили (в «Настройках» или восстановлением из копии): надписи разметки уже заменены;
  // открытые экраны и сообщение внизу собраны на прежнем языке — закрыть, вкладку перерисовать.
  if (usePageLanguage(S.view.settings.language)) {
    closeAllScreens();
    toast('');
  }
  renderVisible();
}

// updateLight — подсветка экрана, одна на все вкладки: горит, когда VPN включён и при ошибке (в том
// числе когда компаньона нет — S.hostProblem, его ставит «Главная»), иначе погашена.
export function updateLight() {
  document.documentElement.dataset.light = S.view?.enabled || S.status?.state === 'error' || S.hostProblem ? 'on' : 'off';
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
  for (const box of document.querySelectorAll('.panel-scroll')) box.scrollTop = 0;
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
// вверху клавиша «назад» (и Esc). build — один раз, render — при каждом изменении данных.
// Содержимое экрана (screen.body) прокручивается целиком. fixed: true — не прокручивается: экран сам
// ставит внутрь список с классом panel-scroll, остальное стоит на месте (выбор сервера, домены вкладки).
export function openScreen({ title, sub = '', actions = [], build = null, render = null, className = '', fixed = false }) {
  const back = el('button', { type: 'button', className: 'back-key', title: t('common.back.title') });
  back.setAttribute('aria-label', t('common.back'));
  setIcon(back, 'back');
  const titleEl = el('h2', { className: 'screen-title', textContent: title });
  const subEl = el('span', { className: 'screen-sub', textContent: sub });
  const frame = el('div', { className: 'screen-body lcd' });
  const body = fixed ? frame : frame.appendChild(el('div', { className: 'panel-scroll screen-scroll' }));
  const sec = el('section', { className: `screen ${className}`.trim() },
    el('header', { className: 'screen-head' }, back, el('div', { className: 'screen-titles' }, titleEl, subEl), ...actions),
    frame);
  sec.setAttribute('role', 'dialog');
  sec.setAttribute('aria-label', title);
  sec.tabIndex = -1; // фокус — на сам экран: так клавиатура и чтение с экрана начинают с него
  const screen = {
    sec,
    body,
    onClose: null,
    setTitle: (text) => { titleEl.textContent = text; sec.setAttribute('aria-label', text); },
    setSub: (text) => { subEl.textContent = text; },
    render: () => render?.(screen),
  };
  back.addEventListener('click', closeScreen);
  screen.opener = focusPath(document.activeElement); // куда вернуть фокус, когда экран закроют
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
  // Фокус — туда, откуда экран открыли (кнопка, строка списка): клавиатура продолжает с того же места.
  const opener = sc.opener && document.querySelector(sc.opener);
  if (opener && opener.offsetWidth && !opener.closest('[inert]')) opener.focus();
}

// focusPath — как найти элемент снова: списки перерисовываются, и сам элемент к закрытию экрана
// может быть уже другим. По id, либо по действию внутри строки списка или блока подписки.
function focusPath(node) {
  if (!node || node === document.body) return '';
  if (node.id) return `#${CSS.escape(node.id)}`;
  const row = node.closest('li[data-id], [data-sub]');
  const key = row ? (row.dataset.id ? `li[data-id="${CSS.escape(row.dataset.id)}"]` : `[data-sub="${CSS.escape(row.dataset.sub)}"]`) : '';
  if (!key) return '';
  if (node === row) return key;
  return node.dataset.action ? `${key} [data-action="${CSS.escape(node.dataset.action)}"]` : key;
}

export function closeAllScreens() {
  while (stack.length) closeScreen();
}

export const screenOpen = () => stack.length > 0;
