// Тесты переключателя «Российские сайты — без VPN» (настройка ruDirect): домены набора
// «Российские сайты без VPN» из domain-sets.json идут в PAC как DIRECT с низшим приоритетом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { findRoute, pacRules, routeFor, routingPlan, ruleTable } from '../extension/lib/rules.js';
import { buildPac } from '../extension/lib/pac.js';
import { DEFAULT_SETTINGS, normalize } from '../extension/lib/storage.js';
import { siteData } from '../extension/lib/sitedomains.js';
import { S1, S2, SETS, setup } from './fakes.js';

const RU = siteData(SETS).ruDirect;
const A = 'SOCKS5 127.0.0.1:27101';
const B = 'SOCKS5 127.0.0.1:27102';
const rule = (domain, action = 'proxy', extra = {}) => ({ id: `r_${domain}`, domain, action, serverId: null, enabled: true, siteDomains: [], siteDomainsRemoved: [], ...extra });

function pacFind(pac) {
  const ctx = vm.createContext({});
  vm.runInContext(pac, ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}
// go — «куда пойдёт сайт» по плану для этого состояния хранилища.
const go = (st) => {
  const plan = routingPlan(normalize(st), RU);
  return plan.pac ? pacFind(buildPac(plan.pac)) : () => 'DIRECT (без PAC)';
};
const on = (rules = [], more = {}) => ({ enabled: true, currentServerId: 's_1', servers: [S1, S2], rules, settings: { ruDirect: true }, ...more });

test('набор: зоны и российские сервисы на других доменах, без повторов; по умолчанию переключатель выключен', () => {
  for (const d of ['ru', 'xn--p1ai', 'su', 'vk.com', 'userapi.com', 'mycdn.me', 'yandex.net', 'yastatic.net', 'yandexcloud.net', 'wbstatic.net', 'avito.st']) assert.ok(RU.includes(d), d);
  assert.equal(new Set(RU).size, RU.length);
  for (const d of RU) assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)*$/, d);
  assert.equal(DEFAULT_SETTINGS.ruDirect, false);
  assert.equal(normalize({}).settings.ruDirect, false, 'новая установка');
  assert.equal(normalize({ settings: { rulesWhenOff: false, theme: 'dark' } }).settings.ruDirect, false, 'обновление с 1.0.0: настройки ещё нет');
});

test('выключен — как раньше; включён — российские сайты напрямую, остальные через VPN', () => {
  const off = go({ ...on(), settings: {} });
  assert.equal(off('ya.ru'), A);
  assert.equal(off('vk.com'), A);
  const f = go(on());
  for (const h of ['ya.ru', 'www.gosuslugi.ru', 'online.sberbank.ru', 'xn--e1afmkfd.xn--p1ai', 'site.su', 'vk.com', 'm.vk.com', 'sun9-1.userapi.com', 'i.mycdn.me',
    'yastatic.net', 'storage.yandexcloud.net', 'static.wbstatic.net', '00.img.avito.st', 'habr.com']) assert.equal(f(h), 'DIRECT', h);
  for (const h of ['example.com', 'youtube.com', 'rutracker.org', 'vk.com.example.org', 'notvk.com', 'ru.wikipedia.org']) assert.equal(f(h), A, h);
  assert.equal(f('192.168.1.1'), 'DIRECT');
});

test('приоритет: правила пользователя и домены сайта побеждают переключатель', () => {
  const rules = [
    rule('shop.example.ru', 'proxy', { serverId: 's_2' }), // конкретный сайт в зоне .ru — через VPN
    rule('vk.com', 'proxy'), // тот же домен, что в наборе, — своё правило важнее
    rule('su', 'proxy', { serverId: 's_2' }), // и правило на целую зону из набора
    rule('video.example.com', 'proxy', { serverId: 's_2', siteDomains: ['cdn.video-example.ru', 'yastatic.net'] }), // домены сайта
    rule('bank.example.ru', 'direct'),
    rule('off.example.ru', 'proxy', { enabled: false }), // выключенное правило не действует
  ];
  const f = go(on(rules));
  assert.equal(f('shop.example.ru'), B, 'правило «через VPN» на сайт в .ru работает при включённом переключателе');
  assert.equal(f('img.shop.example.ru'), B);
  assert.equal(f('other.example.ru'), 'DIRECT', 'соседний сайт в .ru — по переключателю');
  assert.equal(f('vk.com'), A);
  assert.equal(f('m.vk.com'), A);
  assert.equal(f('vk.me'), 'DIRECT', 'остальные домены набора — по переключателю');
  assert.equal(f('site.su'), B);
  assert.equal(f('cdn.video-example.ru'), B, 'домен сайта в зоне .ru — как его правило');
  assert.equal(f('yastatic.net'), B, 'домен сайта, совпавший с доменом набора, — как его правило');
  assert.equal(f('bank.example.ru'), 'DIRECT');
  assert.equal(f('off.example.ru'), 'DIRECT');

  // Таблица: набор — последним и только там, где свободно.
  const table = ruleTable(rules, RU);
  assert.equal(table.get('vk.com').rule.domain, 'vk.com');
  assert.equal(table.get('su').rule.domain, 'su');
  assert.equal(table.get('yastatic.net').via, 'yastatic.net');
  assert.deepEqual(table.get('ru'), { rule: null, via: null, ru: 'ru' });
  assert.equal(pacRules(rules, [S1, S2], S1, 'block', RU).ru, 'DIRECT');
  assert.equal(pacRules(rules, [S1, S2], S1, 'block').ru, undefined);
});

test('VPN выключен: переключатель сам прокси не включает; с правилами «через VPN» — не мешает им', () => {
  const idle = routingPlan(normalize({ ...on(), enabled: false }), RU);
  assert.deepEqual([idle.pac, idle.needCore], [null, false], 'правил «через VPN» нет — прокси и ядро не нужны');
  const f = go({ ...on([rule('shop.example.ru'), rule('youtube.com')]), enabled: false });
  assert.equal(f('shop.example.ru'), A);
  assert.equal(f('youtube.com'), A);
  assert.equal(f('ya.ru'), 'DIRECT');
  assert.equal(f('example.com'), 'DIRECT');
  const plan = routingPlan(normalize({ ...on([rule('shop.example.ru')]), enabled: false }), RU);
  assert.equal(plan.viaVpn, 1, 'домены набора правилами не считаются');
});

test('«Этот сайт» не расходится с PAC: российский сайт — «напрямую: российский сайт»', () => {
  const rules = [rule('shop.example.ru', 'proxy', { serverId: 's_2' }), rule('video.example.com', 'proxy', { siteDomains: ['yastatic.net'] })];
  const st = normalize(on(rules));
  assert.deepEqual(routeFor(st, 'www.gosuslugi.ru', RU), { kind: 'direct', rule: null, ru: 'ru' });
  assert.deepEqual(routeFor(st, 'm.vk.com', RU), { kind: 'direct', rule: null, ru: 'vk.com' });
  assert.deepEqual(routeFor(st, 'img.shop.example.ru', RU), { kind: 'vpn', server: S2, rule: st.rules[0], via: null });
  assert.deepEqual(routeFor(st, 'yastatic.net', RU), { kind: 'vpn', server: S1, rule: st.rules[1], via: 'yastatic.net' });
  assert.deepEqual(routeFor(st, 'example.com', RU), { kind: 'vpn', server: S1, rule: null });
  assert.deepEqual(findRoute(st.rules, 'ya.ru', RU), { rule: null, via: null, ru: 'ru' });
  // Переключатель выключен — российский сайт как остальные.
  const off = normalize({ ...on(rules), settings: {} });
  assert.deepEqual(routeFor(off, 'www.gosuslugi.ru', RU), { kind: 'vpn', server: S1, rule: null });
  // VPN выключен — сайт напрямую и без переключателя: причина — «VPN выключен», а не «российский сайт».
  const vpnOff = normalize({ ...on(rules), enabled: false });
  assert.deepEqual(routeFor(vpnOff, 'www.gosuslugi.ru', RU), { kind: 'direct', rule: null, inactive: null });

  // Сверка окна с PAC по всем видам сайтов и состояний.
  const hosts = ['ya.ru', 'm.vk.com', 'img.shop.example.ru', 'yastatic.net', 'cdn.yastatic.net', 'example.com', 'site.su', 'video.example.com'];
  for (const state of [st, off, vpnOff, normalize({ ...on(rules), enabled: false, settings: { ruDirect: true, rulesWhenOff: false } })]) {
    const plan = routingPlan(state, RU);
    const pac = plan.pac ? pacFind(buildPac(plan.pac)) : () => 'DIRECT';
    for (const h of hosts) {
      const r = routeFor(state, h, RU);
      const want = r.kind === 'vpn' ? `SOCKS5 127.0.0.1:${r.server.localPort}` : 'DIRECT';
      assert.equal(pac(h), want, `${h}: окно — ${r.kind}, PAC — ${pac(h)}`);
    }
  }
});

test('настройка в controller: PAC меняется, правила не трогаются', async () => {
  // У пользователя уже есть явные правила из набора (добавлял «Готовые наборы») и своё правило в .ru.
  const mine = [rule('ru', 'direct'), rule('vk.com', 'direct', { enabled: false }), rule('shop.example.ru', 'proxy', { serverId: 's_2' })];
  const { c, store, proxy, host, events } = setup({ local: { enabled: true, servers: [S1, S2], currentServerId: 's_1', rules: mine, siteSetsApplied: true }, sets: SETS });
  await c.init();
  const before = JSON.stringify(store.local.rules);
  assert.doesNotMatch(proxy.pac, /"su":/, 'по умолчанию выключено');
  assert.match(proxy.pac, /"ru":"DIRECT"/, 'явное правило пользователя на зону ru работает как раньше');
  const applies = host.calls.filter((x) => x.cmd === 'apply').length;

  events.length = 0;
  await c.setSetting('ruDirect', true);
  assert.equal(store.local.settings.ruDirect, true);
  assert.equal(JSON.stringify(store.local.rules), before, 'правила пользователя не тронуты');
  assert.equal(events[0], 'pac');
  const f = pacFind(proxy.pac);
  assert.equal(f('site.su'), 'DIRECT');
  assert.equal(f('yastatic.net'), 'DIRECT');
  assert.equal(f('shop.example.ru'), B);
  assert.equal(f('vk.com'), 'DIRECT', 'своё правило vk.com выключено — домен идёт по переключателю');
  assert.equal(f('example.com'), A);
  assert.equal(store.session.status.state, 'on');
  assert.equal(host.calls.filter((x) => x.cmd === 'apply' && x.params.servers.length !== 2).length, 0);
  assert.ok(host.calls.filter((x) => x.cmd === 'apply').length >= applies, 'список серверов тот же — компаньон ядро не перезапускает');

  await c.setSetting('ruDirect', false);
  assert.doesNotMatch(proxy.pac, /"su":/);
  assert.equal(JSON.stringify(store.local.rules), before);
  await assert.rejects(c.setSetting('ruDirect', 'да'), (e) => e.code === 'BAD_SETTING');
});

test('без файла наборов переключатель ничего не ломает', async () => {
  const { c, proxy } = setup({ local: { enabled: true, servers: [S1], currentServerId: 's_1', settings: { ruDirect: true } } });
  await c.init();
  assert.match(proxy.pac, /var RULES = \{\};/);
});

test('резервная копия сохраняет и восстанавливает переключатель', async () => {
  const parse = { parse_links: () => ({ servers: [{ ...S1 }], errors: [] }) };
  const src = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS, host: parse });
  await src.c.init();
  await src.c.setSetting('ruDirect', true);
  const backup = JSON.parse(JSON.stringify(await src.c.exportBackup()));
  assert.equal(backup.settings.ruDirect, true);

  const dst = setup({ local: { enabled: true }, sets: SETS, host: parse });
  await dst.c.init();
  await dst.c.importBackup(backup);
  assert.equal(dst.store.local.settings.ruDirect, true);
  assert.match(dst.proxy.pac, /"ru":"DIRECT"/, 'после восстановления сразу действует');
  // Копия из версии 1.0.0 — настройки нет: выключено.
  const { ruDirect: _none, ...oldSettings } = backup.settings;
  await dst.c.importBackup({ ...backup, settings: oldSettings });
  assert.equal(dst.store.local.settings.ruDirect, false);
  assert.doesNotMatch(dst.proxy.pac, /"ru":/);
});
