// Подписи для окна и настроек: протокол, защита, адрес, пинг.

export const PROTOCOLS = { vless: 'VLESS', hysteria2: 'HY2' };
export const SECURITY = { none: 'без TLS', tls: 'TLS', reality: 'Reality' };

// hostPort — «адрес:порт», IPv6 в квадратных скобках.
export function hostPort(s) {
  return s.address.includes(':') ? `[${s.address}]:${s.port}` : `${s.address}:${s.port}`;
}

// serverMeta — «VLESS · Reality · nl1.example.com:443». У серверов, которые запускает Xray
// (XHTTP, VLESS Encryption — SPEC-XRAY.md), в конце — «Xray».
export function serverMeta(s) {
  const parts = [PROTOCOLS[s.protocol] || s.protocol, SECURITY[s.security] || s.security, hostPort(s)];
  if (s.core === 'xray') parts.push('Xray');
  return parts.join(' · ');
}

// pingView — текст и оценка пинга: good (< 200 мс), mid (< 500), bad, fail (нет ответа), none (не меряли).
export function pingView(s) {
  if (s.lastPingMs > 0) {
    const ms = s.lastPingMs;
    return { text: `${ms} мс`, level: ms < 200 ? 'good' : ms < 500 ? 'mid' : 'bad' };
  }
  if (s.lastPingError) return { text: 'нет ответа', level: 'fail', title: s.lastPingError };
  return { text: '—', level: 'none' };
}

// pingBars — полоски задержки в окне (SPEC-POPUP.md): n от 1 до 4 (больше — лучше), 0 — нет ответа,
// -1 — ещё не меряли. Пинг меряется запросом через сам сервер (соединение, TLS, ответ сайта),
// поэтому 400–800 мс — обычное дело: до 600 мс — 4 полоски, до 1000 — 3, до 1600 — 2, дольше — 1.
export function pingBars(s) {
  if (s?.lastPingMs > 0) {
    const ms = s.lastPingMs;
    return { n: ms < 600 ? 4 : ms < 1000 ? 3 : ms < 1600 ? 2 : 1, title: `${ms} мс` };
  }
  if (s?.lastPingError) return { n: 0, title: `нет ответа: ${s.lastPingError}` };
  return { n: -1, title: 'пинг ещё не проверялся' };
}

// splitFlag — флаг страны из имени сервера: «🇳🇱 Амстердам» → { flag: '🇳🇱', name: 'Амстердам' }.
// Флаг в середине имени остаётся в имени; нет флага — flag пустой.
export function splitFlag(name) {
  const text = String(name ?? '');
  const lead = /^\s*(\p{Regional_Indicator}{2})\s*/u.exec(text);
  if (lead) return { flag: lead[1], name: text.slice(lead[0].length).trim() || text.trim() };
  const any = /\p{Regional_Indicator}{2}/u.exec(text);
  return { flag: any ? any[0] : '', name: text.trim() };
}

// plural — «1 сервер», «2 сервера», «5 серверов».
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${n} ${many}`;
  if (b === 1) return `${n} ${one}`;
  if (b >= 2 && b <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

// PING_FRESH_MS — сколько пинг сервера считается свежим: моложе — окно расширения не меряет его
// заново при каждом открытии (меньше запросов через сервер; число в статусе — не старше минуты).
export const PING_FRESH_MS = 60_000;

// freshPing — последний пинг сервера, если он моложе PING_FRESH_MS: { ms } или { error }; иначе null.
export function freshPing(s, now = Date.now()) {
  if (!s?.lastPingAt || now - s.lastPingAt >= PING_FRESH_MS || now < s.lastPingAt) return null;
  if (s.lastPingMs > 0) return { ms: s.lastPingMs, error: '' };
  if (s.lastPingError) return { ms: null, error: s.lastPingError };
  return null;
}

// matches — поиск по имени и адресу без учёта регистра.
export function matches(s, query) {
  const q = query.trim().toLowerCase();
  return !q || s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q);
}

// send — команда фоновой части. Ошибки приходят в виде { ok: false, error: { code, message } }.
export async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: { code: 'NO_BACKGROUND', message: `Фоновая часть расширения не отвечает: ${e.message}` } };
  }
}

// Действие правила в выпадающем списке: 'direct', 'proxy:' (текущий сервер), 'proxy:<id сервера>'.
export const actionValue = (r) => (r.action === 'direct' ? 'direct' : `proxy:${r.serverId || ''}`);
export const parseAction = (v) => (v === 'direct' ? { action: 'direct', serverId: null } : { action: 'proxy', serverId: v.slice(6) || null });

// fillActions — варианты «Без VPN», «Через VPN — текущий сервер», «Через VPN — <сервер>».
export function fillActions(select, servers, value) {
  const opt = (v, text) => Object.assign(document.createElement('option'), { value: v, textContent: text });
  select.replaceChildren(
    opt('direct', 'Без VPN'),
    opt('proxy:', 'Через VPN — текущий сервер'),
    ...servers.map((s) => opt(`proxy:${s.id}`, `Через VPN — ${s.name}`)),
  );
  select.value = [...select.options].some((o) => o.value === value) ? value : 'proxy:';
}

// maskUrl — адрес подписки без секретной части: https://sub.example.com/…
export function maskUrl(u) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(String(u));
  return m ? `${m[1]}/…` : '***';
}

// fmtBytes — «12,3 ГБ» / «512 МБ».
export function fmtBytes(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1).replace('.', ',')} ГБ`;
  return `${Math.round(n / (1 << 20))} МБ`;
}

// fmtUptime — сколько работает ядро (секунды от компаньона): «меньше минуты», «12 мин», «3 ч 5 мин»;
// нет числа — «—».
export function fmtUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return 'меньше минуты';
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

// coreText — состояние ядра для диагностики; idle — что сказать, если оно не запущено и ошибки нет.
// Компаньон отдаёт uptime в секундах и ports — локальные порты серверов этого ядра; чего нет — «—».
export function coreText(c, idle = 'не запущено') {
  if (!c) return '—';
  if (c.running) return `работает, PID ${c.pid ?? '—'}, ${fmtUptime(c.uptime)}, портов ${Array.isArray(c.ports) ? c.ports.length : '—'}`;
  return c.lastError ? `не запущено (${c.lastError})` : idle;
}

// fmtDate — «07.11.2026 14:20» (или без времени).
export function fmtDate(ms, withTime = true) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}${withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : ''}`;
}

// addSummary — итог добавления ссылок: «Добавлено 2, пропущено 1: …; подписка «X»: новых 34, …».
export function addSummary({ added, skipped, subscriptions = [] }) {
  const reasons = [...new Set(skipped.map((s) => s.reason))];
  const parts = [];
  if (added || skipped.length || !subscriptions.length) parts.push(`Добавлено ${added}, пропущено ${skipped.length}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
  for (const s of subscriptions) {
    const why = [...new Set(s.skipped.map((x) => x.reason))];
    parts.push(`Подписка «${s.name}»: серверов ${s.added + s.kept}, новых ${s.added}, пропущено ${s.skipped.length}${why.length ? ` (${why.join('; ')})` : ''}` +
      (s.device ? '; привязана к этому компьютеру как устройство' : ''));
  }
  return parts.join('. ');
}
