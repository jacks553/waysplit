// Скриншоты всех экранов окна расширения — для проверки глазами (SPEC-POPUP.md):
//   node tools/popup-shots.js [папка]     (по умолчанию dist/popup-shots, в git не попадает)
// Каждый экран — в светлой и тёмной теме, 400×580 (как окно на панели Chrome), плюс развёрнутая
// страница. Рядом — index.html: все кадры на одной странице, светлая и тёмная тема рядом.
// Данные вымышленные, компаньон — подделка (tools/shots-lib.js); ошибка в странице останавливает съёмку.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareExtension, root, seed, startChrome } from './shots-lib.js';

const outDir = resolve(process.argv[2] || join(root, 'dist', 'popup-shots'));
const work = mkdtempSync(join(tmpdir(), 'waysplit-popup-shots-'));

async function main() {
  const ext = await prepareExtension(work);
  mkdirSync(outDir, { recursive: true });
  const chrome = startChrome(join(work, 'profile'));
  const shots = [];
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: ext });
    const base = `chrome-extension://${id}`;
    const ctl = await chrome.page(400, 580);
    await ctl.goto(`${base}/popup/popup.html?full`);
    const { msg } = await seed(ctl);
    // Ещё отключённое правило — как его видно в списке.
    await msg({ type: 'addRules', domains: ['mail.example.org'], action: 'direct' });
    const mail = (await ctl.eval(`chrome.storage.local.get('rules')`)).rules.find((r) => r.domain === 'mail.example.org');
    await msg({ type: 'updateRule', id: mail.id, patch: { enabled: false } });

    const pop = await chrome.page(400, 580);
    // Открытая вкладка браузера «как будто» — адрес из localStorage (задаётся перед каждым кадром).
    await pop.inject(`if (location.pathname.endsWith('/popup/popup.html')) {
      const u = localStorage.getItem('shot-site');
      chrome.tabs.query = async () => (u ? [{ id: 4242, active: true, url: u }] : []);
    }`);
    const full = await chrome.page(1100, 720);

    for (const theme of ['light', 'dark']) {
      await msg({ type: 'setSetting', key: 'theme', value: theme });
      const shot = async (name, title, prep = null, site = 'https://shop.example.org/catalog', page = pop, url = `${base}/popup/popup.html`) => {
        await ctl.eval(`localStorage.setItem('shot-site', ${JSON.stringify(site)})`); // общий для страниц расширения
        await page.goto(url);
        if (prep) await page.eval(`(async () => { ${prep}; await new Promise((r) => setTimeout(r, 500)); return 1; })()`);
        const file = `${theme}-${name}.png`;
        await page.shot(join(outDir, file));
        if (theme === 'light') shots.push({ name, title });
        console.log('снимок', file);
      };
      const click = (sel) => `document.querySelector(${JSON.stringify(sel)}).click()`;
      const tab = (name) => click(`.tabbar .tab[data-tab="${name}"]`);
      const pause = 'await new Promise((r) => setTimeout(r, 200))';

      await msg({ type: 'setSetting', key: 'rulesWhenOff', value: true });
      await msg({ type: 'toggle', enabled: true });
      await shot('01-home-on', 'Главная: VPN включён, «Этот сайт» без правила');
      await shot('02-home-on-rule', 'Главная: VPN включён, у сайта правило «без VPN»', null, 'https://www.bank.example.net/login');
      await shot('03-home-on-video', 'Главная: правило для сайта, выбор домена (поддомен или весь сайт)', null, 'https://video.example.com/watch');
      await msg({ type: 'toggle', enabled: false });
      await shot('04-home-off', 'Главная: VPN выключен, «Этот сайт» без правила');
      await shot('05-home-off-rule', 'Главная: VPN выключен, правило «через VPN» работает (через выбранный сервер)', null, 'https://news.example.org/today');
      await msg({ type: 'setSetting', key: 'rulesWhenOff', value: false });
      await shot('06-home-off-rule-sleeping', 'Главная: правило не действует — флаг сервера из правила приглушён, в строке «Включить»', null, 'https://news.example.org/today');
      await msg({ type: 'setSetting', key: 'rulesWhenOff', value: true });
      await msg({ type: 'toggle', enabled: true });
      await shot('07-picker', 'Выбор сервера: избранное сверху, группы по подпискам, полоски, звёздочки', click('#serverRow'));
      await shot('08-picker-site', 'Выбор сервера для сайта: прокручен к выбранному и подсвечен', click('#siteServer'), 'https://news.example.org/today');
      await shot('09-servers', 'Вкладка «Серверы»: подписка и свои серверы', tab('servers'));
      await shot('10-servers-menu', 'Вкладка «Серверы»: меню ⋯ у сервера', `${tab('servers')}; ${pause}; document.querySelectorAll('#srvGroups .srv .more')[1].click()`);
      await shot('11-subscription', 'Сведения о подписке', `${tab('servers')}; ${pause}; ${click('#srvGroups .sub-open')}`);
      await shot('12-add', 'Добавление серверов', `${tab('servers')}; ${click('#srvAdd')}`);
      await shot('13-rules', 'Вкладка «Правила»: метка «без VPN» / флаг сервера, корзина, меню ⋯', tab('rules'));
      await shot('14-rules-menu', 'Вкладка «Правила»: меню ⋯ у правила', `${tab('rules')}; ${pause}; document.querySelectorAll('#rulesList .rule [data-action="more"]')[2].click()`);
      await shot('15-rules-tab-menu', 'Вкладка «Правила»: меню ⋯ вкладки', `${tab('rules')}; ${pause}; ${click('#rulesMore')}`);
      await shot('16-settings', 'Вкладка «Настройки»', tab('settings'));
      await shot('17-settings-bottom', 'Вкладка «Настройки»: внизу — диагностика, помощь, версии', `${tab('settings')}; ${pause}; document.getElementById('content').scrollTop = 99999`);
      await shot('18-diag', 'Диагностика', `${tab('settings')}; ${click('#openDiag')}; await new Promise((r) => setTimeout(r, 400))`);
      await shot('19-full', '«Развернуть»: тот же интерфейс на всю вкладку', null, 'https://shop.example.org/catalog', full, `${base}/popup/popup.html?full&site=shop.example.org&tabId=4242#servers`);
    }
  } finally {
    await chrome.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  // Лист для просмотра: светлая и тёмная тема рядом.
  const rows = shots.map((s) => `<section><h2>${s.title}</h2><div class="pair"><img src="light-${s.name}.png" alt="${s.title}, светлая тема"><img src="dark-${s.name}.png" alt="${s.title}, тёмная тема"></div></section>`).join('\n');
  writeFileSync(join(outDir, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Waysplit — окно расширения</title>
<style>body{margin:0;padding:24px;background:#e9edf4;font:15px/1.4 "Segoe UI",system-ui,sans-serif;color:#172033}
h1{font-size:22px;margin:0 0 4px}p{margin:0 0 20px;color:#5d6b82}section{margin:0 0 28px}h2{font-size:15px;margin:0 0 8px}
.pair{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.pair img{display:block;max-width:100%;border-radius:10px;box-shadow:0 6px 24px rgb(23 32 51/.18)}</style></head>
<body><h1>Waysplit — окно расширения (SPEC-POPUP.md)</h1><p>Слева — светлая тема, справа — тёмная. Окно 400×580, как на панели Chrome; данные вымышленные.</p>
${rows}</body></html>`);
  console.log('Готово:', join(outDir, 'index.html'));
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
});
