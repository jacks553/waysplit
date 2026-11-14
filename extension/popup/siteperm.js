// Разрешение Chrome видеть запросы вкладок (webRequest + доступ к сайтам) — одно и для автосбора
// «доменов сайта», и для «Доменов этой вкладки». Оно необязательное: спрашиваем один раз,
// с объяснением, карточкой в окне; без него работают только готовые наборы.

import { send } from '../lib/format.js';
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
const TO_SETTINGS = { action: { label: 'Открыть настройки', run: openSiteSetting } };

// wanted — показывать ли карточку: автосбор включён, разрешения нет, ещё не спрашивали и есть
// хотя бы одно включённое правило «через VPN» для сайта (после первого такого правила).
const wanted = () => {
  const { settings, rules } = S.view;
  return granted === false && settings.autoSiteDomains && !settings.siteDomainsAsked
    && rules.some((r) => r.enabled && r.action === 'proxy' && r.domain.includes('.'));
};

function build(box) {
  const allow = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Разрешить' });
  allow.dataset.act = 'allow';
  allow.addEventListener('click', async () => {
    if (await requestPerm()) toast('Разрешение получено. Обновите вкладку с сайтом — его домены начнут добавляться к правилу.', 'keep');
    else toast('Без разрешения работают только готовые наборы. Разрешить можно в «Настройках».', '', TO_SETTINGS);
  });
  const later = el('button', { type: 'button', className: 'ghost', textContent: 'Не сейчас' });
  later.dataset.act = 'later';
  later.addEventListener('click', async () => {
    await send({ type: 'setSetting', key: 'siteDomainsAsked', value: true });
    toast('Хорошо. Разрешить можно позже — в «Настройках».', '', TO_SETTINGS);
  });
  box.append(
    el('p', { className: 'perm-title', textContent: 'Чтобы видео и картинки сайта тоже шли через VPN' }),
    el('p', { className: 'hint', textContent: 'Waysplit будет запоминать домены, с которых сайт грузит содержимое. Chrome спросит разрешение один раз.' }),
    el('div', { className: 'tools' }, allow, later),
  );
}

// renderPermCards — карточка на «Главной» и на вкладке «Правила».
export function renderPermCards() {
  const show = wanted();
  for (const id of ['permHome', 'permRules']) {
    const box = $(id);
    if (!box) continue;
    if (show && !box.childElementCount) build(box);
    box.hidden = !show;
  }
}

if (chrome.permissions?.onAdded) {
  const changed = () => checkPerm().then(renderVisible);
  chrome.permissions.onAdded.addListener(changed);
  chrome.permissions.onRemoved.addListener(changed);
}
