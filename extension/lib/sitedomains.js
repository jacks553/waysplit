// «Домены сайта»: домены, привязанные к правилу (видео, картинки, скрипты сайта лежат на других
// доменах — googlevideo.com у youtube.com). Это часть правила, а не отдельные правила: то же
// действие и тот же сервер; удалили правило — ушли и они.
//
//   rule.siteDomains        — привязанные домены (punycode, с точкой);
//   rule.siteDomainsRemoved — убранные вручную: автосбор и наборы их не вернут.
//
// Откуда берутся:
//   1) наборы (lib/domain-sets.json): правило на главный домен набора (или его поддомен) получает
//      остальные домены набора — attachSets;
//   2) автосбор, только для включённых правил «через VPN»: пока во вкладке открыт сайт с таким
//      правилом, домены, к которым вкладка обращается, привязываются к нему — SiteCollector.
//
// Chrome выбирает прокси по адресу запроса, а не по вкладке, поэтому привязанный домен идёт
// по правилу во всех вкладках. Отсюда осторожность автосбора (keyFor): общие сервисы
// (google.com, счётчики, реклама, библиотеки скриптов) не привязываются вовсе, у общих хостингов
// (cloudfront.net, github.io) привязывается полное имя хоста, российские зоны и сайты — никогда.

import { isLocalHost, normalizeDomain, pacHost, parents } from './domains.js';
import { siteOf } from './tabdomains.js';

export const MAX_SITE_DOMAINS = 100; // на одно правило: сайт с рекламой не должен набрать сотни
export const FLUSH_QUIET_MS = 2500; // запись — когда новые домены перестали приходить…
export const FLUSH_MAX_MS = 5000; // …но не позже чем через 5 с после первого (YouTube не замолкает)

const RU_DIRECT_SET = 'ru-direct'; // набор «Российские сайты без VPN» в domain-sets.json

// siteData — данные из domain-sets.json в удобном для поиска виде.
export function siteData(json = {}) {
  const sets = Array.isArray(json?.sets) ? json.sets : [];
  const flat = (obj) => Object.values(obj || {}).filter(Array.isArray).flat().map((d) => String(d).toLowerCase());
  return {
    siteSets: sets.filter((s) => Array.isArray(s.main) && s.main.length && Array.isArray(s.domains)),
    common: new Set(flat(json?.common)),
    hostings: new Set(flat(json?.hostings)),
    noCollect: new Set(sets.filter((s) => s.collect === false).flatMap((s) => s.domains || [])),
    // Домены переключателя «Российские сайты — без VPN» (настройка ruDirect) — набор ru-direct.
    ruDirect: sets.filter((s) => s.id === RU_DIRECT_SET).flatMap((s) => s.domains || []).map((d) => String(d).toLowerCase()),
  };
}

const covered = (set, host) => parents(host).some((d) => set.has(d));

// setDomainsFor — домены наборов, для которых domain — главный (или поддомен главного: правило
// на web.telegram.org — тоже Telegram). Сам домен и домены выше него не возвращаются: правило
// на m.youtube.com не должно забирать весь youtube.com.
export function setDomainsFor(data, domain) {
  const out = [];
  for (const set of data.siteSets) {
    if (!set.main.some((m) => domain === m || domain.endsWith(`.${m}`))) continue;
    for (const d of set.domains) {
      if (domain !== d && !domain.endsWith(`.${d}`) && !out.includes(d)) out.push(d);
    }
  }
  return out;
}

// cleanSiteDomain — домен для привязки: как в правилах, но обязательно с точкой (не зона).
export function cleanSiteDomain(input) {
  const n = normalizeDomain(input);
  return n.error || !n.domain.includes('.') ? null : n.domain;
}

// indexRules — быстрый поиск по правилам: explicit — домен → правило (и выключенные: своё правило
// есть своё правило), attached — привязанный домен → правило.
export function indexRules(rules) {
  const explicit = new Map(rules.map((r) => [r.domain, r]));
  const attached = new Map();
  for (const r of rules) for (const d of r.siteDomains || []) if (!attached.has(d)) attached.set(d, r);
  return { explicit, attached };
}

// ownRule — своё правило домена: на него самого или на домен выше (правило покрывает поддомены).
function ownRule(index, host) {
  for (const d of parents(host)) {
    const r = index.explicit.get(d);
    if (r) return r;
  }
  return null;
}

// canAttach — можно ли привязать key к rule: нет своего правила, никуда не привязан (и сам, и
// домен выше), не убран вручную, не сам домен правила, есть место.
export function canAttach(index, rule, key) {
  if (ownRule(index, key)) return false;
  const chain = parents(key);
  if (chain.some((d) => index.attached.has(d))) return false;
  if (chain.some((d) => (rule.siteDomainsRemoved || []).includes(d))) return false;
  return (rule.siteDomains || []).length < MAX_SITE_DOMAINS;
}

// attachSets — правилам с id из ids (по умолчанию всем) привязать домены их наборов.
// Возвращает новый список правил (исходный не меняется).
export function attachSets(rules, data, ids = null) {
  const out = rules.map((r) => ({ ...r, siteDomains: [...(r.siteDomains || [])], siteDomainsRemoved: [...(r.siteDomainsRemoved || [])] }));
  for (const rule of out) {
    if (ids && !ids.has(rule.id)) continue;
    for (const d of setDomainsFor(data, rule.domain)) {
      const key = cleanSiteDomain(d);
      if (key && canAttach(indexRules(out), rule, key)) rule.siteDomains.push(key);
    }
  }
  return out;
}

// tidySiteDomains — порядок в привязках: только годные домены, без повторов; домен со своим
// правилом — на него самого или на домен выше (привязан d1.cloudfront.net, а есть правило
// cloudfront.net) — не привязан ни к кому: иначе в PAC победила бы более конкретная привязка,
// а не своё правило; один домен — у одного правила (у первого).
export function tidySiteDomains(rules) {
  const explicit = new Set(rules.map((r) => r.domain));
  const taken = new Set();
  return rules.map((r) => {
    const siteDomains = [];
    for (const raw of Array.isArray(r.siteDomains) ? r.siteDomains : []) {
      const d = cleanSiteDomain(raw);
      if (!d || parents(d).some((p) => explicit.has(p)) || taken.has(d) || siteDomains.length >= MAX_SITE_DOMAINS) continue;
      taken.add(d);
      siteDomains.push(d);
    }
    // «Убранные вручную» — без самого домена правила и его поддоменов: к правилу они не привязываются.
    const removed = [...new Set((Array.isArray(r.siteDomainsRemoved) ? r.siteDomainsRemoved : []).map(cleanSiteDomain).filter(Boolean))]
      .filter((d) => !siteDomains.includes(d) && !parents(d).includes(r.domain)).slice(0, MAX_SITE_DOMAINS);
    return { ...r, siteDomains, siteDomainsRemoved: removed };
  });
}

// stillAttached — какие из доменов ещё привязаны к какому-нибудь правилу. Для подсказки «обновите
// вкладку»: правило могли удалить, домен — убрать или дать ему своё правило, и тогда подсказка про
// него уже не нужна (а вернули правило — нужна снова: вкладку так и не обновили).
export function stillAttached(rules, domains) {
  const attached = new Set(rules.flatMap((r) => r.siteDomains || []));
  return (Array.isArray(domains) ? domains : []).filter((d) => attached.has(d));
}

// keyFor — что привязывать для имени из запроса, или null — не привязывать:
// локальные адреса и IP, российские зоны и сайты (набор с collect: false), общие сервисы — нет;
// общий хостинг — полное имя хоста; остальное — «сайт» (rr3---sn-x.googlevideo.com → googlevideo.com).
export function keyFor(data, host) {
  const h = pacHost(host);
  if (!h || isLocalHost(h) || h.includes(':') || /^\d+(\.\d+){3}$/.test(h)) return null;
  if (covered(data.noCollect, h) || covered(data.common, h)) return null;
  const key = cleanSiteDomain(covered(data.hostings, h) ? h : siteOf(h));
  return !key || data.hostings.has(key) ? null : key; // сам домен хостинга (cloudfront.net) — никогда
}

// collectingRule — правило, для которого собираем домены вкладки с сайтом topHost: самое
// конкретное включённое правило сайта, и оно «через VPN» и не на целую зону.
export function collectingRule(rules, topHost) {
  const enabled = new Map(rules.filter((r) => r.enabled).map((r) => [r.domain, r]));
  for (const d of parents(String(topHost || '').toLowerCase())) {
    const r = enabled.get(d);
    if (r) return r.action === 'proxy' && r.domain.includes('.') ? r : null;
  }
  return null;
}

// SiteCollector — автосбор. Запросы вкладок приходят из chrome.webRequest (фон); новые домены
// копятся в памяти и записываются пачкой: после FLUSH_QUIET_MS тишины, но не позже FLUSH_MAX_MS
// после первого нового домена (каждая запись — новый PAC в Chrome).
//   load()               → { rules, settings } из хранилища (кэшируется до invalidate());
//   data                 → siteData(…) или Promise;
//   attach(batch, tabs)  → записать: batch — { ruleId: [домены] }, tabs — { tabId: [домены] };
//   isPrivate(tabId)     → вкладка инкогнито? (Promise). Из таких вкладок ничего не собираем:
//                          домены сайта хранятся в правилах, то есть на диске, а от инкогнито на
//                          диске ничего оставаться не должно. Не задано — инкогнито не отличаем.
export class SiteCollector {
  constructor({ load, data, attach, isPrivate = null, timers = globalThis, now = Date.now }) {
    Object.assign(this, { load, data, attach, isPrivate, timers, now });
    this.state = null;
    this.pending = new Map(); // ruleId → Set(доменов)
    this.tabs = new Map(); // tabId → Set(доменов) — для подсказки «обновите вкладку»
    this.seenHosts = new Map(); // «правило|имя» → домен, который из-за этого имени ждёт записи (или null): второй раз имя не разбираем
    this.firstAt = null; // когда пришёл первый домен из ещё не записанных
    this.timer = null;
    this.privateTabs = new Map(); // tabId → Promise «вкладка инкогнито?»: спрашиваем один раз
  }

  // #private — вкладка инкогнито? Узнать не удалось (вкладку уже закрыли) — считаем, что да:
  // лучше не собрать, чем записать лишнее; такой ответ не запоминаем.
  #private(tabId) {
    if (!this.isPrivate) return false;
    if (!this.privateTabs.has(tabId)) {
      this.privateTabs.set(tabId, Promise.resolve().then(() => this.isPrivate(tabId)).catch(() => {
        this.privateTabs.delete(tabId);
        return true;
      }));
    }
    return this.privateTabs.get(tabId);
  }

  // forget — вкладку закрыли: ответ о ней больше не нужен.
  forget(tabId) {
    this.privateTabs.delete(tabId);
  }

  // invalidate — правила или настройки изменились: прочитать заново.
  invalidate() {
    this.state = null;
    this.seenHosts.clear();
  }

  async #load() {
    this.state ??= (async () => {
      const [st, data] = await Promise.all([this.load(), this.data]);
      return { rules: st.rules, on: st.settings.autoSiteDomains !== false, index: indexRules(st.rules), data };
    })();
    return this.state;
  }

  // seen — вкладка tabId с сайтом topHost обратилась к host.
  async seen(tabId, topHost, host) {
    if (tabId < 0 || !topHost || !host) return;
    const st = await this.#load();
    if (!st.on) return;
    const rule = collectingRule(st.rules, topHost);
    if (!rule) return;
    if (await this.#private(tabId)) return; // инкогнито: ни доменов правилу, ни подсказки вкладке
    const mark = `${rule.id}|${host}`;
    if (this.seenHosts.has(mark)) {
      // Имя уже разобрано. Его домен ещё ждёт записи — значит, это другая вкладка того же сайта:
      // ей тоже нужна подсказка «обновите вкладку».
      const waiting = this.seenHosts.get(mark);
      if (waiting && this.pending.get(rule.id)?.has(waiting)) this.#note(tabId, waiting);
      return;
    }
    if (this.seenHosts.size > 5000) this.seenHosts.clear();
    this.seenHosts.set(mark, null);
    const key = keyFor(st.data, host);
    if (!key || !canAttach(st.index, rule, key)) return;
    for (const [id, set] of this.pending) {
      const waiting = parents(key).find((d) => set.has(d));
      if (!waiting) continue;
      // Уже ждёт записи. У этого же правила — вкладке тоже нужна подсказка; у другого — нет:
      // домен достанется не её сайту.
      if (id === rule.id) {
        this.seenHosts.set(mark, waiting);
        this.#note(tabId, waiting);
      }
      return;
    }
    const set = this.pending.get(rule.id) || new Set();
    if ((rule.siteDomains || []).length + set.size >= MAX_SITE_DOMAINS) return;
    set.add(key);
    this.pending.set(rule.id, set);
    this.seenHosts.set(mark, key);
    this.#note(tabId, key);
    this.#schedule();
  }

  // #note — вкладке нужна подсказка «обновите вкладку» про домен key.
  #note(tabId, key) {
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, new Set());
    this.tabs.get(tabId).add(key);
  }

  #schedule() {
    const t = this.now();
    this.firstAt ??= t;
    this.timers.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(FLUSH_QUIET_MS, this.firstAt + FLUSH_MAX_MS - t));
    this.timer = this.timers.setTimeout(() => this.flush(), wait);
  }

  // flush — записать накопленное.
  async flush() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.firstAt = null;
    if (!this.pending.size) return;
    const batch = Object.fromEntries([...this.pending].map(([id, set]) => [id, [...set]]));
    const tabs = Object.fromEntries([...this.tabs].map(([id, set]) => [id, [...set]]));
    this.pending.clear();
    this.tabs.clear();
    await this.attach(batch, tabs);
  }
}
