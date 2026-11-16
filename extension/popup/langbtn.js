// Кнопка языка в шапке окна и страницы «Начало работы» (версия 1.2.1).
//
// На кнопке — язык, на котором сейчас окно: RU или EN (при выборе «как в Chrome» — тот, что
// получился). По нажатию — меню: языки своими названиями («Русский», «English») и «как в Chrome»;
// выбранный в настройках отмечен галочкой. Это та же настройка language, что выбор «Язык» в
// «Настройках»: записывается фоном, язык меняется сразу на всех открытых страницах.
//
// Подсказка и название для чтения с экрана — на всех языках сразу («Язык / Language»): кнопку
// должен узнать и тот, кто не читает на языке окна.

import { LANGS, everyLanguage, language, t } from '../lib/i18n.js';
import { send } from '../lib/format.js';
import { openMenu } from './ui.js';

// initLangButton(btn, setting) — setting() → значение настройки language сейчас ('auto', 'ru', 'en').
export function initLangButton(btn, setting) {
  const label = everyLanguage('settings.language');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  const show = () => { btn.textContent = language().toUpperCase(); };
  btn.addEventListener('click', () => {
    const now = setting();
    const pick = (value) => () => {
      if (value !== now) send({ type: 'setSetting', key: 'language', value });
    };
    openMenu(btn, [
      ...Object.values(LANGS).map((d) => ({ label: d.name, checked: now === d.lang, run: pick(d.lang) })),
      { label: t('settings.language.auto'), checked: now === 'auto', run: pick('auto') },
    ]);
  });
  // Язык страницы сменился (lib/i18n.js ставит его у <html>) — показать его на кнопке.
  new MutationObserver(show).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  show();
}
