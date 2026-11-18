// Страница настроек: окно расширения на всю вкладку, вкладка «Настройки», в выбранном оформлении
// (lib/design.js).

import { designOf, pageUrl } from '../lib/design.js';

let settings;
try {
  ({ settings } = await chrome.storage.local.get('settings'));
} catch { /* хранилище не ответило — откроется новое окно, оно сверится с настройкой само */ }
location.replace(pageUrl(designOf(settings), '?full#settings'));
