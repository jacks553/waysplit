// Общее для окна: элементы, значки, код страны, столбики сигнала, меню, окно вопроса, сообщения.

import { countryCode, noFlags, pingBars } from '../lib/format.js';
import { t } from '../lib/i18n.js';

export const $ = (id) => document.getElementById(id);

// el('li', { className: 'x' }, child, 'текст') — элемент со свойствами и детьми.
// Текст и подсказка (title) — без флагов-эмодзи: флаг в имени сервера заменяется кодом страны
// (design/lcd/STYLE.md: флаг не показывается нигде). Значение поля ввода не трогаем: там имя как есть.
export function el(tag, props = {}, ...children) {
  const clean = { ...props };
  for (const key of ['textContent', 'title']) if (typeof clean[key] === 'string') clean[key] = noFlags(clean[key]);
  const e = Object.assign(document.createElement(tag), clean);
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
  more: '<g fill="currentColor" stroke="none"><rect x="3" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/><rect x="17" y="10" width="4" height="4"/></g>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 3L14.2 8.9L20.6 9.2L15.6 13.2L17.3 19.3L12 15.8L6.7 19.3L8.4 13.2L3.4 9.2L9.8 8.9Z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  ext: '<path d="M13.5 4.5H19.5V10.5"/><path d="M19.5 4.5l-8 8"/><path d="M17 13.5v6H4.5V7H10.5"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.2 4.5v4h-4"/>',
  check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  close: '<path d="M6.8 6.8l10.4 10.4M17.2 6.8 6.8 17.2"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// setIcon — значок в элементе (кнопки из разметки: id → имя значка).
export function setIcon(node, name, cls) {
  node.insertAdjacentHTML('afterbegin', icon(name, cls));
}

// ccEl — код страны в рамке (design/lcd/STYLE.md, «Код страны»). Флага в имени нет — рамки нет,
// место остаётся: имена в списке стоят ровно.
export function ccEl(server, cls = '') {
  const code = countryCode(server?.name);
  return el('span', { className: `cc${code ? '' : ' none'} ${cls}`.trim(), textContent: code });
}

// barsEl — сигнал: четыре столбика, чем меньше задержка, тем больше горит; все погасшие — нет ответа.
export function barsEl(server) {
  const b = pingBars(server);
  const node = el('span', { className: 'bars', title: b.title });
  node.dataset.n = String(b.n);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', t('ui.bars.aria', { title: b.title }));
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
export function ask({ title, text = '', ok = t('common.ok'), danger = false, value = null }) {
  const dlg = $('dlg');
  $('dlgTitle').textContent = noFlags(title);
  $('dlgText').textContent = noFlags(text);
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

// --- сообщения внизу окна ---

// Короткое сообщение об успехе исчезает само через 5 с. Остаётся до закрытия крестиком (или до
// следующего сообщения): ошибка (kind 'error'), сообщение с причиной или указанием — «пропущено…»,
// «обновите вкладку» (kind 'keep'), сообщение с кнопкой (action) и всякое длинное — за 5 секунд
// его не прочесть. action — { label, run }: «Вернуть», «Открыть настройки».
const TOAST_SHORT = 70; // длиннее — уже не «короткое»

let toastTimer = null;
export function toast(text, kind = '', { action = null } = {}) {
  const box = $('toast');
  clearTimeout(toastTimer);
  if (!text) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  text = noFlags(text);
  const sticky = kind === 'error' || kind === 'keep' || !!action || text.length > TOAST_SHORT;
  const parts = [el('span', { className: 'toast-text', textContent: text })];
  if (action) {
    const b = el('button', { type: 'button', className: 'toast-action', textContent: action.label });
    b.addEventListener('click', () => {
      toast('');
      action.run();
    });
    parts.push(b);
  }
  if (sticky) {
    const x = el('button', { type: 'button', className: 'toast-close', title: t('ui.toast.close') });
    x.setAttribute('aria-label', t('ui.toast.close'));
    setIcon(x, 'close');
    x.addEventListener('click', () => toast(''));
    parts.push(x);
  }
  box.replaceChildren(...parts);
  box.dataset.kind = kind === 'keep' ? '' : kind;
  box.dataset.sticky = String(sticky);
  box.hidden = false;
  if (!sticky) toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

// toastOpen — сообщение показано и само не исчезнет (Esc его закрывает).
export const toastOpen = () => !$('toast').hidden && $('toast').dataset.sticky === 'true';
