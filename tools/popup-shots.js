// Скриншоты всех экранов окна расширения — для проверки глазами (SPEC-POPUP.md):
//   node tools/popup-shots.js [папка] [--lang=en]
// По умолчанию — по-русски, в dist/popup-shots; с --lang=en — по-английски (и окно, и вымышленные
// данные), в dist/popup-shots-en. В git эти папки не попадают.
// Каждый экран — в светлой и тёмной теме, 400×600 (как окно на панели Chrome), плюс развёрнутая
// страница. Рядом — index.html: все кадры на одной странице, светлая и тёмная тема рядом.
// Данные вымышленные, компаньон — подделка (tools/shots-lib.js); ошибка в странице останавливает съёмку.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareExtension, root, seed, startChrome } from './shots-lib.js';

const args = process.argv.slice(2);
const lang = args.find((a) => a.startsWith('--lang='))?.slice(7) || 'ru';
const outDir = resolve(args.find((a) => !a.startsWith('--')) || join(root, 'dist', lang === 'ru' ? 'popup-shots' : `popup-shots-${lang}`));
const work = mkdtempSync(join(tmpdir(), 'waysplit-popup-shots-'));

async function main() {
  const ext = await prepareExtension(work, null, lang);
  mkdirSync(outDir, { recursive: true });
  const chrome = startChrome(join(work, 'profile'), { scrollbars: true }); // полосы прокрутки видны, как в настоящем окне
  const shots = [];
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: ext });
    const base = `chrome-extension://${id}`;
    const ctl = await chrome.page(400, 600);
    await ctl.goto(`${base}/popup/popup.html?full`);
    const { msg } = await seed(ctl, lang);
    // Ещё отключённое правило — как его видно в списке.
    await msg({ type: 'addRules', domains: ['mail.example.org'], action: 'direct' });
    const mail = (await ctl.eval(`chrome.storage.local.get('rules')`)).rules.find((r) => r.domain === 'mail.example.org');
    await msg({ type: 'updateRule', id: mail.id, patch: { enabled: false } });
    // «Домены сайта»: правило на главный домен набора — к нему привязаны домены набора.
    await msg({ type: 'addRules', domains: ['youtube.com'], action: 'proxy' });

    const pop = await chrome.page(400, 600);
    const full = await chrome.page(1100, 720);
    // Подмены для кадров — из localStorage (общий для страниц расширения, задаётся перед кадром):
    //   shot-site — адрес открытой вкладки браузера «как будто»;
    //   shot-td   — домены этой вкладки (ответ фона на tabDomains), JSON-список;
    //   shot-perm — разрешение видеть запросы вкладок: yes — есть, ask — Chrome спрашивает, no — отказали;
    //   shot-host — none: компаньон не установлен (ответ на hello);
    //   shot-report — отчёт «Проверить подписку» (подделка компаньона его не составляет).
    const stubs = `if (location.protocol === 'chrome-extension:') {
      const get = (k) => localStorage.getItem(k);
      if (location.pathname.endsWith('/popup/popup.html')) {
        const u = get('shot-site');
        chrome.tabs.query = async () => (u ? [{ id: 4242, active: true, url: u }] : []);
      }
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg, ...rest) => {
        if (msg?.type === 'tabDomains' && get('shot-td')) return { ok: true, result: JSON.parse(get('shot-td')) };
        if (msg?.type === 'checkSubscription') return { ok: true, result: { report: get('shot-report'), device: false, viaVpn: false } };
        if (msg?.type === 'hello' && get('shot-host') === 'none') {
          await new Promise((r) => setTimeout(r, 300)); // язык страницы к этому времени уже выбран
          const { t } = await import(chrome.runtime.getURL('lib/i18n.js'));
          return { ok: false, error: { code: 'HOST_NOT_FOUND', message: t('err.HOST_NOT_FOUND') } };
        }
        return real(msg, ...rest);
      };
      if (get('shot-perm')) {
        chrome.permissions.contains = async () => get('shot-perm') === 'yes';
        chrome.permissions.request = () => (get('shot-perm') === 'ask' ? new Promise(() => {}) : Promise.resolve(false));
      }
    }`;
    await pop.inject(stubs);
    await full.inject(stubs);
    const REPORT = [
      'Проверка подписки Waysplit · 17.11.2026 21:40',
      'Адрес: https://sub.example.com/***',
      '',
      '== Итог',
      'Серверы пришли:',
      '  v2rayN — 5 (список ссылок в base64; запустим 5)',
      '  Happ — 5 (список ссылок в base64; запустим 5)',
      'Серверы не пришли:',
      '  Clash — 200, Clash / Mihomo YAML, только заглушка «Обновите приложение до последней версии»',
      '',
      '== 1. v2rayN',
      'User-Agent: v2rayN/7.15.4',
      'Ответ: 200 OK · text/plain; charset=utf-8 · 2,4 КБ · 0,31 с',
      'Заголовки (без cookie):',
      '  subscription-userinfo: upload=2254857830; download=22870700851; total=214748364800; expire=1801353600',
      '  profile-update-interval: 12',
      '  profile-title: base64:0J/RgNC40LzQtdGAINC/0L7QtNC/0LjRgdC60Lg=',
      '',
      '== 2. Happ',
      'User-Agent: Happ/3.2.1',
      'Ответ: 200 OK · text/plain; charset=utf-8 · 2,4 КБ · 0,28 с',
      'Заголовки: те же, что в способе 1',
    ].join('\n');
    const store = (key, value) => ctl.eval(value === null ? `localStorage.removeItem(${JSON.stringify(key)})` : `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);

    await store('shot-report', REPORT);
    for (const theme of ['light', 'dark']) {
      await msg({ type: 'setSetting', key: 'themeLcd', value: theme }); // тема нового окна — своя настройка
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
      await shot('43-look-menu', 'Кнопка оформления в шапке: меню открыто — «Вид окна» и «Тема», фокус на выбранном виде',
        `document.getElementById('lookBtn').focus(); document.getElementById('lookBtn').click()`);
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
      await shot('40-subscription-report', 'Сведения о подписке: внизу — проверка подписки и её отчёт',
        `${tab('servers')}; ${pause}; ${click('#srvGroups .sub-open')}; ${pause}; ${click('#subCheckRun')}; await new Promise((r) => setTimeout(r, 900)); document.querySelector('.sub-screen .screen-scroll').scrollTop = 99999`);
      await shot('41-sets', 'Готовые наборы', `${tab('rules')}; ${pause}; ${click('#rulesMore')}; ${pause}; document.querySelector('#pop .pop-item').click(); await new Promise((r) => setTimeout(r, 300))`);
      await shot('12-add', 'Добавление серверов', `${tab('servers')}; ${click('#srvAdd')}`);
      await shot('13-rules', 'Вкладка «Правила»: метка «без VPN» / флаг сервера, корзина, меню ⋯', tab('rules'));
      await shot('14-rules-menu', 'Вкладка «Правила»: меню ⋯ у правила', `${tab('rules')}; ${pause}; document.querySelectorAll('#rulesList .rule [data-action="more"]')[2].click()`);
      await shot('15-rules-tab-menu', 'Вкладка «Правила»: меню ⋯ вкладки', `${tab('rules')}; ${pause}; ${click('#rulesMore')}`);
      await shot('16-settings', 'Вкладка «Настройки»', tab('settings'));
      await shot('42-settings-design', 'Вкладка «Настройки»: выбор оформления — первым в разделе с темой и языком', `${tab('settings')}; ${pause}; document.getElementById('design').scrollIntoView({ block: 'center' }); document.getElementById('design').focus()`);
      await shot('17-settings-bottom', 'Вкладка «Настройки»: внизу — диагностика, помощь, версии', `${tab('settings')}; ${pause}; document.querySelector('#panel-settings .panel-scroll').scrollTop = 99999`);
      await shot('18-diag', 'Диагностика', `${tab('settings')}; ${click('#openDiag')}; await new Promise((r) => setTimeout(r, 400))`);
      await shot('19-full', '«Развернуть»: тот же интерфейс на всю вкладку', null, 'https://shop.example.org/catalog', full, `${base}/popup/popup.html?full&site=shop.example.org&tabId=4242#servers`);

      // «Домены сайта»: строка правила «+N доменов сайта», меню «⋯», экран со списком, подсказка
      // на «Главной», карточка разрешения (один раз, после первого правила «через VPN»).
      const ytMore = `[...document.querySelectorAll('#rulesList .rule')].find((x) => x.querySelector('.rule-domain').textContent === 'youtube.com').querySelector('[data-action="more"]').click()`;
      await shot('20-rule-site-domains', 'Вкладка «Правила»: у правила youtube.com — «+6 доменов сайта», в меню ⋯ — «Домены сайта (6)…»', `${tab('rules')}; ${pause}; ${ytMore}`);
      await shot('21-site-domains', 'Экран «Домены сайта»: что привязано к правилу, убрать любой домен',
        `${tab('rules')}; ${pause}; ${ytMore}; ${pause}; [...document.querySelectorAll('#pop .pop-item')].at(-1).click()`); // «Домены сайта…» — последний пункт меню
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

      // «Домены этой вкладки» — вложенный экран: Chrome спрашивает разрешение, в разрешении отказали,
      // список, пусто.
      const td = `${click('#tdButton')}; await new Promise((r) => setTimeout(r, 400))`;
      const tdSite = 'https://news.example.org/today';
      await store('shot-perm', 'ask');
      await shot('33-tab-domains-permission', '«Домены этой вкладки»: нужно разрешение (Chrome спрашивает)', td, tdSite);
      await store('shot-perm', 'no');
      await shot('34-tab-domains-denied', '«Домены этой вкладки»: в разрешении отказали — кнопка «Разрешить»', td, tdSite);
      await store('shot-perm', 'yes');
      await store('shot-td', JSON.stringify(['news.example.org', 'static.news.example.org', 'img.cdn-primer.net', 'www.youtube.com', 'i.ytimg.com',
        'fonts.example-static.com', 'metrics.example.io', 'player.media-primer.tv', 'ads.example-network.com', 'xn--e1afmkfd.xn--p1ai']));
      await shot('35-tab-domains', '«Домены этой вкладки»: список с флажками, пометки у доменов с правилом, внизу действие и «Добавить правила»',
        `${td}; for (const i of [1, 2]) document.querySelectorAll('#tdList input')[i].click()`, tdSite);
      await store('shot-td', '[]');
      await shot('36-tab-domains-empty', '«Домены этой вкладки»: пока пусто', td, tdSite);
      await store('shot-td', null);
      await store('shot-perm', null);

      // «Начало работы»: всё готово (три шага отмечены), компаньона нет, ошибка подключения.
      const welcome = `${base}/welcome/welcome.html`;
      await shot('32-welcome', '«Начало работы»: всё готово — три шага отмечены', null, 'https://shop.example.org/catalog', full, welcome);
      await store('shot-host', 'none');
      await msg({ type: 'toggle', enabled: false });
      await shot('37-welcome-no-companion', '«Начало работы»: компаньона нет — предупреждение, шаги установки, «Скачать»', null, 'https://shop.example.org/catalog', full, welcome);
      await store('shot-host', null);
      await msg({ type: 'toggle', enabled: true });
      const failed = { state: 'error', code: 'CORE_STOPPED', message: await ctl.eval(`import(chrome.runtime.getURL('lib/i18n.js')).then((m) => m.t('err.CORE_STOPPED'))`) };
      await ctl.eval(`chrome.storage.session.set({ status: ${JSON.stringify(failed)} })`);
      await shot('38-welcome-error', '«Начало работы»: ошибка подключения на третьем шаге', `document.getElementById('enable').scrollIntoView({ block: 'center' })`, 'https://shop.example.org/catalog', full, welcome);
      await msg({ type: 'toggle', enabled: false });
      await msg({ type: 'toggle', enabled: true });
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
