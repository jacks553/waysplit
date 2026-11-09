// Главный узел расширения. reconcile() приводит реальность — PAC в Chrome, ядро sing-box
// у компаньона, состояние для окон — к желаемому состоянию из хранилища (SPEC, раздел 4).
// Вызывается при любом изменении и при старте фона; вызовы идут в очередь: пока идёт один,
// следующие сливаются в один повтор.
//
// Зависимости передаются снаружи (в тестах — подделки):
//   store  { get(), set(patch), getSession(key), setSession(obj) } — chrome.storage.local / session
//   proxy  { setPac(data), clear(), control() } — chrome.proxy.settings, control → levelOfControl
//   host   NativeHost (lib/native.js)
//   alarms { start(), stop() } — сторож раз в минуту будит фон, если тот уснул
//   privacy { protect(), release() } — защита WebRTC (chrome.privacy); необязательно
//   ui     { setIcon(state, title) } — значок на панели: off | on | rules | error; необязательно
//   timers { setTimeout, clearTimeout, setInterval, clearInterval }

import { buildPac } from './pac.js';
import { DEFAULT_SETTINGS, PORT_RANGE, freePort, newId, normalize } from './storage.js';
import { routingPlan } from './rules.js';
import { normalizeDomain } from './domains.js';
import { dropSubscription, isDue, mergeSubscription, subHost } from './subscriptions.js';
import { maskUrl } from './format.js';
import { MIN_HOST_VERSION, olderThan, outdatedMessage } from './companion.js';

export const HEARTBEAT_MS = 20000;
export const RECONNECT_DELAYS = [1000, 3000, 10000, 30000];
export const PING_URL = 'https://www.gstatic.com/generate_204';
const APPLY_TIMEOUT = 60000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // как у компаньона: из таких id собираются теги sing-box

export class Controller {
  constructor({ store, proxy, host, alarms, privacy = null, ui = null, timers = globalThis, now = Date.now }) {
    Object.assign(this, { store, proxy, host, alarms, privacy, ui, timers, now });
    this.appliedPac = undefined; // что стоит в Chrome — неизвестно, пока фон не поставил сам
    this.rtc = undefined; // защита WebRTC: 'on' — поставлена нами, 'off' — снята, иначе — почему не вышло
    this.iconKey = '';
    this.readyAt = 0; // когда ядро последний раз поднялось или перезапустилось
    this.events = null; // журнал событий для диагностики (он же в storage.session.events)
    this.wanted = false; // нужно ли сейчас ядро (VPN включён или идёт пинг)
    this.vpnOn = false; // VPN включён и есть сервер
    this.pinging = 0; // сколько проверок пинга идёт: ядро нужно и при выключенном VPN
    this.pingNeed = new Map(); // id сервера → сколько проверок его сейчас меряют (его ядро должно работать)
    this.coreStarted = false;
    this.coreError = null; // почему ядро не поднялось в последний раз
    this.attempt = 0; // попытки переподключения подряд
    this.heartbeat = null;
    this.retryTimer = null;
    this.alarmOn = undefined;
    this.st = null; // последнее состояние для окон (оно же в storage.session.status)
    this.running = null;
    this.again = false;
    this.writes = Promise.resolve();
    host.onDisconnect = (err) => this.#hostLost(err);
  }

  // init — первый запуск фона. В начале сессии браузера (storage.session пуст) применяем
  // настройку автоподключения, потом reconcile.
  init() {
    this.initDone ??= (async () => {
      if (!(await this.store.getSession('started'))) {
        await this.store.setSession({ started: true });
        const st = normalize(await this.store.get());
        if (st.settings.autoConnect === 'off' && st.enabled) await this.store.set({ enabled: false });
      }
      await this.reconcile();
    })();
    return this.initDone;
  }

  reconcile() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          try {
            await this.#step();
          } catch (e) {
            await this.#status({ state: 'error', code: 'INTERNAL', message: `Внутренняя ошибка расширения: ${e.message}` });
          }
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async #step() {
    const st = normalize(await this.store.get());
    const plan = routingPlan(st);
    const server = plan.current;
    const want = plan.vpnOn;
    // SPEC 3.4: ядро — только когда нужно: VPN включён, работают правила «через VPN» или идёт пинг.
    const needCore = plan.needCore || this.pinging > 0;
    this.vpnOn = want;
    this.rulesOnly = plan.rulesOnly;
    this.wanted = needCore;
    const base = { enabled: st.enabled, serverId: server?.id ?? null, conflict: false, control: null, viaVpn: plan.viaVpn };
    const offState = plan.rulesOnly ? 'rules' : st.enabled ? 'no_server' : 'off';

    // 1. PAC — первым. Включаем: сайты сразу идут на порт сервера и ждут ядро (при «не открывать
    //    сайт» напрямую ничего не утечёт). Выключаем: сразу напрямую, ещё до остановки ядра.
    try {
      if (plan.pac) {
        const pac = buildPac(plan.pac);
        if (pac !== this.appliedPac) {
          await this.proxy.setPac(pac);
          this.appliedPac = pac;
        }
      } else if (this.appliedPac !== null) {
        await this.proxy.clear(); // прокси не нужен вообще
        this.appliedPac = null;
      }
      base.control = await this.proxy.control();
      base.conflict = base.control === 'controlled_by_other_extensions';
      if (base.conflict && !this.st?.conflict) this.log('error', 'Прокси Chrome управляет другое расширение');
    } catch (e) {
      this.appliedPac = undefined;
      await this.#status({ ...base, state: 'error', code: 'PROXY_FAILED', message: `Не удалось настроить прокси Chrome: ${e.message}` });
      return;
    }

    // WebRTC (SPEC 3.5): пока VPN включён — disable_non_proxied_udp, иначе браузер может выдать
    // настоящий IP мимо прокси; выключили — вернуть как было.
    if (this.privacy) {
      const protect = want && st.settings.webrtcProtection;
      try {
        if (protect && this.rtc !== 'on') this.rtc = await this.privacy.protect();
        else if (!protect && this.rtc !== 'off') {
          await this.privacy.release();
          this.rtc = 'off';
        }
      } catch (e) {
        this.rtc = 'failed';
        this.log('error', `Защита WebRTC: ${e.message}`);
      }
      base.webrtc = this.rtc;
    }

    if (!needCore) {
      this.#watch(false);
      if (this.coreStarted && this.host.connected) {
        try {
          await this.host.request('stop', {}, 10000);
        } catch { /* компаньон уже ушёл — ядро ушло вместе с ним */ }
      }
      this.coreStarted = false;
      await this.#status({ ...base, state: offState, code: '', message: '', pid: null });
      return;
    }

    // 2. Ядро: apply с полным списком серверов. Тот же список компаньон не перезапускает,
    //    поэтому смена текущего сервера — только новый PAC. Список — по id, а не в порядке
    //    показа: перетаскивание серверов в списке тоже не перезапускает ядро.
    this.#watch(true);
    if (want && !(this.st?.state === 'on' && this.st.serverId === server.id)) {
      await this.#status({ ...base, state: 'connecting', code: '', message: '' });
    }
    try {
      // need — серверы, через которые сейчас идут сайты, и те, что пингуются: второе ядро (Xray)
      // компаньон поднимает, только если среди них есть его серверы (SPEC-XRAY.md).
      const need = [...new Set([...plan.need, ...this.pingNeed.keys()])].sort();
      const res = await this.host.request('apply', {
        servers: [...st.servers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map(({ id, link, localPort }) => ({ id, link, localPort })),
        logLevel: st.settings.logLevel,
        need,
      }, APPLY_TIMEOUT);
      if (olderThan(res.hostVersion, MIN_HOST_VERSION)) {
        // Старый компаньон (SPEC-STORE.md, 1.3): ядро не оставляем, просим обновить. После
        // обновления старый компаньон завершится — #hostLost переподключится уже к новому.
        try {
          await this.host.request('stop', {}, 10000);
        } catch { /* уже ушёл */ }
        throw coded('HOST_OUTDATED', outdatedMessage(res.hostVersion));
      }
      this.coreStarted = res.running;
      if (res.restarted) this.readyAt = this.now();
      this.coreError = res.running ? null : Object.assign(new Error('Ядро не запустилось'), { code: 'CORE_STOPPED' });
      base.pid = res.pid ?? null;
      const bad = want && (res.errors || []).find((e) => e.id === server.id);
      if (!want && (!plan.rulesOnly || res.running)) {
        // VPN выключен: работают только правила или ядро поднято только для пинга.
        this.attempt = 0;
        await this.#status({ ...base, state: offState, code: '', message: '' });
      } else if (!res.running) {
        await this.#status({ ...base, state: 'error', code: 'CORE_STOPPED', message: 'Ядро не запустилось' });
      } else if (bad) {
        await this.#status({ ...base, state: 'error', code: 'SERVER_INVALID', message: `Этот сервер не запустился: ${bad.message}` });
      } else {
        this.attempt = 0;
        await this.#status({ ...base, state: 'on', code: '', message: '' });
      }
    } catch (e) {
      this.coreStarted = false;
      this.coreError = e;
      if (!want && !plan.rulesOnly) return; // пинг при выключенном VPN сам скажет об ошибке
      await this.#status({ ...base, state: 'error', code: e.code || 'ERROR', message: e.message });
      // Повтор — при обрыве связи; старый компаньон повтором не исправить: ждём обновления.
      if ((String(e.code).startsWith('HOST_') && e.code !== 'HOST_OUTDATED') || e.code === 'TIMEOUT') {
        if (e.code === 'TIMEOUT') this.host.disconnect(); // компаньон завис — начать заново
        if (!this.retryTimer) this.#retry(); // при обрыве связи #hostLost уже запланировал
      }
    }
  }

  // toggle — большая кнопка.
  async toggle(enabled) {
    await this.#mutate(() => ({ enabled: !!enabled }));
    await this.reconcile();
    return this.st;
  }

  // addLinks — вставленные ссылки → компаньон разбирает → новые серверы с постоянным портом.
  // Адреса подписок (http(s)://) добавляются как подписки и сразу скачиваются.
  async addLinks(text) {
    const res = await this.host.request('parse_links', { text }, 30000);
    const skipped = res.errors.map((e) => ({ text: e.text, reason: e.reason }));
    const subscriptions = [];
    for (const u of res.subscriptions || []) {
      try {
        subscriptions.push(await this.addSubscription(u));
      } catch (e) {
        skipped.push({ text: maskUrl(u), reason: e.message });
      }
    }
    let added = [];
    await this.#mutate((st) => {
      const servers = [...st.servers];
      const keys = new Set(servers.map((s) => s.key));
      for (const s of res.servers) {
        if (keys.has(s.key)) {
          skipped.push({ text: s.name, reason: 'такой сервер уже есть' });
          continue;
        }
        const localPort = freePort(servers, st.settings.portRangeStart);
        if (localPort === null) {
          skipped.push({ text: s.name, reason: 'закончились свободные локальные порты' });
          continue;
        }
        const server = {
          id: newId(servers), name: s.name, link: s.link, protocol: s.protocol, address: s.address, port: s.port,
          transport: s.transport, security: s.security, core: s.core || 'sing-box', localPort, subscriptionId: null, lastPingMs: null, key: s.key,
        };
        servers.push(server);
        keys.add(s.key);
        added.push(server);
      }
      const patch = { servers };
      if (!servers.some((s) => s.id === st.currentServerId) && added.length) patch.currentServerId = added[0].id;
      return patch;
    });
    if (added.length) await this.reconcile(); // VPN включён — новый список уйдёт в ядро
    return { added: added.length, names: added.map((s) => s.name), skipped, subscriptions };
  }

  // ping — пинг серверов (ids; пусто — все) через их локальные порты. При выключенном VPN
  // ядро поднимается на время проверки и потом гасится. Результаты сохраняются у серверов.
  async ping(ids = []) {
    const st = normalize(await this.store.get());
    const list = ids.length ? st.servers.filter((s) => ids.includes(s.id)) : st.servers;
    if (!list.length) return [];
    this.pinging++;
    this.#hold(list.map((s) => s.id));
    try {
      await this.reconcile();
      if (!this.coreStarted) throw this.coreError || Object.assign(new Error('Ядро не запущено'), { code: 'CORE_STOPPED' });
      const timeoutMs = 5000;
      const res = await this.host.request('ping', { serverIds: list.map((s) => s.id), url: PING_URL, timeoutMs },
        Math.ceil(list.length / 8) * (timeoutMs + 1000) + 10000); // компаньон меряет до 8 серверов сразу
      const byId = new Map((res.results || []).map((r) => [r.id, r]));
      const at = this.now();
      await this.#mutate((cur) => ({
        servers: cur.servers.map((s) => {
          const r = byId.get(s.id);
          return r ? { ...s, lastPingMs: r.ms || null, lastPingError: r.ms ? null : r.error || 'нет ответа', lastPingAt: at } : s;
        }),
      }));
      return list.map((s) => byId.get(s.id) || { id: s.id, error: 'нет ответа' });
    } finally {
      this.pinging--;
      this.#release(list.map((s) => s.id));
      this.reconcile(); // ядро (или Xray) было нужно только для пинга — погасить
    }
  }

  // #hold / #release — серверы, которые сейчас меряются: их ядро должно работать (need в apply).
  #hold(ids) {
    for (const id of ids) this.pingNeed.set(id, (this.pingNeed.get(id) || 0) + 1);
  }

  #release(ids) {
    for (const id of ids) {
      const n = (this.pingNeed.get(id) || 0) - 1;
      if (n > 0) this.pingNeed.set(id, n);
      else this.pingNeed.delete(id);
    }
  }

  // pingCurrent — быстрый пинг текущего сервера (окно открылось при включённом VPN).
  async pingCurrent() {
    const st = normalize(await this.store.get());
    if (!st.servers.some((s) => s.id === st.currentServerId)) return { error: 'Сервер не выбран' };
    return (await this.ping([st.currentServerId]))[0];
  }

  // fastest — пинг всех и выбор самого быстрого.
  async fastest() {
    const best = (await this.ping()).filter((r) => r.ms > 0).sort((a, b) => a.ms - b.ms)[0];
    if (!best) throw Object.assign(new Error('Ни один сервер не ответил'), { code: 'NO_ANSWER' });
    await this.select(best.id);
    return best;
  }

  // select — сделать сервер текущим. Ядро не перезапускается: меняется только PAC.
  async select(id) {
    await this.#mutate((st) => {
      if (!st.servers.some((s) => s.id === id)) throw Object.assign(new Error('Такого сервера нет'), { code: 'NOT_FOUND' });
      return { currentServerId: id };
    });
    await this.reconcile();
    return this.st;
  }

  // rename — новое имя сервера (ядро и PAC не меняются).
  async rename(id, name) {
    const clean = String(name ?? '').trim().slice(0, 100);
    if (!clean) throw Object.assign(new Error('Имя не может быть пустым'), { code: 'BAD_NAME' });
    // customName — обновление подписки это имя больше не меняет.
    await this.#mutate((st) => ({ servers: st.servers.map((s) => (s.id === id ? { ...s, name: clean, customName: true } : s)) }));
  }

  // remove — удалить сервер. Правила, которые на него ссылались, переходят на «текущий сервер»
  // (SPEC, раздел 4); если удалён текущий — текущим становится первый оставшийся.
  async remove(id) {
    let rulesMoved = 0;
    await this.#mutate((st) => {
      const servers = st.servers.filter((s) => s.id !== id);
      const rules = st.rules.map((r) => {
        if (r.serverId !== id) return r;
        rulesMoved++;
        return { ...r, serverId: null };
      });
      const patch = { servers, rules };
      if (st.currentServerId === id) patch.currentServerId = servers[0]?.id ?? null;
      return patch;
    });
    await this.reconcile(); // список изменился — ядро перезапустится с новым
    return { rulesMoved };
  }

  // setFavorite — звёздочка «избранное» у сервера (SPEC-POPUP.md). Хранится key сервера: так
  // избранное не теряется при обновлении подписки. Ядро и PAC не меняются.
  async setFavorite(id, on) {
    await this.#mutate((st) => {
      const s = st.servers.find((x) => x.id === id);
      if (!s) throw coded('NOT_FOUND', 'Такого сервера нет');
      const rest = st.favorites.filter((k) => k !== s.key);
      return { favorites: on ? [...rest, s.key] : rest };
    });
  }

  // reorder — порядок серверов в списке (ids по порядку; остальные — в конец).
  async reorder(ids) {
    await this.#mutate((st) => {
      const rest = new Map(st.servers.map((s) => [s.id, s]));
      const ordered = [];
      for (const id of ids) {
        const s = rest.get(id);
        if (!s) continue; // неизвестный или повторный id
        ordered.push(s);
        rest.delete(id);
      }
      return { servers: [...ordered, ...rest.values()] };
    });
  }

  // addRules — правила для доменов (адрес или домен, по одному в элементе). Один домен — одно
  // правило: для уже известного домена правило заменяется. serverId — только для 'proxy'
  // (null — текущий сервер).
  async addRules(entries, action, serverId = null) {
    if (action !== 'direct' && action !== 'proxy') throw coded('BAD_RULE', 'Неизвестное действие правила');
    const res = { added: 0, updated: 0, skipped: [], domains: [] };
    await this.#mutate((st) => {
      if (action === 'proxy' && serverId && !st.servers.some((s) => s.id === serverId)) throw coded('NOT_FOUND', 'Такого сервера нет');
      const rules = [...st.rules];
      const index = new Map(rules.map((r, i) => [r.domain, i]));
      const seen = new Set();
      for (const raw of entries) {
        const text = String(raw ?? '').trim();
        if (!text || text.startsWith('#')) continue;
        const n = normalizeDomain(text);
        if (n.error) {
          res.skipped.push({ text, reason: n.error });
          continue;
        }
        if (seen.has(n.domain)) continue;
        seen.add(n.domain);
        res.domains.push(n.domain);
        const fields = { action, serverId: action === 'proxy' ? serverId || null : null, enabled: true };
        if (index.has(n.domain)) {
          const i = index.get(n.domain);
          rules[i] = { ...rules[i], ...fields };
          res.updated++;
        } else {
          rules.push({ id: newId(rules, 'r_'), domain: n.domain, ...fields });
          index.set(n.domain, rules.length - 1);
          res.added++;
        }
      }
      return { rules };
    });
    await this.reconcile();
    return res;
  }

  // updateRule — изменить действие, сервер или включённость правила.
  async updateRule(id, patch = {}) {
    await this.#mutate((st) => {
      const rule = st.rules.find((r) => r.id === id);
      if (!rule) throw coded('NOT_FOUND', 'Такого правила нет');
      const next = { ...rule };
      if ('enabled' in patch) next.enabled = !!patch.enabled;
      if ('action' in patch) {
        if (patch.action !== 'direct' && patch.action !== 'proxy') throw coded('BAD_RULE', 'Неизвестное действие правила');
        next.action = patch.action;
      }
      if ('serverId' in patch) {
        if (patch.serverId && !st.servers.some((s) => s.id === patch.serverId)) throw coded('NOT_FOUND', 'Такого сервера нет');
        next.serverId = patch.serverId || null;
      }
      if (next.action === 'direct') next.serverId = null;
      return { rules: st.rules.map((r) => (r.id === id ? next : r)) };
    });
    await this.reconcile();
  }

  // removeRules — удалить правила по id.
  async removeRules(ids) {
    const drop = new Set(ids);
    await this.#mutate((st) => ({ rules: st.rules.filter((r) => !drop.has(r.id)) }));
    await this.reconcile();
  }

  // importRules — правила из файла резервной копии (exportRules). Сервер ищется по имени;
  // не нашёлся — правило идёт через текущий сервер.
  async importRules(data) {
    const list = Array.isArray(data?.rules) ? data.rules : null;
    if (data?.type !== 'rules' || !list) throw coded('BAD_FILE', 'Это не файл правил Waysplit');
    const st = normalize(await this.store.get());
    const groups = new Map(); // «действие|сервер|вкл» → домены: добавляем пачками
    const res = { added: 0, updated: 0, skipped: [], domains: [] };
    for (const r of list) {
      if (r?.action !== 'direct' && r?.action !== 'proxy') {
        res.skipped.push({ text: String(r?.domain ?? ''), reason: 'неизвестное действие' });
        continue;
      }
      const serverId = r.action === 'proxy' && r.server ? st.servers.find((s) => s.name === r.server)?.id ?? null : null;
      const key = `${r.action}|${serverId ?? ''}|${r.enabled !== false}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.domain);
    }
    for (const [key, domains] of groups) {
      const [action, serverId, enabled] = key.split('|');
      const part = await this.addRules(domains, action, serverId || null);
      res.added += part.added;
      res.updated += part.updated;
      res.skipped.push(...part.skipped);
      if (enabled === 'false') {
        await this.#mutate((cur) => ({ rules: cur.rules.map((x) => (part.domains.includes(x.domain) ? { ...x, enabled: false } : x)) }));
      }
    }
    await this.reconcile();
    return res;
  }

  // setSetting — одна настройка (SPEC 3.6). Новый диапазон портов — серверы получают порты
  // из него по порядку (ядро перезапустится).
  async setSetting(key, value) {
    if (!validSetting(key, value)) throw coded('BAD_SETTING', 'Неверное значение настройки');
    await this.#mutate((st) => {
      const patch = { settings: { ...st.settings, [key]: value } };
      if (key === 'portRangeStart' && value !== st.settings.portRangeStart) patch.servers = reassignPorts(st.servers, value);
      return patch;
    });
    await this.reconcile();
  }

  // --- подписки ---

  // addSubscription — новая подписка (или уже известная по адресу) и сразу её скачивание.
  async addSubscription(url) {
    url = String(url ?? '').trim();
    if (!/^https?:\/\/[^/\s]+/i.test(url)) throw coded('BAD_URL', 'Адрес подписки должен начинаться с http:// или https://');
    let sub;
    let created = false;
    await this.#mutate((st) => {
      sub = st.subscriptions.find((s) => s.url === url);
      if (sub) return null;
      created = true;
      sub = { id: newId(st.subscriptions, 'u_'), name: subHost(url), url, intervalHours: st.settings.subscriptionIntervalHours, updatedAt: null, info: null, lastError: null };
      return { subscriptions: [...st.subscriptions, sub] };
    });
    try {
      return await this.updateSubscription(sub.id);
    } catch (e) {
      if (created) await this.#mutate((st) => ({ subscriptions: st.subscriptions.filter((s) => s.id !== sub.id) }));
      throw e;
    }
  }

  // updateSubscription — скачать подписку и слить с серверами (id совпадающих серверов сохраняются).
  // Напрямую не скачалась, а ядро работает — компаньон повторит через текущий сервер.
  async updateSubscription(id) {
    const st = normalize(await this.store.get());
    const sub = st.subscriptions.find((s) => s.id === id);
    if (!sub) throw coded('NOT_FOUND', 'Такой подписки нет');
    let res;
    try {
      // device — подписка уже привязана к компьютеру как устройство (SPEC-SUBS, шаг 2): компаньон
      // сразу отправит идентификатор; иначе сначала без него, а если без него серверов нет — с ним.
      res = await this.host.request('fetch_subscription', {
        url: sub.url,
        userAgent: st.settings.subscriptionUA,
        proxyServerId: this.coreStarted && st.currentServerId ? st.currentServerId : '',
        device: sub.device === true,
      }, 120000); // до двух запросов (без идентификатора и с ним)
    } catch (e) {
      await this.#mutate((cur) => ({ subscriptions: cur.subscriptions.map((x) => (x.id === id ? { ...x, lastError: e.message, lastTryAt: this.now() } : x)) }));
      this.log('error', `Подписка «${sub.name}» не обновилась: ${e.message}`);
      throw e;
    }
    let report;
    let name = sub.name;
    await this.#mutate((cur) => {
      if (!cur.subscriptions.some((x) => x.id === id)) throw coded('NOT_FOUND', 'Подписку удалили, пока она скачивалась');
      const m = mergeSubscription(cur, id, res, this.now());
      report = m.report;
      name = m.patch.subscriptions.find((x) => x.id === id).name;
      return m.patch;
    });
    if (res.deviceUsed && !sub.device) {
      this.log('info', `Подписка «${name}» отдаёт серверы только устройствам — этот компьютер привязан к ней как устройство (отправлен идентификатор)`);
    }
    this.log('info', `Подписка «${name}» обновлена: новых ${report.added}, удалено ${report.removed}, пропущено ${report.skipped.length}${res.viaVpn ? ' (скачана через VPN)' : ''}`);
    await this.reconcile();
    return { ...report, id, name, info: res.info ?? null, viaVpn: !!res.viaVpn, device: !!res.deviceUsed, announce: res.announce || '' };
  }

  // checkSubscription — «Проверить подписку» (SPEC-SUBS.md, шаг 1): компаньон скачивает подписку
  // с User-Agent разных клиентов и возвращает отчёт без секретов. device — отправить ли
  // идентификатор устройства: решает человек (провайдер может засчитать ещё одно устройство).
  async checkSubscription(id, device = false) {
    const st = normalize(await this.store.get());
    const sub = st.subscriptions.find((s) => s.id === id);
    if (!sub) throw coded('NOT_FOUND', 'Такой подписки нет');
    const res = await this.host.request('sub_info', {
      url: sub.url,
      device: device === true,
      proxyServerId: this.coreStarted && st.currentServerId ? st.currentServerId : '',
    }, 180000);
    this.log('info', `Проверка подписки «${sub.name}»${res.device ? ' с идентификатором устройства' : ''}${res.viaVpn ? ' (через VPN)' : ''}`);
    return { id, name: sub.name, report: res.report, device: !!res.device, viaVpn: !!res.viaVpn };
  }

  // removeSubscription — удалить подписку вместе с её серверами.
  async removeSubscription(id) {
    let report;
    await this.#mutate((st) => {
      const m = dropSubscription(st, id);
      report = m.report;
      return m.patch;
    });
    await this.reconcile();
    return report;
  }

  // renameSubscription — своё имя подписки (обновления его больше не меняют).
  async renameSubscription(id, name) {
    const clean = String(name ?? '').trim().slice(0, 100);
    if (!clean) throw coded('BAD_NAME', 'Имя не может быть пустым');
    await this.#mutate((st) => ({ subscriptions: st.subscriptions.map((s) => (s.id === id ? { ...s, name: clean, customName: true } : s)) }));
  }

  // updateDueSubscriptions — автообновление (SPEC 3.1): подписки, у которых прошёл интервал.
  async updateDueSubscriptions() {
    const st = normalize(await this.store.get());
    for (const sub of st.subscriptions.filter((s) => isDue(s, this.now()))) {
      // Не повторять каждые полчаса, если сервер подписки лежит: следующая попытка — через час.
      if (sub.lastTryAt && this.now() - sub.lastTryAt < 3600e3) continue;
      try {
        await this.updateSubscription(sub.id);
      } catch { /* ошибка уже в журнале и у подписки */ }
    }
  }

  // --- резервная копия (SPEC 3.1): в файле секреты (ссылки серверов и адреса подписок) ---

  async exportBackup() {
    const st = normalize(await this.store.get());
    return {
      app: 'Waysplit',
      type: 'backup',
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      currentServerId: st.currentServerId,
      servers: st.servers.map(({ id, name, link, subscriptionId, customName }) => ({ id, name, link, subscriptionId: subscriptionId ?? null, customName: !!customName })),
      subscriptions: st.subscriptions.map(({ id, name, url, intervalHours, customName, device }) => ({ id, name, url, intervalHours, customName: !!customName, device: !!device })),
      rules: st.rules,
      favorites: st.favorites,
      settings: st.settings,
    };
  }

  // importBackup — заменить серверы, подписки, правила и настройки копией из файла.
  // Включён ли VPN — не меняется. Ссылки заново разбирает компаньон; порты — заново по порядку.
  async importBackup(data) {
    if (data?.type !== 'backup' || !Array.isArray(data.servers)) throw coded('BAD_FILE', 'Это не файл резервной копии Waysplit');
    const settings = { ...DEFAULT_SETTINGS };
    for (const [k, v] of Object.entries(data.settings || {})) if (validSetting(k, v)) settings[k] = v;
    const parsed = data.servers.length
      ? await this.host.request('parse_links', { text: data.servers.map((s) => String(s.link ?? '')).join('\n') }, 30000)
      : { servers: [] };
    const byLink = new Map(parsed.servers.map((s) => [s.link, s]));
    const subscriptions = (Array.isArray(data.subscriptions) ? data.subscriptions : [])
      .filter((s) => /^https?:\/\//i.test(String(s?.url ?? '')) && ID_RE.test(s.id))
      .map((s) => ({ id: s.id, name: String(s.name || subHost(s.url)), url: s.url, intervalHours: Number(s.intervalHours) || settings.subscriptionIntervalHours,
        updatedAt: null, info: null, lastError: null, customName: !!s.customName, device: s.device === true }));
    const subIds = new Set(subscriptions.map((s) => s.id));
    const servers = [];
    let skipped = 0;
    for (const b of data.servers) {
      const p = byLink.get(String(b?.link ?? '').trim());
      if (!p) {
        skipped++;
        continue;
      }
      const id = ID_RE.test(b.id) && !servers.some((s) => s.id === b.id) ? b.id : newId(servers);
      const localPort = freePort(servers, settings.portRangeStart);
      if (localPort === null) {
        skipped++;
        continue;
      }
      servers.push({
        id, name: String(b.name || p.name), link: p.link, protocol: p.protocol, address: p.address, port: p.port, transport: p.transport,
        security: p.security, core: p.core || 'sing-box', localPort, subscriptionId: subIds.has(b.subscriptionId) ? b.subscriptionId : null, customName: !!b.customName,
        lastPingMs: null, key: p.key,
      });
    }
    const serverIds = new Set(servers.map((s) => s.id));
    const rules = [];
    for (const r of Array.isArray(data.rules) ? data.rules : []) {
      const n = normalizeDomain(r?.domain);
      if (n.error || (r.action !== 'direct' && r.action !== 'proxy') || rules.some((x) => x.domain === n.domain)) continue;
      rules.push({ id: newId(rules, 'r_'), domain: n.domain, action: r.action, serverId: r.action === 'proxy' && serverIds.has(r.serverId) ? r.serverId : null, enabled: r.enabled !== false });
    }
    const currentServerId = serverIds.has(data.currentServerId) ? data.currentServerId : servers[0]?.id ?? null;
    // Избранное — по key: ключи из копии, у которых сервер восстановился (старые копии — без избранного).
    const keys = new Set(servers.map((s) => s.key));
    const favorites = [...new Set((Array.isArray(data.favorites) ? data.favorites : []).filter((k) => keys.has(k)))];
    await this.#mutate(() => ({ servers, subscriptions, rules, settings, currentServerId, favorites }));
    this.log('info', `Восстановлено из резервной копии: серверов ${servers.length}, подписок ${subscriptions.length}, правил ${rules.length}`);
    await this.reconcile();
    return { servers: servers.length, skipped, subscriptions: subscriptions.length, rules: rules.length };
  }

  // --- диагностика (SPEC 3.6) ---

  // exitIp — «Мой IP сейчас»: внешний IP через текущий сервер (ядро — на время проверки, если нужно).
  async exitIp() {
    const st = normalize(await this.store.get());
    const server = st.servers.find((s) => s.id === st.currentServerId);
    if (!server) throw coded('NO_SERVER', 'Сервер не выбран');
    this.pinging++;
    this.#hold([server.id]);
    try {
      await this.reconcile();
      if (!this.coreStarted) throw this.coreError || coded('CORE_STOPPED', 'Ядро не запущено');
      const r = await this.host.request('exit_ip', { serverId: server.id }, 20000);
      return { ip: r.ip, server: server.name };
    } finally {
      this.pinging--;
      this.#release([server.id]);
      this.reconcile();
    }
  }

  // diagnostics — версии, ядро, журналы компаньона (уже без секретов) и события расширения.
  async diagnostics() {
    const ask = (cmd, params, ms) => this.host.request(cmd, params, ms).catch((e) => ({ error: e.message, code: e.code }));
    return {
      hello: await ask('hello', {}, 15000),
      core: await ask('status', {}, 5000),
      logs: await ask('logs', { lines: 60 }, 15000),
      status: this.st,
      events: (await this.store.getSession('events')) || [],
    };
  }

  // log — событие в журнал расширения (последние 100, в storage.session). Журнал из хранилища
  // загружается один раз: две записи подряд до загрузки не должны затереть друг друга.
  async log(level, text) {
    this.eventsLoading ??= this.store.getSession('events').then((e) => { this.events ??= e || []; });
    await this.eventsLoading;
    this.events.push({ at: this.now(), level, text });
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
    await this.store.setSession({ events: this.events });
  }

  // proxyError — Chrome не смог пройти через прокси (например, ядро упало). Запись в журнал,
  // красный значок на 15 с; не чаще раза в 5 с проверяем, всё ли в порядке.
  proxyError(details) {
    const t = this.now();
    if (t - (this.lastProxyLog || 0) > 5000) {
      this.lastProxyLog = t;
      this.log('error', `Ошибка прокси: ${details?.error || ''}${details?.details ? ` (${details.details})` : ''}`);
    }
    this.#status({ proxyError: { error: details?.error || '', fatal: !!details?.fatal, at: t } });
    this.timers.setTimeout(() => this.#icon(), 15500);
    if ((this.vpnOn || this.rulesOnly) && t - (this.lastKick || 0) > 5000) {
      this.lastKick = t;
      this.reconcile();
    }
  }

  // #mutate — изменения хранилища по одному: прочитать → поправить → записать.
  #mutate(fn) {
    const job = this.writes.then(async () => {
      const patch = await fn(normalize(await this.store.get()));
      if (patch) await this.store.set(patch);
    });
    this.writes = job.catch(() => {});
    return job;
  }

  async #status(patch) {
    if ((patch.state === 'on' || patch.state === 'rules') && this.st?.state !== patch.state) this.readyAt = this.now();
    this.st = { ...(this.st || {}), ...patch, at: this.now() };
    await this.store.setSession({ status: this.st });
    this.#icon();
  }

  // #icon — значок на панели (SPEC 3.5): серый — выключено, зелёный — VPN включён, жёлтый —
  // работают только правила, красный «!» — ошибка (в том числе ошибка прокси за последние 15 с).
  #icon() {
    if (!this.ui || !this.st) return;
    const s = this.st;
    // Ошибки в первые 3 с после запуска ядра — ожидаемые: PAC ставится раньше ядра (защита от утечки).
    const proxyErr = s.proxyError?.fatal && this.now() - s.proxyError.at < 15000 && s.proxyError.at > this.readyAt + 3000
      && (s.state === 'on' || s.state === 'rules');
    let state = 'off';
    let title = 'Waysplit — выключен';
    if (s.conflict) [state, title] = ['error', 'Waysplit — прокси Chrome управляет другое расширение'];
    else if (s.state === 'error') [state, title] = ['error', `Waysplit — ошибка: ${s.message}`];
    else if (proxyErr) [state, title] = ['error', `Waysplit — ошибка прокси: ${s.proxyError.error}`];
    else if (s.state === 'on' || s.state === 'connecting') [state, title] = ['on', s.state === 'on' ? 'Waysplit — подключено' : 'Waysplit — подключение…'];
    else if (s.state === 'rules') [state, title] = ['rules', 'Waysplit — выключен, работают правила сайтов'];
    if (state + title === this.iconKey) return;
    this.iconKey = state + title;
    Promise.resolve(this.ui.setIcon(state, title)).catch(() => {});
  }

  // #watch — пока ядро нужно: держать компаньон, проверять его каждые 20 с, будить фон сторожем.
  #watch(on) {
    if (on) {
      this.host.setKeepAlive(true);
      this.heartbeat ??= this.timers.setInterval(() => this.#beat(), HEARTBEAT_MS);
      if (this.alarmOn !== true) {
        this.alarmOn = true;
        this.alarms.start();
      }
      return;
    }
    this.host.setKeepAlive(false);
    if (this.heartbeat) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    if (this.alarmOn !== false) {
      this.alarmOn = false;
      this.alarms.stop();
    }
  }

  // #beat — heartbeat: компаньон завис (не ответил за 5 с) или ядро упало — восстановить.
  async #beat() {
    if (!this.wanted || this.running) return;
    try {
      const st = await this.host.request('status', {}, 5000);
      if (!st.running) this.reconcile();
    } catch (e) {
      if (e.code === 'TIMEOUT') this.host.disconnect();
      this.reconcile();
    }
  }

  #hostLost(err) {
    this.coreStarted = false;
    if (!this.wanted) return;
    const restarting = err.code === 'HOST_EXITED' || err.code === 'HOST_DISCONNECTED';
    if (this.vpnOn || this.rulesOnly) this.#status(restarting
      ? { state: 'connecting', code: err.code, message: 'Компаньон перезапускается…' }
      : { state: 'error', code: err.code, message: err.message });
    this.#retry();
  }

  // #retry — переподключение с паузой: 1, 3, 10, потом каждые 30 с.
  #retry() {
    this.timers.clearTimeout(this.retryTimer);
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt++;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.reconcile();
    }, delay);
  }
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

// Допустимые значения настроек (SPEC 3.6).
const SETTING_CHECKS = {
  rulesWhenOff: (v) => typeof v === 'boolean',
  onFailure: (v) => v === 'block' || v === 'direct',
  webrtcProtection: (v) => typeof v === 'boolean',
  autoConnect: (v) => v === 'restore' || v === 'off',
  portRangeStart: (v) => Number.isInteger(v) && v >= 1024 && v + PORT_RANGE - 1 <= 65535,
  subscriptionUA: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200,
  subscriptionIntervalHours: (v) => Number.isInteger(v) && v >= 1 && v <= 168,
  logLevel: (v) => ['trace', 'debug', 'info', 'warn', 'error'].includes(v),
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
};

export function validSetting(key, value) {
  return Object.hasOwn(SETTING_CHECKS, key) && SETTING_CHECKS[key](value);
}

// reassignPorts — серверам по порядку порты из нового диапазона.
function reassignPorts(servers, start) {
  const out = [];
  for (const s of servers) {
    const localPort = freePort(out, start);
    if (localPort === null) throw coded('NO_PORTS', 'В новом диапазоне не хватает портов для всех серверов');
    out.push({ ...s, localPort });
  }
  return out;
}
