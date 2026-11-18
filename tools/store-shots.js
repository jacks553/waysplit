// Скриншоты для Chrome Web Store (SPEC-STORE.md, 2.5; SPEC-POPUP.md): node tools/store-shots.js [--lang=en] [папка]
// По умолчанию — store/screenshots: пять картинок 1280×800 (PNG). С --lang=en — те же кадры
// по-английски (окно, подписи и вымышленные данные) в store/screenshots-en: для английского
// языка карточки магазина (версия 1.2.0).
//
// Настоящее окно расширения на вымышленных данных — копия расширения с подделкой компаньона
// (tools/shots-lib.js). Окно показано на фоне в цветах значка с подписью — как его видно на панели
// Chrome. Кадры: 1 — «Главная» (подключено, «Этот сайт» — без VPN по правилу); 2 — выбор сервера
// (избранное, подписка, столбики сигнала); 3 — правила сайтов (у одного — «+4 домена сайта»); 4 — серверы с подпиской;
// 5 — два вида окна рядом: новое (тёмный корпус) и классическое (светлая тема), подпись над окнами.
// На кадрах 1–4 — новое окно с тёмным корпусом: таким его видят изначально (версия 1.3.0).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareExtension, root, seed, sleep, startChrome } from './shots-lib.js';

const args = process.argv.slice(2);
const LANG = args.includes('--lang=en') ? 'en' : 'ru';
const outDir = resolve(args.find((a) => !a.startsWith('--')) || join(root, 'store', LANG === 'en' ? 'screenshots-en' : 'screenshots'));

// Подписи к кадрам: заголовок и текст слева от окна.
const CAPTIONS = {
  ru: [
    ['VPN только для Chrome', 'Нужные сайты идут через ваш сервер, остальные без VPN. Другие программы на компьютере VPN не затрагивает.'],
    ['Ваши серверы под рукой', 'Ссылки VLESS, XHTTP и Hysteria2 или подписка провайдера. Поиск, пинг и избранное: сервер выбирается в одно касание.'],
    ['Свой путь для каждого сайта', 'Через VPN, через выбранный сервер или без VPN. Правило для открытого сайта задаётся прямо на главной.'],
    ['Подписки обновляются сами', 'Трафик, срок действия и сообщения провайдера видно сразу. Серверы подписки и свои стоят в одном списке.'],
    ['Два вида окна', 'Новый и классический. Переключается кнопкой Waysplit в шапке. Светлая и тёмная тема в обоих.'],
  ],
  en: [
    ['VPN for Chrome only', 'The sites you choose go through your server, the rest go without VPN. Other programs on your computer are not affected.'],
    ['Your servers at hand', 'VLESS, XHTTP and Hysteria2 links, or a subscription from your provider. Search, ping and favorites: pick a server in one click.'],
    ['A route for every site', 'Through VPN, through a server you choose, or without VPN. The rule for the open site is right on the Home tab.'],
    ['Subscriptions update automatically', 'Traffic, expiry date and provider messages at a glance. Subscription servers and your own in one list.'],
    ['Two designs', 'New and classic. Switch with the Waysplit button in the popup header. Light and dark themes are in both.'],
  ],
}[LANG];
const work = mkdtempSync(join(tmpdir(), 'waysplit-shots-'));

// Сцена: окно расширения (popup.html во фрейме, 400×600 — как на панели) на фоне в цветах значка,
// слева — подпись.
const stageHtml = `<!doctype html>
<html lang="${LANG}"><head><meta charset="utf-8"><title>Waysplit</title>
<link rel="stylesheet" href="stage.css"><script src="stage.js" defer></script></head>
<body><main class="stage">
  <section class="caption"><img src="../icons/icon128.png" alt="" width="112" height="112"><h1 id="title"></h1><p id="text"></p></section>
  <div class="windows">
    <div class="window"><iframe id="popup" src="../popup/popup.html" title="Waysplit"></iframe></div>
    <div class="window" id="second" hidden><iframe id="classic" title="Waysplit"></iframe></div>
  </div>
</main></body></html>
`;
const stageCss = `html, body { margin: 0; height: 100%; }
body { font-family: "Segoe UI", system-ui, sans-serif; color: #fff; overflow: hidden;
  background: linear-gradient(135deg, #2563eb 0%, #1d6fd0 45%, #0d9488 100%); }
.stage { --z: 1.2; height: 100%; box-sizing: border-box; padding: 0 96px 0 96px;
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 64px; }
.caption img { display: block; margin: 0 0 8px -16px; }
.caption h1 { font-size: 46px; line-height: 1.15; margin: 0 0 18px; font-weight: 700; letter-spacing: -0.5px; }
.caption p { font-size: 23px; line-height: 1.45; margin: 0; max-width: 540px; opacity: 0.94; }
.window { width: calc(400px * var(--z)); height: calc(600px * var(--z)); border-radius: 14px; overflow: hidden;
  box-shadow: 0 28px 70px rgba(4, 20, 60, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.15); }
iframe { display: block; border: 0; width: 400px; height: 600px; transform: scale(var(--z)); transform-origin: 0 0; }
.windows { display: flex; gap: 48px; }
[hidden] { display: none !important; }
/* Кадр «два вида окна»: два окна рядом с подписью слева не помещаются — подпись стоит над окнами. */
.stage.two { --z: 0.96; grid-template-columns: 1fr; grid-template-rows: auto auto; align-content: center; justify-items: center; gap: 26px; }
.stage.two .caption { display: grid; grid-template-columns: auto auto; column-gap: 20px; align-items: center; justify-content: center; }
.stage.two .caption img { grid-row: 1 / 3; width: 84px; height: 84px; margin: 0; }
.stage.two .caption h1 { font-size: 40px; margin: 0 0 4px; }
.stage.two .caption p { font-size: 20px; max-width: none; }
`;
const stageJs = `const q = new URLSearchParams(location.search);
document.getElementById('title').textContent = q.get('t') || '';
document.getElementById('text').textContent = q.get('p') || '';
// two=1 — кадр «два вида окна»: рядом с новым окном классическое.
if (q.get('two')) {
  document.querySelector('.stage').classList.add('two');
  document.getElementById('second').hidden = false;
  document.getElementById('classic').src = '../classic/popup.html';
}
`;

async function main() {
  const ext = await prepareExtension(work, (dir) => {
    mkdirSync(join(dir, 'shots'));
    writeFileSync(join(dir, 'shots', 'stage.html'), stageHtml);
    writeFileSync(join(dir, 'shots', 'stage.css'), stageCss);
    writeFileSync(join(dir, 'shots', 'stage.js'), stageJs);
  }, LANG);
  mkdirSync(outDir, { recursive: true });
  const chrome = startChrome(join(work, 'profile'));
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: ext });
    const base = `chrome-extension://${id}`;
    const ctl = await chrome.page(400, 600);
    await ctl.goto(`${base}/popup/popup.html?full`);
    const { msg } = await seed(ctl, LANG);
    // «Домены сайта» (новое в 1.1.0): у правила video.example.com — четыре привязанных домена
    // (вымышленные), в строке правила видно «+4 домена сайта». Привязка — как при импорте правил.
    await msg({ type: 'importRules', data: { type: 'rules', rules: [{ domain: 'video.example.com', action: 'proxy', server: null, enabled: true,
      siteDomains: ['video-cdn.example.net', 'img-video.example.net', 'static-video.example.org', 'player.example.org'], siteDomainsRemoved: [] }] } });
    // Тема нового окна — изначальная, тёмная; у классического — светлая (кадр 5).
    await msg({ type: 'setSetting', key: 'themeLcd', value: 'dark' });
    await msg({ type: 'setSetting', key: 'theme', value: 'light' });
    await msg({ type: 'toggle', enabled: true });

    const stage = await chrome.page(1280, 800);
    // Открытая вкладка браузера «как будто» — адрес из localStorage (задаётся перед каждым кадром).
    // На кадре 5 рядом стоят оба окна, а настройка «Вид окна» одна: классическому окну во фрейме
    // отвечаем, что выбрано оно, — иначе оно само перешло бы в новое (lib/design.js).
    await stage.inject(`if (location.pathname.endsWith('/popup.html')) {
      const u = localStorage.getItem('shot-site');
      chrome.tabs.query = async () => (u ? [{ id: 4242, active: true, url: u }] : []);
      if (location.pathname.endsWith('/classic/popup.html')) {
        const get = chrome.storage.local.get.bind(chrome.storage.local);
        chrome.storage.local.get = async (keys) => { const r = await get(keys); if (r.settings) r.settings = { ...r.settings, design: 'classic' }; return r; };
      }
    }`);
    // shot — кадр: сайт во вкладке, подпись, что сделать в окне до снимка (код во фрейме окна).
    const shot = async (file, site, title, text, prep = '', two = false) => {
      await ctl.eval(`localStorage.setItem('shot-site', ${JSON.stringify(site)})`);
      await stage.goto(`${base}/shots/stage.html?t=${encodeURIComponent(title)}&p=${encodeURIComponent(text)}${two ? '&two=1' : ''}`);
      await sleep(two ? 1500 : 900); // пинг текущего сервера в статусе
      const ok = await stage.eval(`(async () => {
        const doc = document.getElementById('popup').contentDocument;
        const click = (sel) => doc.querySelector(sel).click();
        ${prep}
        await new Promise((r) => setTimeout(r, 600));
        const shown = (d, path) => !!d && d.location.pathname.endsWith(path) && d.documentElement.classList.contains('ready') && !!d.querySelector('.tabbar .tab[aria-selected="true"]');
        return shown(doc, '/popup/popup.html') && (${two ? `shown(document.getElementById('classic').contentDocument, '/classic/popup.html')` : 'true'}); })()`);
      if (!ok) throw new Error(`${file}: окно расширения не показалось`);
      await stage.shot(join(outDir, file));
      console.log('снимок', join(outDir, file));
    };

    await shot('1-popup.png', 'https://www.bank.example.net/login', ...CAPTIONS[0]);
    await shot('2-servers.png', 'https://shop.example.org/catalog', ...CAPTIONS[1], "click('#serverRow');");
    await shot('3-rules.png', 'https://shop.example.org/catalog', ...CAPTIONS[2], "click('.tabbar .tab[data-tab=\"rules\"]');");
    await shot('4-subscription.png', 'https://shop.example.org/catalog', ...CAPTIONS[3], "click('.tabbar .tab[data-tab=\"servers\"]');");
    await shot('5-designs.png', 'https://news.example.org/today', ...CAPTIONS[4], '', true);
    await msg({ type: 'setSetting', key: 'theme', value: 'system' });
  } finally {
    await chrome.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
});
