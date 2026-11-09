// «Развернуть»: тот же интерфейс на всю вкладку браузера (popup.html?full#вкладка). Сайт, на котором
// открыли окно, передаётся в адресе — блок «Этот сайт» остаётся и на развёрнутой странице.
// do — действие с файлом (импорт, экспорт, резервная копия): в окне расширения окно выбора файла
// его закрывает, поэтому такие действия идут на развёрнутой странице.

import { S } from './state.js';

export function openFull(tab = 'home', action = '') {
  const p = new URLSearchParams({ full: '' });
  if (action) p.set('do', action);
  if (S.site) {
    p.set('site', S.site.host);
    p.set('tabId', String(S.site.tabId));
  }
  chrome.tabs.create({ url: chrome.runtime.getURL(`popup/popup.html?${p}#${tab}`) });
  if (!S.full) window.close();
}
