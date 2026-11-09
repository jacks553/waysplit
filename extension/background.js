// Фоновая часть расширения (service worker). Засыпает, поэтому всё состояние — в chrome.storage,
// а реальность (PAC, ядро, WebRTC, значок) приводит в порядок Controller.reconcile() при каждом
// пробуждении.

import { NativeHost } from './lib/native.js';
import { Controller } from './lib/controller.js';
import { TabDomains } from './lib/tabdomains.js';

const WATCHDOG = 'watchdog';
const SUBSCRIPTIONS = 'subscriptions';
const WEBRTC = chrome.privacy.network.webRTCIPHandlingPolicy;
const host = new NativeHost();

const controller = new Controller({
  store: {
    get: () => chrome.storage.local.get(null),
    set: (patch) => chrome.storage.local.set(patch),
    getSession: async (key) => (await chrome.storage.session.get(key))[key],
    setSession: (obj) => chrome.storage.session.set(obj),
  },
  proxy: {
    setPac: (data) => chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data, mandatory: true } },
      scope: 'regular',
    }),
    clear: () => chrome.proxy.settings.clear({ scope: 'regular' }),
    control: async () => (await chrome.proxy.settings.get({ incognito: false })).levelOfControl,
  },
  // WebRTC: ставим, только если настройкой не управляет другое расширение (иначе set «успешен»,
  // но тут же перекрывается). Ответ: 'on' или почему не вышло.
  privacy: {
    protect: async () => {
      const { levelOfControl } = await WEBRTC.get({});
      if (levelOfControl !== 'controllable_by_this_extension' && levelOfControl !== 'controlled_by_this_extension') {
        return levelOfControl === 'controlled_by_other_extensions' ? 'other' : 'blocked';
      }
      await WEBRTC.set({ value: 'disable_non_proxied_udp' });
      return 'on';
    },
    release: () => WEBRTC.clear({}),
  },
  ui: {
    setIcon: (state, title) => Promise.all([
      chrome.action.setIcon({ path: { 16: `icons/state-${state}-16.png`, 32: `icons/state-${state}-32.png` } }),
      chrome.action.setTitle({ title }),
    ]),
  },
  host,
  alarms: {
    start: () => chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 }),
    stop: () => chrome.alarms.clear(WATCHDOG),
  },
});

const tabDomains = new TabDomains({
  getSession: async (key) => (await chrome.storage.session.get(key))[key],
  setSession: (obj) => chrome.storage.session.set(obj),
});

// Слушатели — сразу при запуске фона (иначе Chrome не разбудит его этими событиями).
chrome.runtime.onStartup.addListener(() => controller.init());
chrome.runtime.onInstalled.addListener((details) => {
  controller.init();
  if (details.reason === 'install') chrome.tabs.create({ url: 'welcome/welcome.html' }); // «Начало работы»
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG) controller.reconcile();
  if (alarm.name === SUBSCRIPTIONS) controller.init().then(() => controller.updateDueSubscriptions());
});
chrome.proxy.onProxyError.addListener((details) => {
  console.warn('Waysplit: ошибка прокси', details.error, details.details);
  controller.proxyError(details);
});
// Прокси Chrome изменился (например, включили Browsec) — проверить, кто им управляет.
chrome.proxy.settings.onChange.addListener(() => controller.reconcile());
chrome.tabs.onRemoved.addListener((tabId) => tabDomains.forget(tabId));

// «Домены этой вкладки» (SPEC 3.3): наблюдение за запросами — только когда пользователь дал
// разрешение (webRequest + доступ к сайтам запрашиваются при первом нажатии кнопки).
function watchRequests() {
  if (!chrome.webRequest || watchRequests.on) return;
  watchRequests.on = true;
  chrome.webRequest.onBeforeRequest.addListener((d) => tabDomains.seen(d), { urls: ['<all_urls>'] });
}
watchRequests();
chrome.permissions.onAdded.addListener(watchRequests);

// Команды от своих страниц (окно, настройки, «Начало работы»).
const commands = {
  toggle: (msg) => controller.toggle(msg.enabled),
  addLinks: (msg) => controller.addLinks(String(msg.text || '')),
  pingCurrent: () => controller.pingCurrent(),
  ping: (msg) => controller.ping(Array.isArray(msg.ids) ? msg.ids : []),
  setFavorite: (msg) => controller.setFavorite(msg.id, msg.on === true),
  fastest: () => controller.fastest(),
  select: (msg) => controller.select(msg.id),
  rename: (msg) => controller.rename(msg.id, msg.name),
  remove: (msg) => controller.remove(msg.id),
  reorder: (msg) => controller.reorder(Array.isArray(msg.ids) ? msg.ids : []),
  addRules: (msg) => controller.addRules(Array.isArray(msg.domains) ? msg.domains : String(msg.text || '').split(/\r?\n/),
    msg.action, msg.serverId ?? null),
  updateRule: (msg) => controller.updateRule(msg.id, msg.patch || {}),
  removeRules: (msg) => controller.removeRules(Array.isArray(msg.ids) ? msg.ids : []),
  importRules: (msg) => controller.importRules(msg.data),
  setSetting: (msg) => controller.setSetting(msg.key, msg.value),
  addSubscription: (msg) => controller.addSubscription(msg.url),
  updateSubscription: (msg) => controller.updateSubscription(msg.id),
  checkSubscription: (msg) => controller.checkSubscription(msg.id, msg.device === true),
  removeSubscription: (msg) => controller.removeSubscription(msg.id),
  renameSubscription: (msg) => controller.renameSubscription(msg.id, msg.name),
  exportBackup: () => controller.exportBackup(),
  importBackup: (msg) => controller.importBackup(msg.data),
  exitIp: () => controller.exitIp(),
  diagnostics: () => controller.diagnostics(),
  tabDomains: (msg) => tabDomains.list(msg.tabId),
  hello: () => host.request('hello'),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    return false;
  }
  const run = commands[msg?.type];
  if (!run) return false;
  controller.init()
    .then(() => run(msg))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: { code: err.code || 'ERROR', message: err.message } }),
    );
  return true; // ответ придёт позже
});

// Фон проснулся по любой причине — привести всё в порядок; подписки — по расписанию.
controller.init();
chrome.alarms.get(SUBSCRIPTIONS).then((a) => a || chrome.alarms.create(SUBSCRIPTIONS, { periodInMinutes: 30, delayInMinutes: 1 }));
