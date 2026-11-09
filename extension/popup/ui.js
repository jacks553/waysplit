// Общее для окна: элементы, значки, флаги, полоски пинга, меню «⋯», окно вопроса, сообщения,
// значки сайтов.

import { pingBars, splitFlag } from '../lib/format.js';
import { toUnicode } from '../lib/domains.js';

export const $ = (id) => document.getElementById(id);

// el('li', { className: 'x' }, child, 'текст') — элемент со свойствами и детьми.
export function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

// Значки — свои, простыми линиями (24×24). Цвет — от текста.
const ICONS = {
  home: '<path d="M4 10.6 12 4l8 6.6V20h-5.4v-5.6H9.4V20H4z"/>',
  servers: '<rect x="4" y="4.5" width="16" height="6.2" rx="1.8"/><rect x="4" y="13.3" width="16" height="6.2" rx="1.8"/><path d="M7.6 7.6h.01M7.6 16.4h.01"/>',
  rules: '<path d="M12 20.5v-7.3L6.4 7.6"/><path d="M12 13.2l5.6-5.6"/><path d="M6.2 12.2V7.4h4.8"/><path d="M17.8 12.2V7.4H13"/>',
  settings: '<path d="M4 7.5h9.2M17.8 7.5H20M4 16.5h2.2M10.8 16.5H20"/><circle cx="15.5" cy="7.5" r="2.3"/><circle cx="8.5" cy="16.5" r="2.3"/>',
  help: '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.4"/><path d="M12 16.9h.01"/>',
  expand: '<path d="M14 4h6v6"/><path d="M20 4l-6.5 6.5"/><path d="M10 20H4v-6"/><path d="M4 20l6.5-6.5"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5.6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.4" cy="12" r="1.6"/></g>',
  star: '<path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.6l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>',
  trash: '<path d="M5 7.2h14"/><path d="M9.8 7.2V5h4.4v2.2"/><path d="M7 7.2l.9 12.3h8.2L17 7.2"/><path d="M10.4 10.8v5.4M13.6 10.8v5.4"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  ext: '<path d="M13.5 4.5H19.5V10.5"/><path d="M19.5 4.5l-8 8"/><path d="M17 13.5v6H4.5V7H10.5"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.2 4.5v4h-4"/>',
  direct: '<circle cx="12" cy="12" r="8"/><path d="M6.4 17.6 17.6 6.4"/>',
  check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  search: '<circle cx="10.8" cy="10.8" r="6"/><path d="M15.3 15.3 20 20"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// setIcon — значок в элементе (кнопки из разметки: id → имя значка).
export function setIcon(node, name, cls) {
  node.insertAdjacentHTML('afterbegin', icon(name, cls));
}

// flagEl — флаг страны из имени сервера; нет флага — первая буква имени в кружке.
export function flagEl(server, cls = '') {
  const { flag, name } = splitFlag(server?.name);
  if (flag) return el('span', { className: `flag ${cls}`.trim(), textContent: flag });
  return el('span', { className: `flag letter ${cls}`.trim(), textContent: (name.trim()[0] || '?').toUpperCase() });
}

// barsEl — четыре полоски задержки: цвет от зелёного до красного, серые — нет ответа.
export function barsEl(server) {
  const b = pingBars(server);
  const node = el('span', { className: 'bars', title: b.title });
  node.dataset.n = String(b.n);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', `Задержка: ${b.title}`);
  for (let i = 1; i <= 4; i++) node.append(el('i', { className: i <= b.n ? 'on' : '' }));
  return node;
}

// --- меню «⋯» (всплывающий список поверх окна) ---

const pop = () => $('pop');
let popAnchor = null;

// openMenu(anchor, items) — items: { label, run, danger, checked, disabled } или '-' (черта).
export function openMenu(anchor, items) {
  const p = pop();
  if (p.matches(':popover-open') && popAnchor === anchor) {
    p.hidePopover();
    return;
  }
  p.replaceChildren(...items.map((it) => {
    if (it === '-') return el('hr');
    const b = el('button', { type: 'button', className: `pop-item${it.danger ? ' danger' : ''}`, disabled: !!it.disabled });
    b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
    b.insertAdjacentHTML('beforeend', it.checked === undefined ? '' : icon('check', 'tick'));
    b.append(el('span', { textContent: it.label }));
    b.addEventListener('click', () => {
      p.hidePopover();
      it.run();
    });
    return b;
  }));
  popAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  p.showPopover();
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth;
  const h = p.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const top = r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4;
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
  p.querySelector('button:not(:disabled)')?.focus();
}

export function initMenu() {
  const p = pop();
  p.addEventListener('toggle', (e) => {
    if (e.newState === 'closed' && popAnchor) {
      popAnchor.setAttribute('aria-expanded', 'false');
      popAnchor = null;
    }
  });
  p.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...p.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
}

export const menuOpen = () => pop().matches(':popover-open');

// --- окно вопроса (вместо confirm/prompt: в окне расширения они неудобны) ---

// ask({ title, text, ok, danger, value }) → true / строка (если задан value — поле ввода) / null.
export function ask({ title, text = '', ok = 'ОК', danger = false, value = null }) {
  const dlg = $('dlg');
  $('dlgTitle').textContent = title;
  $('dlgText').textContent = text;
  $('dlgText').hidden = !text;
  const input = $('dlgInput');
  input.hidden = value === null;
  input.value = value ?? '';
  $('dlgOk').textContent = ok;
  $('dlgOk').classList.toggle('danger', danger);
  dlg.returnValue = '';
  dlg.showModal();
  if (value !== null) {
    input.focus();
    input.select();
  } else {
    $('dlgOk').focus();
  }
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') resolve(null);
      else resolve(value === null ? true : input.value);
    }, { once: true });
  });
}

export const dialogOpen = () => $('dlg').open;

// --- короткие сообщения внизу окна ---

let toastTimer = null;
export function toast(text, kind = '') {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.textContent = text;
  t.dataset.kind = kind;
  t.hidden = !text;
  if (text) toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 9000 : 5000);
}

// --- значки сайтов: только из памяти самого Chrome (разрешение favicon, адрес /_favicon/) ---
// Ни одного запроса в интернет: Chrome отдаёт значок, если сайт уже открывался. Незнакомому сайту
// Chrome отдаёт свой серый значок по умолчанию — его узнаём по точкам и рисуем букву домена.

const favCache = new Map(); // домен → Promise(адрес значка или '' — значка нет)
let defaultSig = null;

const favUrl = (page) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(page)}&size=32`);

async function signature(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 16, 16);
  return ctx.getImageData(0, 0, 16, 16).data.join(',');
}

async function lookup(domain) {
  if (!domain.includes('.')) return ''; // зона (ru, рф) — без значка
  try {
    defaultSig ??= signature(favUrl('https://waysplit-no-such-site.invalid/'));
    const base = await defaultSig;
    for (const page of [`https://${domain}/`, `https://www.${domain}/`]) {
      const url = favUrl(page);
      if ((await signature(url)) !== base) return url;
    }
  } catch {
    // нет разрешения или картинка не читается — буква
  }
  return '';
}

// faviconEl — значок сайта: сразу буква, значок из памяти Chrome — когда найдётся.
export function faviconEl(domain) {
  const shown = toUnicode(domain);
  const node = el('span', { className: 'favicon letter', textContent: (shown.replace(/^www\./, '')[0] || '?').toUpperCase() });
  node.setAttribute('aria-hidden', 'true');
  const show = (url) => {
    if (!url) return;
    node.classList.remove('letter');
    node.replaceChildren(el('img', { src: url, alt: '', width: 16, height: 16 }));
  };
  if (!favCache.has(domain)) favCache.set(domain, lookup(domain));
  favCache.get(domain).then(show);
  return node;
}
