// Язык окна (версия 1.2.0): словари ru и en, перевод надписей, настройка «Язык» и её смена без
// перезапуска, русский у тех, кто обновился. И порядок в коде: все ключи есть в обоих словарях,
// русского текста вне словарей нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, LANGUAGE_SETTINGS, everyLanguage, language, resolveLanguage, setLanguage, t } from '../extension/lib/i18n.js';
import { legacyPhrase } from '../extension/lib/i18n/legacy.js';
import { pingBars, pingError, pingReason } from '../extension/lib/format.js';
import { validSetting } from '../extension/lib/controller.js';
import { S1, S2, setup } from './fakes.js';

const EXT = fileURLToPath(new URL('../extension/', import.meta.url));
const CYR = /[А-Яа-яЁё]/;
const BS = String.fromCharCode(92); // обратная косая черта

// files — файлы расширения с данным расширением имени (путь от extension/, через «/»).
function files(ext, dir = EXT) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(ext, full);
    return name.endsWith(ext) ? [relative(EXT, full).replaceAll(BS, '/')] : [];
  });
}
const read = (file) => readFileSync(join(EXT, file), 'utf8');

// tokens — простой разбор JS на части: строки ('…' и "…"), шаблоны `…${…}…` (выражения внутри
// разбираются как обычный код, так что вложенные шаблоны не сбивают разбор), имена и знаки.
// Комментарии пропускаются. У каждой части — номер строки файла (line). Регулярные выражения
// отдельно не разбираются: в коде расширения в них нет кавычек, а «\/» не принимается за «//».
function tokens(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const step = (to) => {
    for (; i < to; i++) if (src[i] === '\n') line++;
  };
  const scan = (close) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        const e = src.indexOf('\n', i);
        step(e < 0 ? n : e);
      } else if (c === '/' && d === '*') {
        const e = src.indexOf('*/', i + 2);
        step(e < 0 ? n : e + 2);
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c) j += src[j] === BS ? 2 : 1;
        out.push({ type: 'str', value: src.slice(i + 1, j), line });
        step(j + 1);
      } else if (c === '`') {
        // Шаблон: head — текст до первой вставки ${…}, text — весь текст без вставок.
        const tpl = { type: 'tpl', head: null, text: '', line };
        out.push(tpl);
        step(i + 1);
        while (i < n && src[i] !== '`') {
          if (src[i] === BS) {
            tpl.text += src.slice(i, i + 2);
            step(i + 2);
          } else if (src[i] === '$' && src[i + 1] === '{') {
            tpl.head ??= tpl.text;
            step(i + 2);
            scan('}');
            step(i + 1);
          } else {
            tpl.text += src[i];
            step(i + 1);
          }
        }
        tpl.dynamic = tpl.head !== null;
        tpl.head ??= tpl.text;
        step(i + 1);
      } else if (c === BS) {
        out.push({ type: 'p', value: src.slice(i, i + 2), line });
        step(i + 2);
      } else if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j++;
        out.push({ type: 'id', value: src.slice(i, j), line });
        step(j);
      } else {
        if (close && depth === 0 && c === close) return;
        if (c === '{') depth++;
        if (c === '}') depth--;
        if (!/\s/.test(c)) out.push({ type: 'p', value: c, line });
        step(i + 1);
      }
    }
  };
  scan(null);
  return out;
}

const placeholders = (text) => [...new Set(Object.values(typeof text === 'object' ? text : { text }).flatMap((s) => s.match(/\{\w+\}/g) || []))].sort();

test('словари: одни и те же ключи, те же вставки {имя}, формы по числу — как положено языку', () => {
  const { ru, en } = LANGS;
  assert.deepEqual(Object.keys(en.messages).sort(), Object.keys(ru.messages).sort(), 'ключи русского и английского словарей совпадают');
  assert.deepEqual([ru.lang, en.lang, ru.dir, en.dir], ['ru', 'en', 'ltr', 'ltr']);
  assert.ok(ru.name && en.name, 'у языка есть название для списка в настройках');
  for (const key of Object.keys(ru.messages)) {
    const [a, b] = [ru.messages[key], en.messages[key]];
    assert.equal(typeof a, typeof b, `${key}: в обоих языках строка или в обоих — формы по числу`);
    if (typeof a === 'object') {
      assert.deepEqual(Object.keys(a), ['one', 'few', 'many'], `${key}: русские формы`);
      assert.deepEqual(Object.keys(b), ['one', 'other'], `${key}: английские формы`);
    }
    assert.deepEqual(placeholders(b), placeholders(a), `${key}: вставки {имя} в переводе те же`);
    for (const text of Object.values(typeof b === 'object' ? b : { b })) {
      assert.ok(text.trim() !== '', `${key}: английский текст не пустой`);
      assert.ok(!CYR.test(text.replaceAll('рф', '')), `${key}: в английском тексте нет русских букв (кроме зоны .рф): ${text}`);
    }
  }
  // Пустой русский текст — только там, где надпись нужна лишь в переводе.
  const empty = Object.keys(ru.messages).filter((k) => ru.messages[k] === '');
  assert.deepEqual(empty.sort(), ['settings.ver.hostLang', 'sub.check.reportLang']);
});

test('перевод: вставки, склонения, запасной язык, язык «как в Chrome»', () => {
  setLanguage('ru');
  assert.equal(t('rules.removed', { domain: 'example.com' }), 'Правило удалено: example.com');
  assert.deepEqual([1, 2, 5, 11, 21, 22, 0].map((n) => t('n.siteDomains', { n })),
    ['+1 домен сайта', '+2 домена сайта', '+5 доменов сайта', '+11 доменов сайта', '+21 домен сайта', '+22 домена сайта', '+0 доменов сайта']);
  assert.equal(t('home.lcd.rules.detail', { n: 3 }), 'работают правила: 3 сайта через VPN');
  assert.equal(t('нет.такого.ключа'), 'нет.такого.ключа', 'пропуск виден сразу: показан сам ключ');
  assert.equal(t('rules.removed'), 'Правило удалено: {domain}', 'вставка без значения остаётся как есть');

  assert.equal(setLanguage('en'), true, 'язык сменился');
  assert.equal(setLanguage('en'), false, 'тот же язык — не смена');
  assert.equal(language(), 'en');
  assert.equal(t('rules.removed', { domain: 'example.com' }), 'Rule deleted: example.com');
  assert.deepEqual([1, 2, 5, 21, 0].map((n) => t('n.servers', { n })), ['1 server', '2 servers', '5 servers', '21 servers', '0 servers']);
  assert.equal(t('common.withoutVpn'), 'without VPN');
  setLanguage('ru');

  assert.deepEqual(LANGUAGE_SETTINGS, ['auto', 'ru', 'en']);
  assert.equal(resolveLanguage('auto', 'ru'), 'ru');
  assert.equal(resolveLanguage('auto', 'ru-RU'), 'ru');
  assert.equal(resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveLanguage('auto', 'de'), 'en', 'Chrome не на русском — английский');
  assert.equal(resolveLanguage('auto', ''), 'en');
  assert.equal(resolveLanguage('ru', 'en-US'), 'ru', 'язык выбран явно — язык Chrome не важен');
  assert.equal(resolveLanguage('en', 'ru'), 'en');
  assert.equal(resolveLanguage(undefined, 'ru'), 'ru', 'настройки ещё нет — как в Chrome');
});

// scanCode — ключи словаря, которые упоминает код: t('ключ'), t(условие ? 'ключ' : 'ключ') и таблицы
// ключей (HINTS, FILE_ACTIONS). dynamic — начала ключей, которые собираются на ходу: t(`ping.${код}`).
// Ключ словаря всегда с точкой (раздел.надпись): строки без точки в первом аргументе t() — это
// значения в условиях (t(state === 'on' ? …)), а не ключи.
const KEY_LIKE = /^[a-z][\w-]*(\.[\w-]+)+$/i;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
function scanCode() {
  const used = new Set();
  const unknown = [];
  const dynamic = new Set();
  const known = new Set(Object.keys(LANGS.ru.messages));
  for (const file of files('.js')) {
    if (file.startsWith('lib/i18n/')) continue;
    const toks = tokens(read(file));
    for (const tk of toks) {
      if (tk.type === 'str' && known.has(tk.value)) used.add(tk.value);
      if (tk.type === 'tpl' && !tk.dynamic && known.has(tk.text)) used.add(tk.text);
      if (tk.type === 'tpl' && tk.dynamic && /^[a-zA-Z][\w.]*\.$/.test(tk.head)) dynamic.add(tk.head); // `ping.${код}` → «ping.»
    }
    // Первый аргумент t(…): все строки в нём, похожие на ключ, должны быть в словаре.
    toks.forEach((tk, k) => {
      if (tk.type !== 'id' || tk.value !== 't' || toks[k + 1]?.value !== '(' || toks[k - 1]?.value === '.') return;
      let depth = 0;
      for (let m = k + 2; m < toks.length; m++) {
        const x = toks[m];
        if (x.type === 'p' && OPEN.has(x.value)) depth++;
        else if (x.type === 'p' && CLOSE.has(x.value)) {
          if (depth === 0) break;
          depth--;
        } else if (x.type === 'p' && x.value === ',' && depth === 0) break;
        else if (x.type === 'str' && KEY_LIKE.test(x.value) && !known.has(x.value)) unknown.push(`${file}:${x.line}: t('${x.value}')`);
      }
    });
  }
  for (const file of files('.html')) {
    const html = read(file).replace(/<!--[\s\S]*?-->/g, ''); // в комментариях — примеры, не ключи
    for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
      if (known.has(m[1])) used.add(m[1]);
      else unknown.push(`${file}: ${m[0]}`);
    }
  }
  return { used, unknown, dynamic: [...dynamic] };
}

test('ключи: всё, что просит код и разметка, есть в словаре; лишних ключей в словаре нет', () => {
  const { used, unknown, dynamic } = scanCode();
  assert.deepEqual(unknown, [], 'ключи, которых нет в словаре');
  // Ключи, которые собираются на ходу: ошибки по коду, причины пинга, состояния в диагностике,
  // названия наборов. У каждого такого начала в словаре есть хотя бы один ключ.
  for (const prefix of dynamic) {
    assert.ok(Object.keys(LANGS.ru.messages).some((k) => k.startsWith(prefix)), `нет ключей с началом «${prefix}»`);
  }
  const unused = Object.keys(LANGS.ru.messages).filter((k) => !used.has(k) && !dynamic.some((p) => k.startsWith(p)));
  assert.deepEqual(unused, [], 'ключи словаря, которые никто не использует');
});

test('в коде и разметке расширения нет русского текста вне словарей', () => {
  const bad = [];
  const check = (file, text) => {
    text.split('\n').forEach((line, i) => {
      if (CYR.test(line)) bad.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  };
  // Словари и тексты старых компаньонов (lib/i18n/) — единственное место для русского текста в коде.
  // JS: строки, шаблоны и всё остальное вне комментариев (регулярные выражения тоже).
  for (const file of files('.js')) {
    if (file.startsWith('lib/i18n/')) continue;
    for (const tk of tokens(read(file))) {
      const text = tk.type === 'tpl' ? tk.text : tk.value;
      if (CYR.test(text)) bad.push(`${file}:${tk.line}: ${text.slice(0, 100)}`);
    }
  }
  for (const file of files('.html')) check(file, read(file).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')));
  for (const file of files('.css')) check(file, read(file).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')));
  // JSON: пояснения в полях "comment" — это комментарии; русское описание для магазина — в _locales/ru.
  const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'comment').map(([k, x]) => [k, strip(x)])) : v);
  for (const file of files('.json')) if (!file.startsWith('_locales/ru/')) check(file, JSON.stringify(strip(JSON.parse(read(file))), null, 1));
  assert.deepEqual(bad, []);
});

test('манифест: описание — из _locales (ru и en), разрешения прежние', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.description, '__MSG_extDescription__');
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, 'Waysplit');
  const text = (lang) => JSON.parse(read(`_locales/${lang}/messages.json`)).extDescription.message;
  assert.equal(text('ru'), 'VPN для Chrome через ваши серверы VLESS, XHTTP и Hysteria2: часть сайтов через VPN, часть без VPN. Нужен компаньон для Windows.');
  assert.equal(text('en'), 'VPN for Chrome via your own VLESS, XHTTP and Hysteria2 servers: some sites through VPN, some without. Needs a Windows companion.');
  for (const lang of ['ru', 'en']) assert.ok(text(lang).length <= 132, `${lang}: краткое описание — не длиннее 132 знаков`);
  // Перевод не должен требовать новых разрешений.
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'proxy', 'storage', 'alarms', 'activeTab', 'privacy', 'favicon']); // как в 1.2.1: значки сайтов показывает классическое окно
  assert.deepEqual(manifest.optional_permissions, ['webRequest']);
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  assert.equal(manifest.host_permissions, undefined);
});

test('настройка языка: у обновившихся — русский, у новой установки — «как в Chrome»', async () => {
  // Новая установка: хранилище пустое. Chrome английский — окно английское.
  const fresh = setup({ chromeLang: 'en-US', extras: true });
  await fresh.c.init();
  assert.equal(fresh.store.local.settings.language, 'auto');
  assert.equal(fresh.ui.icons.at(-1).title, 'Waysplit — off');
  await assert.rejects(fresh.c.select('s_none'), { code: 'NOT_FOUND', message: 'No such server' });

  // Новая установка при русском Chrome — по-русски.
  const freshRu = setup({ chromeLang: 'ru', extras: true });
  await freshRu.c.init();
  assert.equal(freshRu.store.local.settings.language, 'auto');
  assert.equal(freshRu.ui.icons.at(-1).title, 'Waysplit — выключен');

  // Обновление с 1.0.0 или 1.1.0: в хранилище уже есть данные, настройки языка нет. Язык остаётся
  // русским, даже если Chrome английский; прочие настройки не тронуты.
  const updated = setup({ chromeLang: 'en-US', extras: true, local: { servers: [S1], currentServerId: 's_1', settings: { theme: 'dark' } } });
  await updated.c.init();
  assert.deepEqual([updated.store.local.settings.language, updated.store.local.settings.theme], ['ru', 'dark']);
  assert.equal(updated.ui.icons.at(-1).title, 'Waysplit — выключен');
  await assert.rejects(updated.c.select('s_none'), { message: 'Такого сервера нет' });

  // Язык уже выбран — при следующих запусках фона он не меняется.
  const chosen = setup({ chromeLang: 'ru', extras: true, local: { servers: [S1], settings: { language: 'en' } } });
  await chosen.c.init();
  assert.equal(chosen.store.local.settings.language, 'en');
  assert.equal(chosen.ui.icons.at(-1).title, 'Waysplit — off');
  setLanguage('ru');
});

test('язык меняется сразу, без перезапуска: подсказка значка, ошибки, причины пропуска', async () => {
  const { c, ui, store } = setup({ extras: true, local: { servers: [S1, S2], currentServerId: 's_1', enabled: true, settings: { language: 'ru' } } });
  await c.init();
  assert.equal(ui.icons.at(-1).title, 'Waysplit — подключено');
  assert.deepEqual((await c.addRules(['не домен!', '10.0.0.1'], 'direct')).skipped.map((s) => s.reason), ['не похоже на домен', 'правила — для доменов, а не для IP-адресов']);

  await c.setSetting('language', 'en');
  assert.equal(ui.icons.at(-1).title, 'Waysplit — connected', 'подсказка значка — уже по-английски');
  assert.deepEqual((await c.addRules(['не домен!', '10.0.0.1'], 'direct')).skipped.map((s) => s.reason), ['does not look like a domain', 'rules are for domains, not for IP addresses']);
  await assert.rejects(c.rename('s_1', '  '), { code: 'BAD_NAME', message: 'The name cannot be empty' });

  await c.setSetting('language', 'ru');
  assert.equal(ui.icons.at(-1).title, 'Waysplit — подключено');
  await assert.rejects(c.rename('s_1', '  '), { message: 'Имя не может быть пустым' });

  await c.setSetting('language', 'auto'); // Chrome в тестах русский
  assert.equal(store.local.settings.language, 'auto');
  assert.equal(ui.icons.at(-1).title, 'Waysplit — подключено');
  await assert.rejects(c.setSetting('language', 'de'), { code: 'BAD_SETTING' });
  assert.deepEqual(['auto', 'ru', 'en', 'de', '', null].map((v) => validSetting('language', v)), [true, true, true, false, false, false]);
});

test('пинг: причина хранится фразой и показывается на языке окна; тексты старого компаньона узнаются', async () => {
  // Компаньон 1.0.0 и 1.1.0 присылает только русский текст; 1.2.0 — ещё и фразу (msg, params).
  const { c, store } = setup({
    local: { servers: [S1, S2, { ...S1, id: 's_3', key: 'k3', localPort: 27103 }, { ...S1, id: 's_4', key: 'k4', localPort: 27104 }], currentServerId: 's_1', settings: { language: 'en' } },
    host: { ping: () => ({ results: [
      { id: 's_1', error: 'Сервер не отвечает (возможно, заблокирован UDP)' },
      { id: 's_2', error: 'ядро не слушает порт 27102', msg: 'ping_core_port', params: { port: 27102 } },
      { id: 's_3', error: 'что-то новое' },
      { id: 's_4' }, // причины нет совсем
    ] }) },
  });
  await c.init();
  const res = await c.ping();
  assert.deepEqual(res.map((r) => [r.error, r.reason]), [
    ['Server is not responding (UDP may be blocked)', 'ping_no_response_udp'],
    ['the core is not listening on port 27102', 'ping_core_port'],
    ['что-то новое', null], // незнакомая причина — текст компаньона как есть
    ['no response', null],
  ]);
  const [a, b, x, n] = store.local.servers;
  // В хранилище — текст компаньона как есть (его покажет и прежняя версия) и фраза.
  assert.deepEqual([a, b, x, n].map((s) => [s.lastPingError, s.lastPingMsg]), [
    ['Сервер не отвечает (возможно, заблокирован UDP)', { msg: 'ping_no_response_udp' }],
    ['ядро не слушает порт 27102', { msg: 'ping_core_port', params: { port: 27102 } }],
    ['что-то новое', null],
    ['нет ответа', null],
  ]);
  assert.equal(pingBars(a).title, 'no response: Server is not responding (UDP may be blocked)');
  assert.deepEqual([a, b, x, n].map(pingReason), ['ping_no_response_udp', 'ping_core_port', '', '']);
  assert.equal(pingError(n), 'no response');
  // Язык сменили — та же запись читается по-русски.
  setLanguage('ru');
  assert.deepEqual([a, b, x, n].map(pingError), ['Сервер не отвечает (возможно, заблокирован UDP)', 'ядро не слушает порт 27102', 'что-то новое', 'нет ответа']);
  // Запись прежней версии расширения (фразы ещё не было) — узнаётся по тексту.
  setLanguage('en');
  assert.equal(pingError({ lastPingError: 'Сервер не отвечает', localPort: 27101 }), 'Server is not responding');
  assert.equal(pingError({ lastPingError: 'ядро не слушает порт 27105' }), 'the core is not listening on port 27105');
  assert.equal(pingError({ lastPingError: 'нет ответа' }), 'no response');
  assert.equal(pingReason({ lastPingError: 'Сервер не отвечает' }), 'ping_no_response');
  setLanguage('ru');
  assert.deepEqual(['Сервер не отвечает', 'сервер не запущен в ядре', 'ядро не слушает порт 27105', 'нет ответа', 'другое', ''].map(legacyPhrase),
    [{ msg: 'ping_no_response' }, { msg: 'ping_not_in_core' }, { msg: 'ping_core_port', params: { port: 27105 } }, null, null, null]);
});

test('кнопка языка в шапке: подпись на всех языках сразу, кнопка и меню есть в окне и на «Начале работы»', () => {
  // Подсказку должен понять и тот, кто не читает на языке окна: она собирается из всех словарей.
  assert.equal(everyLanguage('settings.language'), 'Язык / Language');
  setLanguage('en');
  assert.equal(everyLanguage('settings.language'), 'Язык / Language', 'от языка окна не зависит');
  setLanguage('ru');
  const popup = read('popup/popup.html');
  const welcome = read('welcome/welcome.html');
  // В шапке окна кнопка стоит слева от «?».
  assert.ok(/id="langBtn"[^>]*><\/button>\s*<button class="icon-btn" id="helpBtn"/.test(popup), 'в окне кнопка языка — перед кнопкой «?»');
  assert.ok(/<header class="hero">[\s\S]*id="langBtn"[\s\S]*<\/header>/.test(welcome), 'на «Начале работы» кнопка языка — в шапке');
  for (const [name, html] of [['popup.html', popup], ['welcome.html', welcome]]) {
    assert.ok(html.includes('id="pop" popover="auto" role="menu"'), `${name}: есть всплывающее меню`);
  }
  // Стили меню — общие (lib/common.css): страница «Начало работы» не подключает popup.css.
  assert.ok(read('lib/common.css').includes('.pop-item'), 'стили меню лежат в lib/common.css');
  assert.ok(!read('popup/popup.css').includes('.pop-item {'), 'и не повторяются в popup.css');
  const btn = read('popup/langbtn.js');
  assert.ok(btn.includes("key: 'language'") && btn.includes("type: 'setSetting'"), 'кнопка пишет ту же настройку language, что выбор в «Настройках»');
});

test('резервная копия: язык — в настройках; копия прежней версии язык не меняет', async () => {
  const src = setup({ local: { servers: [S1], currentServerId: 's_1', settings: { language: 'en' } }, host: { parse_links: () => ({ servers: [], errors: [] }) } });
  await src.c.init();
  const backup = JSON.parse(JSON.stringify(await src.c.exportBackup()));
  // Формат файла прежний: версии 1.0.0 и 1.1.0 читают его как раньше (незнакомую настройку пропускают).
  assert.deepEqual([backup.app, backup.type, backup.version], ['Waysplit', 'backup', 1]);
  assert.equal(backup.settings.language, 'en');
  setLanguage('ru');

  const dst = setup({ local: { servers: [S2], settings: { language: 'ru' } }, host: { parse_links: () => ({ servers: [], errors: [] }) } });
  await dst.c.init();
  // Копия версии 1.1.0: настройки языка в ней нет — остаётся нынешний.
  const { language: _none, ...oldSettings } = backup.settings;
  await dst.c.importBackup({ ...backup, settings: oldSettings });
  assert.equal(dst.store.local.settings.language, 'ru');
  // Копия версии 1.2.0: язык — из копии.
  await dst.c.importBackup(backup);
  assert.equal(dst.store.local.settings.language, 'en');
  setLanguage('ru');
});
