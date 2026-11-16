// Фразы компаньона на языке окна.
//
// Компаньон 1.2.0 присылает рядом с готовым русским текстом фразу: { msg — код, params — значения
// вставок }. Значение вставки бывает и само фразой ({ msg, params }): «подписка не скачалась:
// <почему>». Словарь хранит фразы под ключами host.<код>; русские — буква в букву как у компаньона
// (это проверяет тест компаньона host/internal/msg).
//
// У компаньонов 1.0.0 и 1.1.0 фраз нет: знакомые тексты (причины пинга) узнаются по тексту
// (i18n/legacy.js), остальные показываются как есть — по-русски. Фраза от компаньона новее
// расширения, которую словарь не знает, — тоже текст как есть.

import { has, t } from './i18n.js';
import { legacyPhrase } from './i18n/legacy.js';

const isPhrase = (v) => v !== null && typeof v === 'object' && typeof v.msg === 'string' && v.msg !== '';

// known — словарь знает фразу и все фразы внутри неё.
function known(p) {
  return isPhrase(p) && has(`host.${p.msg}`) && Object.values(p.params || {}).every((v) => !isPhrase(v) || known(v));
}

function render(p) {
  const params = {};
  for (const [k, v] of Object.entries(p.params || {})) params[k] = isPhrase(v) ? render(v) : v;
  return t(`host.${p.msg}`, params);
}

// hostPhrase — фраза, которую можно сохранить и потом показать на любом языке: { msg, params? }
// из ответа компаньона, если словарь её знает, или узнанная по тексту старого компаньона; иначе null.
// from — объект ответа с полями msg и params (ошибка, строка подписки, результат пинга).
export function hostPhrase(from, text) {
  if (known(from)) return from.params ? { msg: from.msg, params: from.params } : { msg: from.msg };
  return legacyPhrase(text);
}

// hostText — текст на языке окна: по фразе, а если она незнакома — text как есть.
export function hostText(from, text = '') {
  const p = hostPhrase(from, text);
  return p ? render(p) : String(text ?? '');
}
