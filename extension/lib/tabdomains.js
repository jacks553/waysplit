// «Домены этой вкладки» (SPEC 3.3): к каким доменам обращалась вкладка — чтобы добавить им
// правила галочками. Собирает фон из chrome.webRequest (только наблюдение, ничего не меняет).
// Фон засыпает, поэтому собранное копится и в storage.session (живёт до закрытия браузера).

const MAX_PER_TAB = 300;

export class TabDomains {
  constructor(store) {
    this.store = store; // { getSession(key), setSession(obj) }
    this.tabs = null; // tabId → Set(имён)
    this.saveTimer = null;
  }

  async #load() {
    if (this.tabs) return;
    const saved = (await this.store.getSession('tabDomains')) || {};
    this.tabs ??= new Map(Object.entries(saved).map(([id, list]) => [Number(id), new Set(list)]));
  }

  // seen — запрос из chrome.webRequest.onBeforeRequest. Новая страница во вкладке — список заново.
  async seen(details) {
    if (details.tabId < 0) return;
    let host;
    try {
      host = new URL(details.url).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return;
    }
    if (!host) return;
    await this.#load();
    if (details.type === 'main_frame' || !this.tabs.has(details.tabId)) this.tabs.set(details.tabId, new Set());
    const set = this.tabs.get(details.tabId);
    if (set.size < MAX_PER_TAB) set.add(host);
    this.#save();
  }

  async list(tabId) {
    await this.#load();
    return [...(this.tabs.get(Number(tabId)) || [])];
  }

  async forget(tabId) {
    await this.#load();
    if (this.tabs.delete(tabId)) this.#save();
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.store.setSession({ tabDomains: Object.fromEntries([...this.tabs].map(([id, set]) => [id, [...set]])) });
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
