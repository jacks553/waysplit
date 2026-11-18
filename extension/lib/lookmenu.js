// Кнопка оформления в шапке окна и её меню (design/lcd/STYLE.md, «Каркас окна» и «Два оформления»).
// Значок и название Waysplit в шапке — одна кнопка. По нажатию — меню из двух групп: «Вид окна»
// (новый, классический) и «Тема» (тёмная, светлая, как в системе). Меню меняет те же настройки, что
// строки «Вид окна» и «Тема» в «Настройках»: design и тему этого окна (themeLcd у нового, theme у
// классического). Модуль общий для двух окон; как кнопка и меню выглядят, решают стили окна.
//
// Меню — тот же всплывающий список #pop, что у кнопки языка и у «⋯» (его стрелки вверх и вниз
// обрабатывает ui.js окна). Подписи групп не нажимаются. При открытии фокус встаёт на выбранный вид
// окна. Выбор темы меняет её сразу. Выбор другого вида сразу открывает другое окно на той же
// вкладке, фокус встаёт на кнопку оформления (переход — popup.js окна и lib/design.js).

import { send } from './format.js';
import { t } from './i18n.js';
import { designOf } from './design.js';

const TICK = '<svg class="ic tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.6l4.4 4.4L19 7.4"/></svg>';

const designName = (design) => t(design === 'classic' ? 'settings.design.classic' : 'settings.design.lcd');
const themeName = (theme) => t(theme === 'light' ? 'settings.theme.light' : theme === 'system' ? 'settings.theme.system' : 'settings.theme.dark');

// initLookButton(btn, { themeKey, settings }) — themeKey: настройка темы этого окна ('themeLcd' или
// 'theme'); settings() → настройки сейчас.
export function initLookButton(btn, { themeKey, settings }) {
  const pop = document.getElementById('pop');
  let mine = false; // в #pop сейчас меню оформления
  let closedAt = -1000;
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
  const item = (text, checked, run) => {
    const b = el('button', 'pop-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(checked));
    b.insertAdjacentHTML('beforeend', TICK);
    b.append(el('span', '', text));
    b.addEventListener('click', () => {
      pop.hidePopover();
      btn.focus(); // фокус — на кнопке: с неё он перейдёт в окно другого вида
      if (!checked) run();
    });
    return b;
  };
  // Группа: подпись (не нажимается) и её значения.
  const group = (title, items) => {
    const box = el('div', 'pop-set');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', title);
    const label = el('div', 'pop-group', title);
    label.setAttribute('aria-hidden', 'true');
    box.append(label, ...items);
    return box;
  };

  function build() {
    const now = settings() || {};
    const design = designOf(now);
    const theme = ['dark', 'light', 'system'].includes(now[themeKey]) ? now[themeKey] : themeKey === 'themeLcd' ? 'dark' : 'system';
    const set = (key, value) => () => send({ type: 'setSetting', key, value });
    pop.replaceChildren(
      group(t('settings.design'), ['lcd', 'classic'].map((d) => item(designName(d), d === design, set('design', d)))),
      document.createElement('hr'),
      group(t('settings.theme'), ['dark', 'light', 'system'].map((v) => item(themeName(v), v === theme, set(themeKey, v)))),
    );
  }

  function open() {
    build();
    mine = true;
    pop.classList.add('pop-look');
    btn.setAttribute('aria-expanded', 'true');
    btn.focus(); // сюда вернётся фокус, когда меню закроют (Esc)
    pop.showPopover();
    // Меню — под кнопкой, левый край вровень с её левым краем.
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    (pop.querySelector('.pop-item[aria-checked="true"]') || pop.querySelector('.pop-item'))?.focus();
  }

  btn.addEventListener('click', () => {
    if (pop.matches(':popover-open')) {
      const wasMine = mine;
      pop.hidePopover();
      if (wasMine) return; // повторное нажатие закрывает меню
    } else if (performance.now() - closedAt < 250) {
      return; // меню только что закрылось этим же нажатием (нажатие мимо меню закрывает его само)
    }
    // Открываем следующим шагом: другое меню в том же списке успевает сообщить о своём закрытии.
    setTimeout(open, 0);
  });
  pop.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'closed' || !mine) return;
    mine = false;
    closedAt = performance.now();
    pop.classList.remove('pop-look');
    btn.setAttribute('aria-expanded', 'false');
  });
}
