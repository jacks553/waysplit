// Модель данных в chrome.storage.local (SPEC, раздел 4). Секреты (ссылки серверов) — только
// в local, не в sync. Пишет в хранилище только фоновая часть; окна читают и шлют ей команды.

export const SCHEMA_VERSION = 1;
export const PORT_RANGE = 199; // 27101–27299 при начале по умолчанию

export const DEFAULT_SETTINGS = {
  rulesWhenOff: true,
  onFailure: 'block', // сервер недоступен: 'block' — не открывать сайт, 'direct' — напрямую
  webrtcProtection: true,
  autoConnect: 'restore', // при запуске Chrome: 'restore' — как было, 'off' — выключено
  portRangeStart: 27101,
  subscriptionUA: 'v2rayN/7.0',
  subscriptionIntervalHours: 12, // как часто обновлять подписки (если сервер подписки не сказал сам)
  logLevel: 'warn',
  theme: 'system',
};

// normalize дополняет сохранённое значениями по умолчанию (новые поля не ломают старые данные).
export function normalize(raw = {}) {
  return {
    schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION,
    enabled: raw.enabled === true,
    currentServerId: raw.currentServerId ?? null,
    servers: Array.isArray(raw.servers) ? raw.servers : [],
    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
    rules: Array.isArray(raw.rules) ? raw.rules : [],
    // favorites — избранные серверы (звёздочки в окне, SPEC-POPUP.md): по key сервера, а не по id —
    // key не меняется при обновлении подписки и при повторном добавлении той же ссылки.
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((k) => typeof k === 'string') : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
  };
}

// freePort — первый свободный локальный порт из диапазона; null — диапазон занят целиком.
export function freePort(servers, start = DEFAULT_SETTINGS.portRangeStart) {
  const used = new Set(servers.map((s) => s.localPort));
  for (let p = start; p < start + PORT_RANGE && p <= 65535; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

// newId — короткий id вида s_ab12 (сервер) или r_ab12 (правило), не совпадающий с имеющимися.
export function newId(items, prefix = 's_', random = Math.random) {
  const used = new Set(items.map((x) => x.id));
  for (;;) {
    const id = prefix + Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
    if (!used.has(id)) return id;
  }
}
