// Окно расширения (SPEC-POPUP.md): вкладки «Главная · Серверы · Правила · Настройки» внизу,
// вложенные экраны поверх вкладки (стрелка «назад» и Esc), «?» — помощь, «Развернуть» — тот же
// интерфейс на всю вкладку браузера (popup.html?full; им же открывается страница настроек).
// Окно только показывает данные из chrome.storage и шлёт команды фону.

import { applyTheme } from '../lib/theme.js';
import { arrival, checkDesign, designOf, focusedId, goDesign } from '../lib/design.js';
import { initLookButton } from '../lib/lookmenu.js';
import { startPage, t } from '../lib/i18n.js';
import { ISSUES_URL, helpUrl } from '../lib/companion.js';
import { pacHost } from '../lib/domains.js';
import { $, dialogOpen, el, initMenu, menuOpen, openMenu, setIcon, toast, toastOpen } from './ui.js';
import { S, activeTab, closeScreen, loadData, screenOpen, showTab } from './state.js';
import { checkHost } from './home.js';
import './servers.js';
import { rulesActions } from './rules.js';
import { backupActions } from './settings.js';
import { openFull } from './full.js';
import { initLangButton } from './langbtn.js';
import { checkPerm } from './siteperm.js';

// Тема нового окна — своя настройка. Оформление (lib/design.js): выбрано классическое — это окно
// сразу переходит в него и дальше не строится. До этого страница не показывается (lib/common.css).
await applyTheme('themeLcd');
if (!(await checkDesign('lcd'))) await new Promise(() => {});
const arrived = arrival(); // пришли из классического окна: на какой вкладке оно было и куда поставить фокус
startPage(); // надписи разметки — сразу, на языке прошлого раза (настройка читается чуть позже)

const params = new URLSearchParams(location.search);
S.full = params.has('full');
document.documentElement.classList.toggle('full', S.full);

// --- шапка и вкладки ---

setIcon($('helpBtn'), 'help');
setIcon($('expandBtn'), 'expand');
$('expandBtn').hidden = S.full;
const TAB_ICONS = { home: 'home', servers: 'servers', rules: 'rules', settings: 'settings' };
for (const tab of document.querySelectorAll('.tabbar .tab')) {
  setIcon(tab.querySelector('.tab-icon'), TAB_ICONS[tab.dataset.tab]);
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
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
initLangButton($('langBtn'), () => S.view?.settings?.language || 'auto');
// Кнопка оформления: меню «Вид окна» и «Тема» (тема нового окна — настройка themeLcd).
setIcon($('lookBtn').querySelector('.chev'), 'down');
initLookButton($('lookBtn'), { themeKey: 'themeLcd', settings: () => S.view?.settings });
$('helpBtn').addEventListener('click', () => openMenu($('helpBtn'), [
  { label: t('top.help'), run: () => chrome.tabs.create({ url: helpUrl() }) },
  { label: t('top.report'), run: () => chrome.tabs.create({ url: ISSUES_URL }) },
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab?.url || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') S.site = { host: pacHost(u.hostname), tabId: tab.id };
  } catch {
    S.site = null;
  }
}

// Действие с файлом, ради которого развернули страницу: кнопка — по нажатию (выбор файла и
// сохранение Chrome разрешает только в ответ на нажатие). Что это за действие и как называется
// кнопка — ключи словаря.
const FILE_ACTIONS = {
  import: ['file.import', 'file.choose', rulesActions.import],
  export: ['file.export', 'file.save', rulesActions.export],
  'backup-save': ['file.backupSave', 'settings.backup.save', backupActions['backup-save']],
  'backup-restore': ['file.backupRestore', 'file.choose', backupActions['backup-restore']],
};

function offerFileAction() {
  const a = FILE_ACTIONS[params.get('do')];
  if (!S.full || !a) return;
  const bar = el('div', { className: 'action-bar', role: 'status' }, el('span', { textContent: t(a[0]) }),
    el('button', { type: 'button', className: 'btn', textContent: t(a[1]), onclick: () => { bar.remove(); a[2](); } }),
    el('button', { type: 'button', className: 'link', textContent: t('file.dismiss'), onclick: () => bar.remove() }));
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

// Оформление сменили (в этом окне или в другом): перейти в классическое окно на той же вкладке.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const want = designOf(changes.settings.newValue);
  if (want !== 'lcd') goDesign(want, { tab: activeTab() || '', focus: focusedId() });
});

// Окно всегда открывается на «Главной»; развёрнутая страница — на вкладке из адреса; после смены
// оформления — на той вкладке, где оно было.
const first = arrived?.tab || (S.full ? location.hash.slice(1) || 'home' : 'home');
Promise.all([loadSite(), checkPerm()]).then(loadData).then(() => {
  showTab(first);
  // Вид сменили строкой в настройках или кнопкой в шапке — фокус на том же месте в этом окне.
  if (arrived?.focus) {
    $(arrived.focus).scrollIntoView({ block: 'center' });
    $(arrived.focus).focus();
  }
  performance.mark('waysplit-ready'); // окно показано с данными — замер в tools/chrome-check.js
  offerFileAction();
  checkHost();
});
