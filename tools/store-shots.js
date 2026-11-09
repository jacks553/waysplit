// Скриншоты для Chrome Web Store (SPEC-STORE.md, 2.5; SPEC-POPUP.md): node tools/store-shots.js [папка]
// По умолчанию — store/screenshots: пять картинок 1280×800 (PNG).
//
// Настоящее окно расширения на вымышленных данных — копия расширения с подделкой компаньона
// (tools/shots-lib.js). Окно показано на фоне в цветах значка с подписью — как его видно на панели
// Chrome. Кадры: 1 — «Главная» (подключено, «Этот сайт» — напрямую по правилу); 2 — выбор сервера
// (избранное, подписка, полоски); 3 — правила сайтов; 4 — серверы с подпиской; 5 — тёмная тема.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareExtension, root, seed, sleep, startChrome } from './shots-lib.js';

const outDir = resolve(process.argv[2] || join(root, 'store', 'screenshots'));
const work = mkdtempSync(join(tmpdir(), 'waysplit-shots-'));

// Сцена: окно расширения (popup.html во фрейме, 400×580 — как на панели) на фоне в цветах значка,
// слева — подпись.
const stageHtml = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Waysplit</title>
<link rel="stylesheet" href="stage.css"><script src="stage.js" defer></script></head>
<body><main class="stage">
  <section class="caption"><img src="../icons/icon128.png" alt="" width="112" height="112"><h1 id="title"></h1><p id="text"></p></section>
  <div class="window"><iframe id="popup" src="../popup/popup.html" title="Waysplit"></iframe></div>
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
.window { width: calc(400px * var(--z)); height: calc(580px * var(--z)); border-radius: 14px; overflow: hidden;
  box-shadow: 0 28px 70px rgba(4, 20, 60, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.15); }
iframe { display: block; border: 0; width: 400px; height: 580px; transform: scale(var(--z)); transform-origin: 0 0; }
`;
const stageJs = `const q = new URLSearchParams(location.search);
document.getElementById('title').textContent = q.get('t') || '';
document.getElementById('text').textContent = q.get('p') || '';
`;

async function main() {
  const ext = await prepareExtension(work, (dir) => {
    mkdirSync(join(dir, 'shots'));
    writeFileSync(join(dir, 'shots', 'stage.html'), stageHtml);
    writeFileSync(join(dir, 'shots', 'stage.css'), stageCss);
    writeFileSync(join(dir, 'shots', 'stage.js'), stageJs);
  });
  mkdirSync(outDir, { recursive: true });
  const chrome = startChrome(join(work, 'profile'));
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: ext });
    const base = `chrome-extension://${id}`;
    const ctl = await chrome.page(400, 580);
    await ctl.goto(`${base}/popup/popup.html?full`);
    const { msg } = await seed(ctl);
    await msg({ type: 'setSetting', key: 'theme', value: 'light' });
    await msg({ type: 'toggle', enabled: true });

    const stage = await chrome.page(1280, 800);
    // Открытая вкладка браузера «как будто» — адрес из localStorage (задаётся перед каждым кадром).
    await stage.inject(`if (location.pathname.endsWith('/popup/popup.html')) {
      const u = localStorage.getItem('shot-site');
      chrome.tabs.query = async () => (u ? [{ id: 4242, active: true, url: u }] : []);
    }`);
    // shot — кадр: сайт во вкладке, подпись, что сделать в окне до снимка (код во фрейме окна).
    const shot = async (file, site, title, text, prep = '') => {
      await ctl.eval(`localStorage.setItem('shot-site', ${JSON.stringify(site)})`);
      await stage.goto(`${base}/shots/stage.html?t=${encodeURIComponent(title)}&p=${encodeURIComponent(text)}`);
      await sleep(900); // пинг текущего сервера в статусе
      const ok = await stage.eval(`(async () => {
        const doc = document.getElementById('popup').contentDocument;
        const click = (sel) => doc.querySelector(sel).click();
        ${prep}
        await new Promise((r) => setTimeout(r, 600));
        return !!doc.querySelector('.tabbar .tab[aria-selected="true"]'); })()`);
      if (!ok) throw new Error(`${file}: окно расширения не показалось`);
      await stage.shot(join(outDir, file));
      console.log('снимок', join(outDir, file));
    };

    await shot('1-popup.png', 'https://www.bank.example.net/login', 'VPN только для Chrome',
      'Нужные сайты — через ваш сервер, остальные — напрямую. Другие программы на компьютере VPN не затрагивает.');
    await shot('2-servers.png', 'https://shop.example.org/catalog', 'Ваши серверы под рукой',
      'Ссылки VLESS (в том числе XHTTP) и Hysteria2 или подписка провайдера. Поиск, пинг и избранное — сервер выбирается в одно касание.',
      "click('#serverRow');");
    await shot('3-rules.png', 'https://shop.example.org/catalog', 'Свой путь для каждого сайта',
      'Через VPN, через выбранный сервер или напрямую. Правило для открытого сайта — прямо на главной.',
      "click('.tabbar .tab[data-tab=\"rules\"]');");
    await shot('4-subscription.png', 'https://shop.example.org/catalog', 'Подписки обновляются сами',
      'Трафик, срок действия и сообщения провайдера видно сразу. Серверы подписки и свои — в одном списке.',
      "click('.tabbar .tab[data-tab=\"servers\"]');");
    await msg({ type: 'setSetting', key: 'theme', value: 'dark' });
    await shot('5-dark.png', 'https://news.example.org/today', 'Светлая и тёмная тема',
      'Как в системе или на ваш выбор. Всё управление — прямо в окне расширения.');
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
