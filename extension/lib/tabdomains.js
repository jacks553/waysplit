// «Домены этой вкладки» (SPEC 3.3): к каким доменам обращалась вкладка — чтобы добавить им
// правила галочками. Собирает фон из chrome.webRequest (только наблюдение, ничего не меняет).
// Фон засыпает, поэтому собранное копится и в storage.session (живёт до закрытия браузера).
// Заодно помнит, какой сайт открыт во вкладке (tops) — для автосбора «доменов сайта»
// (lib/sitedomains.js).

import { pacHost } from './domains.js';

const MAX_PER_TAB = 300;

export class TabDomains {
  constructor(store) {
    this.store = store; // { getSession(key), setSession(obj) }
    this.tabs = null; // tabId → Set(имён)
    this.tops = null; // tabId → имя сайта, открытого во вкладке
    this.saveTimer = null;
  }

  async #load() {
    if (this.tabs) return;
    const [saved, tops] = await Promise.all([this.store.getSession('tabDomains'), this.store.getSession('tabTops')]);
    this.tabs ??= new Map(Object.entries(saved || {}).map(([id, list]) => [Number(id), new Set(list)]));
    this.tops ??= new Map(Object.entries(tops || {}).map(([id, host]) => [Number(id), host]));
  }

  // seen — запрос из chrome.webRequest.onBeforeRequest (он приходит до отправки запроса, поэтому
  // видны и запросы, которые потом не удались). Новая страница во вкладке — список заново.
  // Ответ: { host, top, navigated } — имя из запроса, сайт вкладки (если известен) и «это новая
  // страница»; null — запрос не из вкладки или без имени.
  async seen(details) {
    if (details.tabId < 0) return null;
    let host;
    try {
      host = pacHost(new URL(details.url).hostname);
    } catch {
      return null;
    }
    if (!host) return null;
    await this.#load();
    const navigated = details.type === 'main_frame';
    // Записываем, только когда что-то изменилось: новая страница или новое имя. Вкладка с видео
    // обращается к одним и тем же именам снова и снова — писать каждый раз незачем.
    let changed = false;
    if (navigated || !this.tabs.has(details.tabId)) {
      this.tabs.set(details.tabId, new Set());
      changed = true;
    }
    if (navigated) this.tops.set(details.tabId, host);
    const set = this.tabs.get(details.tabId);
    if (set.size < MAX_PER_TAB && !set.has(host)) {
      set.add(host);
      changed = true;
    }
    if (changed) this.#save();
    return { host, top: this.tops.get(details.tabId) || null, navigated };
  }

  async list(tabId) {
    await this.#load();
    return [...(this.tabs.get(Number(tabId)) || [])];
  }

  // has — вкладка ещё открыта: от неё были запросы и её не закрыли (forget).
  has(tabId) {
    return !!this.tabs?.has(Number(tabId));
  }

  async forget(tabId) {
    await this.#load();
    const had = this.tabs.delete(tabId);
    if (this.tops.delete(tabId) || had) this.#save();
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.store.setSession({
        tabDomains: Object.fromEntries([...this.tabs].map(([id, set]) => [id, [...set]])),
        tabTops: Object.fromEntries(this.tops),
      });
    }, 500);
  }
}

// Двухуровневые зоны: для них «сайт» — это три последние части имени (bbc.co.uk, gosuslugi.com.ru).
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru',
  'com.ua', 'org.ua', 'co.jp', 'ne.jp', 'or.jp', 'com.au', 'net.au', 'com.br', 'com.tr', 'co.kr', 'com.cn', 'co.in', 'com.kz']);

// siteOf — домен «сайта» для правила: rr3---sn-abc.googlevideo.com → googlevideo.com.
export function siteOf(host) {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const two = parts.slice(-2).join('.');
  return SECOND_LEVEL.has(two) ? parts.slice(-3).join('.') : two;
}
