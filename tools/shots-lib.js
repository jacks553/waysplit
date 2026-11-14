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

export const ownLinks = [
  reality('NL', 'Амстердам', 'nl.example.net'),
  reality('DE', 'Франкфурт', 'de.example.net'),
  hy2('FI', 'Хельсинки', 'fi.example.net'),
  xhttp('TR', 'Стамбул', 'tr.example.net'),
  ws('JP', 'Токио', 'jp.example.net'),
  hy2('US', 'Нью-Йорк', 'us.example.net'),
];
const subLinks = [
  reality('SE', 'Стокгольм', 'se.vpn.example.net'),
  reality('GB', 'Лондон', 'gb.vpn.example.net'),
  hy2('PL', 'Варшава', 'pl.vpn.example.net'),
];
export const subUrl = 'https://sub.example.com/api/sub/demo';
// Пинг как у настоящего: через сам сервер (соединение, TLS, ответ) — сотни миллисекунд; 0 — нет ответа.
const pings = { Амстердам: 412, Франкфурт: 468, Хельсинки: 655, Стамбул: 590, Токио: 1240, 'Нью-Йорк': 870, Стокгольм: 436, Лондон: 512, Варшава: 0 };
const GB = 2 ** 30;

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

// prepareExtension — копия расширения в work/extension с подделкой компаньона; extra(ext) — свои
// файлы в копию (например, сцена для магазина). Вернёт путь к копии.
export async function prepareExtension(work, extra = null) {
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
    sub: { ...subParse, title: 'Мой VPN', updateIntervalHours: 12, format: '',
      info: { upload: Math.round(2.1 * GB), download: Math.round(21.3 * GB), total: 200 * GB, expire: Math.floor(Date.UTC(2027, 0, 31) / 1000) },
      announce: 'Плановые работы в ночь на воскресенье, 03:00–04:00 (МСК).' },
    pings,
  };
  const ext = join(work, 'extension');
  cpSync(join(root, 'extension'), ext, { recursive: true });
  writeFileSync(join(ext, 'lib', 'native.js'), mockNative(fix));
  extra?.(ext);
  return ext;
}

// seed — данные в расширение через страницу ctl: свои серверы, подписка, правила, избранное,
// текущий сервер, пинг всех. Вернёт msg (команда фону) и idOf (id сервера по городу).
export async function seed(ctl) {
  const msg = async (m) => {
    const r = await ctl.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
    if (!r?.ok) throw new Error(`${m.type}: ${r?.error?.message}`);
    return r.result;
  };
  await msg({ type: 'addLinks', text: ownLinks.join('\n') });
  await msg({ type: 'addSubscription', url: subUrl });
  const { servers } = await ctl.eval(`chrome.storage.local.get('servers')`);
  const idOf = (city) => servers.find((s) => s.name.includes(city)).id;
  await msg({ type: 'addRules', domains: ['bank.example.net', 'рф'], action: 'direct' });
  await msg({ type: 'addRules', domains: ['video.example.com'], action: 'proxy' });
  await msg({ type: 'addRules', domains: ['news.example.org'], action: 'proxy', serverId: idOf('Франкфурт') });
  await msg({ type: 'setFavorite', id: idOf('Амстердам'), on: true });
  await msg({ type: 'setFavorite', id: idOf('Стокгольм'), on: true });
  await msg({ type: 'select', id: idOf('Амстердам') });
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
