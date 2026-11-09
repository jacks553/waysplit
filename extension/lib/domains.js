// Домены для правил (SPEC, раздел 3.3): ввод → домен в punycode, обратно — для показа.
//
// Chrome передаёт в PAC имена в punycode и нижнем регистре, поэтому правила хранятся так же:
// «пример.рф» → «xn--e1afmkfd.xn--p1ai», зона «рф» → «xn--p1ai».

// normalizeDomain принимает адрес или домен: убирает схему, путь, порт, «www.», «*.» и точку
// в начале (зона «.ru» → «ru»), переводит кириллицу в punycode (это делает new URL).
// Ответ: { domain } или { error } с причиной по-русски.
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return { error: 'пустая строка' };
  s = s.replace(/^\*\./, '').replace(/^\.+/, '');
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`).hostname;
  } catch {
    return { error: 'не похоже на домен' };
  }
  host = host.replace(/\.$/, '');
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4);
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return { error: 'правила — для доменов, а не для IP-адресов' };
  if (!host || host.length > 253) return { error: 'не похоже на домен' };
  for (const label of host.split('.')) {
    if (!/^[a-z0-9-]{1,63}$/.test(label) || label.startsWith('-') || label.endsWith('-')) return { error: 'не похоже на домен' };
  }
  if (host === 'localhost' || /\.(localhost|local|lan)$/.test(host) || host === 'local' || host === 'lan') {
    return { error: 'локальные адреса всегда идут напрямую' };
  }
  return { domain: host };
}

// parents — сам домен и все родительские: a.b.example.com → a.b.example.com, b.example.com, example.com, com.
export function parents(host) {
  const out = [];
  let h = host;
  for (;;) {
    out.push(h);
    const i = h.indexOf('.');
    if (i < 0) return out;
    h = h.slice(i + 1);
  }
}

// isLocalHost — то же, что PAC всегда отправляет напрямую (для блока «Этот сайт»).
export function isLocalHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || /\.(localhost|local|lan)$/.test(h)) return true;
  if (h.includes(':')) {
    if (h === '::1') return true;
    const first = h.split(':')[0];
    if (!first || first.length > 4) return false;
    const v = parseInt(first, 16);
    return (v & 0xfe00) === 0xfc00 || (v & 0xffc0) === 0xfe80;
  }
  if (!h.includes('.')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// toUnicode — punycode обратно в буквы для показа: «xn--p1ai» → «рф». Битая метка остаётся как есть.
export function toUnicode(domain) {
  return domain.split('.').map((label) => {
    if (!label.startsWith('xn--')) return label;
    try {
      return decodeLabel(label.slice(4));
    } catch {
      return label;
    }
  }).join('.');
}

// Декодер punycode (RFC 3492, раздел 6.2).
const BASE = 36;
const TMIN = 1;
const TMAX = 26;

function adapt(delta, numPoints, first) {
  delta = first ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((BASE - TMIN) * TMAX) >> 1) {
    delta = Math.floor(delta / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + 38));
}

function decodeLabel(input) {
  const out = [];
  const basic = Math.max(input.lastIndexOf('-'), 0);
  for (let j = 0; j < basic; j++) out.push(input.charCodeAt(j));
  let n = 128;
  let i = 0;
  let bias = 72;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length;) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) throw new Error('обрыв');
      const c = input.charCodeAt(idx++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : BASE; // 0–9 → 26–35, a–z → 0–25
      if (digit >= BASE) throw new Error('не цифра');
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
