// Два оформления окна (design/lcd/STYLE.md, «Два оформления»): новое — «кнопочный телефон»
// (popup/), классическое — окно версии 1.2.1 (classic/). Выбор — настройка design: 'lcd' или
// 'classic'; пока её нет, действует 'lcd'.
//
// Какое окно открывает значок расширения, решает фон (chrome.action.setPopup, background.js). На
// случай, если Chrome всё же открыл не то окно (или страницу на всю вкладку открыли по старому
// адресу), каждое окно при загрузке сверяется с настройкой само — checkDesign — и, если оно не то,
// сразу переходит в другое с теми же параметрами адреса. Пока проверка не прошла, страница не
// показывается (правило html:not(.ready) в стилях окна): чужое окно не мелькает.

export const PAGES = { lcd: 'popup/popup.html', classic: 'classic/popup.html' };

export const designOf = (settings) => (settings?.design === 'classic' ? 'classic' : 'lcd');

// pageUrl — адрес окна выбранного оформления; tail — параметры и вкладка: '?full#settings'.
export const pageUrl = (design, tail = '') => chrome.runtime.getURL(PAGES[design] || PAGES.lcd) + tail;

const ARRIVAL = 'waysplit-design-arrival';

// FOCUS_IDS — откуда меняют вид окна: строка «Вид окна» в настройках и кнопка оформления в шапке.
// У обоих окон id этих элементов одинаковые.
export const FOCUS_IDS = ['design', 'lookBtn'];

// goDesign — перейти в окно другого оформления: та же вкладка окна (tab) и параметры адреса.
// focus — id элемента, на который поставить фокус в новом окне (когда вид сменили им самим): один
// из FOCUS_IDS или ''.
export function goDesign(design, { tab = '', focus = '' } = {}) {
  try {
    sessionStorage.setItem(ARRIVAL, JSON.stringify({ tab, focus }));
  } catch { /* без памяти вкладки — просто перейдём */ }
  location.replace(pageUrl(design, location.search + (tab ? `#${tab}` : location.hash)));
}

// arrival — пришли из окна другого оформления: { tab, focus } (один раз) или null.
export function arrival() {
  try {
    const raw = sessionStorage.getItem(ARRIVAL);
    sessionStorage.removeItem(ARRIVAL);
    const data = raw ? JSON.parse(raw) : null;
    return data && { tab: String(data.tab || ''), focus: FOCUS_IDS.includes(data.focus) ? data.focus : '' };
  } catch {
    return null;
  }
}

// focusedId — на каком из FOCUS_IDS сейчас фокус ('' — ни на каком): его передают в goDesign.
export const focusedId = () => (FOCUS_IDS.includes(document.activeElement?.id) ? document.activeElement.id : '');

// checkDesign(mine) — первым делом в окне: mine — оформление этого окна. Выбрано другое — переход
// (вернёт false, окно дальше не строится); своё — страница показывается (вернёт true).
export async function checkDesign(mine) {
  let want = mine;
  try {
    want = designOf((await chrome.storage.local.get('settings')).settings);
  } catch { /* хранилище не ответило — остаёмся в этом окне */ }
  if (want !== mine) {
    goDesign(want);
    return false;
  }
  document.documentElement.classList.add('ready');
  return true;
}
