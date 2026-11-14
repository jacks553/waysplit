// Скриншоты всех экранов окна расширения — для проверки глазами (SPEC-POPUP.md):
//   node tools/popup-shots.js [папка]     (по умолчанию dist/popup-shots, в git не попадает)
// Каждый экран — в светлой и тёмной теме, 400×600 (как окно на панели Chrome), плюс развёрнутая
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
    const ctl = await chrome.page(400, 600);
    await ctl.goto(`${base}/popup/popup.html?full`);
    const { msg } = await seed(ctl);
    // Ещё отключённое правило — как его видно в списке.
    await msg({ type: 'addRules', domains: ['mail.example.org'], action: 'direct' });
    const mail = (await ctl.eval(`chrome.storage.local.get('rules')`)).rules.find((r) => r.domain === 'mail.example.org');
    await msg({ type: 'updateRule', id: mail.id, patch: { enabled: false } });
    // «Домены сайта»: правило на главный домен набора — к нему привязаны домены набора.
    await msg({ type: 'addRules', domains: ['youtube.com'], action: 'proxy' });

    const pop = await chrome.page(400, 600);
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
      await shot('04-home-off', 'Главная: VPN выключен, работают правила; у сайта правила нет');
      await shot('05-home-off-rule', 'Главная: VPN выключен, работают правила; у сайта правило «через VPN» (через выбранный сервер)', null, 'https://news.example.org/today');
      await msg({ type: 'setSetting', key: 'rulesWhenOff', value: false });
      await shot('06-home-off-rule-sleeping', 'Главная: правило не действует — флаг сервера из правила приглушён, в строке «Включить»', null, 'https://news.example.org/today');
      await shot('31-home-off-plain', 'Главная: VPN выключен (правила при выключенном VPN отключены), у сайта нет правила');
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

      // «Домены сайта»: строка правила «+N доменов сайта», меню «⋯», экран со списком, подсказка
      // на «Главной», карточка разрешения (один раз, после первого правила «через VPN»).
      const ytMore = `[...document.querySelectorAll('#rulesList .rule')].find((x) => x.querySelector('.rule-domain').textContent === 'youtube.com').querySelector('[data-action="more"]').click()`;
      await shot('20-rule-site-domains', 'Вкладка «Правила»: у правила youtube.com — «+6 доменов сайта», в меню ⋯ — «Домены сайта (6)…»', `${tab('rules')}; ${pause}; ${ytMore}`);
      await shot('21-site-domains', 'Экран «Домены сайта»: что привязано к правилу, убрать любой домен',
        `${tab('rules')}; ${pause}; ${ytMore}; ${pause}; [...document.querySelectorAll('#pop .pop-item')].find((x) => x.textContent.includes('Домены сайта')).click()`);
      await ctl.eval(`chrome.storage.session.set({ siteNew: { 4242: ['googlevideo.com', 'ytimg.com'] } })`);
      await msg({ type: 'toggle', enabled: false });
      await shot('22-home-site-new', 'Главная: автосбор нашёл новые домены сайта — «обновите вкладку»', null, 'https://www.youtube.com/watch');
      await ctl.eval(`chrome.storage.session.set({ siteNew: {} })`);
      await msg({ type: 'setSetting', key: 'siteDomainsAsked', value: false });
      await shot('23-home-permission', 'Главная: карточка разрешения — один раз, после первого правила «через VPN»', null, 'https://www.youtube.com/watch');
      await shot('24-rules-permission', 'Вкладка «Правила»: та же карточка разрешения', tab('rules'));
      await msg({ type: 'setSetting', key: 'siteDomainsAsked', value: true });
      await shot('25-settings-site-domains', 'Настройки: «Российские сайты — без VPN», «Автоматически добавлять домены сайта» и «нужно разрешение Chrome»', `${tab('settings')}; ${pause}; document.getElementById('autoSiteDomains').scrollIntoView({ block: 'center' })`);
      await msg({ type: 'toggle', enabled: true });

      // «Российские сайты — без VPN»: переключатель на «Главной» (настройка, а не правила),
      // напоминание на «Правилах», галочка на «Начале работы».
      await shot('26-home-ru-off', 'Главная: «Российские сайты — без VPN» выключен — российский сайт идёт через VPN, как остальные', null, 'https://gorod-primer.ru/novosti');
      await msg({ type: 'setSetting', key: 'ruDirect', value: true });
      await shot('27-home-ru-on', 'Главная: «Российские сайты — без VPN» включён — «Напрямую: российский сайт»', null, 'https://gorod-primer.ru/novosti');
      await shot('28-rules-ru', 'Вкладка «Правила»: напоминание «Российские сайты — без VPN: включено»', tab('rules'));
      // Корзина удаляет правило сразу — в сообщении «Вернуть»; после кадра правило возвращаем.
      await shot('30-rules-undo', 'Вкладка «Правила»: «Правило удалено» с кнопкой «Вернуть» и крестиком',
        `${tab('rules')}; ${pause}; [...document.querySelectorAll('#rulesList .rule')].find((x) => x.querySelector('.rule-domain').textContent === 'news.example.org').querySelector('[data-action="remove"]').click()`);
      await pop.eval(`(async () => { document.querySelector('#toast .toast-action').click(); await new Promise((r) => setTimeout(r, 600)); return 1; })()`);
      await shot('29-welcome-ru', '«Начало работы»: галочка «Российские сайты — без VPN» на шаге со ссылкой', `document.getElementById('ruDirect').scrollIntoView({ block: 'center' })`, 'https://gorod-primer.ru/novosti', full, `${base}/welcome/welcome.html`);
      await msg({ type: 'setSetting', key: 'ruDirect', value: false });
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
<body><h1>Waysplit — окно расширения (SPEC-POPUP.md)</h1><p>Слева — светлая тема, справа — тёмная. Окно 400×600, как на панели Chrome; данные вымышленные.</p>
${rows}</body></html>`);
  console.log('Готово:', join(outDir, 'index.html'));
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
});
