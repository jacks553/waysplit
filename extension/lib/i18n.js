// Язык окна: словари и перевод надписей. Сторонних библиотек нет.
//
// Словарь — один файл на язык (lib/i18n/ru.js, lib/i18n/en.js): код языка, его название,
// направление письма и надписи «ключ → текст». Новый язык — файл словаря и строка в LANGS ниже
// (и, для карточки магазина, _locales/<язык>/messages.json с названием и кратким описанием).
//
//   t('rules.enabled', { domain })   → «Правило для example.com включено»: в тексте — {domain};
//   t('n.servers', { n: 3 })         → «3 сервера»: у надписи со склонением вместо строки —
//                                      формы по категориям Intl.PluralRules (в русском one, few,
//                                      many; в английском one, other), выбирается по n.
//
// Настройка language: 'auto' (как в Chrome: русский при русском Chrome, иначе английский) или код
// языка. Встроенный chrome.i18n для окна не годится: он берёт язык браузера и не переключается.

import ru from './i18n/ru.js';
import en from './i18n/en.js';

export const LANGS = { ru, en };
export const LANGUAGE_SETTINGS = ['auto', ...Object.keys(LANGS)];

let current = ru;
const rules = new Map(); // язык → Intl.PluralRules

// chromeLanguage — язык интерфейса Chrome ('ru', 'en-US'…); вне расширения (тесты) — пусто.
export const chromeLanguage = () => globalThis.chrome?.i18n?.getUILanguage?.() || '';

// resolveLanguage — код языка по настройке: 'auto' — по языку Chrome.
export function resolveLanguage(setting, ui = chromeLanguage()) {
  if (Object.hasOwn(LANGS, setting)) return setting;
  return /^ru\b/i.test(ui) ? 'ru' : 'en';
}

// setLanguage — язык надписей (код из LANGS). Вернёт true, если язык изменился.
export function setLanguage(code) {
  const next = LANGS[code] || LANGS.en;
  const changed = next !== current;
  current = next;
  return changed;
}

export const language = () => current.lang;
// everyLanguage — надпись на всех языках сразу, через « / »: «Язык / Language». Для того, что должен
// узнать и человек, который не читает на языке окна (кнопка языка в шапке).
export const everyLanguage = (key) => Object.values(LANGS).map((d) => d.messages[key]).join(' / ');
export const has = (key) => Object.hasOwn(current.messages, key);

// t — надпись на текущем языке. Нет ключа в словаре — берётся английский, потом русский; нет
// нигде — сам ключ (так пропуск виден сразу).
export function t(key, params = null) {
  const dict = [current, LANGS.en, LANGS.ru].find((d) => Object.hasOwn(d.messages, key));
  if (!dict) return key;
  let text = dict.messages[key];
  if (typeof text === 'object') {
    if (!rules.has(dict.lang)) rules.set(dict.lang, new Intl.PluralRules(dict.lang));
    const form = rules.get(dict.lang).select(Number(params?.n) || 0);
    text = text[form] ?? text.other ?? text.many ?? text.few ?? text.one;
  }
  return params ? text.replace(/\{(\w+)\}/g, (all, name) => (Object.hasOwn(params, name) ? String(params[name]) : all)) : text;
}

// --- страницы расширения (окно, «Начало работы») ---

const CACHE = 'waysplit-lang';
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

// fill — текст в элемент. Обычно это просто его текст. Но если прямо внутри элемента есть
// вложенные с data-slot="имя" (ссылка, <code>, выделение), текст — шаблон: на месте {имя} остаётся
// этот вложенный элемент, текст идёт вокруг. Так предложение лежит в словаре целиком, и порядок
// слов в каждом языке свой. Вернёт сам элемент.
export function fill(node, text) {
  const slots = new Map([...node.children].filter((c) => c.dataset.slot).map((c) => [c.dataset.slot, c]));
  if (!slots.size) node.textContent = text;
  else node.replaceChildren(...text.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? slots.get(part) ?? '' : part)).filter((part) => part !== ''));
  return node;
}

// slot — пометить элемент как вставку {имя} (для fill).
export function slot(name, node) {
  node.dataset.slot = name;
  return node;
}

// applyStatic — надписи разметки: data-i18n="ключ" — текст элемента (правила — как у fill),
// data-i18n-title, data-i18n-aria-label, data-i18n-placeholder, data-i18n-alt — его атрибуты.
// У <html> — язык и направление письма.
export function applyStatic(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) fill(node, t(node.dataset.i18n));
  for (const attr of ATTRS) {
    for (const node of root.querySelectorAll(`[data-i18n-${attr}]`)) node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
  }
  if (root === document) {
    document.documentElement.lang = current.lang;
    document.documentElement.dir = current.dir;
  }
}

// startPage — язык страницы при открытии. Настройка лежит в chrome.storage и читается не сразу,
// поэтому язык прошлого раза запоминается в памяти страницы (localStorage): надписи появляются
// сразу и на нужном языке.
export function startPage() {
  let cached = null;
  try {
    cached = localStorage.getItem(CACHE);
  } catch { /* память страницы недоступна — возьмём язык Chrome */ }
  setLanguage(Object.hasOwn(LANGS, cached) ? cached : resolveLanguage('auto'));
  applyStatic();
}

// usePageLanguage — настройка языка прочитана или изменилась: переключить надписи разметки.
// Вернёт true, если язык изменился (страница перерисует остальное сама).
export function usePageLanguage(setting) {
  const code = resolveLanguage(setting);
  try {
    localStorage.setItem(CACHE, code);
  } catch { /* не страшно: в следующий раз язык определится заново */ }
  if (!setLanguage(code)) return false;
  applyStatic();
  return true;
}
