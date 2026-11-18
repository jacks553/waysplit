// КЛАССИЧЕСКОЕ ОКНО: окно версии 1.2.1, заморожено (design/lcd/STYLE.md, «Два оформления»).
// Новые функции сюда не добавляются; правки — только такие, без которых окно перестанет работать.
// Новое окно — в папке popup. Чем этот файл отличается от версии 1.2.1, записано в PROGRESS.md.

// Разрешение Chrome видеть запросы вкладок (webRequest + доступ к сайтам) — одно и для автосбора
// «доменов сайта», и для «Доменов этой вкладки». Оно необязательное: спрашиваем один раз,
// с объяснением, карточкой в окне; без него работают только готовые наборы.

import { send } from '../lib/format.js';
import { language, t } from '../lib/i18n.js';
import { $, el, toast } from './ui.js';
import { S, closeAllScreens, renderVisible, showTab } from './state.js';

export const SITE_PERMS = { permissions: ['webRequest'], origins: ['<all_urls>'] };

let granted = null; // null — ещё не спрашивали у Chrome

export const permGranted = () => granted === true;

export async function checkPerm() {
  try {
    granted = await chrome.permissions.contains(SITE_PERMS);
  } catch {
    granted = false;
  }
  return granted;
}

// requestPerm — вызывать прямо в обработчике нажатия (иначе Chrome не покажет вопрос). Пока Chrome
// спрашивает, окно расширения может закрыться, поэтому «уже спрашивали» записываем сразу.
export async function requestPerm() {
  const asking = chrome.permissions.request(SITE_PERMS);
  if (!S.view.settings.siteDomainsAsked) send({ type: 'setSetting', key: 'siteDomainsAsked', value: true });
  try {
    granted = await asking;
  } catch {
    granted = false;
  }
  renderVisible();
  return granted;
}

// openSiteSetting — перейти к галочке «Автоматически добавлять домены сайта» в «Настройках»
// (кнопка в сообщениях вместо слов «включить можно в „Настройках“»).
export function openSiteSetting() {
  closeAllScreens();
  showTab('settings');
  const box = $('autoSiteDomains');
  box.scrollIntoView({ block: 'center' });
  box.focus();
}
const toSettings = () => ({ action: { label: t('common.openSettings'), run: openSiteSetting } });

// wanted — показывать ли карточку: автосбор включён, разрешения нет, ещё не спрашивали и есть
// хотя бы одно включённое правило «через VPN» для сайта (после первого такого правила).
const wanted = () => {
  const { settings, rules } = S.view;
  return granted === false && settings.autoSiteDomains && !settings.siteDomainsAsked
    && rules.some((r) => r.enabled && r.action === 'proxy' && r.domain.includes('.'));
};

function build(box) {
  const allow = el('button', { type: 'button', className: 'btn btn-small', textContent: t('common.allow') });
  allow.dataset.act = 'allow';
  allow.addEventListener('click', async () => {
    if (await requestPerm()) toast(t('perm.toast.granted'), 'keep');
    else toast(t('perm.toast.denied'), '', toSettings());
  });
  const later = el('button', { type: 'button', className: 'ghost', textContent: t('common.notNow') });
  later.dataset.act = 'later';
  later.addEventListener('click', async () => {
    await send({ type: 'setSetting', key: 'siteDomainsAsked', value: true });
    toast(t('perm.toast.later'), '', toSettings());
  });
  box.replaceChildren(
    el('p', { className: 'perm-title', textContent: t('perm.title') }),
    el('p', { className: 'hint', textContent: t('perm.text') }),
    el('div', { className: 'tools' }, allow, later),
  );
  box.dataset.lang = language();
}

// renderPermCards — карточка на «Главной» и на вкладке «Правила».
export function renderPermCards() {
  const show = wanted();
  for (const id of ['permHome', 'permRules']) {
    const box = $(id);
    if (!box) continue;
    if (show && box.dataset.lang !== language()) build(box); // первый показ или язык сменили
    box.hidden = !show;
  }
}

if (chrome.permissions?.onAdded) {
  const changed = () => checkPerm().then(renderVisible);
  chrome.permissions.onAdded.addListener(changed);
  chrome.permissions.onRemoved.addListener(changed);
}
