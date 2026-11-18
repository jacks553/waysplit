// Общее для скриншотов (tools/store-shots.js — магазин, tools/popup-shots.js — все экраны окна):
// вымышленные данные, подделка связи с компаньоном, копия расширения, Chrome без окна по трубе
// DevTools. Не скрипт: запускать store-shots.js или popup-shots.js.
//
// Настоящий интерфейс на вымышленных данных. Расширение — временная копия extension/, в которой
// связь с компаньоном (lib/native.js) заменена подделкой с готовыми ответами: компаньон, ядра и
// сеть не нужны, ваши серверы и настройки не трогаются (Chrome — во временном профиле).
// Серверы — на адресах *.example.net (такие имена зарезервированы для примеров), ключи — из хеша
// строк, IP — из диапазона для документации 203.0.113.0/24. Как эти серверы видит расширение
// (протокол, транспорт, ядро) — спрашиваем у настоящего компаньона: parse_links по этим ссылкам
// (host\bin\waysplit-host.exe, с временной папкой данных).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromePath = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hostExe = join(root, 'host', 'bin', 'waysplit-host.exe');
const extId = readFileSync(join(root, 'host', 'extid.go'), 'utf8').match(/extensionID = "([a-p]{32})"/)[1];

// --- вымышленные данные ---
const hash = (s) => createHash('sha256').update(`waysplit-shots/${s}`).digest();
const uuid = (s) => {
  const x = hash(s).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
};
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const tag = (cc, city) => `#${encodeURIComponent(`${flag(cc)} ${city}`)}`;
const reality = (cc, city, host) => `vless://${uuid(host)}@${host}:443?encryption=none&security=reality&sni=www.example.com`
  + `&fp=chrome&pbk=${hash(`pbk/${host}`).toString('base64url')}&sid=${hash(`sid/${host}`).toString('hex').slice(0, 8)}`
  + `&type=tcp&flow=xtls-rprx-vision${tag(cc, city)}`;
const hy2 = (cc, city, host) => `hysteria2://${hash(`pw/${host}`).toString('hex').slice(0, 20)}@${host}:443?sni=${host}${tag(cc, city)}`;
const xhttp = (cc, city, host) => `vless://${uuid(host)}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome`
  + `&type=xhttp&path=%2Fxh&mode=auto${tag(cc, city)}`;
const ws = (cc, city, host) => `vless://${uuid(host)}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=%2Fws${tag(cc, city)}`;

// Данные — на языке кадров (ru или en): города серверов, название подписки, сообщение провайдера,
// зона в правилах. Остальное (адреса, ключи, пинг) от языка не зависит.
const CITIES = {
  ru: { NL: 'Амстердам', DE: 'Франкфурт', FI: 'Хельсинки', TR: 'Стамбул', JP: 'Токио', US: 'Нью-Йорк', SE: 'Стокгольм', GB: 'Лондон', PL: 'Варшава' },
  en: { NL: 'Amsterdam', DE: 'Frankfurt', FI: 'Helsinki', TR: 'Istanbul', JP: 'Tokyo', US: 'New York', SE: 'Stockholm', GB: 'London', PL: 'Warsaw' },
};
const TEXTS = {
  ru: { subTitle: 'Мой VPN', announce: 'Плановые работы в ночь на воскресенье, 03:00–04:00 (МСК).', zone: 'рф' },
  en: { subTitle: 'My VPN', announce: 'Scheduled maintenance on Sunday night, 03:00–04:00 (UTC).', zone: 'de' },
};
// Пинг как у настоящего: через сам сервер (соединение, TLS, ответ) — сотни миллисекунд; 0 — нет ответа.
const PINGS = { NL: 412, DE: 468, FI: 655, TR: 590, JP: 1240, US: 870, SE: 436, GB: 512, PL: 0 };
export const subUrl = 'https://sub.example.com/api/sub/demo';
const GB = 2 ** 30;

// fixtures — вымышленные данные на языке lang.
function fixtures(lang) {
  const city = CITIES[lang] || CITIES.ru;
  return {
    city,
    text: TEXTS[lang] || TEXTS.ru,
    ownLinks: [
      reality('NL', city.NL, 'nl.example.net'),
      reality('DE', city.DE, 'de.example.net'),
      hy2('FI', city.FI, 'fi.example.net'),
      xhttp('TR', city.TR, 'tr.example.net'),
      ws('JP', city.JP, 'jp.example.net'),
      hy2('US', city.US, 'us.example.net'),
    ],
    subLinks: [
      reality('SE', city.SE, 'se.vpn.example.net'),
      reality('GB', city.GB, 'gb.vpn.example.net'),
      hy2('PL', city.PL, 'pl.vpn.example.net'),
    ],
    pings: Object.fromEntries(Object.entries(PINGS).map(([cc, ms]) => [city[cc], ms])),
  };
}

// --- настоящий компаньон: как он разбирает эти ссылки ---
function companion(msg, work) {
  return new Promise((ok, fail) => {
    const env = { ...process.env, LOCALAPPDATA: join(work, 'appdata') }; // журнал — во временную папку
    const p = spawn(hostExe, [`chrome-extension://${extId}/`, '--parent-window=0'], { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
    const body = Buffer.from(JSON.stringify({ id: 1, ...msg }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    p.stdin.write(Buffer.concat([len, body]));
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
      const res = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8'));
      p.stdin.end();
      res.ok ? ok(res.result) : fail(new Error(`компаньон: ${res.error?.message}`));
    });
    p.on('error', fail);
  });
}

// --- подделка связи с компаньоном (lib/native.js в копии расширения) ---
function mockNative(fix) {
  return `// Подделка связи с компаньоном — только для скриншотов (tools/shots-lib.js).
export const HOST_NAME = 'com.waysplit.host';
export const DEFAULT_TIMEOUT = 15000;
export class HostError extends Error {
  constructor(code, message) { super(message); this.name = 'HostError'; this.code = code; }
}
export function chromeError(text) { return new HostError('HOST_DISCONNECTED', String(text || '')); }
const FIX = ${JSON.stringify(fix)};
const handlers = {
  hello: () => FIX.hello,
  parse_links: () => FIX.parse,
  fetch_subscription: () => FIX.sub,
  apply: (p) => ({ hostVersion: FIX.hello.hostVersion, running: true, restarted: true, pid: 4242,
    servers: Object.fromEntries(p.servers.map((s) => [s.id, s.localPort])), errors: [], warnings: {} }),
  stop: () => ({ running: false }),
  status: async () => { // как у настоящего компаньона: uptime в секундах, ports — порты серверов ядра
    const { servers = [] } = await chrome.storage.local.get('servers');
    const sb = { running: true, pid: 4242, uptime: 754, ports: servers.filter((s) => s.core !== 'xray').map((s) => s.localPort) };
    return { ...sb, cores: { 'sing-box': sb, xray: { running: false, uptime: 0 } } };
  },
  ping: async (p) => {
    const { servers = [] } = await chrome.storage.local.get('servers');
    return { results: p.serverIds.map((id) => {
      const name = servers.find((s) => s.id === id)?.name || '';
      const city = Object.keys(FIX.pings).find((c) => name.includes(c));
      const ms = FIX.pings[city] ?? 600;
      return ms ? { id, ms } : { id, error: 'таймаут 5 с' };
    }) };
  },
  exit_ip: () => ({ ip: '203.0.113.24' }),
  logs: () => ({ host: '', singbox: '', xray: '' }),
};
export class NativeHost {
  constructor() { this.keepAlive = false; this.onDisconnect = null; this.on = false; }
  get connected() { return this.on; }
  setKeepAlive(on) { this.keepAlive = on; }
  disconnect() { this.on = false; }
  async request(cmd, params = {}) {
    this.on = true;
    const f = handlers[cmd];
    if (!f) throw new HostError('UNKNOWN_CMD', 'подделка не знает команду ' + cmd);
    await new Promise((r) => setTimeout(r, 20));
    return JSON.parse(JSON.stringify(await f(params)));
  }
}
`;
}

// from — папка расширения (по умолчанию — extension этого проекта; другая — например, версия 1.2.1
// для сравнения кадров классического окна).
// prepareExtension — копия расширения в work/extension с подделкой компаньона; extra(ext) — свои
// файлы в копию (например, сцена для магазина); lang — язык данных (ru или en). Вернёт путь к копии.
export async function prepareExtension(work, extra = null, lang = 'ru', from = join(root, 'extension')) {
  const { ownLinks, subLinks, pings, text } = fixtures(lang);
  const parse = await companion({ cmd: 'parse_links', text: ownLinks.join('\n') }, work);
  const subParse = await companion({ cmd: 'parse_links', text: subLinks.join('\n') }, work);
  if (parse.servers.length !== ownLinks.length || subParse.servers.length !== subLinks.length) {
    throw new Error(`компаньон разобрал не все ссылки: ${JSON.stringify([...parse.errors, ...subParse.errors])}`);
  }
  const hostVersion = readFileSync(join(root, 'host', 'main.go'), 'utf8').match(/const version = "([^"]+)"/)[1];
  const appDir = 'C:\\Users\\user\\AppData\\Local\\Programs\\Waysplit';
  const fix = {
    hello: { hostVersion, singboxVersion: '1.14.4', singboxPath: `${appDir}\\sing-box.exe`, xrayVersion: '26.10.31',
      xrayPath: `${appDir}\\xray.exe`, dataDir: 'C:\\Users\\user\\AppData\\Local\\Waysplit' },
    parse,
    sub: { ...subParse, title: text.subTitle, updateIntervalHours: 12, format: '',
      info: { upload: Math.round(2.1 * GB), download: Math.round(21.3 * GB), total: 200 * GB, expire: Math.floor(Date.UTC(2027, 0, 31) / 1000) },
      announce: text.announce },
    pings,
  };
  const ext = join(work, 'extension');
  cpSync(from, ext, { recursive: true });
  writeFileSync(join(ext, 'lib', 'native.js'), mockNative(fix));
  extra?.(ext);
  return ext;
}

// seed — данные в расширение через страницу ctl: язык окна, свои серверы, подписка, правила,
// избранное, текущий сервер, пинг всех. lang — язык окна и данных (ru или en): задаётся явно,
// чтобы кадры не зависели от языка Chrome. Вернёт msg (команда фону) и idOf (id сервера по коду
// страны: 'NL', 'DE'…).
export async function seed(ctl, lang = 'ru') {
  const { ownLinks, city, text } = fixtures(lang);
  const msg = async (m) => {
    const r = await ctl.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
    if (!r?.ok) throw new Error(`${m.type}: ${r?.error?.message}`);
    return r.result;
  };
  await msg({ type: 'setSetting', key: 'language', value: lang });
  await msg({ type: 'addLinks', text: ownLinks.join('\n') });
  await msg({ type: 'addSubscription', url: subUrl });
  const { servers } = await ctl.eval(`chrome.storage.local.get('servers')`);
  const idOf = (cc) => servers.find((s) => s.name.includes(city[cc])).id;
  await msg({ type: 'addRules', domains: ['bank.example.net', text.zone], action: 'direct' });
  await msg({ type: 'addRules', domains: ['video.example.com'], action: 'proxy' });
  await msg({ type: 'addRules', domains: ['news.example.org'], action: 'proxy', serverId: idOf('DE') });
  await msg({ type: 'setFavorite', id: idOf('NL'), on: true });
  await msg({ type: 'setFavorite', id: idOf('SE'), on: true });
  await msg({ type: 'select', id: idOf('NL') });
  await msg({ type: 'ping', ids: [] });
  // Карточка «разрешить видеть запросы вкладок» (домены сайта) показывается один раз, до ответа —
  // на обычных кадрах её нет; кадр с ней — в popup-shots.js.
  await msg({ type: 'setSetting', key: 'siteDomainsAsked', value: true });
  return { msg, idOf };
}

// --- Chrome и DevTools по трубе ---
// scrollbars — с полосами прокрутки, как в настоящем окне. screen — размер экрана: у Chrome без
// окна он по умолчанию 800×600, а на невысоком экране окно расширения ниже (popup.css: 580 вместо 600).
export function startChrome(profile, { scrollbars = false, screen = '1920x1080' } = {}) {
  const proc = spawn(chromePath, [
    '--headless=new', `--screen-info={${screen}}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-proxy-server', ...(scrollbars ? [] : ['--hide-scrollbars']),
    '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let nextId = 1;
  let buf = '';
  const waiting = new Map();
  proc.stdio[4].on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        msg.error ? w.reject(new Error(`${w.method}: ${msg.error.message}`)) : w.resolve(msg.result);
      }
    }
  });
  proc.stdio[3].on('error', () => {});
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    return new Promise((res, rej) => waiting.set(id, { resolve: res, reject: rej, method }));
  };
  // page(ширина, высота) — вкладка; ошибки скриптов страницы копятся в window.__errs (errors()).
  const page = async (width, height) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push(e.message));
      addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason?.stack || e.reason)));` }, sessionId);
    const p = {
      eval: async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`в странице: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      },
      goto: async (url) => {
        await send('Page.navigate', { url }, sessionId);
        for (let i = 0; i < 100 && (await p.eval('document.readyState')) !== 'complete'; i++) await sleep(100);
        await sleep(700); // данные из хранилища и шрифты
      },
      // mouse — настоящий щелчок мышью в точке страницы; key — настоящее нажатие клавиши (Enter, Escape, стрелки).
      mouse: async (x, y) => {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, sessionId);
        }
      },
      key: async (key) => {
        const code = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9 }[key];
        const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        await send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...base, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }, sessionId);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
      },
      // focused — считать страницу активной (иначе у фоновой вкладки :focus-visible не срабатывает, клавиши не доходят).
      focused: () => send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId),
      // inject — свой код до скриптов страницы и её фреймов (при следующей загрузке).
      inject: (source) => send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId),
      // errors — ошибки скриптов страницы (и окна во фрейме сцены магазина).
      errors: () => p.eval(`[...(window.__errs || []), ...[...document.querySelectorAll('iframe')].flatMap((f) => f.contentWindow?.__errs || [])]`),
      shot: async (file) => {
        await send('Target.activateTarget', { targetId });
        await sleep(400);
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(file, Buffer.from(data, 'base64'));
        const errs = await p.errors();
        if (errs.length) throw new Error(`${file}: ошибки в странице: ${errs.join(' | ')}`);
      },
    };
    return p;
  };
  const close = async () => {
    proc.kill();
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
  };
  return { send, page, close };
}
