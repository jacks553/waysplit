// Окно расширения (SPEC-POPUP.md): вкладки «Главная · Серверы · Правила · Настройки» внизу,
// вложенные экраны поверх вкладки (стрелка «назад» и Esc), «?» — помощь, «Развернуть» — тот же
// интерфейс на всю вкладку браузера (popup.html?full; им же открывается страница настроек).
// Окно только показывает данные из chrome.storage и шлёт команды фону.

import { applyTheme } from '../lib/theme.js';
import { HELP_URL, ISSUES_URL } from '../lib/companion.js';
import { pacHost } from '../lib/domains.js';
import { $, dialogOpen, el, initMenu, menuOpen, openMenu, setIcon, toast, toastOpen } from './ui.js';
import { S, closeScreen, loadData, screenOpen, showTab } from './state.js';
import { checkHost } from './home.js';
import './servers.js';
import { rulesActions } from './rules.js';
import { backupActions } from './settings.js';
import { openFull } from './full.js';
import { checkPerm } from './siteperm.js';

applyTheme();

const params = new URLSearchParams(location.search);
S.full = params.has('full');
document.documentElement.classList.toggle('full', S.full);

// --- шапка и вкладки ---

setIcon($('helpBtn'), 'help');
setIcon($('expandBtn'), 'expand');
$('expandBtn').hidden = S.full;
const TAB_ICONS = { home: 'home', servers: 'servers', rules: 'rules', settings: 'settings' };
for (const t of document.querySelectorAll('.tabbar .tab')) {
  setIcon(t.querySelector('.tab-icon'), TAB_ICONS[t.dataset.tab]);
  t.addEventListener('click', () => showTab(t.dataset.tab));
}
// Стрелки влево и вправо — по вкладкам (как у обычного списка вкладок).
document.querySelector('.tabbar').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...document.querySelectorAll('.tabbar .tab')];
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
  showTab(next.dataset.tab);
});

initMenu();
$('helpBtn').addEventListener('click', () => openMenu($('helpBtn'), [
  { label: 'Помощь', run: () => chrome.tabs.create({ url: HELP_URL }) },
  { label: 'Сообщить об ошибке', run: () => chrome.tabs.create({ url: ISSUES_URL }) },
]));
$('expandBtn').addEventListener('click', () => openFull(document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab));

// Esc — назад (меню и окно вопроса закрываются сами, раньше экрана).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || menuOpen() || dialogOpen()) return;
  // Сообщение внизу окна, которое само не исчезает, — первым: оно поверх всего.
  if (toastOpen()) {
    e.preventDefault();
    toast('');
  } else if (screenOpen()) {
    e.preventDefault();
    closeScreen();
  }
});

// --- данные ---

// loadSite — открытая вкладка браузера (разрешение activeTab даётся, когда открыли окно).
// На развёрнутой странице сайт приходит в адресе (full.js).
async function loadSite() {
  if (S.full) {
    const host = params.get('site');
    const tabId = Number(params.get('tabId'));
    if (host && tabId) S.site = { host, tabId };
    return;
  }
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(t?.url || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') S.site = { host: pacHost(u.hostname), tabId: t.id };
  } catch {
    S.site = null;
  }
}

// Действие с файлом, ради которого развернули страницу: кнопка — по нажатию (выбор файла и
// сохранение Chrome разрешает только в ответ на нажатие).
const FILE_ACTIONS = {
  import: ['Импорт правил из файла', 'Выбрать файл', rulesActions.import],
  export: ['Экспорт правил в файл (секретов в нём нет)', 'Сохранить файл', rulesActions.export],
  'backup-save': ['Резервная копия: серверы, подписки, правила и настройки. В файле секреты — храните его как пароль.', 'Сохранить копию', backupActions['backup-save']],
  'backup-restore': ['Восстановить из резервной копии: текущие данные будут заменены.', 'Выбрать файл', backupActions['backup-restore']],
};

function offerFileAction() {
  const a = FILE_ACTIONS[params.get('do')];
  if (!S.full || !a) return;
  const bar = el('div', { className: 'action-bar', role: 'status' }, el('span', { textContent: a[0] }),
    el('button', { type: 'button', className: 'btn btn-small', textContent: a[1], onclick: () => { bar.remove(); a[2](); } }),
    el('button', { type: 'button', className: 'link', textContent: 'Не нужно', onclick: () => bar.remove() }));
  $(`panel-${location.hash.slice(1) || 'home'}`)?.prepend(bar);
}

// Список доменов вкладок и сайты вкладок (lib/tabdomains.js) фон пишет в память сеанса от запросов
// вкладок, а окну они не нужны: изменились только они — данные не перечитываем. Это список
// исключений: на любое другое изменение окно перечитывает данные.
const NOT_FOR_WINDOW = ['tabDomains', 'tabTops'];
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === 'session' && keys.length && keys.every((k) => NOT_FOR_WINDOW.includes(k))) return;
  if (area === 'local' || area === 'session') loadData();
});

// Окно всегда открывается на «Главной»; развёрнутая страница — на вкладке из адреса.
const first = S.full ? location.hash.slice(1) || 'home' : 'home';
Promise.all([loadSite(), checkPerm()]).then(loadData).then(() => {
  showTab(first);
  performance.mark('waysplit-ready'); // окно показано с данными — замер в tools/chrome-check.js
  offerFileAction();
  checkHost();
});
