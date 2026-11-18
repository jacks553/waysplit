// Скриншоты классического окна (окно версии 1.2.1, папка extension/classic) — для проверки глазами
// и для сравнения с настоящим окном 1.2.1 (design/lcd/STYLE.md, «Два оформления»):
//   node tools/popup-shots-classic.js [папка] [--baseline=<папка расширения версии 1.2.1>]
// По умолчанию снимает классическое окно этого проекта в dist/popup-shots-classic. С --baseline —
// окно из другой папки расширения (например, из ветки main: там оно лежит в popup/) теми же шагами
// и с теми же данными: кадры можно сравнить попиксельно. Отличаться должны только шапка (значок и
// название стали кнопкой оформления) и настройки (появилась строка «Вид окна»).
// Обе темы, 400×600: четыре вкладки, выбор сервера, меню кнопки оформления, настройки у выбора темы. Данные вымышленные,
// компаньон — подделка (tools/shots-lib.js). В git папка с кадрами не попадает.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareExtension, root, seed, startChrome } from './shots-lib.js';

const args = process.argv.slice(2);
const baseline = args.find((a) => a.startsWith('--baseline='))?.slice(11) || '';
const outDir = resolve(args.find((a) => !a.startsWith('--')) || join(root, 'dist', 'popup-shots-classic'));
const work = mkdtempSync(join(tmpdir(), 'waysplit-classic-shots-'));
// В версии 1.2.1 окно лежит в popup/, настройки design в ней нет.
const windowPath = baseline ? 'popup/popup.html' : 'classic/popup.html';

async function main() {
  const ext = await prepareExtension(work, null, 'ru', baseline ? resolve(baseline) : undefined);
  mkdirSync(outDir, { recursive: true });
  const chrome = startChrome(join(work, 'profile')); // без полос прокрутки, как снимались кадры версии 1.2.1
  try {
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: ext });
    const base = `chrome-extension://${id}`;
    const ctl = await chrome.page(400, 600);
    await ctl.goto(`${base}/welcome/welcome.html`); // страница расширения, которая не переходит в другое окно
    const { msg } = await seed(ctl, 'ru');
    if (!baseline) await msg({ type: 'setSetting', key: 'design', value: 'classic' });
    await msg({ type: 'toggle', enabled: true });

    const pop = await chrome.page(400, 600);
    // Открытая вкладка браузера «как будто».
    await pop.inject(`if (location.pathname.endsWith('/popup.html')) chrome.tabs.query = async () => [{ id: 4242, active: true, url: 'https://shop.example.org/catalog' }];`);
    const click = (sel) => `document.querySelector(${JSON.stringify(sel)}).click()`;
    const tab = (name) => click(`.tabbar .tab[data-tab="${name}"]`);
    const pause = 'await new Promise((r) => setTimeout(r, 300))';
    const FRAMES = [
      ['home', ''],
      ['servers', tab('servers')],
      ['rules', tab('rules')],
      ['settings', tab('settings')],
      ['picker', click('#serverRow')],
      // Кнопка оформления в шапке: меню открыто (в окне версии 1.2.1 такой кнопки нет).
      ...(baseline ? [] : [['look-menu', `document.getElementById('lookBtn').focus(); document.getElementById('lookBtn').click()`]]),
      // Настройки у выбора темы: в классическом окне над темой стоит выбор оформления.
      ['settings-look', `${tab('settings')}; ${pause}; document.getElementById('theme').scrollIntoView({ block: 'center' })`],
    ];
    for (const theme of ['light', 'dark']) {
      await msg({ type: 'setSetting', key: 'theme', value: theme });
      for (const [name, prep] of FRAMES) {
        await pop.goto(`${base}/${windowPath}`);
        await pop.eval(`(async () => { await new Promise((r) => setTimeout(r, 600)); ${prep}; await new Promise((r) => setTimeout(r, 600)); return 1; })()`);
        const info = await pop.eval(`({ path: location.pathname, ready: document.documentElement.classList.contains('ready'), design: !!document.getElementById('design') })`);
        if (!info.path.endsWith(`/${windowPath}`)) throw new Error(`кадр ${name}: открылось ${info.path}, а не ${windowPath}`);
        await pop.shot(join(outDir, `${theme}-${name}.png`));
        console.log('снимок', `${theme}-${name}.png`);
      }
    }
  } finally {
    await chrome.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log('Готово:', outDir);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
});
