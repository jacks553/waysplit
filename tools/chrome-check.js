// Проверка расширения в настоящем Chrome: node tools/chrome-check.js [папка-для-снимков]
//
// Тестовый «VPN-сервер» — sing-box с двумя VLESS-входами (серверы A и B) и сайт target.test.
// Имя target.test знает только этот сервер (DNS типа hosts), причём через A оно ведёт на сайт,
// отвечающий «A» (127.0.0.1), а через B — на сайт «B» (127.0.0.2). Так видно, открывается ли
// сайт через VPN вообще и через какой из серверов.
//
// Chrome запускается без окна во временном профиле (ваш профиль не трогается), расширение
// грузится через DevTools (Extensions.loadUnpacked; флаги --remote-debugging-pipe и
// --enable-unsafe-extension-debugging). --no-proxy-server: без расширения Chrome идёт напрямую,
// а не через системный прокси Windows (например, от v2rayN); прокси расширения важнее флагов.
//
// Напрямую (без VPN) Chrome приходит на третий сайт «DIRECT» (127.0.0.3): так ему велит флаг
// --host-resolver-rules для *.test и free.example. Ответ сайта сразу показывает маршрут.
//
// Окно расширения (SPEC-POPUP.md) — вкладки «Главная · Серверы · Правила · Настройки», вложенные
// экраны и меню «⋯»; страница настроек — то же окно на всю вкладку (popup.html?full).
// Шаги: окно открывается на «Главной», вкладки переключаются, замер скорости → подписка → включение
// (сайт «A») → смена сервера на экране выбора (сайт «B» за 1–2 с, ядро не перезапускается) → пинг
// всех → звёздочка «избранное», Esc и «назад» → страница настроек и «Развернуть» → переименование,
// порядок («Ниже» в меню «⋯»), «самый быстрый» → «Этот сайт»: переключатель, сервер для сайта
// (кнопка с флагом), «Убрать правило» → правила: зона test через сервер B (побеждает самое
// конкретное), кириллический домен, набор доменов, правила при выключенном VPN (меню «⋯», жёлтая
// строка «Включить», галочка в настройках), отключение правила в «⋯», импорт → защита WebRTC,
// другое прокси-расширение, недоступный
// сервер («Не открывать сайт» / «Открыть напрямую»), подписка, диагностика, резервная копия →
// удаление текущего сервера → выключение (сайт напрямую,
// а в конце — сервер XHTTP через второе ядро Xray: запуск только когда нужен, sing-box не трогается;
// ядро остановлено) → пинг при выключенном VPN (ядро на время проверки) → остановка фона
// Под конец — «домены сайта» (второй запуск Chrome с копией расширения, где разрешение видеть
// запросы вкладок обязательное): автосбор, новый PAC не обрывает долгую загрузку в другой вкладке,
// подсказка «обновите вкладку», экран «Домены сайта», набор, настройка. И третий запуск — вкладка
// инкогнито: автосбор из неё ничего не привязывает.
// расширения (всё поднимается само) → закрытие Chrome (ядро завершается). Настоящий перезапуск Chrome так не проверить: расширение,
// загруженное через DevTools, после перезапуска не сохраняется.
// Компаньон должен быть собран и зарегистрирован (install); порты 27101–27102 — свободны.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const singbox = join(root, 'host', 'bin', 'sing-box.exe');
const xrayBin = join(root, 'host', 'bin', 'xray.exe');
const shotsDir = process.argv[2];
const expectedId = readFileSync(join(root, 'host', 'extid.go'), 'utf8').match(/extensionID = "([a-p]{32})"/)?.[1];
// Какую папку расширения проверять: по умолчанию extension/ из проекта; WAYSPLIT_EXTENSION — другую,
// например распакованный Waysplit-extension.zip из выпуска (так его проверяет tools/ci.ps1: именно
// то, что люди ставят вручную через «Загрузить распакованное расширение»).
const extDir = resolve(process.env.WAYSPLIT_EXTENSION || join(root, 'extension'));
const hostVersion = readFileSync(join(root, 'host', 'main.go'), 'utf8').match(/const version = "([^"]+)"/)?.[1] || '?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLUSH_WAIT = 6500; // дольше, чем автосбор «доменов сайта» ждёт перед записью (до 5 с)
const work = mkdtempSync(join(tmpdir(), 'waysplit-check-'));
const profile = join(work, 'profile');
const cleanup = [];
const skipped = []; // что не удалось проверить в этой версии Chrome (не ошибка расширения)
let failed = false;

function check(ok, text) {
  console.log(`${ok ? 'OK ' : 'ОШИБКА'}  ${text}`);
  if (!ok) failed = true;
  return ok;
}

// --- тестовые сайты и «VPN-сервер» ---
// Имена, к которым обращается страница /page (кроме своего): обычный «чужой» домен сайта, общий
// хостинг и общий сервис — для проверки автосбора «доменов сайта».
const PAGE_HOSTS = { cdn: 'img.media-cdn.test', cf: 'd1.cloudfront.net', ga: 'www.google-analytics.com' };
const RU_SITE = 'gorod-primer.ru'; // вымышленный российский сайт — для «Российские сайты — без VPN»
const SLOW_CHUNKS = 48; // /slow — «большой файл»: кусок 64 КБ каждые 250 мс, всего 12 с
const SLOW_CHUNK = 64 * 1024;

// Сайт отвечает своей буквой — по ней видно маршрут. /page — страница, которая тянет данные
// с других доменов (PAGE_HOSTS) и показывает, какой сайт ответил; /slow — долгая загрузка.
async function startSite(host, port, letter) {
  const site = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/page')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8"><title>Страница</title><p id="me">Waysplit-OK ${letter}</p>
        ${Object.keys(PAGE_HOSTS).map((k) => `<p id="${k}"></p>`).join('')}
        <script>for (const [id, host] of Object.entries(${JSON.stringify(PAGE_HOSTS)})) {
          fetch('http://' + host + ':' + location.port + '/').then((r) => r.text(), () => 'ошибка').then((t) => { document.getElementById(id).textContent = t; });
        }</script>`);
    }
    if (req.url.startsWith('/slow')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(SLOW_CHUNKS * SLOW_CHUNK));
      let sent = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(SLOW_CHUNK, letter[0]));
        if (++sent === SLOW_CHUNKS) {
          clearInterval(timer);
          res.end();
        }
      }, 250);
      res.on('close', () => clearInterval(timer));
      return undefined;
    }
    return res.end(`Waysplit-OK ${letter}`);
  });
  await new Promise((r, j) => site.once('error', j).listen(port, host, r));
  cleanup.push(() => site.close());
  return site.address().port;
}

// startSubServer — тестовая подписка: base64 со ссылками и заголовки, как у панелей
// (название, трафик и срок, интервал обновления). На чужой User-Agent — веб-страница.
async function startSubServer(links) {
  const srv = http.createServer((req, res) => {
    if (req.headers['user-agent'] !== 'v2rayN/7.0') return res.end('<html>Панель</html>');
    res.setHeader('Profile-Title', `base64:${Buffer.from('Тестовая подписка').toString('base64')}`);
    res.setHeader('Subscription-Userinfo', `upload=1073741824; download=2147483648; total=107374182400; expire=${Math.floor(Date.now() / 1000) + 30 * 86400}`);
    res.setHeader('Profile-Update-Interval', '6');
    res.end(Buffer.from(links.join(String.fromCharCode(10))).toString('base64'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}/api/sub/SECRET-TOKEN`;
}

// startHwidSubServer — подписка с привязкой к устройству (SPEC-SUBS, шаг 2), как у Remnawave:
// без x-hwid — заглушка «App not supported», с x-hwid — серверы и сообщение провайдера.
// seen — по запросам: «без» или «ОС/модель» устройства. Сервер локальный: идентификатор
// никуда, кроме 127.0.0.1, не уходит.
async function startHwidSubServer(links) {
  const seen = [];
  const b64 = (s) => Buffer.from(s).toString('base64');
  const srv = http.createServer((req, res) => {
    const hwid = req.headers['x-hwid'];
    seen.push(hwid ? `${req.headers['x-device-os']}/${req.headers['x-device-model']}` : 'без');
    res.setHeader('X-Hwid-Active', 'true');
    res.setHeader('Profile-Title', `base64:${b64('Тест HWID')}`);
    res.setHeader('Announce', `base64:${b64('#00ff00Тест: пишите в поддержку')}`);
    if (!hwid) {
      res.setHeader('X-Hwid-Not-Supported', 'true');
      return res.end(b64('vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?type=tcp#App%20not%20supported'));
    }
    res.end(b64(links.join(String.fromCharCode(10))));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/api/sub/HWID-TOKEN`, seen };
}

// startBodyServer — подписка, которая отдаёт готовое тело (Xray JSON и т. п., SPEC-SUBS п. 1).
async function startBodyServer(body, type) {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', type);
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}/api/sub/JSON-TOKEN/json`;
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startVpnServer(uuid) {
  const pa = await freePort();
  const pb = await freePort();
  const names = ['target.test', 'other.test', 'page.test', 'files.test', RU_SITE, ...Object.values(PAGE_HOSTS)];
  const hosts = (tag, ip) => ({ type: 'hosts', tag, predefined: Object.fromEntries(names.map((n) => [n, ip])) });
  const cfg = {
    log: { level: 'info', timestamp: false },
    dns: { servers: [hosts('hostsA', '127.0.0.1'), hosts('hostsB', '127.0.0.2'), { type: 'local', tag: 'local' }] },
    inbounds: [
      { type: 'vless', tag: 'inA', listen: '127.0.0.1', listen_port: pa, users: [{ uuid }] },
      { type: 'vless', tag: 'inB', listen: '127.0.0.1', listen_port: pb, users: [{ uuid }] },
    ],
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'direct', tag: 'siteA', domain_resolver: 'hostsA' },
      { type: 'direct', tag: 'siteB', domain_resolver: 'hostsB' },
    ],
    route: {
      default_domain_resolver: 'local', // остальные имена (www.gstatic.com для пинга) — обычным DNS
      rules: [
        { inbound: ['inA'], domain: names, outbound: 'siteA' },
        { inbound: ['inB'], domain: names, outbound: 'siteB' },
      ],
    },
  };
  const file = join(work, 'server.json');
  writeFileSync(file, JSON.stringify(cfg));
  const proc = spawn(singbox, ['run', '--disable-color', '-c', file, '-D', work], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  cleanup.push(() => proc.kill());
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes('sing-box started'); i++) await sleep(50);
  if (!log.includes('sing-box started')) throw new Error(`тестовый сервер не запустился:\n${log}`);
  return { pa, pb };
}

// startXrayServer — тестовый сервер VLESS + XHTTP на Xray (этап 8): target.test и other.test
// через него ведут на сайт «X» (127.0.0.4). Xray 26 по умолчанию не выпускает сервер к локальным
// адресам — для теста разрешаем (finalRules).
async function startXrayServer(uuid) {
  const port = await freePort();
  const cfg = {
    log: { loglevel: 'warning' },
    dns: { hosts: { 'target.test': '127.0.0.4', 'other.test': '127.0.0.4' } },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'vless', settings: { clients: [{ id: uuid }], decryption: 'none' },
      streamSettings: { network: 'xhttp', security: 'none', xhttpSettings: { path: '/xh' } } }],
    outbounds: [{ protocol: 'freedom', settings: { targetStrategy: 'UseIP', finalRules: [{ action: 'allow', ip: ['127.0.0.0/8'] }] } }],
  };
  const file = join(work, 'xray-server.json');
  writeFileSync(file, JSON.stringify(cfg));
  const proc = spawn(xrayBin, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  cleanup.push(() => proc.kill());
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes(' started'); i++) await sleep(50);
  if (!log.includes(' started')) throw new Error(`тестовый сервер Xray не запустился:\n${log}`);
  return port;
}

async function portOpen(port) {
  return new Promise((r) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); r(true); });
    s.once('error', () => r(false));
  });
}

async function waitPort(port, open, ms) {
  for (let t = 0; t < ms; t += 250) {
    if ((await portOpen(port)) === open) return true;
    await sleep(250);
  }
  return false;
}

// --- Chrome и DevTools по трубе (JSON-сообщения через нулевой байт) ---
// screen — размер экрана: у Chrome без окна он по умолчанию 800×600, а на невысоком экране окно
// расширения ниже (popup.css: 580 вместо 600) — проверяем обычный случай, экран 1920×1080.
// lang — язык интерфейса Chrome: от него зависит язык окна при настройке «как в Chrome» (версия
// 1.2.0). Основная проверка идёт по-русски на любом компьютере: на машине сборки GitHub Chrome английский.
function startChrome(profileDir = profile, moreHosts = [], screen = '1920x1080', lang = 'ru') {
  const proc = spawn(chromePath, [
    '--headless=new', `--lang=${lang}`, `--screen-info={${screen}}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-proxy-server',
    `--host-resolver-rules=${['*.test', 'free.example', RU_SITE, ...moreHosts].map((h) => `MAP ${h} 127.0.0.3`).join(', ')}`,
    // Окна расширения в проверке — фоновые вкладки: без этих флагов Chrome замедляет в них таймеры
    // вплоть до раза в минуту, и ожидания по 100 мс растягиваются на десятки минут.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
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
  // page(адрес, browserContextId) — новая вкладка; с browserContextId — в окне инкогнито
  // (Target.createBrowserContext).
  const page = async (url, browserContextId) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', ...(browserContextId ? { browserContextId } : {}) });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const p = {
      targetId,
      eval: async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`в странице: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      },
      // goto — открыть адрес; вернёт текст ошибки сети ('' — открылось).
      goto: async (to) => {
        const r = await send('Page.navigate', { url: to }, sessionId);
        for (let i = 0; i < 100; i++) {
          if ((await p.eval('document.readyState')) === 'complete') break;
          await sleep(100);
        }
        return r.errorText || '';
      },
      // text — открыть адрес и вернуть текст страницы ('' — не открылась).
      text: async (to) => ((await p.goto(to)) ? '' : p.eval('document.body.innerText')),
      shot: async (file, scheme) => {
        await send('Target.activateTarget', { targetId }); // фоновая вкладка не доигрывает плавные переходы
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
        await sleep(400);
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(file, Buffer.from(data, 'base64'));
      },
      // size(ширина, высота, [ширина экрана, высота экрана]) — размер окна; экран — если нужен не 1920×1080.
      size: (width, height, screen) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false,
        ...(screen ? { screenWidth: screen[0], screenHeight: screen[1] } : {}) }, sessionId),
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
      // focused — считать страницу активной (иначе у фоновой вкладки :focus и :focus-visible не срабатывают).
      focused: () => send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId),
      // scheme — тема системы для этой страницы: 'light' или 'dark'.
      scheme: (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }, sessionId),
      // inject — свой код до скриптов страницы (при следующей загрузке).
      inject: async (source) => {
        await send('Page.enable', {}, sessionId); // без этого скрипт не подставляется
        await send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
      },
    };
    if (url) await p.goto(url);
    return p;
  };
  const close = async () => {
    proc.kill();
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
  };
  return { send, page, close };
}

// Код, который выполняется в окне расширения (popup.html; с ?full — оно же на всю вкладку,
// SPEC-POPUP.md): вкладки внизу, вложенные экраны, меню «⋯», сообщения внизу окна (#toast).
const wait = `const wait = async (f, ms = 20000) => { for (let t = 0; t < ms && !f(); t += 100) await new Promise((r) => setTimeout(r, 100)); return f(); };
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // plain — имя сервера без флага: в окне флага-эмодзи нет нигде, в подсказках вместо него код страны.
  const plain = (s) => String(s).replace(/\\p{Regional_Indicator}{2}\\s*/gu, '');
  const tab = (name) => document.querySelector('.tabbar .tab[data-tab="' + name + '"]').click();
  const toastText = () => ($('toast').hidden ? '' : ($('toast').querySelector('.toast-text') || $('toast')).textContent);
  const clearToast = () => { $('toast').hidden = true; $('toast').textContent = ''; };
  const menuItem = async (anchor, label) => {
    anchor.click();
    await wait(() => $('pop').matches(':popover-open'), 3000);
    const b = [...document.querySelectorAll('#pop .pop-item')].find((x) => x.textContent.trim() === label);
    if (!b) { $('pop').hidePopover(); return false; }
    b.click();
    return true;
  };
  const srvRow = (name) => [...document.querySelectorAll('#srvGroups li.srv')].find((x) => x.querySelector('.srv-name')?.title.includes(plain(name)));
  const ruleLi = (shown) => [...document.querySelectorAll('#rulesList li.rule')].find((x) => x.querySelector('.rule-domain').textContent === shown);
  const siteView = () => ({ hidden: $('site').hidden, vpn: $('siteVpn').getAttribute('aria-pressed') === 'true', text: document.querySelector('#siteControls .seg[aria-pressed="true"]')?.textContent || '',
    why: $('siteWhy').textContent, server: $('siteServer').title, dim: $('siteServer').classList.contains('dim'),
    warn: $('siteWarn').hidden ? '' : $('siteWarnText').textContent, fix: $('siteWarnFix').textContent, remove: !$('ruleRemove').hidden, reload: !$('reload').hidden,
    code: $('siteFlag').textContent });`;
const js = {
  // add — ссылки или подписка: «Серверы» → «+ Добавить» → экран добавления.
  add: (text) => `(async () => { ${wait}
    tab('servers');
    $('srvAdd').click();
    await wait(() => $('addLinks'));
    $('addLinks').value = ${JSON.stringify(text)};
    $('addLinks').form.requestSubmit();
    await wait(() => /^(Добавлено|Подписка)/.test($('addResult').textContent) || $('addResult').dataset.kind === 'error');
    const out = $('addResult').textContent;
    tab('home');
    return out; })()`,
  power: (states) => `(async () => { ${wait}
    tab('home');
    $('power').click();
    await sleep(300);
    await wait(() => ${JSON.stringify(states)}.includes($('status').dataset.state));
    await sleep(1500); // успеть показать пинг
    return { state: $('status').dataset.state, status: $('status').textContent, detail: $('detail').textContent,
      problem: $('problem').hidden ? '' : $('problemText').textContent }; })()`,
  status: `chrome.storage.session.get('status').then((x) => x.status)`,
  local: `chrome.storage.local.get(null)`,
  proxy: `chrome.proxy.settings.get({}).then((s) => ({ level: s.levelOfControl, mode: s.value.mode }))`,
  // pick — «Главная» → строка «Сервер» → экран выбора: поиск по имени, нажатие на строку.
  pick: (name) => `(async () => { ${wait}
    tab('home');
    await wait(() => !$('serverRow').hidden);
    $('serverRow').click();
    await wait(() => document.querySelector('.screen.picker'));
    const search = document.querySelector('.screen.picker .pick-search input');
    search.value = ${JSON.stringify(name)};
    search.dispatchEvent(new Event('input'));
    const li = [...document.querySelectorAll('.screen.picker li[data-id]')].find((x) => x.querySelector('.srv-name').title.includes(plain(${JSON.stringify(name)})));
    if (!li) return 'нет в списке';
    li.click();
    await wait(() => !document.querySelector('.screen.picker'), 5000);
    return document.querySelector('.screen.picker') ? 'экран не закрылся' : 'выбран'; })()`,
  // favorite — звёздочка у сервера на экране выбора; что видно после и как закрывается экран (Esc).
  favorite: (name) => `(async () => { ${wait}
    tab('home');
    $('serverRow').click();
    await wait(() => document.querySelector('.screen.picker'));
    const li = [...document.querySelectorAll('.screen.picker li[data-id]')].find((x) => x.querySelector('.srv-name').title.includes(plain(${JSON.stringify(name)})));
    li.querySelector('[data-action="star"]').click();
    await wait(() => document.querySelector('.screen.picker .group-title')?.textContent === 'Избранное', 5000);
    const groups = [...document.querySelectorAll('.screen.picker .group-title')].map((h) => h.textContent);
    const first = document.querySelector('.screen.picker li[data-id]');
    const out = { groups, first: first.querySelector('.srv-name').title, star: first.querySelector('[data-action="star"]').getAttribute('aria-pressed'),
      bars: first.querySelector('.bars').dataset.n, barsTitle: first.querySelector('.bars').title,
      stored: (await chrome.storage.local.get('favorites')).favorites || [] };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(() => !document.querySelector('.screen'), 3000);
    out.escClosed = !document.querySelector('.screen');
    $('serverRow').click();
    await wait(() => document.querySelector('.screen.picker'));
    document.querySelector('.screen .back-key').click();
    await wait(() => !document.querySelector('.screen'), 3000);
    out.backClosed = !document.querySelector('.screen');
    return out; })()`,
  pickerGroups: `(async () => { ${wait}
    tab('home');
    $('serverRow').click();
    await wait(() => document.querySelector('.screen.picker .group-title'));
    const out = { groups: [...document.querySelectorAll('.screen.picker .group-title')].map((h) => h.textContent),
      first: document.querySelector('.screen.picker li[data-id] .srv-name').title };
    tab('home');
    return out; })()`,
  pingAll: `(async () => { ${wait}
    tab('servers');
    clearToast();
    $('pingAll').click();
    await wait(() => /^Ответили/.test(toastText()) || $('toast').dataset.kind === 'error', 40000);
    return toastText(); })()`,
  // serverAction — «Серверы»: меню «⋯» у сервера с таким именем, пункт label (на «Удалить?» — да).
  serverAction: (name, label) => `(async () => { ${wait}
    tab('servers');
    await wait(() => srvRow(${JSON.stringify(name)}));
    const li = srvRow(${JSON.stringify(name)});
    if (!li) return 'нет строки';
    clearToast();
    if (!(await menuItem(li.querySelector('[data-action="more"]'), ${JSON.stringify(label)}))) return 'нет пункта';
    if ($('dlg').open) $('dlgOk').click();
    return 'нажато'; })()`,
  renameTo: (name) => `(async () => { ${wait}
    await wait(() => document.querySelector('#srvGroups .rename'));
    const input = document.querySelector('#srvGroups .rename');
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(() => /сохранено/.test(toastText()));
    return toastText(); })()`,
  moveFirstDown: `(async () => { ${wait}
    tab('servers');
    await wait(() => document.querySelector('#srvGroups li.srv'));
    await menuItem(document.querySelector('#srvGroups li.srv [data-action="more"]'), 'Ниже');
    await sleep(500);
    return 'ok'; })()`,
  clickToast: (id, untilRe) => `(async () => { ${wait}
    clearToast();
    $(${JSON.stringify(id)}).click();
    await wait(() => ${untilRe}.test(toastText()), 40000);
    return toastText(); })()`,
  // Блок «Этот сайт» на «Главной»: что показано; переключатель, сервер для сайта, «Убрать правило».
  site: `(async () => { ${wait}
    tab('home');
    await wait(() => !$('site').hidden && $('siteWhy').textContent, 5000);
    return siteView(); })()`,
  siteClick: (id) => `(async () => { ${wait}
    tab('home');
    const before = JSON.stringify(siteView());
    (${JSON.stringify(id)} === 'siteSwitch' ? document.querySelector('#siteControls .seg[aria-pressed="false"]') : $(${JSON.stringify(id)})).click();
    await wait(() => JSON.stringify(siteView()) !== before, 5000);
    await sleep(200);
    return siteView(); })()`,
  // sitePick — кнопка с флагом → экран «Сервер для …»: сервер по имени или 'same' / 'direct'.
  sitePick: (name) => `(async () => { ${wait}
    tab('home');
    $('siteServer').click();
    await wait(() => document.querySelector('.screen.picker'));
    const items = [...document.querySelectorAll('.screen.picker li')];
    const li = items.find((x) => x.dataset.key === ${JSON.stringify(name)}) || items.find((x) => x.querySelector('.srv-name')?.title.includes(plain(${JSON.stringify(name)})));
    if (!li) return { error: 'нет в списке' };
    const specials = items.filter((x) => x.dataset.key).map((x) => x.querySelector('.srv-name').textContent);
    li.click();
    await wait(() => !document.querySelector('.screen.picker'), 5000);
    await sleep(300);
    return { specials, ...siteView() }; })()`,
  tab: (name) => `(async () => { document.querySelector('.tabbar .tab[data-tab="${name}"]').click(); return 'ok'; })()`,
  // Вкладка «Правила».
  addRule: (text, action) => `(async () => { ${wait}
    tab('rules');
    clearToast();
    $('ruleInput').value = ${JSON.stringify(text)};
    $('ruleInput').dispatchEvent(new Event('input'));
    await wait(() => [...$('ruleAction').options].some((o) => o.value === ${JSON.stringify(action)}));
    $('ruleAction').value = ${JSON.stringify(action)};
    $('ruleForm').requestSubmit();
    await wait(() => /^Добавлено|^Не/.test(toastText()));
    return toastText(); })()`,
  addSet: (setId, action) => `(async () => { ${wait}
    tab('rules');
    clearToast();
    await menuItem($('rulesMore'), 'Готовые наборы…');
    await wait(() => document.querySelector('.screen li[data-set="${setId}"]'));
    document.querySelector('.screen li[data-set="${setId}"] [data-act="${action}"]').click();
    await wait(() => /^Набор/.test(toastText()));
    const out = toastText();
    tab('rules');
    return out; })()`,
  ruleRow: (shown) => `(async () => { ${wait}
    tab('rules');
    await wait(() => ruleLi(${JSON.stringify(shown)}));
    const li = ruleLi(${JSON.stringify(shown)});
    return li ? { sub: li.querySelector('.rule-sub')?.textContent || '', target: li.querySelector('.rule-target').textContent,
      on: !li.classList.contains('off'), favicon: !!li.querySelector('.favicon') } : null; })()`,
  ruleMenu: (shown, label) => `(async () => { ${wait}
    tab('rules');
    const li = ruleLi(${JSON.stringify(shown)});
    if (!li) return 'нет строки';
    const ok = await menuItem(li.querySelector('[data-action="more"]'), ${JSON.stringify(label)});
    await sleep(300);
    return ok ? 'ok' : 'нет пункта'; })()`,
  rulesWhenOffMenu: `(async () => { ${wait}
    tab('rules');
    await menuItem($('rulesMore'), 'Правила работают, когда VPN выключен');
    await sleep(300);
    return 'ok'; })()`,
  // Вкладка «Настройки».
  checkbox: (id) => `(async () => { document.querySelector('.tabbar .tab[data-tab="settings"]').click(); document.getElementById(${JSON.stringify(id)}).click();
    await new Promise((r) => setTimeout(r, 300)); return document.getElementById(${JSON.stringify(id)}).checked; })()`,
  // Этап 6.
  webrtc: `chrome.privacy.network.webRTCIPHandlingPolicy.get({}).then((s) => ({ value: s.value, level: s.levelOfControl }))`,
  title: `chrome.action.getTitle({})`,
  pac: `chrome.proxy.settings.get({}).then((s) => s.value.pacScript?.data || '')`,
  setRadio: (name, value) => `(async () => { document.querySelector('.tabbar .tab[data-tab="settings"]').click();
    document.querySelector('input[name="${name}"][value="${value}"]').click(); await new Promise((r) => setTimeout(r, 800)); return 'ok'; })()`,
  setSelect: (id, value) => `(async () => { document.querySelector('.tabbar .tab[data-tab="settings"]').click();
    const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 800)); return 'ok'; })()`,
  // Подписка: экран «сведения о подписке» → «Проверить подписку» (SPEC-SUBS, шаг 1), без идентификатора устройства.
  subCheck: `(async () => { ${wait}
    tab('servers');
    await wait(() => document.querySelector('#srvGroups .sub-open'));
    document.querySelector('#srvGroups .sub-open').click();
    await wait(() => $('subCheckRun'));
    $('subCheckRun').click();
    await sleep(200);
    await wait(() => !$('subCheckReport').hidden || $('subCheckState').dataset.kind === 'error', 90000);
    const out = { state: $('subCheckState').textContent, report: $('subCheckReport').textContent,
      runClass: $('subCheckRun').className, filled: [...document.querySelectorAll('.screen .btn')].map((b) => b.textContent.trim()).join(', ') };
    tab('servers');
    return out; })()`,
  subUpdate: `(async () => { ${wait}
    tab('servers');
    clearToast();
    await menuItem(document.querySelector('#srvGroups .sub-head [data-action="subMore"]'), 'Обновить');
    await sleep(200);
    await wait(() => toastText() && !/^Обновляю/.test(toastText()), 30000);
    return toastText(); })()`,
  // subInfo — строка подписки на вкладке «Серверы» и её экран сведений.
  subInfo: (name) => `(async () => { ${wait}
    tab('servers');
    const block = () => [...document.querySelectorAll('#srvGroups .sub-block')].find((b) => b.querySelector('.sub-name').textContent.includes(${JSON.stringify(name)}));
    await wait(() => block() && (${JSON.stringify(name)} !== 'Тест HWID' || block().querySelector('.sub-note')));
    if (!block()) return { head: '', facts: '' };
    const head = block().innerText;
    block().querySelector('.sub-open').click();
    await wait(() => $('subFacts')?.textContent);
    const facts = $('subFacts').innerText;
    tab('servers');
    return { head, facts }; })()`,
  diag: `(async () => { ${wait}
    tab('settings');
    $('openDiag').click();
    await wait(() => $('diagFacts'));
    await wait(() => /Компаньон/.test($('diagFacts').textContent) && !/проверяю/.test($('diagFacts').textContent) && !$('diagRefresh').disabled, 20000);
    return { facts: $('diagFacts').innerText, hostLog: $('diag-host').textContent, events: $('diag-events').textContent }; })()`,
  myIp: `(async () => { ${wait}
    $('myIp').click();
    await new Promise((r) => setTimeout(r, 200));
    await wait(() => !$('myIp').disabled, 30000);
    return $('myIpResult').textContent; })()`,
  message: (msg) => `chrome.runtime.sendMessage(${JSON.stringify(msg)})`,
  // «Домены сайта»: карточка разрешения (на «Главной» и на «Правилах») и её кнопка «Не сейчас».
  permCard: `(async () => { ${wait}
    tab('home');
    await sleep(300);
    const home = !$('permHome').hidden;
    const text = $('permHome').innerText;
    // Окно 400×600: под карточкой должен быть виден хотя бы заголовок блока «Этот сайт».
    $('content').scrollTop = 0;
    const box = (node) => node.getBoundingClientRect();
    const fit = { card: Math.round(box($('permHome')).height), siteShown: !$('site').hidden,
      label: Math.round(box($('site').querySelector('.site-label')).bottom), view: Math.round(box($('content')).bottom), win: innerWidth + '×' + innerHeight };
    tab('rules');
    await sleep(100);
    const rules = !$('permRules').hidden;
    tab('home');
    return { home, rules, text, fit }; })()`,
  permLater: `(async () => { ${wait}
    tab('home');
    clearToast();
    $('permHome').querySelector('[data-act="later"]').click();
    await wait(() => $('permHome').hidden && toastText(), 5000);
    const out = { hidden: $('permHome').hidden, toast: toastText(), asked: (await chrome.storage.local.get('settings')).settings?.siteDomainsAsked,
      action: $('toast').querySelector('.toast-action')?.textContent || '', sticky: $('toast').dataset.sticky };
    // Не «включить можно в „Настройках“» словами, а кнопка, которая туда переводит.
    $('toast').querySelector('.toast-action')?.click();
    await sleep(300);
    out.tab = document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab;
    out.focus = document.activeElement?.id || '';
    out.toastGone = $('toast').hidden;
    return out; })()`,
  // ruSwitch — «Российские сайты — без VPN» на «Главной»: что показано; click — нажать и дождаться.
  ruSwitch: (click) => `(async () => { ${wait}
    tab('home');
    await wait(() => !$('ruSwitch').hidden, 5000);
    const b = $('ruSwitch');
    const before = b.getAttribute('aria-checked');
    if (${click ? 'true' : 'false'}) {
      clearToast();
      b.click();
      await wait(() => b.getAttribute('aria-checked') !== before, 5000);
    }
    $('content').scrollTop = 0;
    const box = (node) => node.getBoundingClientRect();
    return { shown: !b.hidden, on: b.getAttribute('aria-checked') === 'true', title: b.querySelector('.ru-title').textContent, sub: b.title,
      toast: toastText(), setting: (await chrome.storage.local.get('settings')).settings?.ruDirect === true,
      bottom: Math.round(box(b).bottom), label: Math.round(box($('site').querySelector('.site-label')).bottom), view: Math.round(box($('content')).bottom) }; })()`,
  // siteNew — подсказка «Найдены новые домены сайта» на «Главной».
  siteNew: `(async () => { ${wait}
    tab('home');
    await wait(() => !$('site').hidden && !$('siteNew').hidden, 5000);
    return { shown: !$('siteNew').hidden, text: $('siteNewText').textContent, domains: $('siteNew').title, why: $('siteWhy').textContent }; })()`,
  // siteDomains — экран «Домены сайта» у правила (меню «⋯»): что в списке; remove — убрать домен.
  siteDomains: (shown, remove) => `(async () => { ${wait}
    tab('rules');
    await wait(() => ruleLi(${JSON.stringify(shown)}));
    ruleLi(${JSON.stringify(shown)}).querySelector('[data-action="more"]').click();
    await wait(() => $('pop').matches(':popover-open'), 3000);
    const item = [...document.querySelectorAll('#pop .pop-item')].find((x) => x.textContent.trim().startsWith('Домены сайта'));
    if (!item) { $('pop').hidePopover(); return { error: 'нет пункта' }; }
    const label = item.textContent.trim();
    item.click();
    await wait(() => document.querySelector('.screen.sd-screen'), 3000);
    const names = () => [...document.querySelectorAll('.sd-screen .sd-name')].map((x) => x.textContent);
    const out = { label, title: document.querySelector('.sd-screen .screen-title').textContent, sub: document.querySelector('.sd-screen .screen-sub').textContent,
      before: names(), how: document.querySelector('.sd-screen .hint').textContent, auto: document.querySelector('.sd-screen .sd-auto').textContent };
    const drop = ${JSON.stringify(remove || '')};
    if (drop) {
      clearToast();
      document.querySelector('.sd-screen button[data-domain="' + drop + '"]').click();
      await wait(() => !names().includes(drop), 5000);
      out.after = names();
      out.removed = document.querySelector('.sd-screen .sd-removed').textContent;
      out.toast = toastText();
      out.sticky = $('toast').dataset.sticky;
      out.restoreH = Math.round(document.querySelector('.sd-screen .sd-removed-row .link').getBoundingClientRect().height);
    }
    return out; })()`,
};

// readUntil — открывать адрес, пока ответ не станет нужным (или не выйдет время); вернёт [текст, мс].
async function readUntil(tab, url, want, ms = 5000) {
  const t0 = Date.now();
  let text = '';
  while (Date.now() - t0 < ms) {
    text = await tab.text(url);
    if (text.includes(want)) break;
    await sleep(200);
  }
  return [text, Date.now() - t0];
}

try {
  const uuid = randomUUID();
  const sitePort = await startSite('127.0.0.1', 0, 'A');
  await startSite('127.0.0.2', sitePort, 'B');
  await startSite('127.0.0.3', sitePort, 'DIRECT'); // сюда Chrome приходит напрямую, без VPN
  await startSite('127.0.0.4', sitePort, 'X'); // сюда ведёт сервер XHTTP (Xray, этап 8)
  const { pa, pb } = await startVpnServer(uuid);
  const linkA = `vless://${uuid}@127.0.0.1:${pa}?type=tcp&security=none#%F0%9F%87%B3%F0%9F%87%B1%20Сервер%20A`;
  const linkB = `vless://${uuid}@127.0.0.1:${pb}?type=tcp&security=none#%F0%9F%87%A9%F0%9F%87%AA%20Сервер%20B`;
  const target = `http://target.test:${sitePort}/`;
  const otherUrl = `http://other.test:${sitePort}/`;
  const freeUrl = `http://free.example:${sitePort}/`;
  console.log(`Тестовые серверы: A 127.0.0.1:${pa}, B 127.0.0.1:${pb}; сайт ${target}`);
  check(!(await portOpen(27101)) && !(await portOpen(27102)), 'порты 27101 и 27102 свободны перед проверкой');

  const chrome = startChrome();
  console.log(`Расширение: ${extDir}`);
  const { id } = await chrome.send('Extensions.loadUnpacked', { path: extDir });
  check(id === expectedId, `ID расширения в Chrome ${id} совпадает с host/extid.go`);

  const popup = await chrome.page(`chrome-extension://${id}/popup/popup.html`);
  await popup.size(400, 600);
  // Окно открывается на «Главной», с данными — быстро; вкладки переключаются (SPEC-POPUP.md).
  const ui0 = await popup.eval(`(async () => { ${wait}
    await wait(() => performance.getEntriesByName('waysplit-ready').length, 5000);
    const ready = performance.getEntriesByName('waysplit-ready')[0]?.startTime ?? -1;
    const first = document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab;
    const seen = [];
    for (const t of ['servers', 'rules', 'settings', 'home']) {
      tab(t);
      seen.push([...document.querySelectorAll('.panel')].filter((p) => !p.hidden).map((p) => p.id).join('+'));
    }
    return { ready, first, seen: seen.join(', ') }; })()`);
  check(ui0.first === 'home' && ui0.seen === 'panel-servers, panel-rules, panel-settings, panel-home', `окно открылось на «Главной», вкладки переключаются (${ui0.seen})`);
  // У автора — 90–160 мс; порог с запасом на медленную машину сборки (GitHub Actions): на ней первое
  // открытие окна сразу после загрузки расширения занимало 1600–1900 мс (выпуск 1.1.0).
  check(ui0.ready > 0 && ui0.ready < 3000, `окно показано с данными за ${Math.round(ui0.ready)} мс от открытия`);
  // Язык (версия 1.2.0): у новой установки — «как в Chrome». Chrome здесь русский — окно по-русски.
  const lang0 = await popup.eval(`(async () => ({ setting: (await chrome.storage.local.get('settings')).settings?.language,
    ui: chrome.i18n.getUILanguage(), html: document.documentElement.lang, home: document.querySelector('.tabbar .tab[data-tab="home"]').textContent.trim() }))()`);
  check(lang0.setting === 'auto' && /^ru/.test(lang0.ui) && lang0.html === 'ru' && lang0.home === 'Главная',
    `новая установка: язык «как в Chrome» (${lang0.setting}), Chrome — ${lang0.ui}, окно по-русски (lang=${lang0.html}, «${lang0.home}»)`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-empty.png'), 'light');
  const welcome = (await chrome.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/welcome/welcome.html'));
  check(!!welcome, 'при установке открылась страница «Начало работы»');
  const subUrl = await startSubServer([linkA, linkB]);
  const added = await popup.eval(js.add(subUrl));
  check(/^Подписка «Тестовая подписка»: серверов 2, новых 2, пропущено 0/.test(added), `подписка из окна: «${added}»`);
  const local0 = await popup.eval(js.local);
  check(!JSON.stringify(local0.servers).includes('SECRET-TOKEN') && local0.subscriptions[0]?.intervalHours === 6 && local0.subscriptions[0]?.info?.total === 107374182400,
    'подписка: название, трафик и интервал из заголовков; адреса подписки у серверов нет');

  const tab = await chrome.page();
  let [text] = await readUntil(tab, target, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `VPN выключен: target.test идёт напрямую («${text}»)`);

  // --- этап 3: включение и выключение ---
  let st = await popup.eval(js.power(['on', 'warn', 'error']));
  check(st.state === 'on', `включение: [${st.state}] ${st.status} — ${st.detail || st.problem}`);
  const px = await popup.eval(js.proxy);
  check(px.level === 'controlled_by_this_extension' && px.mode === 'pac_script', `прокси Chrome: ${px.mode}, ${px.level}`);
  [text] = await readUntil(tab, target, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `VPN включён: target.test открылся через сервер A («${text}»)`);

  // --- этап 4: смена сервера без перезапуска ядра ---
  const pid1 = (await popup.eval(js.status)).pid;
  check((await popup.eval(js.pick('Сервер B'))) === 'выбран', 'в popup выбран сервер B из списка');
  let ms;
  [text, ms] = await readUntil(tab, target, 'Waysplit-OK B');
  check(text === 'Waysplit-OK B' && ms <= 2000, `сайт пошёл через сервер B за ${(ms / 1000).toFixed(1)} с`);
  const st2 = await popup.eval(js.status);
  check(st2.pid === pid1, `ядро не перезапускалось (PID ${pid1} → ${st2.pid})`);
  const pinged = await popup.eval(js.pingAll);
  check(/^Ответили 2 из 2/.test(pinged), `пинг всех в popup: «${pinged}»`);
  // Избранное: звёздочка — сервер в группе «Избранное» сверху; экран закрывается и Esc, и «назад».
  const fav = await popup.eval(js.favorite('Сервер B'));
  check(fav.groups[0] === 'Избранное' && fav.first.includes('Сервер B') && fav.star === 'true' && fav.stored.length === 1,
    `звёздочка: «${fav.first}» — в «Избранном» сверху (группы: ${fav.groups.join(', ')})`);
  const favMs = Number.parseInt(fav.barsTitle, 10); // полоски — по правилу pingBars (lib/format.js)
  const favBars = favMs < 600 ? 4 : favMs < 1000 ? 3 : favMs < 1600 ? 2 : 1;
  check(/^\d+ мс$/.test(fav.barsTitle) && fav.bars === String(favBars), `полоски задержки: ${fav.bars} из 4, подсказка «${fav.barsTitle}»`);
  check(fav.escClosed && fav.backClosed, 'экран выбора сервера закрывается и Esc, и стрелкой «назад»');
  if (shotsDir) {
    await popup.eval(`document.getElementById('serverRow').click()`);
    await sleep(500);
    await popup.shot(join(shotsDir, 'popup-list-light.png'), 'light');
    await popup.shot(join(shotsDir, 'popup-list-dark.png'), 'dark');
    await popup.eval(`document.querySelector('.screen .back-key').click()`);
  }

  // --- этап 4: страница настроек — то же окно на всю вкладку ---
  const redirect = await chrome.page(`chrome-extension://${id}/options/options.html`);
  await sleep(1500); // переход на popup.html?full#settings
  const where = await redirect.eval(`(async () => { ${wait}
    await wait(() => document.querySelector('.tabbar .tab[aria-selected="true"]'), 5000);
    return { url: location.href, tab: document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab,
      full: document.documentElement.classList.contains('full'), expand: !$('expandBtn').hidden }; })()`);
  check(/\/popup\/popup\.html\?full#settings$/.test(where.url) && where.tab === 'settings' && where.full && !where.expand,
    `страница настроек — то же окно на всю вкладку, открыто на «Настройках» (${where.url.replace(/^.*\//, '')})`);
  await chrome.send('Target.closeTarget', { targetId: redirect.targetId });
  // «Развернуть» в окне: то же окно на всю вкладку браузера, на той же вкладке окна.
  const small = await chrome.page(`chrome-extension://${id}/popup/popup.html`);
  await small.eval(`(async () => { ${wait} await wait(() => performance.getEntriesByName('waysplit-ready').length); tab('rules');
    setTimeout(() => $('expandBtn').click(), 50); return 'ok'; })()`);
  await sleep(1500);
  const expanded = (await chrome.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && /\/popup\/popup\.html\?full=?#rules$/.test(t.url));
  check(!!expanded, `«Развернуть» открыло то же окно на всю вкладку: ${expanded?.url.replace(/^.*\//, '') || 'нет вкладки'}`);
  if (expanded) await chrome.send('Target.closeTarget', { targetId: expanded.targetId });
  try { await chrome.send('Target.closeTarget', { targetId: small.targetId }); } catch { /* окно уже закрылось само */ }

  const opts = await chrome.page(`chrome-extension://${id}/popup/popup.html?full`);
  await opts.size(1000, 640);
  await opts.eval(js.serverAction('Сервер A', 'Переименовать'));
  const renamed = await opts.eval(js.renameTo('🇳🇱 Амстердам (тест)'));
  let local = await opts.eval(js.local);
  check(local.servers.some((s) => s.name === '🇳🇱 Амстердам (тест)'), `переименование: «${renamed}»`);
  const before = local.servers.map((s) => s.name);
  await opts.eval(js.moveFirstDown);
  local = await opts.eval(js.local);
  check(local.servers[0].name === before[1] && local.servers[1].name === before[0], `порядок стрелкой: ${local.servers.map((s) => s.name).join(', ')}`);
  check((await popup.eval(js.status)).pid === pid1, 'порядок списка ядро не перезапускает');
  if (shotsDir) {
    await opts.shot(join(shotsDir, 'options-light.png'), 'light');
    await opts.shot(join(shotsDir, 'options-dark.png'), 'dark');
  }
  const fast = await opts.eval(js.clickToast('fastest', '/^Выбран самый быстрый|не ответил/'));
  check(/^Выбран самый быстрый/.test(fast), `«самый быстрый»: «${fast}»`);

  // --- этап 5: правила сайтов ---
  local = await opts.eval(js.local);
  const srvA = local.servers.find((s) => s.name.includes('Амстердам'));
  const srvB = local.servers.find((s) => s.name.includes('Сервер B'));
  await popup.eval(js.message({ type: 'select', id: srvA.id }));
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `без правил other.test идёт через текущий сервер A («${text}»)`);

  // «Этот сайт» для вкладки target.test. Окно в проверке открыто вкладкой, а не кнопкой расширения,
  // поэтому адрес «активной вкладки» подставляем сами.
  await popup.inject(`chrome.tabs.query = async () => [{ id: -1, url: ${JSON.stringify(target)} }];`);
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  let site = await popup.eval(js.site);
  check(site.vpn && site.text === 'Через VPN' && /как у остальных/.test(site.why) && site.server.includes(srvA.name.replace(/\p{Regional_Indicator}{2}\s*/gu, '')) && !/\p{Regional_Indicator}/u.test(site.server),
    `«Этот сайт» до правила: «${site.text}» — ${site.why}`);
  let perm = await popup.eval(js.permCard);
  check(!perm.home && !perm.rules, 'правил «через VPN» ещё нет — карточки разрешения для «доменов сайта» нет');
  site = await popup.eval(js.siteClick('siteSwitch'));
  check(!site.vpn && site.text === 'Без VPN' && site.why === 'По правилу для target.test · без VPN' && site.remove && site.reload && site.code === '—',
    `кнопка «${site.text}» нажата: ${site.why}; «Убрать правило» и «Обновить вкладку» на месте; на кнопке сервера для сайта — прочерк («${site.code}»)`);
  const links = await popup.eval(`['ruleRemove', 'tdButton'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height))`);
  check(links.every((h) => h >= 24), `ссылки «Убрать правило» и «Домены этой вкладки»: высота области нажатия ${links.join(' и ')} пикс. (не меньше 24)`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-site.png'), 'light');
  [text] = await readUntil(tab, target, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `с правилом «без VPN» target.test идёт напрямую («${text}»)`);
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `остальные сайты по-прежнему через VPN: other.test («${text}»)`);
  // Кнопка с флагом: сервер для сайта — B; «Убрать правило» — снова как у остальных.
  site = await popup.eval(js.sitePick('Сервер B'));
  check(site.specials?.join(', ') === 'Как у остальных сайтов, Без VPN' && site.vpn && /через .*Сервер B/.test(site.why) && site.server.includes('Сервер B'),
    `кнопка с флагом: для сайта выбран сервер B — ${site.why}`);
  [text] = await readUntil(tab, target, 'Waysplit-OK B');
  check(text === 'Waysplit-OK B', `target.test идёт через выбранный для него сервер B, хотя текущий — A («${text}»)`);
  // «Домены сайта»: после первого правила «через VPN» — карточка с объяснением и вопросом о разрешении
  // (один раз). Само окно разрешения Chrome без окна не показать — нажимаем «Не сейчас».
  perm = await popup.eval(js.permCard);
  check(perm.home && perm.rules && /Chrome спросит разрешение один раз/.test(perm.text) && /Разрешить/.test(perm.text) && /Не сейчас/.test(perm.text),
    'первое правило «через VPN» — на «Главной» и на «Правилах» карточка: зачем разрешение, «Разрешить» и «Не сейчас»');
  // На «Главной» над блоком «Этот сайт» — сервер, «Российские сайты — без VPN» и эта карточка.
  // Запас 8 пикс.; строка под статусом во всех обычных состояниях — одна (и при «работают правила»).
  check(perm.fit.win === '400×600' && perm.fit.siteShown && perm.fit.label + 8 <= perm.fit.view,
    `окно ${perm.fit.win}, VPN включён: переключатель «Российские сайты — без VPN», карточка (${perm.fit.card} пикс.) и заголовок блока «Этот сайт» помещаются (низ заголовка ${perm.fit.label}, край видимой части ${perm.fit.view})`);
  // Тот же замер во втором состоянии «Главной»: VPN выключен, работают правила.
  await popup.eval(js.message({ type: 'toggle', enabled: false }));
  const fitOff = await popup.eval(`(async () => { ${wait}
    tab('home');
    await wait(() => $('status').dataset.state === 'rules', 10000);
    $('content').scrollTop = 0;
    const box = (node) => node.getBoundingClientRect();
    return { state: $('status').dataset.state, status: $('status').textContent, detail: $('detail').textContent, card: !$('permHome').hidden,
      label: Math.round(box($('site').querySelector('.site-label')).bottom), view: Math.round(box($('content')).bottom),
      led: $('powerZone').dataset.led + ' / ' + $('ledLabel').textContent, light: document.documentElement.dataset.light,
      power: Math.round(box($('power')).bottom) <= Math.round(box(document.querySelector('.tabbar')).top) }; })()`);
  check(fitOff.state === 'rules' && fitOff.card && fitOff.label + 8 <= fitOff.view && fitOff.status === 'VPN выключен' && /^работают правила: 1 сайт через VPN$/.test(fitOff.detail)
    && fitOff.led === 'rules / правила' && fitOff.light === 'off' && fitOff.power,
    `окно 400×600, «${fitOff.status}» («${fitOff.detail}»), лампочка «${fitOff.led}», подсветка ${fitOff.light}: строка «Российские сайты», запрос разрешения и заголовок «Этот сайт» видны на экране (низ заголовка ${fitOff.label}, край ${fitOff.view}), клавиша питания на месте`);
  await popup.eval(js.message({ type: 'toggle', enabled: true }));
  await popup.eval(`(async () => { ${wait} await wait(() => $('status').dataset.state === 'on', 15000); return 1; })()`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-site-perm.png'), 'light');
  const later = await popup.eval(js.permLater);
  check(later.hidden && later.asked === true && /Настройках/.test(later.toast), `«Не сейчас»: карточка убрана и больше не появится («${later.toast}»)`);
  check(later.action === 'Открыть настройки' && later.sticky === 'true' && later.tab === 'settings' && later.focus === 'autoSiteDomains' && later.toastGone,
    `в сообщении — кнопка «${later.action}»: переводит на «Настройки», к галочке «Автоматически добавлять домены сайта»`);
  // Без карточки разрешения блок «Этот сайт» виден в окне 400×600 целиком, вместе с нижней строкой
  // ссылок, во всех обычных состояниях «Главной». Окно открываем заново: после нажатий в нём остаётся
  // строка «Обновите вкладку», а нужен вид, с которым окно открывается.
  const homeFit = async (states) => {
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    return popup.eval(`(async () => { ${wait}
      await wait(() => performance.getEntriesByName('waysplit-ready').length && ${JSON.stringify(states)}.includes($('status').dataset.state) && !$('site').hidden, 15000);
      await sleep(500); // пинг текущего сервера дописывается в статус
      $('content').scrollTop = 0;
      const box = (node) => node.getBoundingClientRect();
      const links = [$('tdButton'), $('ruleRemove')].filter((x) => !x.hidden);
      return { state: $('status').dataset.state, status: $('status').textContent, why: $('siteWhy').textContent, card: !$('permHome').hidden, win: innerWidth + '×' + innerHeight,
        app: Math.round(box(document.querySelector('.app')).height),
        bottom: Math.round(box($('site')).bottom), view: Math.round(box($('content')).bottom), scroll: $('content').scrollHeight - $('content').clientHeight,
        links: links.map((x) => x.textContent), linksBottom: Math.max(...links.map((x) => Math.round(box(x).bottom))) }; })()`);
  };
  const fits = (f, height = 600) => f.win === `400×${height}` && f.app === height && !f.card && f.bottom <= f.view && f.linksBottom <= f.view;
  const fitText = (f) => `блок «Этот сайт» виден целиком (низ блока ${f.bottom}, ссылки «${f.links.join('», «')}» — до ${f.linksBottom}, край видимой части ${f.view}, прокрутка ${f.scroll})`;
  let fit = await homeFit(['on', 'warn']);
  check(fits(fit) && fit.why.startsWith('По правилу для target.test') && fit.links.length === 2,
    `окно ${fit.win}, VPN включён, у сайта правило («${fit.why}»): ${fitText(fit)}`);
  // Невысокий экран (1920×1080 при масштабе 150 % для Chrome — 1280×720): под значком расширения
  // места меньше 600, поэтому окно там 580 (popup.css) — и блок всё равно виден целиком.
  await popup.size(400, 580, [1280, 720]);
  fit = await homeFit(['on', 'warn']);
  check(fits(fit, 580) && fit.links.length === 2, `экран 1280×720: окно ${fit.win} (высота .app — ${fit.app}), VPN включён, у сайта правило: ${fitText(fit)}`);
  await popup.size(400, 600);
  await popup.eval(js.message({ type: 'toggle', enabled: false }));
  fit = await homeFit(['rules']);
  check(fits(fit) && fit.state === 'rules', `окно ${fit.win}, «${fit.status}»: ${fitText(fit)}`);
  await popup.eval(js.message({ type: 'toggle', enabled: true }));
  await popup.eval(`(async () => { ${wait} await wait(() => ['on', 'warn'].includes($('status').dataset.state), 15000); return 1; })()`);

  // Английский язык (версия 1.2.0). Выбор в «Настройках» меняет надписи сразу, без перезапуска: и на
  // странице, где выбрали, и в уже открытом окне расширения, и подсказку значка на панели. Потом —
  // те же замеры «Главной» в окне 400×600: английские надписи другой длины.
  const pickLanguage = (value) => `(async () => { ${wait}
    tab('settings');
    $('language').value = ${JSON.stringify(value)};
    $('language').dispatchEvent(new Event('change'));
    await wait(() => document.documentElement.lang === ${JSON.stringify(value === 'en' ? 'en' : 'ru')}, 5000);
    await sleep(300);
    return { html: document.documentElement.lang, settings: document.querySelector('.tabbar .tab[data-tab="settings"]').textContent.trim(),
      legends: [...document.querySelectorAll('#panel-settings legend')].map((x) => x.textContent).join(', '), value: $('language').value,
      options: [...$('language').options].map((o) => o.textContent).join(', '), tab: document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab }; })()`;
  const langOf = (code) => `(async () => { ${wait}
    await wait(() => document.documentElement.lang === ${JSON.stringify(code)}, 5000);
    return { html: document.documentElement.lang, home: document.querySelector('.tabbar .tab[data-tab="home"]').textContent.trim(), status: $('status').textContent }; })()`;
  const en1 = await opts.eval(pickLanguage('en'));
  check(en1.html === 'en' && en1.settings === 'Settings' && en1.value === 'en' && en1.tab === 'settings' && en1.options === 'same as Chrome, Русский, English',
    `язык English в «Настройках»: страница сразу по-английски (lang=${en1.html}, разделы: ${en1.legends}; варианты языка: ${en1.options})`);
  const en2 = await popup.eval(langOf('en'));
  check(en2.html === 'en' && en2.home === 'Home' && /^(VPN is on|No response)$/.test(en2.status),
    `открытое окно расширения тоже по-английски, без перезапуска: «${en2.home}», «${en2.status}»`);
  const enTitle = await popup.eval(js.title);
  check(enTitle === 'Waysplit — connected', `подсказка значка на панели по-английски: «${enTitle}»`);
  fit = await homeFit(['on', 'warn']);
  check(fits(fit) && fit.why.startsWith('By the rule for target.test') && fit.links.join() === 'Domains of this tab,Remove rule',
    `English: окно ${fit.win}, VPN включён, у сайта правило («${fit.why}»): ${fitText(fit)}`);
  await popup.size(400, 580, [1280, 720]);
  fit = await homeFit(['on', 'warn']);
  check(fits(fit, 580) && fit.links.length === 2, `English, экран 1280×720: окно ${fit.win} (высота .app — ${fit.app}), у сайта правило: ${fitText(fit)}`);
  await popup.size(400, 600);
  await popup.eval(js.message({ type: 'toggle', enabled: false }));
  fit = await homeFit(['rules']);
  check(fits(fit) && fit.status === 'VPN is off', `English: окно ${fit.win}, «${fit.status}»: ${fitText(fit)}`);
  await popup.eval(js.message({ type: 'toggle', enabled: true }));
  await popup.eval(`(async () => { ${wait} await wait(() => ['on', 'warn'].includes($('status').dataset.state), 15000); return 1; })()`);
  const ru1 = await opts.eval(pickLanguage('ru'));
  const ru2 = await popup.eval(langOf('ru'));
  check(ru1.html === 'ru' && ru1.settings === 'Настройки' && ru1.value === 'ru' && ru2.home === 'Главная' && (await popup.eval(js.title)) === 'Waysplit — подключено',
    `язык Русский: страница, окно и подсказка значка снова по-русски («${ru1.settings}», «${ru2.home}»)`);

  // Кнопка языка в шапке (версия 1.2.1): на кнопке язык окна, в меню три пункта, выбранный отмечен.
  // Язык меняется сразу, без перезапуска: и в окне, и на развёрнутой странице. Шапка остаётся в одну
  // строку. С клавиатуры меню ведёт себя как меню «?»: фокус на первом пункте, стрелка вниз — к следующему.
  const headPick = (label) => `(async () => { ${wait}
    const b = $('langBtn');
    const before = b.getAttribute('aria-expanded');
    b.click();
    await wait(() => $('pop').matches(':popover-open'), 3000);
    const items = [...document.querySelectorAll('#pop .pop-item')];
    const out = { menu: items.map((x) => x.textContent.trim() + (x.getAttribute('aria-checked') === 'true' ? '*' : '')).join(', '),
      focused: document.activeElement === items[0], before, open: b.getAttribute('aria-expanded'), title: b.title, aria: b.getAttribute('aria-label') };
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    out.moved = document.activeElement === items[1];
    items.find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click();
    await sleep(300);
    out.closed = b.getAttribute('aria-expanded');
    return out; })()`;
  const headState = (code) => `(async () => { ${wait}
    await wait(() => document.documentElement.lang === ${JSON.stringify(code)} && $('langBtn').textContent === ${JSON.stringify(code.toUpperCase())}, 5000);
    const top = $('top');
    const rows = new Set([...top.children].filter((c) => c.offsetWidth).map((c) => Math.round((c.getBoundingClientRect().top + c.getBoundingClientRect().bottom) / 2)));
    return { lang: document.documentElement.lang, btn: $('langBtn').textContent, height: Math.round(top.getBoundingClientRect().height), rows: rows.size,
      overflow: top.scrollWidth - top.clientWidth, home: document.querySelector('.tabbar .tab[data-tab="home"]').textContent.trim(),
      setting: (await chrome.storage.local.get('settings')).settings?.language }; })()`;
  const oneRow = (h) => h.height === 44 && h.rows === 1 && h.overflow === 0;
  const hp1 = await popup.eval(headPick('English'));
  const hs1 = await popup.eval(headState('en'));
  const hf1 = await opts.eval(headState('en'));
  check(hp1.menu === 'Русский*, English, как в Chrome' && hp1.title === 'Язык / Language' && hp1.aria === hp1.title && hp1.before === 'false' && hp1.open === 'true' && hp1.closed === 'false' && hp1.focused && hp1.moved,
    `кнопка языка в шапке: подсказка «${hp1.title}», меню «${hp1.menu}» (звёздочка — галочка), фокус на первом пункте: ${hp1.focused}, стрелка вниз ведёт ко второму: ${hp1.moved}`);
  check(hs1.lang === 'en' && hs1.btn === 'EN' && hs1.home === 'Home' && hs1.setting === 'en' && hf1.lang === 'en' && hf1.btn === 'EN',
    `выбрали English кнопкой в шапке: окно сразу по-английски («${hs1.home}», на кнопке ${hs1.btn}), развёрнутая страница тоже (${hf1.lang}, ${hf1.btn}), настройка language — ${hs1.setting}`);
  check(oneRow(hs1) && oneRow(hf1), `шапка в одну строку: окно 400 пикс. — высота ${hs1.height}, строк ${hs1.rows}, сдвиг ${hs1.overflow}; развёрнутая страница — высота ${hf1.height}, строк ${hf1.rows}, сдвиг ${hf1.overflow}`);
  const hp2 = await popup.eval(headPick('same as Chrome'));
  const hs2 = await popup.eval(headState('ru'));
  check(hp2.menu === 'Русский, English*, same as Chrome' && hs2.setting === 'auto' && hs2.btn === 'RU' && hs2.home === 'Главная',
    `«как в Chrome» (Chrome русский): на кнопке язык, который получился, — ${hs2.btn}, окно «${hs2.home}», настройка language — ${hs2.setting}`);
  const hp3 = await popup.eval(headPick('Русский'));
  const hs3 = await popup.eval(headState('ru'));
  const hf3 = await opts.eval(headState('ru'));
  check(hp3.menu === 'Русский, English, как в Chrome*' && hs3.setting === 'ru' && hs3.btn === 'RU' && oneRow(hs3) && oneRow(hf3),
    `выбрали «Русский»: настройка language — ${hs3.setting}, на кнопке ${hs3.btn}, шапка по-русски тоже в одну строку (окно ${hs3.height}, развёрнутая страница ${hf3.height})`);

  await opts.eval(js.tab('settings'));
  check(await opts.eval(`document.getElementById('autoSiteDomains').checked && !document.getElementById('autoSitePerm').hidden`),
    'в «Настройках»: «Автоматически добавлять домены сайта» включено, рядом — «нужно разрешение Chrome» и кнопка «Разрешить»');
  site = await popup.eval(js.siteClick('ruleRemove'));
  check(site.vpn && /^Правила нет/.test(site.why) && !site.remove, `«Убрать правило»: ${site.why}`);
  // Тот же замер у сайта без правила (пояснение — в одну строку) и при выключенном VPN.
  fit = await homeFit(['on', 'warn']);
  check(fits(fit) && fit.why === 'Правила нет — как у остальных сайтов: через VPN' && fit.links.join() === 'Домены этой вкладки',
    `окно ${fit.win}, VPN включён, у сайта нет правила («${fit.why}»): ${fitText(fit)}`);
  await popup.eval(js.message({ type: 'toggle', enabled: false }));
  fit = await homeFit(['off']);
  check(fits(fit) && fit.state === 'off' && fit.why === 'Правила нет — как у остальных сайтов: без VPN', `окно ${fit.win}, «${fit.status}» («${fit.why}»): ${fitText(fit)}`);
  // Те же два замера по-английски (язык — сообщением фону, как его записывает «Настройки»).
  await popup.eval(js.message({ type: 'setSetting', key: 'language', value: 'en' }));
  fit = await homeFit(['off']);
  check(fits(fit) && fit.status === 'VPN is off' && fit.why === 'No rule — same as other sites: without VPN' && fit.links.join() === 'Domains of this tab',
    `English: окно ${fit.win}, «${fit.status}» («${fit.why}»): ${fitText(fit)}`);
  await popup.eval(js.message({ type: 'toggle', enabled: true }));
  fit = await homeFit(['on', 'warn']);
  check(fits(fit) && fit.why === 'No rule — same as other sites: through VPN', `English: окно ${fit.win}, VPN включён, у сайта нет правила («${fit.why}»): ${fitText(fit)}`);
  // Сообщения компаньона (версия 1.2.0): он присылает фразу с кодом, и окно показывает её на своём
  // языке. Две строки, которые не станут серверами, — причины по-английски, а после смены языка тот же
  // запрос даёт их по-русски. Компаньон свежий — строки «обновите компаньон» в «Настройках» нет.
  const badLinks = ['vless://nouuid.example.com:443', 'ss://YWVzLTI1Ni1nY206cGFzcw@ss.example.com:8388'].join(String.fromCharCode(10));
  const skipEn = (await popup.eval(js.message({ type: 'addLinks', text: badLinks })))?.result?.skipped?.map((x) => x.reason) || [];
  check(skipEn.length === 2 && skipEn[0] === 'the link has no UUID' && /^protocol .+ is not supported yet$/.test(skipEn[1]),
    `English: причины компаньона, почему строки не стали серверами, — по-английски: «${skipEn.join('», «')}»`);
  await opts.eval(js.tab('settings'));
  const hostLang = await opts.eval(`(async () => { ${wait} await wait(() => /companion [0-9]/.test($('versions').textContent), 10000); return { versions: $('versions').textContent, hidden: $('hostLang').hidden }; })()`);
  check(hostLang.hidden && hostLang.versions.includes(`companion ${hostVersion}`), `English, «Настройки»: «${hostLang.versions}», строки «обновите компаньон» нет (компаньон свежий)`);
  await popup.eval(js.message({ type: 'setSetting', key: 'language', value: 'ru' }));
  await popup.eval(langOf('ru'));
  const skipRu = (await popup.eval(js.message({ type: 'addLinks', text: badLinks })))?.result?.skipped?.map((x) => x.reason) || [];
  check(skipRu.length === 2 && skipRu[0] === 'в ссылке нет uuid' && /^протокол .+ пока не поддерживается$/.test(skipRu[1]),
    `по-русски те же причины: «${skipRu.join('», «')}»`);
  await popup.eval(js.message({ type: 'toggle', enabled: true }));
  await popup.eval(`(async () => { ${wait} await wait(() => ['on', 'warn'].includes($('status').dataset.state), 15000); return 1; })()`);
  [text] = await readUntil(tab, target, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `правило убрано — target.test снова через текущий сервер A («${text}»)`);
  site = await popup.eval(js.siteClick('siteSwitch')); // снова «без VPN» — для проверок правил ниже
  check(site.why === 'По правилу для target.test · без VPN', 'переключатель снова поставил правило «без VPN» для target.test');

  let added5 = await opts.eval(js.addRule('test', `proxy:${srvB.id}`));
  check(/^Добавлено 1/.test(added5), `правило на зону test через сервер B: «${added5}»`);
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK B');
  check(text === 'Waysplit-OK B', `зона test → сервер B: other.test через B, хотя текущий — A («${text}»)`);
  [text] = await readUntil(tab, target, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `побеждает самое конкретное правило: target.test по-прежнему напрямую («${text}»)`);
  added5 = await opts.eval(js.addRule('https://www.пример.рф/страница', 'direct'));
  const row = await opts.eval(js.ruleRow('пример.рф'));
  check(/^Добавлено 1/.test(added5) && row?.sub === 'xn--e1afmkfd.xn--p1ai' && !row.favicon, `кириллический домен: «пример.рф» хранится как ${row?.sub}; значка сайта в строке правила нет`);
  added5 = await opts.eval(js.addSet('youtube', 'direct'));
  check(/добавлено 7/.test(added5), `набор доменов: «${added5}»`);
  if (shotsDir) {
    await opts.shot(join(shotsDir, 'options-rules-light.png'), 'light');
    await opts.shot(join(shotsDir, 'options-rules-dark.png'), 'dark');
  }

  st = await popup.eval(js.power(['rules', 'off', 'error']));
  check(st.state === 'rules', `VPN выключен, правила работают: [${st.state}] ${st.status} — ${st.detail}`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-rules.png'), 'light');
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK B');
  check(text === 'Waysplit-OK B', `при выключенном VPN правило «через VPN» работает: other.test через B («${text}»)`);
  [text] = await readUntil(tab, freeUrl, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `сайт без правил при выключенном VPN — напрямую («${text}»)`);
  await opts.eval(js.rulesWhenOffMenu);
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `«Правила работают, когда VPN выключен» сняли в меню «⋯» правил — other.test напрямую («${text}»)`);
  check(await waitPort(srvB.localPort, false, 5000), 'ядро остановлено: правил «через VPN» больше нет в работе');
  // «Этот сайт», когда правило не действует: флаг сервера из правила приглушён, в жёлтой строке «Включить».
  await popup.inject(`chrome.tabs.query = async () => [{ id: -1, url: ${JSON.stringify(otherUrl)} }];`);
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  site = await popup.eval(js.site);
  check(/правила при выключенном VPN отключены/.test(site.warn) && site.dim && site.server.includes('Сервер B') && !site.vpn && site.fix === 'Включить правила',
    `«Этот сайт»: правило не действует — «${site.warn}», флаг сервера из правила приглушён, кнопка — «${site.fix}»`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-site-sleeping.png'), 'light');
  site = await popup.eval(js.siteClick('siteWarnFix'));
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK B');
  await opts.eval(js.tab('settings'));
  check(site.vpn && !site.warn && text === 'Waysplit-OK B' && (await opts.eval(`document.getElementById('setRulesWhenOff').checked`)),
    `«Включить» в жёлтой строке: правила снова работают при выключенном VPN — other.test через B («${text}»), галочка в «Настройках» стоит`);
  check((await opts.eval(js.checkbox('setRulesWhenOff'))) === false, 'галочку «Правила работают, когда VPN выключен» в «Настройках» сняли');
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `…и правило снова не действует: other.test напрямую («${text}»)`);
  check((await opts.eval(js.checkbox('setRulesWhenOff'))) === true, 'галочку поставили обратно');
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK B');
  check(text === 'Waysplit-OK B', `настройку вернули — other.test снова через B («${text}»)`);
  check((await opts.eval(js.ruleMenu('test', 'Отключить правило'))) === 'ok', 'в меню «⋯» правила есть «Отключить правило»');
  const offRow = await opts.eval(js.ruleRow('test'));
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT' && !offRow?.on && /выключено/.test(offRow?.sub), `правило на зону отключили, не удаляя — other.test напрямую («${text}»), строка «${offRow?.sub}»`);
  const imp = await opts.eval(js.message({ type: 'importRules', data: { type: 'rules', rules: [{ domain: 'imported.test', action: 'proxy', server: srvB.name, enabled: true }] } }));
  local = await opts.eval(js.local);
  const importedRule = local.rules.find((r) => r.domain === 'imported.test');
  check(imp?.ok && imp.result.added === 1 && importedRule?.serverId === srvB.id, 'импорт правил: правило добавлено, сервер найден по имени');

  // Убрать все правила, включить VPN снова через A — дальше проверки этапов 3–4.
  await opts.eval(js.message({ type: 'removeRules', ids: local.rules.map((r) => r.id) }));
  st = await popup.eval(js.power(['on', 'warn', 'error']));
  check(st.state === 'on', `правила убраны, VPN снова включён: ${st.status}`);
  [text] = await readUntil(tab, target, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `правила убраны — target.test снова через A («${text}»)`);

  // --- «Российские сайты — без VPN»: настройка, а не правила ---
  const ruUrl = `http://${RU_SITE}:${sitePort}/`;
  [text] = await readUntil(tab, ruUrl, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `переключатель выключен (по умолчанию): российский сайт идёт через VPN, как остальные («${text}»)`);
  await popup.inject(`chrome.tabs.query = async () => [{ id: -1, url: ${JSON.stringify(ruUrl)} }];`);
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  let ru = await popup.eval(js.ruSwitch(false));
  check(ru.shown && !ru.on && !ru.setting && ru.title === 'Российские сайты — без VPN' && ru.sub === '.ru, .рф, .su, VK, Яндекс и другие' && ru.bottom < ru.view,
    `«Главная»: строка «${ru.title}» с подсказкой «${ru.sub}», выключена`);
  ru = await popup.eval(js.ruSwitch(true));
  check(ru.on && ru.setting && /идут без VPN/.test(ru.toast), `переключатель включён: «${ru.toast}»`);
  [text] = await readUntil(tab, ruUrl, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `российский сайт пошёл напрямую, хотя VPN включён («${text}»)`);
  [text] = await readUntil(tab, target, 'Waysplit-OK A');
  check(text === 'Waysplit-OK A', `остальные сайты — по-прежнему через VPN («${text}»)`);
  site = await popup.eval(js.site);
  check(!site.vpn && site.text === 'Без VPN' && /^Без VPN: российский сайт/.test(site.why) && !site.remove, `«Этот сайт»: ${site.why}`);
  // Тот же сайт с точкой в конце адреса: для PAC это то же имя — и окно отвечает так же.
  const dotPop = await chrome.page();
  await dotPop.inject(`chrome.tabs.query = async () => [{ id: -1, url: ${JSON.stringify(`http://${RU_SITE}.:${sitePort}/`)} }];`);
  await dotPop.goto(`chrome-extension://${id}/popup/popup.html`);
  const dotted = await dotPop.eval(js.site);
  await chrome.send('Target.closeTarget', { targetId: dotPop.targetId });
  check(dotted.why === site.why && !dotted.vpn, `адрес с точкой в конце (${RU_SITE}.) — тот же сайт: «${dotted.why}»`);
  const ruNote = await opts.eval(`(async () => { ${wait}
    tab('rules');
    await wait(() => !$('rulesRu').hidden, 5000);
    const rules = $('rulesRu').hidden ? '' : $('rulesRu').textContent;
    tab('settings');
    return { rules, settings: $('setRuDirect').checked, count: (await chrome.storage.local.get('rules')).rules.length }; })()`);
  check(ruNote.rules === 'Российские сайты — без VPN: включено' && ruNote.settings && ruNote.count === 0,
    `вкладка «Правила»: напоминание «${ruNote.rules}»; в «Настройках» галочка стоит; правил по-прежнему ${ruNote.count} — это настройка, а не правила`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-ru-direct.png'), 'light');
  // Правило пользователя важнее: «Через VPN» для этого сайта — и он идёт через VPN.
  site = await popup.eval(js.siteClick('siteSwitch'));
  [text] = await readUntil(tab, ruUrl, 'Waysplit-OK A');
  check(site.vpn && site.why.startsWith(`По правилу для ${RU_SITE}`) && text === 'Waysplit-OK A', `правило «через VPN» для российского сайта побеждает переключатель: ${site.why} («${text}»)`);
  site = await popup.eval(js.siteClick('ruleRemove'));
  [text] = await readUntil(tab, ruUrl, 'Waysplit-OK DIRECT');
  check(/^Без VPN: российский сайт/.test(site.why) && text === 'Waysplit-OK DIRECT', `правило убрали — сайт снова напрямую по переключателю («${text}»)`);
  // «Начало работы»: та же настройка галочкой; выключаем — сайт снова через VPN.
  const wel = await chrome.page(`chrome-extension://${id}/welcome/welcome.html`);
  const welRu = await wel.eval(`(async () => { ${wait}
    await wait(() => $('ruDirect').checked, 5000);
    const out = { text: $('ruDirect').closest('label').innerText.replace(/\\s+/g, ' ').trim(), wasOn: $('ruDirect').checked };
    $('ruDirect').click();
    await sleep(700);
    out.setting = (await chrome.storage.local.get('settings')).settings?.ruDirect;
    await wait(() => $('hostState').dataset.kind === 'ok', 10000);
    out.host = $('hostState').textContent;
    out.hostColor = getComputedStyle($('hostState')).color;
    out.done = $('step1').dataset.done;
    out.light = document.documentElement.dataset.light;
    out.screen = getComputedStyle(document.querySelector('.steps')).backgroundColor;
    out.font = getComputedStyle($('hostState')).fontFamily;
    return out; })()`);
  await chrome.send('Target.closeTarget', { targetId: wel.targetId });
  [text] = await readUntil(tab, ruUrl, 'Waysplit-OK A');
  ru = await popup.eval(js.ruSwitch(false));
  check(welRu.text === 'Российские сайты — без VPN .ru, .рф, .su, VK, Яндекс и другие' && welRu.wasOn && welRu.setting === false && !ru.on && text === 'Waysplit-OK A',
    `«Начало работы»: галочка «${welRu.text}» — сняли, переключатель на «Главной» выключен, российский сайт снова через VPN («${text}»)`);
  check(/^Компаньон на связи/.test(welRu.host) && welRu.hostColor === 'rgb(28, 36, 22)' && welRu.done === 'true' && welRu.light === 'on' && welRu.screen === 'rgb(197, 209, 168)'
    && /^"Waysplit LCD"/.test(welRu.font),
  `«Начало работы»: «${welRu.host}» — чернилами на экране (${welRu.hostColor}), шаг отмечен, подсветка экрана горит (${welRu.screen})`);

  // Сообщения внизу окна: ошибка остаётся до крестика, короткое об успехе исчезает само.
  // В меню «⋯» у пункта с фокусом — синяя обводка; в «Настройках» у каждой галочки название и пояснение.
  const toasts = await opts.eval(`(async () => { ${wait}
    tab('rules');
    clearToast();
    $('ruleInput').value = 'плохой домен!';
    $('ruleInput').dispatchEvent(new Event('input'));
    $('ruleForm').requestSubmit();
    await wait(() => toastText(), 5000);
    const err = { text: toastText(), kind: $('toast').dataset.kind, sticky: $('toast').dataset.sticky, close: !!$('toast').querySelector('.toast-close') };
    await sleep(6000);
    err.stillShown = !$('toast').hidden;
    $('toast').querySelector('.toast-close')?.click();
    err.closed = $('toast').hidden;
    $('ruleInput').value = '';
    $('ruleInput').dispatchEvent(new Event('input'));
    tab('servers');
    $('pingAll').click();
    await wait(() => /^Проверяю/.test(toastText()), 3000);
    const short = { text: toastText(), sticky: $('toast').dataset.sticky, close: !!$('toast').querySelector('.toast-close') };
    await wait(() => /^Ответили/.test(toastText()), 40000);
    await sleep(5600);
    short.gone = $('toast').hidden;
    const css = [...document.styleSheets].flatMap((s) => [...s.cssRules]).find((r) => r.selectorText?.includes('.pop-item:focus-visible'));
    tab('settings');
    const checks = [...document.querySelectorAll('#panel-settings .check')];
    return { err, short, focus: css ? css.style.cssText : '',
      opts: checks.length, named: checks.filter((c) => c.querySelector('.opt-name')?.textContent && c.querySelector('.opt-note')?.textContent).length }; })()`);
  check(toasts.err.kind === 'error' && toasts.err.sticky === 'true' && toasts.err.close && toasts.err.stillShown && toasts.err.closed,
    `сообщение об ошибке («${toasts.err.text}») остаётся и через 6 с, закрывается крестиком`);
  check(toasts.short.sticky === 'false' && !toasts.short.close && toasts.short.gone, `короткое сообщение («${toasts.short.text}») — без крестика, исчезает само`);
  check(/background:\s*var\(--ink\)/.test(toasts.focus) && /color:\s*var\(--screen\)/.test(toasts.focus), `пункт меню «⋯» с фокусом клавиатуры залит чернилами, как под мышью («${toasts.focus}»)`);
  check(toasts.opts >= 6 && toasts.named === toasts.opts, `«Настройки»: у всех ${toasts.opts} галочек и вариантов — название и пояснение отдельно`);

  // --- этап 6: защита, другое прокси-расширение, настройки, подписка, диагностика, копия ---
  const rtcOn = await popup.eval(js.webrtc);
  check(rtcOn.value === 'disable_non_proxied_udp' && rtcOn.level === 'controlled_by_this_extension', `WebRTC при включённом VPN: ${rtcOn.value} (${rtcOn.level})`);
  const title1 = await popup.eval(js.title);
  check(title1 === 'Waysplit — подключено', `подсказка у значка: «${title1}»`);

  // Другое прокси-расширение (как Browsec): ставит свой прокси — у нас предупреждение.
  const conflictDir = join(work, 'conflict-ext');
  mkdirSync(conflictDir);
  writeFileSync(join(conflictDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Чужой прокси (тест)', version: '1', permissions: ['proxy'], background: { service_worker: 'sw.js' } }));
  writeFileSync(join(conflictDir, 'sw.js'), "chrome.runtime.onInstalled.addListener(() => chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 9 } } }, scope: 'regular' }));");
  const { id: otherExt } = await chrome.send('Extensions.loadUnpacked', { path: conflictDir });
  let conflict = false;
  for (let i = 0; i < 60 && !conflict; i++) {
    conflict = (await popup.eval(js.status))?.conflict === true;
    if (!conflict) await sleep(250);
  }
  await sleep(300);
  const banner = await popup.eval(`!document.getElementById('conflict').hidden`);
  check(conflict && banner, 'другое расширение взяло прокси — в окне предупреждение «Прокси сейчас управляет другое расширение»');
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-conflict.png'), 'light');
  check(/другое расширение/.test(await popup.eval(js.title)), 'значок — красный «!», в подсказке — про другое расширение');
  await chrome.send('Extensions.uninstall', { id: otherExt });
  for (let i = 0; i < 60 && conflict; i++) {
    conflict = (await popup.eval(js.status))?.conflict === true;
    if (conflict) await sleep(250);
  }
  [text] = await readUntil(tab, target, 'Waysplit-OK A', 10000);
  check(!conflict && text === 'Waysplit-OK A', `чужое расширение убрали — Waysplit снова управляет прокси («${text}»)`);

  // Сервер недоступен: третий сервер на порту, где никто не слушает (ядро при этом работает).
  const deadPort = await freePort();
  const addedDead = await popup.eval(js.add(`vless://${uuid}@127.0.0.1:${deadPort}?type=tcp&security=none#Недоступный`));
  local = await popup.eval(js.local);
  const dead = local.servers.find((s) => s.name === 'Недоступный');
  check(!!dead, `добавлен недоступный сервер: «${addedDead}»`);
  await popup.eval(js.message({ type: 'select', id: dead.id }));
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const deadView = await popup.eval(`(async () => { ${wait}
    await wait(() => $('status').dataset.state === 'warn', 15000);
    return { state: $('status').dataset.state, status: $('status').textContent, detail: $('detail').textContent }; })()`);
  check(deadView.state === 'warn' && deadView.status === 'Нет ответа' && /Сайты не откроются/.test(deadView.detail),
    `окно при недоступном сервере: «${deadView.status}» — ${deadView.detail}`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-dead.png'), 'light');
  // Сервер без ответа — словами: в строке сервера на «Серверах» и на «Главной», а не только полосками.
  const deadMeta = await opts.eval(`(async () => { ${wait}
    tab('servers');
    await wait(() => srvRow('Недоступный')?.querySelector('.srv-fail'), 10000);
    const row = srvRow('Недоступный');
    const text = row?.querySelector('.srv-meta-text');
    const cs = text ? getComputedStyle(text) : null;
    return { meta: row?.querySelector('.srv-meta')?.textContent || '', cut: cs ? cs.textOverflow + ', ' + cs.overflowX + ', ' + cs.whiteSpace : '' }; })()`);
  const deadLabel = await popup.eval(`document.getElementById('srvMs').textContent + (document.getElementById('srvMs').classList.contains('fail') ? '' : ' (не выделено)')`);
  check(/^нет ответа · VLESS/.test(deadMeta.meta) && deadLabel === 'нет ответа', `сервер без ответа подписан словами: «${deadMeta.meta}»; на «Главной» — «${deadLabel}»`);
  check(deadMeta.cut === 'ellipsis, hidden, nowrap', `длинный адрес в строке сервера обрезается с многоточием (${deadMeta.cut})`);
  check(!/; DIRECT"/.test(await popup.eval(js.pac)), '«Не открывать сайт» (по умолчанию): запасного DIRECT в PAC нет');
  let deadErr = await tab.goto(target);
  [text] = await readUntil(tab, target, 'Waysplit-OK', 3000);
  check(deadErr !== '' && text === '', `«Не открывать сайт»: target.test не открылся ни через VPN, ни напрямую (${deadErr})`);
  await opts.eval(js.setRadio('onFailure', 'direct'));
  check(/; DIRECT"/.test(await popup.eval(js.pac)), '«Открыть напрямую»: в PAC появился запасной DIRECT');
  [text] = await readUntil(tab, target, 'Waysplit-OK DIRECT', 8000);
  check(text === 'Waysplit-OK DIRECT', `«Открыть напрямую»: при недоступном сервере target.test открылся напрямую («${text}»)`);
  await opts.eval(js.setRadio('onFailure', 'block'));
  await popup.eval(js.message({ type: 'select', id: srvA.id }));
  await opts.eval(js.message({ type: 'remove', id: dead.id }));
  [text] = await readUntil(tab, target, 'Waysplit-OK A', 10000);
  check(text === 'Waysplit-OK A', `недоступный сервер убран, снова сервер A («${text}»)`);

  // Настройки: тема нового окна — своя настройка (themeLcd), изначально тёмная, и при светлой теме системы.
  await popup.scheme('light');
  const theme0 = await popup.eval(`({ attr: document.documentElement.dataset.theme, body: getComputedStyle(document.body).backgroundColor })`);
  theme0.select = await opts.eval(`(async () => { ${wait} tab('settings'); await sleep(300); return $('themeLcd').value; })()`);
  const themeSet = (await opts.eval(js.local)).settings;
  check(theme0.attr === 'dark' && theme0.body === 'rgb(49, 59, 72)' && theme0.select === 'dark' && themeSet.themeLcd === 'dark' && (themeSet.theme ?? 'system') === 'system',
    `тема нового окна изначально тёмная, и при светлой теме системы (корпус ${theme0.body}); тема классического окна — «как в системе»`);
  await opts.eval(js.setSelect('themeLcd', 'light'));
  await sleep(300);
  const theme1 = await popup.eval(`({ attr: document.documentElement.dataset.theme, body: getComputedStyle(document.body).backgroundColor })`);
  check(theme1.attr === 'light' && theme1.body === 'rgb(221, 225, 230)' && (await opts.eval(js.local)).settings.theme === 'system',
    `светлая тема из настроек применилась в окне (корпус ${theme1.body}); тему классического окна это не меняет`);
  if (shotsDir) await opts.shot(join(shotsDir, 'options-settings.png'), 'light');
  await opts.eval(js.setSelect('themeLcd', 'system'));
  await sleep(300);
  await popup.scheme('dark');
  const themeSysDark = await popup.eval(`getComputedStyle(document.body).backgroundColor`);
  await popup.scheme('light');
  const themeSysLight = await popup.eval(`getComputedStyle(document.body).backgroundColor`);
  check(themeSysDark === 'rgb(49, 59, 72)' && themeSysLight === 'rgb(221, 225, 230)', `тема «как в системе»: при тёмной системе корпус ${themeSysDark}, при светлой — ${themeSysLight}`);
  await opts.eval(js.setSelect('themeLcd', 'dark'));

  // --- два оформления (версия 1.3.0, design/lcd/STYLE.md): новое окно и классическое (окно версии 1.2.1) ---
  // ctl — страница расширения, которая сама никуда не переходит: с неё шлём команды фону.
  const ctl = await chrome.page(`chrome-extension://${id}/welcome/welcome.html`);
  const pathOf = async (page) => { try { return await page.eval('location.pathname + location.search + location.hash'); } catch { return ''; } };
  // waitPage — страница перешла на адрес и окно показано с данными.
  const waitPage = async (page, re, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) {
      try {
        if (re.test(await pathOf(page)) && (await page.eval(`performance.getEntriesByName('waysplit-ready').length > 0`))) return true;
      } catch { /* страница как раз переходит */ }
      await sleep(200);
    }
    return false;
  };
  const pickDesign = (value) => `(async () => { ${wait}
    tab('settings');
    const s = $('design');
    s.scrollIntoView({ block: 'center' });
    s.focus();
    const before = { value: s.value, focused: document.activeElement === s, path: location.pathname, first: [...s.closest('fieldset').querySelectorAll('select')].indexOf(s) };
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change'));
    return before; })()`;
  const designView = `(async () => { ${wait}
    await wait(() => performance.getEntriesByName('waysplit-ready').length, 5000);
    await sleep(300);
    const a = document.activeElement;
    return { path: location.pathname, search: location.search, hash: location.hash, ready: document.documentElement.classList.contains('ready'),
      tab: document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab, focus: a?.id || '', ring: !!a?.matches?.(':focus-visible'), value: $('design')?.value,
      popup: await chrome.action.getPopup({}), setting: (await chrome.storage.local.get('settings')).settings?.design, theme: document.documentElement.dataset.theme || '' }; })()`;
  const setDesign = async (value) => {
    await ctl.eval(js.message({ type: 'setSetting', key: 'design', value }));
    const re = value === 'classic' ? /^\/classic\/popup\.html/ : /^\/popup\/popup\.html/;
    return (await waitPage(popup, re)) && (await waitPage(opts, re));
  };

  // Из нового окна — в классическое: выбор в «Настройках», окно сразу открывается в другом оформлении
  // на вкладке «Настройки», фокус — на том же выборе; значок расширения открывает классическое окно.
  await opts.focused();
  const d0 = await opts.eval(pickDesign('classic'));
  const toClassic = await waitPage(opts, /^\/classic\/popup\.html\?full/);
  const d1 = await opts.eval(designView);
  const popToClassic = await waitPage(popup, /^\/classic\/popup\.html/);
  check(d0.value === 'lcd' && d0.focused && d0.first === 0 && toClassic && d1.search.includes('full') && d1.tab === 'settings' && d1.focus === 'design' && d1.ring && d1.value === 'classic' && d1.ready
    && /\/classic\/popup\.html$/.test(d1.popup) && d1.setting === 'classic' && popToClassic,
  `оформление: в новом окне выбрали «классическое» (выбор — первым в разделе) — страница сразу открылась в классическом окне на вкладке «${d1.tab}», фокус на выборе оформления; значок открывает ${d1.popup.replace(/^.*\/\/[^/]+\//, '')}; открытое окно тоже перешло${d1.ring && d1.focus === 'design' ? '' : ` ${JSON.stringify({ d0, d1, toClassic, popToClassic })}`}`);

  // Классическое окно — короткая проверка: открывается, четыре вкладки показывают содержимое, VPN
  // выключается и включается, правило добавляется и удаляется, тема меняется, окно на всю вкладку открывается.
  const cl = await popup.eval(`(async () => { ${wait}
    await wait(() => performance.getEntriesByName('waysplit-ready').length, 5000);
    const out = { tabs: [], path: location.pathname };
    for (const name of ['home', 'servers', 'rules', 'settings']) {
      tab(name);
      await sleep(300);
      const p = $('panel-' + name);
      if (!p.hidden && p.offsetHeight > 100 && p.innerText.trim().length > 20) out.tabs.push(name);
    }
    out.frozen = document.documentElement.previousSibling?.nodeType === 8 || [...document.childNodes].some((n) => n.nodeType === 8 && /КЛАССИЧЕСКОЕ ОКНО/.test(n.data));
    out.servers = document.querySelectorAll('#srvGroups li.srv').length;
    out.flags = document.querySelectorAll('#srvGroups .flag').length;
    out.font = getComputedStyle(document.body).fontFamily;
    out.lcd = !!document.querySelector('.lcd');
    tab('home');
    return out; })()`);
  check(cl.path === '/classic/popup.html' && cl.tabs.join(', ') === 'home, servers, rules, settings' && cl.servers > 0 && cl.flags === cl.servers && !cl.lcd && /Segoe UI/.test(cl.font),
    `классическое окно открывается, вкладки с содержимым: ${cl.tabs.join(', ')}; серверов ${cl.servers}, у каждого флаг; шрифт и вид прежние`);
  const clPower = (state) => `(async () => { ${wait}
    tab('home');
    $('power').click();
    await wait(() => $('status').dataset.state === ${JSON.stringify(state)}, 20000);
    return { state: $('status').dataset.state, text: $('status').textContent }; })()`;
  const clOff = await popup.eval(clPower('off'));
  [text] = await readUntil(tab, target, 'Waysplit-OK DIRECT');
  const clOn = await popup.eval(clPower('on'));
  let textOn;
  [textOn] = await readUntil(tab, target, 'Waysplit-OK A', 10000);
  check(clOff.state === 'off' && text === 'Waysplit-OK DIRECT' && clOn.state === 'on' && textOn === 'Waysplit-OK A',
    `классическое окно: VPN выключили («${clOff.text}», сайт «${text}») и включили («${clOn.text}», сайт «${textOn}»)`);
  const clAdded = await popup.eval(js.addRule('classic-check.test', 'direct'));
  const clRule = await popup.eval(`(async () => { ${wait}
    const row = () => [...document.querySelectorAll('#rulesList li.rule')].find((x) => x.querySelector('.rule-domain').textContent === 'classic-check.test');
    await wait(() => row(), 5000);
    const out = { row: !!row(), stored: (await chrome.storage.local.get('rules')).rules.some((r) => r.domain === 'classic-check.test') };
    row()?.querySelector('[data-action="remove"]').click();
    await wait(() => !row(), 5000);
    await sleep(300);
    out.gone = !row() && !(await chrome.storage.local.get('rules')).rules.some((r) => r.domain === 'classic-check.test');
    clearToast();
    return out; })()`);
  check(/^Добавлено 1/.test(clAdded) && clRule.row && clRule.stored && clRule.gone, `классическое окно: правило добавлено («${clAdded}») и удалено`);
  await popup.eval(js.setSelect('theme', 'dark'));
  const clTheme = { attr: await popup.eval('document.documentElement.dataset.theme'), set: (await ctl.eval(js.local)).settings };
  await popup.eval(js.setSelect('theme', 'system'));
  check(clTheme.attr === 'dark' && clTheme.set.theme === 'dark' && clTheme.set.themeLcd === 'dark' && (await popup.eval('document.documentElement.dataset.theme')) === undefined,
    `классическое окно: тема меняется своей настройкой (data-theme="${clTheme.attr}"), потом снова «как в системе»; тема нового окна — ${clTheme.set.themeLcd}`);
  // Окно на всю вкладку — в выбранном оформлении из всех трёх мест: «Развернуть», страница настроек, ссылка на «Начале работы».
  const clSmall = await chrome.page(`chrome-extension://${id}/classic/popup.html`);
  await clSmall.eval(`(async () => { ${wait} await wait(() => performance.getEntriesByName('waysplit-ready').length); tab('rules');
    setTimeout(() => $('expandBtn').click(), 50); return 'ok'; })()`);
  await sleep(1500);
  const clExpanded = (await chrome.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && /\/classic\/popup\.html\?full=?#rules$/.test(t.url));
  if (clExpanded) await chrome.send('Target.closeTarget', { targetId: clExpanded.targetId });
  try { await chrome.send('Target.closeTarget', { targetId: clSmall.targetId }); } catch { /* окно уже закрылось само */ }
  const clOptions = await chrome.page(`chrome-extension://${id}/options/options.html`);
  const clOptionsOk = await waitPage(clOptions, /^\/classic\/popup\.html\?full#settings$/);
  await chrome.send('Target.closeTarget', { targetId: clOptions.targetId });
  const clLink = await ctl.eval(`(async () => { ${wait} await wait(() => /classic/.test($('openFull').href), 5000); return $('openFull').getAttribute('href'); })()`);
  // Открыли не то окно (старый адрес нового окна): оно само переходит в выбранное, с теми же параметрами адреса.
  const clWrong = await chrome.page(`chrome-extension://${id}/popup/popup.html?full#rules`);
  const clWrongOk = await waitPage(clWrong, /^\/classic\/popup\.html\?full#rules$/);
  const clWrongTab = await clWrong.eval(`document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab`);
  await chrome.send('Target.closeTarget', { targetId: clWrong.targetId });
  check(!!clExpanded && clOptionsOk && /\/classic\/popup\.html\?full#rules$/.test(clLink) && clWrongOk && clWrongTab === 'rules',
    `классическое оформление: «Развернуть» (${clExpanded?.url.replace(/^.*\//, '') || 'нет вкладки'}), страница настроек и ссылка на «Начале работы» открывают классическое окно на всю вкладку; адрес нового окна сам переходит в классическое, вкладка «${clWrongTab}»`);

  // Из классического окна — обратно в новое: выбор рядом с темой, переход на «Настройки», фокус на выборе.
  const d2 = await opts.eval(pickDesign('lcd'));
  const toLcd = await waitPage(opts, /^\/popup\/popup\.html\?full/);
  const d3 = await opts.eval(designView);
  const popToLcd = await waitPage(popup, /^\/popup\/popup\.html/);
  check(d2.value === 'classic' && d2.focused && toLcd && d3.search.includes('full') && d3.tab === 'settings' && d3.focus === 'design' && d3.ring && d3.value === 'lcd' && d3.ready
    && /\/popup\/popup\.html$/.test(d3.popup) && d3.setting === 'lcd' && d3.theme === 'dark' && popToLcd,
  `оформление: в классическом окне выбрали «новое» — страница сразу открылась в новом окне на вкладке «${d3.tab}», фокус на выборе оформления; значок открывает ${d3.popup.replace(/^.*\/\/[^/]+\//, '')}; тема нового окна — ${d3.theme}${d3.ring && d3.focus === 'design' ? '' : ` ${JSON.stringify({ d2, d3, toLcd, popToLcd })}`}`);
  // Адрес классического окна при выбранном новом оформлении сам переходит в новое.
  const lcdWrong = await chrome.page(`chrome-extension://${id}/classic/popup.html?full#servers`);
  const lcdWrongOk = await waitPage(lcdWrong, /^\/popup\/popup\.html\?full#servers$/);
  await chrome.send('Target.closeTarget', { targetId: lcdWrong.targetId });
  check(lcdWrongOk, 'выбрано новое оформление: адрес классического окна сам переходит в новое, на ту же вкладку');
  // Кнопка оформления в шапке (design/lcd/STYLE.md, «Каркас окна»): значок и название — одна кнопка с
  // меню «Вид окна» и «Тема». Меню открывается мышью и с клавиатуры, меняет те же настройки, что строки
  // в «Настройках». После смены вида открывается другое окно на той же вкладке, фокус — на кнопке.
  await popup.focused();
  const lookMenu = `(async () => { ${wait}
    await sleep(250);
    const p = $('pop'), a = document.activeElement, b = $('lookBtn'), pr = p.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { open: p.matches(':popover-open'), expanded: b.getAttribute('aria-expanded'), groups: [...p.querySelectorAll('.pop-group')].map((x) => x.textContent).join(', '),
      items: [...p.querySelectorAll('.pop-item')].map((x) => (x.getAttribute('aria-checked') === 'true' ? '*' : '') + x.textContent.trim()).join(', '),
      focus: a === b ? 'кнопка' : a.textContent.trim(), ring: a.matches(':focus-visible'), groupButtons: p.querySelectorAll('button.pop-group, .pop-group[tabindex]').length,
      under: Math.round(pr.top - br.bottom), left: Math.round(pr.left - br.left), tab: document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab }; })()`;
  const lookBox = await popup.eval(`(async () => { ${wait} tab('rules'); await sleep(200); const b = $('lookBtn'), r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: Math.round(r.left), h: Math.round(r.height), radius: cs.borderRadius, border: cs.borderTopWidth, title: b.title, aria: b.getAttribute('aria-label'),
      name: b.querySelector('.brand').textContent, tabs: (() => { const seen = []; for (const n of ['home', 'servers', 'rules', 'settings']) { tab(n); if ($('lookBtn').offsetWidth) seen.push(n); } tab('rules'); return seen.length; })() }; })()`);
  await popup.mouse(lookBox.x, lookBox.y);
  const lookMouse = await popup.eval(lookMenu);
  await popup.mouse(lookBox.x, lookBox.y);
  const lookAgain = await popup.eval(lookMenu);
  check(lookBox.left === 16 && lookBox.h === 28 && lookBox.radius === '14px' && lookBox.border === '1px' && lookBox.title === 'Оформление' && lookBox.aria === 'Оформление' && lookBox.name === 'Waysplit' && lookBox.tabs === 4
    && lookMouse.open && lookMouse.expanded === 'true' && lookMouse.groups === 'Вид окна, Тема' && lookMouse.items === '*новый, классический, *тёмная, светлая, как в системе' && lookMouse.focus === 'новый'
    && lookMouse.groupButtons === 0 && lookMouse.under === 4 && lookMouse.left === 0 && !lookAgain.open && lookAgain.expanded === 'false',
  `кнопка оформления в шапке (слева ${lookBox.left}, высота ${lookBox.h}, на всех четырёх вкладках): щелчок мышью открывает меню под кнопкой — группы «${lookMouse.groups}», значения ${lookMouse.items}; фокус на выбранном виде; второй щелчок закрывает`);
  await popup.eval(`document.getElementById('lookBtn').focus()`);
  await popup.key('Enter');
  const lookKey = await popup.eval(lookMenu);
  const lookWalk = [];
  for (let i = 0; i < 5; i++) {
    await popup.key('ArrowDown');
    lookWalk.push(await popup.eval(`document.activeElement.textContent.trim()`));
  }
  await popup.key('Escape');
  const lookEsc = await popup.eval(lookMenu);
  check(lookKey.open && lookKey.focus === 'новый' && lookKey.ring && lookWalk.join(', ') === 'классический, тёмная, светлая, как в системе, новый' && !lookEsc.open && lookEsc.focus === 'кнопка' && lookEsc.ring && lookEsc.tab === 'rules',
    `с клавиатуры: Enter на кнопке открывает меню, фокус на «${lookKey.focus}»; стрелка вниз идёт по значениям обеих групп (${lookWalk.join(', ')}); Esc закрывает меню и возвращает фокус на кнопку`);
  // Тема из меню: меняется сразу, меню закрывается; строка «Тема» в настройках показывает то же.
  const lookPick = (text) => `(async () => { ${wait}
    const b = $('lookBtn'); b.focus(); b.click();
    await wait(() => $('pop').matches(':popover-open') && $('pop').querySelector('.pop-group'), 3000);
    const it = [...$('pop').querySelectorAll('.pop-item')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    setTimeout(() => it.click(), 50);
    return !!it; })()`;
  // Строки «Вид окна» и «Тема» в настройках показывают то же: их значения читаем на вкладке «Настройки»
  // (там они отрисованы) и возвращаемся на прежнюю вкладку.
  const lookState = `(async () => { ${wait} await sleep(500); const a = document.activeElement;
    const out = { path: location.pathname, theme: document.documentElement.dataset.theme || '', open: $('pop').matches(':popover-open'), focus: a?.id || '',
      ring: !!a?.matches?.(':focus-visible'), tab: document.querySelector('.tabbar .tab[aria-selected="true"]')?.dataset.tab,
      settings: (({ design, theme, themeLcd }) => ({ design, theme, themeLcd }))((await chrome.storage.local.get('settings')).settings), popup: await chrome.action.getPopup({}) };
    tab('settings');
    await sleep(250);
    out.select = ($('themeLcd') || $('theme')).value;
    out.design = $('design').value;
    tab(out.tab);
    return out; })()`;
  await popup.eval(lookPick('светлая'));
  const lookLight = await popup.eval(lookState);
  await popup.eval(lookPick('тёмная'));
  const lookDark = await popup.eval(lookState);
  check(lookLight.theme === 'light' && lookLight.settings.themeLcd === 'light' && lookLight.settings.theme === 'system' && !lookLight.open && lookLight.focus === 'lookBtn' && lookLight.select === 'light'
    && lookDark.theme === 'dark' && lookDark.settings.themeLcd === 'dark' && lookDark.tab === 'rules' && lookDark.select === 'dark' && lookDark.design === 'lcd',
  `меню кнопки оформления: «светлая» — тема нового окна сменилась сразу (${lookLight.theme}), меню закрылось, тема классического не тронута; «тёмная» — вернулась (${lookDark.theme})`);
  // Вид из меню: из нового окна — в классическое и обратно, на той же вкладке, фокус на кнопке оформления.
  await popup.eval(lookPick('классический'));
  const lookToClassic = (await waitPage(popup, /^\/classic\/popup\.html/)) && (await waitPage(opts, /^\/classic\/popup\.html/));
  const lookC = await popup.eval(lookState);
  const lookCBox = await popup.eval(`(() => { const r = document.getElementById('lookBtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await popup.mouse(lookCBox.x, lookCBox.y);
  const lookCMenu = await popup.eval(lookMenu);
  await popup.key('Escape');
  await popup.eval(lookPick('тёмная'));
  const lookCDark = await popup.eval(lookState);
  await popup.eval(lookPick('как в системе'));
  const lookCSystem = await popup.eval(lookState);
  check(lookToClassic && lookC.path === '/classic/popup.html' && lookC.tab === 'rules' && lookC.focus === 'lookBtn' && lookC.ring && lookC.settings.design === 'classic' && lookC.design === 'classic' && /\/classic\/popup\.html$/.test(lookC.popup)
    && lookCMenu.open && lookCMenu.groups === 'Вид окна, Тема' && lookCMenu.items === 'новый, *классический, тёмная, светлая, *как в системе' && lookCMenu.focus === 'классический'
    && lookCDark.theme === 'dark' && lookCDark.settings.theme === 'dark' && lookCDark.settings.themeLcd === 'dark' && lookCSystem.theme === '' && lookCSystem.settings.theme === 'system',
  `меню кнопки оформления: «классический» — окно сразу классическое, вкладка «${lookC.tab}», фокус на кнопке оформления, значок открывает классическое окно; в нём та же кнопка и то же меню (${lookCMenu.items}), тема меняется своей настройкой${lookC.focus === 'lookBtn' && lookCMenu.open && lookCDark.theme === 'dark' ? '' : ` ${JSON.stringify({ lookToClassic, lookC, lookCMenu, lookCDark, lookCSystem })}`}`);
  await popup.eval(lookPick('новый'));
  const lookToLcd = (await waitPage(popup, /^\/popup\/popup\.html/)) && (await waitPage(opts, /^\/popup\/popup\.html/));
  const lookL = await popup.eval(lookState);
  check(lookToLcd && lookL.path === '/popup/popup.html' && lookL.tab === 'rules' && lookL.focus === 'lookBtn' && lookL.ring && lookL.settings.design === 'lcd' && lookL.design === 'lcd' && lookL.theme === 'dark' && /\/popup\/popup\.html$/.test(lookL.popup),
    `меню кнопки оформления в классическом окне: «новый» — окно сразу новое, вкладка «${lookL.tab}», фокус на кнопке оформления, тема ${lookL.theme}`);
  await popup.eval(`(async () => { ${wait} tab('home'); return 1; })()`);
  [text] = await readUntil(tab, target, 'Waysplit-OK A', 10000);
  check(text === 'Waysplit-OK A', `после переключений оформления VPN работает («${text}»)`);

  // Подписка: обновление сохраняет id серверов; в настройках — трафик и срок.
  await opts.eval(js.tab('servers'));
  const idsBefore = (await opts.eval(js.local)).servers.map((s) => s.id).join(',');
  const upd = await opts.eval(js.subUpdate);
  check(/обновлена: новых 0, удалено 0/.test(upd) && (await opts.eval(js.local)).servers.map((s) => s.id).join(',') === idsBefore, `обновление подписки: «${upd}» — id серверов те же`);
  const favAfter = await popup.eval(js.pickerGroups);
  local = await opts.eval(js.local);
  check(favAfter.groups[0] === 'Избранное' && favAfter.first.includes('Сервер B') && local.favorites.includes(srvB.key),
    `избранное после обновления подписки на месте: «${favAfter.first}»`);
  const subI = await opts.eval(js.subInfo('Тестовая подписка'));
  check(/^3 из 100 ГБ, до \d\d\.\d\d\.\d{4}$/m.test(subI.head) && !/сервер/.test(subI.head) && /3,0 ГБ из 100,0 ГБ/.test(subI.facts)
    && /127\.0\.0\.1:\d+\/…/.test(subI.facts) && !/SECRET/.test(subI.head + subI.facts),
    `подписка: ${subI.head.replace(/\s+/g, ' ')}; адрес — ${subI.facts.match(/http\S+/)?.[0]}`);
  if (shotsDir) await opts.shot(join(shotsDir, 'options-servers.png'), 'light');
  const sc = await opts.eval(js.subCheck);
  check(/^Проверка подписки \(адрес скрыт\)/.test(sc.report) && /Waysplit сейчас — 2 \(base64 со ссылками; запустим 2\)/.test(sc.report)
    && /v2rayN 7\.25\.6 — 200, веб-страница/.test(sc.report) && /Заголовки устройства \(x-hwid и др\.\) не отправлялись/.test(sc.report)
    && !/SECRET-TOKEN|127\.0\.0\.1/.test(sc.report), `«Проверить подписку»: ${sc.state}`);
  check(/\bghost\b/.test(sc.runClass) && sc.filled === 'Обновить', `экран подписки: «Проверить подписку» — контурная, залитая кнопка одна («${sc.filled}»)`);
  if (shotsDir) await opts.shot(join(shotsDir, 'options-subcheck.png'), 'light');

  // SPEC-SUBS, шаг 2: подписка, которая отдаёт серверы только устройствам.
  const uuid2 = randomUUID();
  const hw = await startHwidSubServer([`vless://${uuid2}@127.0.0.1:9?type=tcp#HWID%201`, `vless://${uuid2}@127.0.0.1:10?type=xhttp&path=%2Fx#HWID%202`]);
  const addedH = await opts.eval(js.add(hw.url));
  check(/Подписка «Тест HWID»: серверов 2, новых 2, пропущено 0; привязана к этому компьютеру как устройство/.test(addedH) && hw.seen.join(', ') === 'без, Windows/Chrome',
    `подписка с привязкой к устройству: «${addedH}»; запросы: ${hw.seen.join(', ')}`);
  const subHi = await opts.eval(js.subInfo('Тест HWID'));
  check(!/привязана/.test(subHi.head) && /Сообщение провайдера: Тест: пишите в поддержку/.test(subHi.head)
    && /подписка привязана к этому компьютеру как устройство/.test(subHi.facts) && !/HWID-TOKEN|#00ff00/.test(subHi.head + subHi.facts),
    'под строкой подписки — сообщение провайдера (обычный текст); привязка к устройству — в сведениях подписки, в короткой строке её нет');
  if (shotsDir) await opts.shot(join(shotsDir, 'options-hwid.png'), 'light');
  local = await opts.eval(js.local);
  const subH = local.subscriptions.find((x) => x.name === 'Тест HWID');
  hw.seen.length = 0;
  const updH = await opts.eval(js.message({ type: 'updateSubscription', id: subH.id }));
  check(updH?.ok && hw.seen.join(', ') === 'Windows/Chrome', `привязанная подписка обновляется сразу с идентификатором (запросы: ${hw.seen.join(', ')})`);
  await opts.eval(js.message({ type: 'removeSubscription', id: subH.id }));

  // SPEC-SUBS, п. 1: ссылка «для приложения» — Xray JSON; сервер из группы автовыбора повторяет отдельный.
  const uuid3 = randomUUID();
  const xo = (addr, port, net) => ({ protocol: 'vless', tag: `t-${port}`, settings: { address: addr, port, id: uuid3, encryption: 'none' },
    streamSettings: { network: net, security: 'none', ...(net === 'xhttp' ? { xhttpSettings: { path: '/x' } } : {}) } });
  const jsonUrl = await startBodyServer(JSON.stringify([
    { remarks: '⚡️ Автовыбор', outbounds: [xo('127.0.0.1', 11, 'raw'), xo('127.0.0.1', 12, 'xhttp'), { protocol: 'freedom' }] },
    { remarks: 'JSON 1', outbounds: [xo('127.0.0.1', 11, 'raw'), { protocol: 'blackhole' }] },
  ]), 'application/json');
  const addedJ = await opts.eval(js.add(jsonUrl));
  check(/Подписка «127\.0\.0\.1»: серверов 2, новых 2, пропущено 0/.test(addedJ), `подписка Xray JSON — 2 сервера без повтора: «${addedJ}»`);
  const subJi = await opts.eval(js.subInfo('127.0.0.1'));
  local = await opts.eval(js.local);
  const subJ = local.subscriptions.find((x) => x.format === 'xray-json');
  const namesJ = local.servers.filter((s) => s.subscriptionId === subJ?.id).map((s) => `${s.name}/${s.core}`).sort().join(', ');
  check(/Формат\s+Xray JSON/.test(subJi.facts) && namesJ === 'JSON 1/sing-box, ⚡️ Автовыбор · t-12/xray', `в сведениях подписки — «Формат: Xray JSON»; серверы: ${namesJ}`);
  await opts.eval(js.message({ type: 'removeSubscription', id: subJ.id }));

  // Диагностика.
  const diag = await opts.eval(js.diag);
  // Версия компаньона — именно из строки «Компаньон»: у расширения версия та же, и поиск по всему
  // тексту нашёл бы её в строке «Расширение», даже если компаньон ответил другой.
  const hostLine = diag.facts.match(/Компаньон\s+([^\n]*)/)?.[1] || '';
  check(hostLine === hostVersion && /1\.14\.4/.test(diag.facts) && /Xray\s*\d+\.\d+\.\d+/.test(diag.facts) && /запуск из Chrome/.test(diag.hostLog),
    `диагностика: версия компаньона — «${hostLine}» (в host/main.go — ${hostVersion}), версии sing-box и Xray, журнал компаньона`);
  check(!/SECRET-TOKEN|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(diag.hostLog + diag.events), 'в журналах нет uuid и адреса подписки');
  const coreLine = diag.facts.match(/Ядро sing-box\s+([^\n]*)/)?.[1] || '';
  check(/^работает, PID \d+, (меньше минуты|\d+ мин|\d+ ч \d+ мин), портов [1-9]\d*$/.test(coreLine) && !/NaN/.test(diag.facts) && /ID [a-p]{32}/.test(diag.facts),
    `диагностика: ядро — «${coreLine}», ID расширения — здесь`);
  const myIp = await opts.eval(js.myIp);
  check(/сайты видят IP \d+\.\d+\.\d+\.\d+/.test(myIp), `«Мой IP сейчас»: «${myIp}»`);
  if (shotsDir) await opts.shot(join(shotsDir, 'options-diag.png'), 'light');

  // Резервная копия: сохранить и восстановить — те же серверы и id.
  const backup = await opts.eval(js.message({ type: 'exportBackup' }));
  const restored = await opts.eval(js.message({ type: 'importBackup', data: backup.result }));
  const afterRestore = await opts.eval(js.local);
  check(restored?.ok && afterRestore.servers.map((s) => s.id).join(',') === backup.result.servers.map((s) => s.id).join(','),
    `резервная копия: сохранили и восстановили — те же серверы и id (${restored?.result?.servers ?? restored?.error?.message})`);
  [text] = await readUntil(tab, target, 'Waysplit-OK A', 10000);
  check(text === 'Waysplit-OK A', `после восстановления VPN работает («${text}»)`);
  // Резервная копия сохраняет и восстанавливает выбор оформления и обе темы. Старая копия (версии до
  // 1.3.0) этих ключей не знает: оформление и тема нового окна после неё остаются как были.
  const setMany = async (obj) => { for (const [key, value] of Object.entries(obj)) await ctl.eval(js.message({ type: 'setSetting', key, value })); };
  await setMany({ theme: 'light', themeLcd: 'system' });
  const movedForCopy = await setDesign('classic');
  const copyNew = (await ctl.eval(js.message({ type: 'exportBackup' }))).result;
  await setMany({ theme: 'system', themeLcd: 'dark' });
  const movedBack = await setDesign('lcd');
  const inNew = await ctl.eval(js.message({ type: 'importBackup', data: copyNew }));
  const movedByCopy = (await waitPage(popup, /^\/classic\/popup\.html/)) && (await waitPage(opts, /^\/classic\/popup\.html/));
  const afterNew = (await ctl.eval(js.local)).settings;
  check(movedForCopy && movedBack && copyNew.settings.design === 'classic' && copyNew.settings.theme === 'light' && copyNew.settings.themeLcd === 'system' && inNew?.ok
    && afterNew.design === 'classic' && afterNew.theme === 'light' && afterNew.themeLcd === 'system' && movedByCopy && /\/classic\/popup\.html$/.test(await ctl.eval('chrome.action.getPopup({})')),
  `резервная копия с выбором оформления: в копии — ${copyNew.settings.design}, темы ${copyNew.settings.theme} и ${copyNew.settings.themeLcd}; после восстановления — ${afterNew.design}, ${afterNew.theme}, ${afterNew.themeLcd}; открытые окна перешли в классическое`);
  const { design: _noDesign, themeLcd: _noThemeLcd, ...oldCopySettings } = copyNew.settings;
  const inOld = await ctl.eval(js.message({ type: 'importBackup', data: { ...copyNew, settings: { ...oldCopySettings, theme: 'dark' } } }));
  const afterOld = (await ctl.eval(js.local)).settings;
  check(inOld?.ok && afterOld.design === 'classic' && afterOld.themeLcd === 'system' && afterOld.theme === 'dark',
    `старая копия без выбора оформления: оформление (${afterOld.design}) и тема нового окна (${afterOld.themeLcd}) остались как были, тема классического окна — из копии (${afterOld.theme})`);
  await setMany({ theme: 'system', themeLcd: 'dark' });
  check(await setDesign('lcd'), 'оформление возвращено: новое окно');
  // После восстановления копии подписки считаются необновлёнными, и расширение обновит их само, когда
  // сработает сторож (раз в минуту). Такое обновление возвращает серверы подписки, удалённые из списка, —
  // и дальнейшие шаги (удаление текущего сервера, пинг серверов обоих ядер) зависели бы от того, успело ли
  // оно пройти. Поэтому обновляем подписки здесь сами и ждём: дальше до конца проверки они не обновляются.
  for (const sub of afterRestore.subscriptions) await opts.eval(js.message({ type: 'updateSubscription', id: sub.id }));
  let fresh = [];
  for (let i = 0; i < 100; i++) {
    fresh = (await opts.eval(js.local)).subscriptions;
    if (fresh.every((x) => typeof x.updatedAt === 'number')) break;
    await sleep(100);
  }
  check(fresh.every((x) => typeof x.updatedAt === 'number'), `подписки после восстановления обновлены (${fresh.length}): дальше сами не обновляются`);
  await opts.eval(js.tab('servers'));

  local = await opts.eval(js.local);
  const current = local.servers.find((s) => s.id === local.currentServerId);
  const other = local.servers.find((s) => s.id !== local.currentServerId);
  await opts.eval(js.serverAction(current.name, 'Удалить'));
  for (let i = 0; i < 50 && (await opts.eval(js.local)).servers.length !== 1; i++) await sleep(100);
  local = await opts.eval(js.local);
  check(local.servers.length === 1 && local.currentServerId === other.id, `удалён текущий «${current.name}» — текущим стал «${other.name}»`);
  const letter = other.name.includes('Амстердам') ? 'A' : 'B';
  [text] = await readUntil(tab, target, `Waysplit-OK ${letter}`, 10000);
  check(text === `Waysplit-OK ${letter}`, `после удаления сайт идёт через оставшийся сервер («${text}»)`);

  // --- выключение и пинг при выключенном VPN ---
  st = await popup.eval(js.power(['off']));
  check(st.state === 'off', `выключение: [${st.state}] ${st.status}`);
  [text] = await readUntil(tab, target, 'Waysplit-OK DIRECT');
  check(text === 'Waysplit-OK DIRECT', `после выключения target.test снова идёт напрямую («${text}»)`);
  check(await waitPort(other.localPort, false, 5000), `ядро остановлено: порт ${other.localPort} закрыт`);
  const rtcOff = await popup.eval(js.webrtc);
  check(rtcOff.value === 'default' && rtcOff.level === 'controllable_by_this_extension', `VPN выключен — WebRTC вернулся как было: ${rtcOff.value}`);
  const offPing = await opts.eval(js.pingAll);
  check(/^Ответили 1 из 1/.test(offPing), `пинг при выключенном VPN: «${offPing}»`);
  check(await waitPort(other.localPort, false, 5000), 'после пинга ядро снова остановлено');
  check((await popup.eval(js.status)).state === 'off', 'VPN по-прежнему выключен');

  // Перезапуск фонового скрипта (VPN выключен, компаньон не запущен): фон останавливаем и будим
  // сообщением — он начинает с init().
  const restartSw = async () => {
    const sws = (await chrome.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
    for (const w of sws) await chrome.send('Target.closeTarget', { targetId: w.targetId });
    await sleep(500);
    const r = await ctl.eval(js.message({ type: 'clearSiteNew', tabId: 0 }));
    await sleep(300);
    return r?.ok === true;
  };
  // Выбор оформления сохраняется после перезапуска фона: значок по-прежнему открывает выбранное окно.
  const keptMove = await setDesign('classic');
  const keptWoke = await restartSw();
  const kept = { popup: await ctl.eval('chrome.action.getPopup({})'), design: (await ctl.eval(js.local)).settings.design, path: await pathOf(popup) };
  const keptBack = await setDesign('lcd');
  const keptWoke2 = await restartSw();
  const kept2 = { popup: await ctl.eval('chrome.action.getPopup({})'), design: (await ctl.eval(js.local)).settings.design };
  check(keptMove && keptWoke && /\/classic\/popup\.html$/.test(kept.popup) && kept.design === 'classic' && /^\/classic\/popup\.html/.test(kept.path)
    && keptBack && keptWoke2 && /\/popup\/popup\.html$/.test(kept2.popup) && kept2.design === 'lcd',
  `выбор оформления сохраняется после перезапуска фонового скрипта: было классическое — значок открывает ${kept.popup.replace(/^.*\/\/[^/]+\//, '')}; вернули новое — ${kept2.popup.replace(/^.*\/\/[^/]+\//, '')}`);
  // Перенос темы при первом запуске новой версии: в хранилище прежняя настройка темы и нет темы нового
  // окна. Была светлая — в новом окне светлая; была тёмная или не была выбрана — тёмная.
  const baseSettings = (await ctl.eval(js.local)).settings;
  const { themeLcd: _oldLcd, theme: _oldTheme, ...noThemes } = baseSettings;
  const carried = [];
  for (const [was, want] of [['light', 'light'], ['dark', 'dark'], [null, 'dark']]) {
    await ctl.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(was ? { ...noThemes, theme: was } : noThemes)} })`);
    const woke = await restartSw();
    const got = (await ctl.eval(js.local)).settings;
    await sleep(300);
    const shown = await popup.eval('document.documentElement.dataset.theme');
    carried.push({ was: was || 'не выбрана', got: got.themeLcd, shown, classic: got.theme ?? 'system', ok: woke && got.themeLcd === want && shown === want && (got.theme ?? 'system') === (was || 'system') });
  }
  await ctl.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(baseSettings)} })`);
  check(carried.every((x) => x.ok), `перенос темы при первом запуске новой версии: ${carried.map((x) => `была ${x.was} — в новом окне ${x.got}`).join('; ')}; тема классического окна не менялась`);
  check((await restartSw()) && (await ctl.eval(js.local)).settings.themeLcd === baseSettings.themeLcd && (await waitPage(popup, /^\/popup\/popup\.html/)), 'настройки возвращены, окно новое');

  // --- восстановление после остановки фона и закрытие Chrome ---
  st = await popup.eval(js.power(['on', 'warn', 'error']));
  check(st.state === 'on', `снова включено: ${st.status}`);
  const { targetInfos } = await chrome.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
  check(!!sw, 'фоновая часть расширения найдена');
  await chrome.send('Target.closeTarget', { targetId: sw.targetId });
  check(await waitPort(other.localPort, false, 10000), 'фон остановлен: компаньон и ядро завершились');
  const t0 = Date.now();
  let back = false;
  for (let i = 0; i < 30 && !back; i++) {
    back = (await tab.goto(target)) === ''; // первая неудача будит фон (chrome.proxy.onProxyError)
    if (!back) await sleep(1000);
  }
  check(back, `фон проснулся сам, ядро поднялось, target.test снова открывается (через ${Math.round((Date.now() - t0) / 1000)} с)`);

  // --- этап 8: сервер XHTTP — через второе ядро, Xray ---
  const xPort = await startXrayServer(uuid);
  const addX = await popup.eval(js.add(`vless://${uuid}@127.0.0.1:${xPort}?type=xhttp&path=%2Fxh&security=none#%F0%9F%87%AB%F0%9F%87%B7%20Сервер%20X`));
  local = await popup.eval(js.local);
  const srvX = local.servers.find((s) => s.name.includes('Сервер X'));
  check(/^Добавлено 1/.test(addX) && srvX?.core === 'xray', `сервер XHTTP добавлен, ядро — Xray: «${addX}»`);
  check(!(await portOpen(srvX.localPort)), 'Xray не запущен, пока его сервер не нужен');
  const sbPid = (await popup.eval(js.status)).pid;
  await popup.eval(js.message({ type: 'select', id: srvX.id }));
  [text, ms] = await readUntil(tab, target, 'Waysplit-OK X', 10000);
  check(text === 'Waysplit-OK X', `выбран сервер XHTTP — target.test идёт через Xray (${(ms / 1000).toFixed(1)} с, «${text}»)`);
  check((await popup.eval(js.status)).pid === sbPid, `sing-box не перезапускался (PID ${sbPid})`);
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const metaX = await popup.eval(`(async () => { ${wait} tab('servers'); await wait(() => srvRow('Сервер X')); return srvRow('Сервер X').querySelector('.srv-meta').textContent; })()`);
  check(/Xray/.test(metaX), `в окне у сервера пометка ядра: «${metaX}»`);
  if (shotsDir) await popup.shot(join(shotsDir, 'popup-xray.png'), 'light');
  const pingX = await popup.eval(js.pingAll);
  check(/^Ответили 2 из 2/.test(pingX), `пинг серверов обоих ядер: «${pingX}» (серверы: ${(await popup.eval(js.local)).servers.map((x) => x.name).join(', ')})`);
  await popup.eval(js.message({ type: 'select', id: other.id }));
  [text] = await readUntil(tab, target, `Waysplit-OK ${letter}`, 10000);
  check(text === `Waysplit-OK ${letter}` && await waitPort(srvX.localPort, false, 10000), `обратно на sing-box («${text}») — Xray остановлен, он больше не нужен`);
  const ruleX = await opts.eval(js.message({ type: 'addRules', domains: ['other.test'], action: 'proxy', serverId: srvX.id }));
  [text] = await readUntil(tab, otherUrl, 'Waysplit-OK X', 10000);
  check(ruleX?.ok && text === 'Waysplit-OK X', `правило «other.test через сервер XHTTP» — Xray поднялся ради правила («${text}»)`);
  [text] = await readUntil(tab, target, `Waysplit-OK ${letter}`, 5000);
  check(text === `Waysplit-OK ${letter}`, `остальные сайты — через текущий сервер sing-box («${text}»)`);

  // --- этап 9: без компаньона — так расширение видит новый пользователь и проверяющий магазина ---
  // Копия расширения без поля key (свой ID) и с именем компаньона, которого нет: Chrome отвечает
  // «host not found». Окно и «Начало работы» должны сразу показать шаги установки и ссылку на загрузку.
  const bareDir = join(work, 'bare-ext');
  cpSync(extDir, bareDir, { recursive: true });
  const bareManifest = JSON.parse(readFileSync(join(bareDir, 'manifest.json'), 'utf8'));
  delete bareManifest.key;
  writeFileSync(join(bareDir, 'manifest.json'), JSON.stringify(bareManifest));
  const bareNative = join(bareDir, 'lib', 'native.js');
  writeFileSync(bareNative, readFileSync(bareNative, 'utf8').replace("'com.waysplit.host'", "'com.waysplit.absent'"));
  const { id: bareId } = await chrome.send('Extensions.loadUnpacked', { path: bareDir });
  const barePopup = await chrome.page(`chrome-extension://${bareId}/popup/popup.html`);
  await barePopup.size(400, 600);
  const bare = await barePopup.eval(`(async () => { ${wait}
    await wait(() => !$('problem').hidden, 10000);
    await sleep(400); // подсветка включается плавно, за 150 мс
    globalThis.__fresh = { path: location.pathname, theme: document.documentElement.dataset.theme, body: getComputedStyle(document.body).backgroundColor,
      popup: await chrome.action.getPopup({}), settings: (await chrome.storage.local.get('settings')).settings || {} };
    return { problem: $('problem').hidden ? '' : $('problemText').textContent, color: getComputedStyle($('status')).color, steps: $('steps').children.length,
      link: $('downloadRow').hidden ? '' : $('download').href, label: $('download').textContent, page: $('releasePage').href,
      status: $('status').textContent, detail: $('detail').textContent, led: $('powerZone').dataset.led, ledLabel: $('ledLabel').textContent,
      light: document.documentElement.dataset.light, screen: getComputedStyle($('content')).backgroundColor, twice: !$('problemText').hidden }; })()`);
  check(/не установлен/.test(bare.problem) && bare.steps === 3 && bare.label === 'Скачать'
    && /\/releases\/latest\/download\/Waysplit-companion\.zip$/.test(bare.link) && /\/releases\/latest$/.test(bare.page),
  `без компаньона окно сразу показывает шаги установки и кнопку «Скачать» с архивом последнего выпуска («${bare.problem}», шагов ${bare.steps})`);
  check(bare.status === 'Нет компаньона' && /не установлен/.test(bare.detail) && bare.led === 'error' && bare.ledLabel === 'ошибка' && bare.light === 'on'
    && bare.screen === 'rgb(197, 209, 168)' && bare.color === 'rgb(28, 36, 22)' && !bare.twice,
  `без компаньона и при выключенном VPN это ошибка: крупно «${bare.status}», ниже «${bare.detail}», лампочка «${bare.ledLabel}», экран горит (${bare.screen}); причина не повторяется в рамке`);
  if (shotsDir) await barePopup.shot(join(shotsDir, 'popup-no-companion.png'), 'light');
  await barePopup.scheme('light');
  const freshInstall = await barePopup.eval(`({ ...__fresh, bodyLight: getComputedStyle(document.body).backgroundColor })`);
  check(freshInstall.path === '/popup/popup.html' && /\/popup\/popup\.html$/.test(freshInstall.popup) && freshInstall.theme === 'dark' && freshInstall.bodyLight === 'rgb(49, 59, 72)'
    && (freshInstall.settings.design ?? 'lcd') === 'lcd' && freshInstall.settings.themeLcd === 'dark',
  `новая установка: окно новое, корпус тёмный и при светлой теме системы (${freshInstall.bodyLight}); в настройках оформление ${freshInstall.settings.design ?? 'не записано (действует новое)'}, тема ${freshInstall.settings.themeLcd}`);
  const bareWelcome = await chrome.page(`chrome-extension://${bareId}/welcome/welcome.html`);
  await bareWelcome.scheme('light');
  const bw = await bareWelcome.eval(`(async () => { ${wait}
    await wait(() => $('hostState').dataset.kind === 'error', 10000);
    return { state: $('hostState').textContent, howto: !$('howto').hidden, steps: $('installSteps').children.length,
      theme: document.documentElement.dataset.theme, body: getComputedStyle(document.querySelector('.phone')).backgroundColor, pageBg: getComputedStyle(document.body).backgroundColor,
      ready: document.documentElement.classList.contains('ready'), open: $('openFull').getAttribute('href'),
      link: $('download').href, label: $('download').textContent, page: $('releasePage').href,
      cmd: /powershell|setup\\.ps1/i.test(document.body.innerText) }; })()`);
  check(bw.howto && bw.steps === 3 && bw.label === 'Скачать' && /\/releases\/latest\/download\/Waysplit-companion\.zip$/.test(bw.link)
    && /\/releases\/latest$/.test(bw.page) && !bw.cmd,
  `«Начало работы» без компаньона: шаги и кнопка «Скачать», без команд PowerShell («${bw.state}»)`);
  check(bw.theme === 'dark' && bw.body === 'rgb(49, 59, 72)' && bw.pageBg === 'rgb(20, 24, 29)' && bw.ready && /\/popup\/popup\.html\?full#rules$/.test(bw.open),
    `«Начало работы» после установки с нуля: тема нового окна, тёмная и при светлой теме системы (корпус ${bw.body}, страница ${bw.pageBg}); ссылка «открыть» ведёт в новое окно`);
  if (shotsDir) await bareWelcome.shot(join(shotsDir, 'welcome-no-companion.png'), 'light');
  await chrome.send('Extensions.uninstall', { id: bareId });

  await chrome.close();
  check(await waitPort(other.localPort, false, 10000), 'Chrome закрыт: ядро завершилось вместе с ним');
  check(await waitPort(srvX.localPort, false, 10000), 'Chrome закрыт: Xray тоже завершился');

  // --- новая установка в английском Chrome (версия 1.2.0): язык «как в Chrome» — английский ---
  // Та же копия без компаньона, но свой профиль и Chrome с английским интерфейсом.
  const enChrome = startChrome(join(work, 'profile-en'), [], '1920x1080', 'en');
  try {
    const { id: enId } = await enChrome.send('Extensions.loadUnpacked', { path: bareDir });
    const enPop = await enChrome.page(`chrome-extension://${enId}/popup/popup.html`);
    await enPop.size(400, 600);
    const e1 = await enPop.eval(`(async () => { ${wait}
      await wait(() => !$('problem').hidden, 10000);
      return { ui: chrome.i18n.getUILanguage(), setting: (await chrome.storage.local.get('settings')).settings?.language, html: document.documentElement.lang,
        home: document.querySelector('.tabbar .tab[data-tab="home"]').textContent.trim(), problem: $('problemText').textContent, hint: $('hint').textContent, status: $('status').textContent,
        label: $('download').textContent, steps: [...$('steps').children].map((li) => li.textContent), title: await chrome.action.getTitle({}) }; })()`);
    check(/^en/.test(e1.ui) && e1.setting === 'auto' && e1.html === 'en' && e1.home === 'Home' && e1.status === 'No companion' && e1.problem === 'Companion is not installed'
      && e1.label === 'Download' && e1.steps.length === 3 && e1.title === 'Waysplit — off',
    `английский Chrome (${e1.ui}), новая установка: язык «как в Chrome», окно по-английски — «${e1.problem}», «${e1.hint}», кнопка «${e1.label}», значок «${e1.title}»`);
    if (shotsDir) await enPop.shot(join(shotsDir, 'popup-no-companion-en.png'), 'light');
    const enWelcome = await enChrome.page(`chrome-extension://${enId}/welcome/welcome.html`);
    const e2 = await enWelcome.eval(`(async () => { ${wait}
      await wait(() => $('hostState').dataset.kind === 'error', 10000);
      return { html: document.documentElement.lang, title: document.title, h1: document.querySelector('h1').textContent, state: $('hostState').textContent,
        label: $('download').textContent, steps: $('installSteps').children.length }; })()`);
    check(e2.html === 'en' && e2.title === 'Waysplit — getting started' && e2.h1 === e2.title && e2.state === 'Companion is not installed' && e2.label === 'Download' && e2.steps === 3,
      `«Начало работы» в английском Chrome: «${e2.title}», «${e2.state}», шагов установки ${e2.steps}`);

    // Та же кнопка языка — на «Начале работы». Chrome английский, язык «как в Chrome»: на кнопке EN.
    // Выбрали «Русский» — страница сразу по-русски; вернули «как в Chrome» — снова по-английски.
    const welPick = (label, code) => `(async () => { ${wait}
      const b = $('langBtn');
      const out = { was: b.textContent, title: b.title };
      b.click();
      await wait(() => $('pop').matches(':popover-open'), 3000);
      const items = [...document.querySelectorAll('#pop .pop-item')];
      out.menu = items.map((x) => x.textContent.trim() + (x.getAttribute('aria-checked') === 'true' ? '*' : '')).join(', ');
      items.find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click();
      await wait(() => document.documentElement.lang === ${JSON.stringify(code)} && b.textContent === ${JSON.stringify(code.toUpperCase())}, 5000);
      out.html = document.documentElement.lang; out.btn = b.textContent; out.h1 = document.querySelector('h1').textContent;
      out.setting = (await chrome.storage.local.get('settings')).settings?.language;
      return out; })()`;
    const w1 = await enWelcome.eval(welPick('Русский', 'ru'));
    const w2 = await enWelcome.eval(welPick('как в Chrome', 'en'));
    check(w1.was === 'EN' && w1.title === 'Язык / Language' && w1.menu === 'Русский, English, same as Chrome*' && w1.html === 'ru' && w1.btn === 'RU' && w1.setting === 'ru'
      && w2.menu === 'Русский*, English, как в Chrome' && w2.html === 'en' && w2.btn === 'EN' && w2.setting === 'auto',
    `кнопка языка на «Начале работы»: была ${w1.was}, меню «${w1.menu}»; «Русский» — «${w1.h1}» (${w1.btn}); «как в Chrome» — «${w2.h1}» (${w2.btn}, настройка ${w2.setting})`);
  } finally {
    await enChrome.close();
  }

  // --- «домены сайта»: автосбор ---
  // Автосбору нужно разрешение видеть запросы вкладок, а окно разрешения в Chrome без окна не
  // нажать. Поэтому — второй запуск Chrome (свой профиль) с копией расширения, где это разрешение
  // обязательное (ключ и ID те же: компаньон её пускает). Всё остальное в копии — как есть.
  console.log('\nДомены сайта (копия расширения с разрешением видеть запросы вкладок):');
  const siteDir = join(work, 'site-ext');
  cpSync(extDir, siteDir, { recursive: true });
  const siteManifest = JSON.parse(readFileSync(join(siteDir, 'manifest.json'), 'utf8'));
  siteManifest.permissions.push('webRequest');
  siteManifest.host_permissions = ['<all_urls>'];
  delete siteManifest.optional_permissions;
  delete siteManifest.optional_host_permissions;
  writeFileSync(join(siteDir, 'manifest.json'), JSON.stringify(siteManifest));
  const chrome2 = startChrome(join(work, 'profile2'), [PAGE_HOSTS.cf, PAGE_HOSTS.ga]);
  const { id: id2 } = await chrome2.send('Extensions.loadUnpacked', { path: siteDir });
  check(id2 === expectedId, 'копия расширения загружена с тем же ID');
  const win = await chrome2.page(`chrome-extension://${id2}/popup/popup.html?full`);
  await win.size(1000, 640);
  await win.eval(`(async () => { ${wait} await wait(() => performance.getEntriesByName('waysplit-ready').length, 5000); return 'ok'; })()`);
  const addedS = await win.eval(js.add(linkA));
  check(/^Добавлено 1/.test(addedS), `сервер A добавлен: «${addedS}»`);
  const rulesOf = async () => Object.fromEntries((await win.eval(js.local)).rules.map((r) => [r.domain, r]));
  const pageUrl = `http://page.test:${sitePort}/page`;
  const pageView = (t) => t.eval(`Object.fromEntries(['me', ...${JSON.stringify(Object.keys(PAGE_HOSTS))}].map((k) => [k, document.getElementById(k)?.textContent || '']))`);
  // openPage — открыть страницу и дождаться ответов всех её чужих доменов.
  const openPage = async (t, want, url = pageUrl) => {
    let v = {};
    for (let i = 0; i < 40; i++) {
      if (i % 10 === 0) await t.goto(url);
      v = await pageView(t);
      if (v.me === want && v.cdn && v.cf && v.ga) break;
      await sleep(250);
    }
    return v;
  };

  // VPN выключен; правила «через VPN» для page.test (страница) и files.test (долгая загрузка).
  const ruleS = await win.eval(js.message({ type: 'addRules', domains: ['page.test', 'files.test'], action: 'proxy', serverId: null }));
  check(ruleS?.ok && ruleS.result.added === 2, 'правила «через VPN» для page.test и files.test (VPN выключен)');
  const tab1 = await chrome2.page();
  const tab2 = await chrome2.page();
  [text] = await readUntil(tab2, `http://files.test:${sitePort}/`, 'Waysplit-OK A', 10000);
  check(text === 'Waysplit-OK A', `files.test идёт через VPN по правилу («${text}»)`);

  // Поправка 7: во второй вкладке идёт долгая загрузка через прокси; в первой открывается сайт,
  // автосбор привязывает его домены — Chrome получает новый PAC. Загрузка не должна оборваться.
  const pac0 = await win.eval(js.pac);
  await tab2.eval(`window.dlDone = false; window.dl = fetch('/slow').then((r) => r.arrayBuffer())
    .then((b) => ({ ok: true, n: b.byteLength, first: String.fromCharCode(new Uint8Array(b)[0]), last: String.fromCharCode(new Uint8Array(b)[b.byteLength - 1]) }), (e) => ({ ok: false, error: String(e) }))
    .then((r) => { window.dlDone = true; return r; }); 'начато'`);
  const dlStart = Date.now();
  let view = await openPage(tab1, 'Waysplit-OK A');
  check(view.me === 'Waysplit-OK A' && view.cdn === 'Waysplit-OK DIRECT' && view.cf === 'Waysplit-OK DIRECT',
    `до автосбора: сама страница — через VPN («${view.me}»), её чужие домены — напрямую («${view.cdn}», «${view.cf}»)`);
  let got = [];
  let attachMs = 0;
  for (let i = 0; i < 40 && !got.length; i++) {
    got = (await rulesOf())['page.test']?.siteDomains || [];
    attachMs = Date.now() - dlStart;
    if (!got.length) await sleep(250);
  }
  check(got.includes('media-cdn.test') && got.includes(PAGE_HOSTS.cf) && got.length === 2,
    `автосбор привязал к правилу page.test: ${got.join(', ') || 'ничего'} — «сайт» целиком, общий хостинг полным именем, общий сервис (${PAGE_HOSTS.ga}) не привязан`);
  let pac1 = '';
  for (let i = 0; i < 20 && !pac1.includes('media-cdn.test'); i++) {
    pac1 = await win.eval(js.pac);
    if (!pac1.includes('media-cdn.test')) await sleep(250);
  }
  const stillLoading = (await tab2.eval('window.dlDone')) === false;
  check(pac1 !== pac0 && pac1.includes('"media-cdn.test"') && pac1.includes(`"${PAGE_HOSTS.cf}"`) && !pac1.includes('google-analytics'),
    `Chrome получил новый PAC с привязанными доменами (через ${(attachMs / 1000).toFixed(1)} с после начала загрузки)`);
  check(stillLoading, 'в этот момент долгая загрузка во второй вкладке ещё шла');
  const dl = await tab2.eval('window.dl');
  check(dl.ok && dl.n === SLOW_CHUNKS * SLOW_CHUNK && dl.first === 'A' && dl.last === 'A',
    `смена PAC не оборвала загрузку в другой вкладке: ${dl.ok ? `получено ${dl.n} байт из ${SLOW_CHUNKS * SLOW_CHUNK} через сервер A за ${((Date.now() - dlStart) / 1000).toFixed(1)} с` : dl.error}`);

  // Подсказка на «Главной» для этой вкладки и «Обновить вкладку».
  const tabs2 = await win.eval(`chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url })))`);
  const pageTab = tabs2.find((t) => t.url === pageUrl);
  const home = await chrome2.page();
  await home.size(400, 600);
  await home.inject(`chrome.tabs.query = async () => [{ id: ${pageTab?.id ?? -1}, url: ${JSON.stringify(pageUrl)} }];`);
  await home.goto(`chrome-extension://${id2}/popup/popup.html`);
  const hint = await home.eval(js.siteNew);
  check(!!pageTab && hint.shown && hint.text === 'Найдены новые домены сайта — обновите вкладку' && hint.domains.includes('media-cdn.test') && /\+2 домена сайта/.test(hint.why),
    `«Главная»: «${hint.text}» (${hint.domains}); строка сайта — ${hint.why}`);
  if (shotsDir) await home.shot(join(shotsDir, 'popup-site-new.png'), 'light');
  // Правило удалили — подсказка про его домены не нужна; вернули — нужна снова (вкладку не обновляли).
  const ruleP = (await rulesOf())['page.test'];
  await win.eval(js.message({ type: 'removeRules', ids: [ruleP.id] }));
  const hintGone = await home.eval(`(async () => { ${wait} return wait(() => $('siteNew').hidden, 5000); })()`);
  await win.eval(js.message({ type: 'restoreRules', rules: [ruleP] }));
  const hintBack = await home.eval(js.siteNew);
  check(hintGone && hintBack.shown && hintBack.domains.includes('media-cdn.test'), 'правило удалили — подсказки «обновите вкладку» нет; вернули — она снова на месте');
  await home.eval(`document.getElementById('siteNewReload').click()`);
  view = {};
  for (let i = 0; i < 40 && !(view.cdn === 'Waysplit-OK A' && view.cf === 'Waysplit-OK A' && view.ga); i++) {
    await sleep(250);
    try { view = await pageView(tab1); } catch { view = {}; } // вкладка как раз перезагружается
  }
  check(view.cdn === 'Waysplit-OK A' && view.cf === 'Waysplit-OK A' && view.ga !== 'Waysplit-OK A',
    `«Обновить вкладку»: домены сайта пошли через VPN («${view.cdn}», «${view.cf}»), общий сервис — нет («${view.ga}»)`);
  const hintAfter = await home.eval(`(async () => { ${wait} await wait(() => $('siteNew').hidden, 5000); return { hidden: $('siteNew').hidden, session: (await chrome.storage.session.get('siteNew')).siteNew }; })()`);
  check(hintAfter.hidden && !hintAfter.session?.[pageTab?.id], 'после обновления вкладки подсказка убрана');
  // «Домены этой вкладки»: сайты, к которым обращалась вкладка (свой — первым), с пометкой, если
  // сайт идёт по правилу — своему или по «домену сайта» чужого правила.
  const tdl = await home.eval(`(async () => { ${wait}
    $('tdButton').focus();
    $('tdButton').click();
    await wait(() => $('tdList')?.children.length > 0, 5000);
    const sc = document.querySelector('.screen.td-screen');
    const out = { note: $('tdNote').textContent, rows: [...$('tdList').children].map((li) => li.querySelector('.td-name').textContent + (li.querySelector('.td-rule') ? ' — ' + li.querySelector('.td-rule').textContent : '')),
      title: sc?.querySelector('.screen-title').textContent, sub: sc?.querySelector('.screen-sub').textContent, onHome: !!$('panel-home').querySelector('#tdList, .td-list'),
      rowH: [...new Set([...$('tdList').querySelectorAll('label')].map((l) => l.offsetHeight))].join(','), icons: sc.querySelectorAll('img, .favicon').length,
      actions: !$('tdActions').hidden && $('tdActions').contains($('tdAction')) && $('tdAdd').textContent, listScrolls: getComputedStyle($('tdList')).overflowY,
      bodyScrolls: getComputedStyle(sc.querySelector('.screen-body')).overflowY, flags: /\\p{Regional_Indicator}/u.test(sc.innerText + [...$('tdAction').options].map((o) => o.textContent).join('')) };
    document.querySelector('.screen .back-key').click();
    await wait(() => !document.querySelector('.screen'), 3000);
    out.closed = !document.querySelector('.screen');
    out.focusBack = document.activeElement === $('tdButton');
    return out; })()`);
  check(tdl.rows.join('; ') === 'page.test — через VPN; cloudfront.net; google-analytics.com; media-cdn.test — через VPN' && /^Вкладка обращалась к 4 сайтам/.test(tdl.note),
    `«Домены этой вкладки»: ${tdl.rows.join('; ')}`);
  check(tdl.title === 'Домены этой вкладки' && tdl.sub === 'page.test' && !tdl.onHome && tdl.rowH === '36' && tdl.icons === 0 && tdl.actions === 'Добавить правила'
    && tdl.listScrolls === 'auto' && tdl.bodyScrolls === 'hidden' && !tdl.flags && tdl.closed && tdl.focusBack,
  `«Домены этой вкладки» — вложенный экран («${tdl.title}», «${tdl.sub}»): строки ${tdl.rowH} пикс., значков сайтов нет, внизу выбор действия и «${tdl.actions}», прокручивается только список; «назад» вернул фокус на ссылку`);
  [text] = await readUntil(tab2, `http://free.example:${sitePort}/`, 'Waysplit-OK DIRECT', 5000);
  check(text === 'Waysplit-OK DIRECT', `сайты без правил по-прежнему напрямую («${text}»)`);

  // Открытое окно не перечитывает данные, когда от запросов вкладок изменился только список доменов
  // вкладок (фон пишет его в память сеанса через 0,5 с после запроса), а на любое другое изменение —
  // перечитывает. Считаем перерисовки «Главной»; если в это же время изменилось что-то ещё
  // (например, сторож раз в минуту обновил состояние) — пробуем ещё раз.
  await home.eval(`globalThis.__ev = []; globalThis.__renders = 0;
    chrome.storage.onChanged.addListener((c, area) => { __ev.push(area + ':' + Object.keys(c).sort().join('+')); });
    new MutationObserver(() => { __renders++; }).observe(document.getElementById('content'), { childList: true, subtree: true, characterData: true }); 1`);
  let quiet = null;
  for (let i = 0; i < 3 && !quiet; i++) {
    await home.eval(`__ev.length = 0; __renders = 0; 1`);
    await readUntil(tab2, `http://free.example:${sitePort}/?${i}`, 'Waysplit-OK DIRECT', 5000);
    await sleep(1200);
    const seen = await home.eval(`({ ev: __ev, renders: __renders })`);
    if (seen.ev.length && seen.ev.every((e) => /^session:(tabDomains\+tabTops|tabDomains|tabTops)$/.test(e))) quiet = seen;
  }
  await home.eval(`__renders = 0; 1`);
  await win.eval(`chrome.storage.session.set({ probe: 1 })`);
  const woke = await home.eval(`(async () => { ${wait} await wait(() => __renders > 0, 3000); return __renders; })()`);
  await win.eval(`chrome.storage.session.remove('probe')`);
  check(!!quiet && quiet.renders === 0 && woke > 0,
    `открытое окно: от запросов вкладки (${quiet ? quiet.ev.join(', ') : 'чистого замера не вышло'}) — перерисовок ${quiet?.renders}; от другого изменения в памяти сеанса — перерисовалось`);

  // Строка правила и экран «Домены сайта»: убрать домен — он уходит из PAC и сам не возвращается.
  const rowS = await win.eval(js.ruleRow('page.test'));
  check(/\+2 домена сайта/.test(rowS?.sub), `строка правила: «page.test» — «${rowS?.sub}»`);
  if (shotsDir) await win.shot(join(shotsDir, 'options-rules-site-domains.png'), 'light');
  const sd = await win.eval(js.siteDomains('page.test', 'media-cdn.test'));
  check(sd.label === 'Домены сайта (2)…' && sd.title === 'Домены сайта · 2' && sd.sub === 'page.test' && sd.before.join(', ') === `media-cdn.test, ${PAGE_HOSTS.cf}`
    && /идут так же, как page\.test: через VPN/.test(sd.how) && /добавляются сами/.test(sd.auto),
  `меню «⋯» → «${sd.label}»: экран «${sd.title}» — ${sd.before?.join(', ')}`);
  check(sd.after?.join(', ') === PAGE_HOSTS.cf && /media-cdn\.test/.test(sd.removed) && /убран/.test(sd.toast), `убрали media-cdn.test: в списке — ${sd.after?.join(', ')}; «${sd.removed}»`);
  check(sd.sticky === 'true' && sd.restoreH >= 24, `сообщение с указанием остаётся до закрытия; ссылка «Вернуть убранные» — ${sd.restoreH} пикс. высотой`);
  if (shotsDir) await win.shot(join(shotsDir, 'options-site-domains.png'), 'light');
  await win.eval(js.tab('rules'));
  check(!(await win.eval(js.pac)).includes('media-cdn.test'), 'убранного домена больше нет в PAC');
  view = await openPage(tab1, 'Waysplit-OK A');
  await sleep(FLUSH_WAIT);
  const afterDrop = (await rulesOf())['page.test'];
  check(view.cdn === 'Waysplit-OK DIRECT' && view.cf === 'Waysplit-OK A' && afterDrop.siteDomains.join(', ') === PAGE_HOSTS.cf && afterDrop.siteDomainsRemoved.join(', ') === 'media-cdn.test',
    `вкладку обновили: убранный домен снова напрямую («${view.cdn}») и сам не вернулся; остальное — через VPN («${view.cf}»)`);

  // Удаление правила: между корзиной и «⋯» — не меньше 24 пикс.; в сообщении — «Вернуть», и правило
  // возвращается таким, каким было, вместе с доменами сайта.
  const beforeDel = (await rulesOf())['page.test'];
  const undo = await win.eval(`(async () => { ${wait}
    tab('rules');
    await wait(() => ruleLi('page.test'));
    const li = ruleLi('page.test');
    const glyph = (sel) => li.querySelector(sel + ' svg').getBoundingClientRect();
    const out = { gap: Math.round(glyph('[data-action="more"]').left - glyph('[data-action="remove"]').right) };
    clearToast();
    li.querySelector('[data-action="remove"]').click();
    await wait(() => /^Правило удалено/.test(toastText()) && !ruleLi('page.test'), 5000);
    out.toast = toastText();
    out.action = $('toast').querySelector('.toast-action')?.textContent || '';
    out.sticky = $('toast').dataset.sticky;
    out.gone = !ruleLi('page.test') && !(await chrome.storage.local.get('rules')).rules.some((r) => r.domain === 'page.test');
    $('toast').querySelector('.toast-action')?.click();
    await wait(() => ruleLi('page.test'), 5000);
    await sleep(300);
    out.back = !!ruleLi('page.test');
    out.after = toastText();
    return out; })()`);
  const afterUndo = (await rulesOf())['page.test'];
  check(undo.gap >= 24, `между значками корзины и «⋯» — ${undo.gap} пикс. (не меньше 24)`);
  check(undo.gone && undo.toast === 'Правило удалено: page.test' && undo.action === 'Вернуть' && undo.sticky === 'true', `корзина: «${undo.toast}» с кнопкой «${undo.action}»`);
  check(undo.back && JSON.stringify(afterUndo) === JSON.stringify(beforeDel) && (await win.eval(js.pac)).includes(`"${PAGE_HOSTS.cf}"`),
    `«Вернуть»: правило вернулось таким же — с доменами сайта (${afterUndo?.siteDomains.join(', ')}) и убранными (${afterUndo?.siteDomainsRemoved.join(', ')}); «${undo.after}»`);

  // Набор: правило на главный домен набора получает его домены — без отдельных правил.
  const addedY = await win.eval(js.addRule('youtube.com', 'proxy:'));
  const rowY = await win.eval(js.ruleRow('youtube.com'));
  const pacY = await win.eval(js.pac);
  check(/^Добавлено 1/.test(addedY) && /\+6 доменов сайта/.test(rowY?.sub) && pacY.includes('"googlevideo.com"') && pacY.includes('"yt3.googleusercontent.com"')
    && Object.keys(await rulesOf()).length === 3, `правило youtube.com: «${rowY?.sub}» из набора, в PAC — googlevideo.com и yt3.googleusercontent.com; правил по-прежнему 3`);
  // Выключили автосбор — новые домены не привязываются.
  check((await win.eval(js.checkbox('autoSiteDomains'))) === false, '«Автоматически добавлять домены сайта» в «Настройках» сняли');
  await win.eval(js.message({ type: 'restoreSiteDomains', id: afterDrop.id }));
  await openPage(tab1, 'Waysplit-OK A');
  await sleep(FLUSH_WAIT);
  check(((await rulesOf())['page.test'].siteDomains || []).join(', ') === PAGE_HOSTS.cf, 'автосбор выключен: страницу открыли снова — media-cdn.test не привязан');

  // Три вкладки одного сайта сразу. Новый домен находит та, что обратилась к нему первой, но
  // «обновите вкладку» нужна всем открытым: две остаются — подсказка у обеих. Третью закрываем,
  // пока домены ждут записи: домены правилу достаются, а подсказки для закрытой вкладки нет.
  await win.eval(js.message({ type: 'setSetting', key: 'autoSiteDomains', value: true }));
  const urls3 = [`${pageUrl}?first`, `${pageUrl}?second`, `${pageUrl}?closed`];
  const tabs3 = [await chrome2.page(), await chrome2.page(), await chrome2.page()];
  await Promise.all(tabs3.map((t, i) => openPage(t, 'Waysplit-OK A', urls3[i])));
  const open3 = await win.eval(`chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url })))`);
  const [idFirst, idSecond, idClosed] = urls3.map((u) => open3.find((t) => t.url === u)?.id);
  await chrome2.send('Target.closeTarget', { targetId: tabs3[2].targetId });
  await sleep(FLUSH_WAIT);
  const hintsLeft = await win.eval(`chrome.storage.session.get('siteNew').then((s) => s.siteNew || {})`);
  check(!!idClosed && ((await rulesOf())['page.test'].siteDomains || []).includes('media-cdn.test') && !(idClosed in hintsLeft),
    `вкладку закрыли до записи автосбора: media-cdn.test привязан, подсказки для закрытой вкладки нет (в памяти сеанса: ${JSON.stringify(hintsLeft)})`);
  check(!!idFirst && !!idSecond && [idFirst, idSecond].every((id) => hintsLeft[id]?.includes('media-cdn.test')),
    'две вкладки одного сайта: подсказка «обновите вкладку» — у обеих');

  await chrome2.close();
  check(await waitPort(27101, false, 10000), 'второй Chrome закрыт: ядро завершилось');

  // --- вкладка инкогнито: автосбор из неё ничего не привязывает ---
  // Третий запуск Chrome: той же копии расширения разрешаем работать в инкогнито — как галочкой на
  // chrome://extensions (без «режима разработчика» Chrome при этом выключил бы распакованное
  // расширение). Домены сайта хранятся в правилах, то есть на диске, — от вкладки инкогнито там
  // ничего остаться не должно; «Домены этой вкладки» для неё работают: это только память сеанса.
  // Галочка перезапускает расширение, поэтому сначала даём ему запуститься (перезапуск поверх
  // первого запуска оставляет фон без ответа), а после — открываем его страницу заново.
  // Не получилось подготовить Chrome — шаги пропускаются, и итоговая строка об этом говорит.
  console.log('\nВкладка инкогнито (копия расширения, которой разрешена работа в инкогнито):');
  const chrome3 = startChrome(join(work, 'profile3'), [PAGE_HOSTS.cf, PAGE_HOSTS.ga]);
  const { id: id3 } = await chrome3.send('Extensions.loadUnpacked', { path: siteDir });
  // answers — фон отвечает странице на команду (ждём не дольше 2 с); ready3 — новая вкладка со
  // страницей расширения, которой фон отвечает, или null.
  const answers = (p) => p.eval(`Promise.race([chrome.runtime.sendMessage({ type: 'tabDomains', tabId: 0 }).then((r) => !!(r && r.ok), () => false),
    new Promise((r) => setTimeout(() => r(false), 2000))])`).catch(() => false);
  const ready3 = async () => {
    const p = await chrome3.page();
    for (let i = 0; i < 15; i++) {
      await p.goto(`chrome-extension://${id3}/popup/popup.html?full`);
      if (await answers(p)) return p;
      await sleep(500);
    }
    return null;
  };
  let skip3 = (await ready3()) ? '' : 'расширение не запустилось';
  if (!skip3) {
    const extPage = await chrome3.page('chrome://extensions/');
    const allowed = await extPage.eval(`(async () => {
      if (!chrome.developerPrivate) return false;
      await new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r));
      await new Promise((r) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(id3)}, incognitoAccess: true }, r));
      await new Promise((r) => setTimeout(r, 1500)); // расширение перезапускается
      return new Promise((r) => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id3)}, (i) => r(!!(i && i.incognitoAccess && i.incognitoAccess.isActive) && i.state === 'ENABLED')));
    })()`).catch(() => false);
    if (!allowed) skip3 = 'Chrome не дал разрешить расширению работу в инкогнито';
  }
  const win3 = skip3 ? null : await ready3();
  if (!skip3 && !win3) skip3 = 'после разрешения работать в инкогнито фон расширения не отвечает';
  if (skip3) {
    skipped.push(`вкладка инкогнито (${skip3})`);
    console.log(`ПРОПУСК  ${skip3} — шаги про вкладку инкогнито не проверены`);
  } else {
    const added3 = await win3.eval(js.add(linkA));
    const rule3 = await Promise.race([win3.eval(js.message({ type: 'addRules', domains: ['page.test'], action: 'proxy', serverId: null })), sleep(70000).then(() => null)]);
    const incognito = await chrome3.page(undefined, (await chrome3.send('Target.createBrowserContext')).browserContextId);
    let seen = {};
    for (let i = 0; i < 40 && !(seen.me && seen.cdn && seen.cf && seen.ga); i++) {
      if (i % 10 === 0) await incognito.goto(pageUrl);
      seen = await pageView(incognito);
      if (!(seen.me && seen.cdn && seen.cf && seen.ga)) await sleep(250);
    }
    await sleep(FLUSH_WAIT);
    const state3 = () => win3.eval(`(async () => {
      const inc = (await chrome.tabs.query({})).find((t) => t.incognito);
      const s = await chrome.storage.session.get(['tabDomains', 'siteNew']);
      return { inc: inc ? inc.id : null, domains: inc ? (s.tabDomains || {})[inc.id] || [] : [], hints: s.siteNew || {},
        rule: (await chrome.storage.local.get('rules')).rules.find((r) => r.domain === 'page.test') }; })()`);
    let s3 = await state3();
    check(/^Добавлено 1/.test(added3) && !!rule3?.ok && s3.inc !== null && s3.domains.includes(PAGE_HOSTS.cdn) && s3.domains.includes(PAGE_HOSTS.cf),
      `вкладка инкогнито открыла страницу (${seen.me}); её запросы видны в «Доменах этой вкладки» (только память сеанса): ${s3.domains.join(', ') || 'пусто'}`);
    check(!!s3.rule && s3.rule.siteDomains.length === 0 && !(s3.inc in s3.hints),
      `из вкладки инкогнито к правилу page.test ничего не привязано (${JSON.stringify(s3.rule?.siteDomains)}), подсказки «обновите вкладку» для неё нет`);
    // Та же страница в обычной вкладке: домены привязываются, как раньше, и подсказка — только у неё.
    await openPage(await chrome3.page(), 'Waysplit-OK A');
    for (let i = 0; i < 40 && !s3.rule?.siteDomains.length; i++) {
      await sleep(250);
      s3 = await state3();
    }
    check(s3.rule?.siteDomains.join(', ') === `media-cdn.test, ${PAGE_HOSTS.cf}` && Object.keys(s3.hints).length === 1 && !(s3.inc in s3.hints),
      `та же страница в обычной вкладке: привязаны ${s3.rule?.siteDomains.join(', ') || 'ничего'}; подсказка — только у обычной вкладки`);
  }
  await chrome3.close();
  check(await waitPort(27101, false, 10000), 'третий Chrome закрыт: ядро завершилось');
} catch (e) {
  check(false, e.message);
} finally {
  for (const f of cleanup.reverse()) f();
  await sleep(1500);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* Chrome ещё держит файлы — не страшно */ }
}
console.log(failed ? '\nЕСТЬ ОШИБКИ' : skipped.length ? `\nВсё в порядке; не проверено: ${skipped.join('; ')}` : '\nВсё в порядке');
process.exit(failed ? 1 : 0);
