// Правила сайтов (SPEC, разделы 3.3 и 3.4).
//
// Правило: { id, domain (punycode, нижний регистр), action: 'direct' | 'proxy',
//            serverId (null — текущий сервер), enabled, siteDomains, siteDomainsRemoved }.
// Домен покрывает все поддомены, побеждает самое конкретное правило (google.com → VPN,
// mail.google.com → без VPN: почта идёт напрямую). siteDomains — «домены сайта»
// (lib/sitedomains.js): идут так же, как само правило; своё правило домена важнее привязки.

import { proxyString } from './pac.js';
import { isLocalHost, pacHost, parents } from './domains.js';

// ruleTable — что куда идёт: домен → { rule, via, ru }. Сначала сами правила (via null), потом их
// «домены сайта» (via — привязанный домен): своё правило домена побеждает привязку, из двух
// привязок — первая. Только включённые правила. Последними — ru: домены набора «Российские сайты
// напрямую», когда включён переключатель «Российские сайты — без VPN» (rule null, ru — домен из
// набора): правила пользователя и домены сайта важнее. Как всегда, побеждает самое конкретное:
// правило «через VPN» на shop.example.ru работает и при зоне ru из набора.
// Одна таблица — и для PAC, и для окна.
export function ruleTable(rules, ru = []) {
  const table = new Map();
  const enabled = rules.filter((r) => r.enabled);
  for (const r of enabled) table.set(r.domain, { rule: r, via: null });
  for (const r of enabled) {
    for (const d of r.siteDomains || []) if (!table.has(d)) table.set(d, { rule: r, via: d });
  }
  for (const d of ru) if (!table.has(d)) table.set(d, { rule: null, via: null, ru: d });
  return table;
}

// routeIn — поиск имени сайта в готовой таблице ruleTable: { rule, via, ru } или null. Когда имён
// много (список «Домены этой вкладки»), таблицу строят один раз, а не на каждое имя.
export function routeIn(table, host) {
  for (const d of parents(pacHost(host))) {
    const hit = table.get(d);
    if (hit) return hit;
  }
  return null;
}

// findRoute — { rule, via, ru } для имени сайта с учётом «доменов сайта» и российских сайтов
// (как решит PAC) или null. rule null и ru — сайт идёт напрямую как российский.
export function findRoute(rules, host, ru = []) {
  return routeIn(ruleTable(rules, ru), host);
}

// ruList — домены «Российские сайты — без VPN», если переключатель включён (иначе пусто).
const ruList = (settings, ruDomains) => (settings.ruDirect ? ruDomains || [] : []);

// ruleServer — через какой сервер идёт правило «через VPN»: свой или текущий
// (serverId null или сервер удалён).
export function ruleServer(rule, servers, current) {
  return (rule.serverId && servers.find((s) => s.id === rule.serverId)) || current || null;
}

// pacRules — включённые правила, их «домены сайта» и российские сайты (ru) → { домен: строка
// прокси } для PAC.
export function pacRules(rules, servers, current, onFailure, ru = []) {
  const map = {};
  for (const [domain, { rule }] of ruleTable(rules, ru)) {
    if (!rule || rule.action === 'direct') {
      map[domain] = 'DIRECT';
      continue;
    }
    const s = ruleServer(rule, servers, current);
    if (s) map[domain] = proxyString(s.localPort, onFailure);
  }
  return map;
}

// routingPlan — что должно стоять в Chrome при этом состоянии хранилища:
//   vpnOn     — VPN включён и есть текущий сервер (всё через него, кроме правил);
//   rulesOnly — VPN выключен, но правила «через VPN» работают (настройка rulesWhenOff);
//   pac       — { defaultProxy, rules } для buildPac или null (прокси не нужен вообще);
//   needCore  — нужно ли ядро; viaVpn — сколько правил ведут через VPN («домены сайта» — часть
//               правила, отдельно не считаются);
//   need      — id серверов, через которые сейчас идут сайты (текущий и серверы правил): компаньон
//               запускает Xray, только если среди них есть его серверы (SPEC-XRAY.md).
// ruDomains — домены набора «Российские сайты без VPN» (lib/domain-sets.json): попадают в PAC как
// DIRECT, когда включена настройка ruDirect.
export function routingPlan(st, ruDomains = []) {
  const current = st.servers.find((s) => s.id === st.currentServerId) || null;
  const vpnOn = st.enabled && current !== null;
  const { onFailure, rulesWhenOff } = st.settings;
  const active = vpnOn || rulesWhenOff;
  const rules = active ? pacRules(st.rules, st.servers, current, onFailure, ruList(st.settings, ruDomains)) : {};
  const viaVpn = active ? st.rules.filter((r) => r.enabled && r.action === 'proxy' && ruleServer(r, st.servers, current)).length : 0;
  if (!vpnOn && viaVpn === 0) {
    // Правила «без VPN» при выключенном VPN ничего не меняют — прокси не нужен.
    return { current, vpnOn, rulesOnly: false, pac: null, needCore: false, viaVpn: 0, need: [] };
  }
  const need = new Set(vpnOn ? [current.id] : []);
  for (const r of st.rules) {
    if (!r.enabled || r.action === 'direct') continue;
    const s = ruleServer(r, st.servers, current);
    if (s) need.add(s.id);
  }
  return {
    current,
    vpnOn,
    rulesOnly: !vpnOn,
    pac: { defaultProxy: vpnOn ? proxyString(current.localPort, onFailure) : 'DIRECT', rules },
    needCore: true,
    viaVpn,
    need: [...need].sort(),
  };
}

// routeFor — куда сейчас идёт сайт (для блока «Этот сайт» в окне):
//   { kind: 'local' } — локальный адрес, всегда напрямую;
//   { kind: 'vpn', server, rule, via } / { kind: 'direct', rule, via } — rule null, если правила
//   нет; via — «домен сайта», через который сработало правило (null — само правило);
//   inactive — правило есть, но не действует (VPN выключен и правила при выключенном VPN отключены);
//   { kind: 'direct', rule: null, ru } — российский сайт при включённом «Российские сайты — без VPN»
//   (ru — домен из набора), когда VPN включён: без переключателя он шёл бы через VPN.
export function routeFor(st, host, ruDomains = []) {
  if (isLocalHost(host)) return { kind: 'local', rule: null };
  const current = st.servers.find((s) => s.id === st.currentServerId) || null;
  const vpnOn = st.enabled && current !== null;
  const { rule, via, ru } = findRoute(st.rules, host, ruList(st.settings, ruDomains)) || { rule: null, via: null };
  if (rule && (vpnOn || st.settings.rulesWhenOff)) {
    if (rule.action === 'direct') return { kind: 'direct', rule, via };
    const server = ruleServer(rule, st.servers, current);
    if (server) return { kind: 'vpn', server, rule, via };
  }
  if (ru && vpnOn) return { kind: 'direct', rule: null, ru };
  const inactive = rule && !vpnOn && !st.settings.rulesWhenOff ? rule : null;
  if (vpnOn) return { kind: 'vpn', server: current, rule: null };
  return { kind: 'direct', rule: null, inactive };
}

// Файл резервной копии правил: серверы в нём — по имени (id у каждой установки свои).
export function exportRules(rules, servers) {
  return {
    app: 'Waysplit',
    type: 'rules',
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: rules.map((r) => ({
      domain: r.domain,
      action: r.action,
      server: r.action === 'proxy' && r.serverId ? servers.find((s) => s.id === r.serverId)?.name ?? null : null,
      enabled: r.enabled,
      siteDomains: [...(r.siteDomains || [])],
      siteDomainsRemoved: [...(r.siteDomainsRemoved || [])],
    })),
  };
}
