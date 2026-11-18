// Два оформления окна (версия 1.3.0, design/lcd/STYLE.md, «Два оформления»): настройка design,
// своя тема у нового окна и её перенос, резервная копия, состав папки classic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_SETTINGS, normalize } from '../extension/lib/storage.js';
import { validSetting } from '../extension/lib/controller.js';
import { FOCUS_IDS, PAGES, arrival, designOf } from '../extension/lib/design.js';
import { LANGS } from '../extension/lib/i18n.js';
import { S1, S2, setup } from './fakes.js';

const EXT = new URL('../extension/', import.meta.url);
const read = (file) => readFileSync(new URL(file, EXT), 'utf8');

test('настройка оформления: пока ключа нет — новое окно; значения — только lcd и classic', async () => {
  assert.equal(DEFAULT_SETTINGS.design, 'lcd');
  assert.equal(normalize({ settings: { theme: 'dark' } }).settings.design, 'lcd', 'у обновившихся ключа нет — действует новое оформление');
  assert.deepEqual([designOf(undefined), designOf({}), designOf({ design: 'lcd' }), designOf({ design: 'classic' }), designOf({ design: 'другое' })], ['lcd', 'lcd', 'lcd', 'classic', 'lcd']);
  assert.deepEqual(PAGES, { lcd: 'popup/popup.html', classic: 'classic/popup.html' });
  for (const [k, v, ok] of [['design', 'lcd', true], ['design', 'classic', true], ['design', 'новое', false], ['design', '', false],
    ['themeLcd', 'dark', true], ['themeLcd', 'light', true], ['themeLcd', 'system', true], ['themeLcd', 'синяя', false]]) {
    assert.equal(validSetting(k, v), ok, `${k} = ${v}`);
  }
  const { c, store } = setup({ local: { servers: [S1] } });
  await c.init();
  await c.setSetting('design', 'classic');
  assert.equal(store.local.settings.design, 'classic');
  await assert.rejects(c.setSetting('design', 'третье'), (e) => e.code === 'BAD_SETTING');
  assert.equal(store.local.settings.design, 'classic', 'неверное значение ничего не меняет');
});

test('тема нового окна: изначально тёмная; перенос при первом запуске — светлая только у тех, кто выбрал светлую', async () => {
  assert.equal(DEFAULT_SETTINGS.themeLcd, 'dark');
  assert.equal(DEFAULT_SETTINGS.theme, 'system', 'у классического окна по-прежнему «как в системе»');
  // Три случая обновления: была светлая, была тёмная, не была выбрана. Тема классического окна не меняется.
  for (const [was, lcd] of [['light', 'light'], ['dark', 'dark'], [undefined, 'dark'], ['system', 'dark']]) {
    const settings = was === undefined ? { language: 'ru' } : { language: 'ru', theme: was };
    const { c, store } = setup({ local: { servers: [S1], settings } });
    await c.init();
    assert.equal(store.local.settings.themeLcd, lcd, `прежняя тема ${was} → тема нового окна ${lcd}`);
    assert.equal(normalize(store.local).settings.theme, was ?? 'system', 'тема классического окна осталась как была');
  }
  // Новая установка — тёмная.
  const fresh = setup({});
  await fresh.c.init();
  assert.equal(fresh.store.local.settings.themeLcd, 'dark');
  // Перенос — один раз: тему нового окна уже выбирали — следующие запуски фона её не трогают.
  const chosen = setup({ local: { servers: [S1], settings: { theme: 'light', themeLcd: 'system' } } });
  await chosen.c.init();
  assert.equal(chosen.store.local.settings.themeLcd, 'system');
  // Темы независимы: смена одной не меняет другую.
  await chosen.c.setSetting('themeLcd', 'dark');
  assert.deepEqual([chosen.store.local.settings.theme, chosen.store.local.settings.themeLcd], ['light', 'dark']);
  await chosen.c.setSetting('theme', 'system');
  assert.deepEqual([chosen.store.local.settings.theme, chosen.store.local.settings.themeLcd], ['system', 'dark']);
});

test('резервная копия: выбор оформления и обе темы — в копии; старая копия без них их не меняет', async () => {
  const host = { parse_links: () => ({ servers: [], errors: [] }) };
  const src = setup({ local: { servers: [S1], currentServerId: 's_1', settings: { language: 'ru', design: 'classic', theme: 'light', themeLcd: 'system' } }, host });
  await src.c.init();
  const backup = JSON.parse(JSON.stringify(await src.c.exportBackup()));
  assert.deepEqual([backup.app, backup.type, backup.version], ['Waysplit', 'backup', 1], 'формат файла прежний');
  assert.deepEqual([backup.settings.design, backup.settings.theme, backup.settings.themeLcd], ['classic', 'light', 'system']);

  // Новая копия: оформление и обе темы — из копии.
  const dst = setup({ local: { servers: [S2], settings: { language: 'ru', design: 'lcd', theme: 'dark', themeLcd: 'dark' } }, host });
  await dst.c.init();
  await dst.c.importBackup(backup);
  assert.deepEqual([dst.store.local.settings.design, dst.store.local.settings.theme, dst.store.local.settings.themeLcd], ['classic', 'light', 'system']);

  // Старая копия (версии до 1.3.0): ключей design и themeLcd в ней нет — оформление и тема нового окна
  // остаются нынешними, тема классического окна — из копии, как раньше.
  const { design: _d, themeLcd: _t, ...oldSettings } = backup.settings;
  for (const now of [{ design: 'lcd', themeLcd: 'dark' }, { design: 'classic', themeLcd: 'light' }]) {
    const old = setup({ local: { servers: [S2], settings: { language: 'ru', theme: 'dark', ...now } }, host });
    await old.c.init();
    await old.c.importBackup({ ...backup, settings: oldSettings });
    assert.deepEqual([old.store.local.settings.design, old.store.local.settings.themeLcd], [now.design, now.themeLcd], 'оформление и тема нового окна не изменились');
    assert.equal(old.store.local.settings.theme, 'light', 'тема классического окна — из копии');
  }
  // Неверное значение в копии пропускается.
  const bad = setup({ local: { servers: [S2], settings: { language: 'ru', design: 'classic' } }, host });
  await bad.c.init();
  await bad.c.importBackup({ ...backup, settings: { ...backup.settings, design: 'третье' } });
  assert.equal(bad.store.local.settings.design, 'classic');
});

test('папка classic: окно версии 1.2.1 — пометка о заморозке в каждом файле, свои стили, выбор оформления', () => {
  const names = readdirSync(new URL('classic/', EXT)).sort();
  assert.deepEqual(names, ['common.css', 'diag.js', 'full.js', 'home.js', 'langbtn.js', 'picker.js', 'popup.css', 'popup.html', 'popup.js', 'rules.js',
    'servers.js', 'settings.js', 'siteperm.js', 'state.js', 'ui.js']);
  for (const name of names) {
    const head = read(`classic/${name}`).slice(0, 400);
    assert.ok(/КЛАССИЧЕСКОЕ ОКНО: окно версии 1\.2\.1, заморожено/.test(head) && /Новые функции сюда не добавляются/.test(head), `classic/${name}: в начале файла нет пометки о заморозке`);
  }
  const html = read('classic/popup.html');
  assert.ok(html.includes('<link rel="stylesheet" href="common.css">') && !html.includes('../lib/common.css'), 'классическое окно берёт свои стили, а не стили нового окна');
  assert.ok(/id="design"[\s\S]*id="theme"/.test(html), 'выбор оформления — рядом с темой');
  assert.ok(read('classic/full.js').includes('classic/popup.html') && !read('classic/full.js').includes('`popup/popup.html'), '«Развернуть» открывает классическое окно');
  assert.ok(read('classic/common.css').includes('TwemojiCountryFlags.woff2'), 'флаги стран — из своего шрифта');
  // Название ошибок, код страны и прочее новое в классическое окно не переносится.
  const code = names.filter((n) => n.endsWith('.js')).map((n) => read(`classic/${n}`)).join('\n');
  for (const word of ['shownName', 'countryCode', 'noFlags', 'home.err.', 'home.lcd.', 'themeLcd']) assert.ok(!code.includes(word), `в classic нет «${word}»`);
});

test('оба окна: сверка оформления при загрузке, выбор в настройках; новое окно — выбор первым в разделе', () => {
  for (const [dir, mine] of [['popup', 'lcd'], ['classic', 'classic']]) {
    const js = read(`${dir}/popup.js`);
    assert.ok(js.includes(`checkDesign('${mine}')`), `${dir}/popup.js сверяется с настройкой`);
    assert.ok(js.includes('goDesign(want') && js.includes('arrival()'), `${dir}/popup.js переходит в другое окно и принимает переход`);
    assert.ok(read(`${dir}/settings.js`).includes("key: 'design'"), `${dir}/settings.js сохраняет выбор`);
    const html = read(`${dir}/popup.html`);
    assert.equal(html.match(/<select[^>]*id="design"[\s\S]*?<\/select>/)[0].match(/<option value="(\w+)"/g).join(), '<option value="lcd",<option value="classic"');
  }
  const html = read('popup/popup.html');
  const group = html.slice(html.indexOf('data-i18n="settings.look.legend"'));
  const order = ['id="design"', 'id="themeLcd"', 'id="language"'].map((x) => group.indexOf(x));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], 'в новом окне: оформление, тема, язык');
  assert.ok(!html.includes('id="theme"'), 'тема нового окна — настройка themeLcd');
  assert.ok(read('popup/popup.js').includes("applyTheme('themeLcd')") && read('welcome/welcome.js').includes("applyTheme('themeLcd')"), 'новое окно и «Начало работы» берут тему нового окна');
  assert.ok(/applyTheme\(\);/.test(read('classic/popup.js')), 'классическое окно берёт прежнюю тему');
  // Пока сверка не прошла, страница не показывается — чужое окно не мелькает.
  for (const css of ['lib/common.css', 'classic/popup.css']) assert.ok(read(css).includes('html:not(.ready) body { visibility: hidden; }'), css);
  // Страница настроек и ссылка внизу «Начала работы» открывают окно в выбранном оформлении.
  assert.ok(read('options/options.js').includes("pageUrl(designOf(settings), '?full#settings')"));
  assert.ok(read('welcome/welcome.js').includes("pageUrl(designOf(st.settings), '?full#rules')"));
  assert.ok(read('background.js').includes('chrome.action.setPopup({ popup: PAGES[designOf(settings)] })'), 'фон выбирает окно для значка');
});

test('выбор вида окна: в русских настройках строка не повторяет название раздела', () => {
  const ru = LANGS.ru.messages;
  const en = LANGS.en.messages;
  assert.deepEqual([ru['settings.design'], ru['settings.design.lcd'], ru['settings.design.classic']], ['Вид окна', 'новый', 'классический']);
  assert.deepEqual([en['settings.design'], en['settings.design.lcd'], en['settings.design.classic']], ['Design', 'new', 'classic']);
  assert.notEqual(ru['settings.design'], ru['settings.look.legend'], 'раздел «Оформление» и строка в нём называются по-разному');
  assert.notEqual(en['settings.design'], en['settings.look.legend']);
});

test('кнопка оформления в шапке: есть в обоих окнах, на «Начале работы» её нет; меню — из двух групп', () => {
  for (const dir of ['popup', 'classic']) {
    const html = read(`${dir}/popup.html`);
    const head = html.slice(html.indexOf('<header class="top"'), html.indexOf('</header>'));
    const btn = head.match(/<button class="look-btn" id="lookBtn"[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
    assert.ok(btn, `${dir}: кнопка оформления стоит в шапке`);
    assert.ok(/data-i18n-aria-label="settings\.look\.legend"/.test(btn) && /data-i18n-title="settings\.look\.legend"/.test(btn), `${dir}: подсказка и название — «Оформление»`);
    assert.ok(/class="logo"/.test(btn) && /<span class="brand">Waysplit<\/span>/.test(btn) && /class="chev"/.test(btn), `${dir}: в кнопке значок, название и уголок`);
    assert.ok(head.indexOf('id="lookBtn"') < head.indexOf('id="langBtn"'), `${dir}: кнопка оформления — слева, перед кнопкой языка`);
    const js = read(`${dir}/popup.js`);
    assert.ok(js.includes(`initLookButton($('lookBtn'), { themeKey: '${dir === 'popup' ? 'themeLcd' : 'theme'}'`), `${dir}: меню меняет тему своего окна`);
    assert.ok(js.includes('focus: focusedId()') && js.includes('$(arrived.focus).focus()'), `${dir}: после перехода фокус — на том же месте`);
    assert.ok(read(`${dir === 'popup' ? 'lib/common.css' : 'classic/popup.css'}`).includes('.pop-group {'), `${dir}: у подписи группы есть стиль`);
  }
  assert.ok(!read('welcome/welcome.html').includes('lookBtn') && !read('welcome/welcome.js').includes('lookmenu'), 'на «Начале работы» кнопки оформления нет');
  // Строки в настройках остались: меню меняет те же настройки.
  for (const dir of ['popup', 'classic']) assert.ok(read(`${dir}/popup.html`).includes('id="design"'), `${dir}: строка «Вид окна» в настройках на месте`);
  const menu = read('lib/lookmenu.js');
  assert.ok(menu.includes("t('settings.design')") && menu.includes("t('settings.theme')"), 'подписи групп — те же тексты, что в настройках');
  assert.ok(menu.includes("'menuitemradio'") && menu.includes("el('div', 'pop-group', title)"), 'значения — пункты меню, подписи групп — не кнопки');
  assert.ok(menu.includes("set('design', d)") && menu.includes('set(themeKey, v)'), 'меню меняет настройки design и тему окна');
  assert.ok(menu.indexOf("'dark', 'light', 'system'].map") > 0, 'порядок тем: тёмная, светлая, как в системе');
});

test('переход между окнами: фокус передаётся только на выбор вида в настройках или на кнопку в шапке', () => {
  assert.deepEqual(FOCUS_IDS, ['design', 'lookBtn']);
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(arrival(), null, 'перехода не было');
    for (const [saved, want] of [[{ tab: 'rules', focus: 'lookBtn' }, { tab: 'rules', focus: 'lookBtn' }], [{ tab: 'settings', focus: 'design' }, { tab: 'settings', focus: 'design' }],
      [{ tab: 'home', focus: '' }, { tab: 'home', focus: '' }], [{ tab: 'home', focus: 'power' }, { tab: 'home', focus: '' }], [{ focus: true }, { tab: '', focus: '' }]]) {
      store.set('waysplit-design-arrival', JSON.stringify(saved));
      assert.deepEqual(arrival(), want);
      assert.equal(arrival(), null, 'переход читается один раз');
    }
    store.set('waysplit-design-arrival', 'не JSON');
    assert.equal(arrival(), null);
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('манифест: разрешения совпадают с версией 1.2.1 (favicon — для значков сайтов классического окна)', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'proxy', 'storage', 'alarms', 'activeTab', 'privacy', 'favicon']);
  assert.equal(manifest.action.default_popup, 'popup/popup.html', 'изначально значок открывает новое окно');
});
