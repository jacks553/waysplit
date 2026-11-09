// Подписки (SPEC, раздел 3.1): слияние того, что пришло по адресу подписки, с серверами.
//
// Подписка: { id, name, url, intervalHours, updatedAt, info, lastError, customName, viaVpn,
//   device — привязана к компьютеру как устройство (SPEC-SUBS), announce — сообщение провайдера }.
// У серверов из подписки — subscriptionId. При обновлении сервер узнаётся по key (протокол +
// адрес + порт + uuid/пароль), его id сохраняется — правила и выбранный сервер не ломаются.

import { freePort, newId } from './storage.js';

// mergeSubscription — итог fetch_subscription → { patch для хранилища, report }.
// report: added, kept, removed, skipped [{ text, reason }], rulesMoved.
export function mergeSubscription(st, subId, res, now) {
  const report = { added: 0, kept: 0, removed: 0, skipped: (res.errors || []).map((e) => ({ text: e.text, reason: e.reason })), rulesMoved: 0 };
  const fresh = new Map(res.servers.map((s) => [s.key, s]));
  const otherKeys = new Set(st.servers.filter((s) => s.subscriptionId !== subId).map((s) => s.key));
  const removed = new Set();
  const servers = [];
  for (const s of st.servers) {
    if (s.subscriptionId !== subId) {
      servers.push(s);
      continue;
    }
    const f = fresh.get(s.key);
    if (!f) {
      removed.add(s.id);
      report.removed++;
      continue;
    }
    fresh.delete(s.key);
    report.kept++;
    servers.push({
      ...s, link: f.link, protocol: f.protocol, address: f.address, port: f.port, transport: f.transport, security: f.security,
      core: f.core || 'sing-box', name: s.customName ? s.name : f.name,
    });
  }
  for (const f of fresh.values()) {
    if (otherKeys.has(f.key)) {
      report.skipped.push({ text: f.name, reason: 'такой сервер уже есть' });
      continue;
    }
    const localPort = freePort(servers, st.settings.portRangeStart);
    if (localPort === null) {
      report.skipped.push({ text: f.name, reason: 'закончились свободные локальные порты' });
      continue;
    }
    servers.push({
      id: newId(servers), name: f.name, link: f.link, protocol: f.protocol, address: f.address, port: f.port,
      transport: f.transport, security: f.security, core: f.core || 'sing-box', localPort, subscriptionId: subId, lastPingMs: null, key: f.key,
    });
    report.added++;
  }
  const rules = st.rules.map((r) => {
    if (!removed.has(r.serverId)) return r;
    report.rulesMoved++;
    return { ...r, serverId: null };
  });
  let currentServerId = st.currentServerId;
  if (!servers.some((s) => s.id === currentServerId)) {
    currentServerId = servers.find((s) => s.subscriptionId === subId)?.id ?? servers[0]?.id ?? null;
  }
  const subscriptions = st.subscriptions.map((x) => (x.id !== subId ? x : {
    ...x,
    name: x.customName ? x.name : res.title || x.name,
    updatedAt: now,
    info: res.info ?? null,
    intervalHours: res.updateIntervalHours > 0 ? res.updateIntervalHours : x.intervalHours,
    lastError: null,
    viaVpn: !!res.viaVpn,
    // SPEC-SUBS, шаг 2: серверы пришли только с идентификатором устройства — запомнить (дальше
    // компаньон сразу шлёт его); сообщение провайдера — как пришло (обычный текст).
    device: x.device === true || res.deviceUsed === true,
    announce: typeof res.announce === 'string' ? res.announce : '',
    format: typeof res.format === 'string' ? res.format : '', // '' — ссылки; xray-json, singbox-json, clash-yaml
  }));
  return { patch: { servers, rules, currentServerId, subscriptions }, report };
}

// dropSubscription — удалить подписку вместе с её серверами.
export function dropSubscription(st, subId) {
  const removed = new Set(st.servers.filter((s) => s.subscriptionId === subId).map((s) => s.id));
  const servers = st.servers.filter((s) => !removed.has(s.id));
  let rulesMoved = 0;
  const rules = st.rules.map((r) => {
    if (!removed.has(r.serverId)) return r;
    rulesMoved++;
    return { ...r, serverId: null };
  });
  const currentServerId = servers.some((s) => s.id === st.currentServerId) ? st.currentServerId : servers[0]?.id ?? null;
  return {
    patch: { servers, rules, currentServerId, subscriptions: st.subscriptions.filter((x) => x.id !== subId) },
    report: { removed: removed.size, rulesMoved },
  };
}

// isDue — пора ли обновлять подписку (никогда не обновлялась или прошёл её интервал).
export function isDue(sub, now) {
  return typeof sub.updatedAt !== 'number' || now - sub.updatedAt >= (sub.intervalHours || 12) * 3600e3;
}

// subHost — название подписки по умолчанию: адрес сервера подписки.
export function subHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Подписка';
  }
}
