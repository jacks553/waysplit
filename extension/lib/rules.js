// Правила сайтов (SPEC, разделы 3.3 и 3.4).
//
// Правило: { id, domain (punycode, нижний регистр), action: 'direct' | 'proxy',
//            serverId (null — текущий сервер), enabled }. Домен покрывает все поддомены,
// побеждает самое конкретное правило (google.com → VPN, mail.google.com → без VPN:
// почта идёт напрямую).

import { proxyString } from './pac.js';
import { isLocalHost, parents } from './domains.js';

// findRule — самое конкретное включённое правило для имени сайта.
export function findRule(rules, host) {
  const byDomain = new Map(rules.filter((r) => r.enabled).map((r) => [r.domain, r]));
  for (const d of parents(host)) {
    const r = byDomain.get(d);
    if (r) return r;
  }
  return null;
}

// ruleServer — через какой сервер идёт правило «через VPN»: свой или текущий
// (serverId null или сервер удалён).
export function ruleServer(rule, servers, current) {
  return (rule.serverId && servers.find((s) => s.id === rule.serverId)) || current || null;
}

// pacRules — включённые правила → { домен: строка прокси } для PAC.
export function pacRules(rules, servers, current, onFailure) {
  const map = {};
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.action === 'direct') {
      map[r.domain] = 'DIRECT';
      continue;
    }
    const s = ruleServer(r, servers, current);
    if (s) map[r.domain] = proxyString(s.localPort, onFailure);
  }
  return map;
}

// routingPlan — что должно стоять в Chrome при этом состоянии хранилища:
//   vpnOn     — VPN включён и есть текущий сервер (всё через него, кроме правил);
//   rulesOnly — VPN выключен, но правила «через VPN» работают (настройка rulesWhenOff);
//   pac       — { defaultProxy, rules } для buildPac или null (прокси не нужен вообще);
//   needCore  — нужно ли ядро; viaVpn — сколько правил ведут через VPN;
//   need      — id серверов, через которые сейчас идут сайты (текущий и серверы правил): компаньон
//               запускает Xray, только если среди них есть его серверы (SPEC-XRAY.md).
export function routingPlan(st) {
  const current = st.servers.find((s) => s.id === st.currentServerId) || null;
  const vpnOn = st.enabled && current !== null;
  const { onFailure, rulesWhenOff } = st.settings;
  const rules = vpnOn || rulesWhenOff ? pacRules(st.rules, st.servers, current, onFailure) : {};
  const viaVpn = Object.values(rules).filter((v) => v !== 'DIRECT').length;
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
//   { kind: 'vpn', server, rule } / { kind: 'direct', rule } — rule null, если правила нет;
//   inactive — правило есть, но не действует (VPN выключен и правила при выключенном VPN отключены).
export function routeFor(st, host) {
  if (isLocalHost(host)) return { kind: 'local', rule: null };
  const current = st.servers.find((s) => s.id === st.currentServerId) || null;
  const vpnOn = st.enabled && current !== null;
  const rule = findRule(st.rules, host);
  if (rule && (vpnOn || st.settings.rulesWhenOff)) {
    if (rule.action === 'direct') return { kind: 'direct', rule };
    const server = ruleServer(rule, st.servers, current);
    if (server) return { kind: 'vpn', server, rule };
  }
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
    })),
  };
}
