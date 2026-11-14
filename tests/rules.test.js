// Тесты extension/lib/rules.js и правил в controller.js (этап 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { exportRules, findRoute, pacRules, routeFor, routeIn, routingPlan, ruleTable } from '../extension/lib/rules.js';
import { buildPac } from '../extension/lib/pac.js';
import { isLocalHost, pacHost } from '../extension/lib/domains.js';
import { normalize } from '../extension/lib/storage.js';
import { S1, S2, setup } from './fakes.js';

const rule = (domain, action, serverId = null, enabled = true) => ({ id: `r_${domain}`, domain, action, serverId, enabled });
const A = 'SOCKS5 127.0.0.1:27101';
const B = 'SOCKS5 127.0.0.1:27102';

// find — PAC по плану и функция «куда пойдёт этот сайт».
function find(st) {
  const plan = routingPlan(normalize(st));
  if (!plan.pac) return () => 'DIRECT (без PAC)';
  const ctx = vm.createContext({});
  vm.runInContext(buildPac(plan.pac), ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

test('самое конкретное правило побеждает, выключенные не считаются', () => {
  const rules = [rule('google.com', 'proxy'), rule('mail.google.com', 'direct'), rule('ru', 'direct'), rule('ya.ru', 'proxy', null, false)];
  assert.equal(findRoute(rules, 'www.google.com').rule, rules[0]);
  assert.equal(findRoute(rules, 'mail.google.com').rule, rules[1]);
  assert.equal(findRoute(rules, 'a.mail.google.com').rule, rules[1]);
  assert.equal(findRoute(rules, 'ya.ru').rule, rules[2], 'выключенное ya.ru не мешает правилу на зону');
  assert.equal(findRoute(rules, 'example.com'), null);
});

test('правило «через VPN»: свой сервер, текущий или текущий вместо удалённого', () => {
  const map = pacRules([rule('a.com', 'proxy', 's_2'), rule('b.com', 'proxy'), rule('c.com', 'proxy', 's_gone'), rule('d.com', 'direct')], [S1, S2], S1, 'block');
  assert.deepEqual(map, { 'a.com': B, 'b.com': A, 'c.com': A, 'd.com': 'DIRECT' });
  assert.deepEqual(pacRules([rule('a.com', 'proxy')], [S1], S1, 'direct'), { 'a.com': `${A}; DIRECT` });
});

test('VPN включён: всё через текущий, правила — исключения (проверка этапа 5)', () => {
  const go = find({ enabled: true, currentServerId: 's_1', servers: [S1, S2], rules: [rule('api.ipify.org', 'direct')] });
  assert.equal(go('api.ipify.org'), 'DIRECT', 'api.ipify.org видит мой IP');
  assert.equal(go('ifconfig.me'), A, 'ifconfig.me — IP сервера');
});

test('пример из SPEC: google.com через VPN, mail.google.com без VPN', () => {
  const go = find({ enabled: false, currentServerId: 's_1', servers: [S1], rules: [rule('google.com', 'proxy'), rule('mail.google.com', 'direct')] });
  assert.equal(go('www.google.com'), A);
  assert.equal(go('mail.google.com'), 'DIRECT');
  assert.equal(go('example.com'), 'DIRECT');
});

test('VPN выключен: правила «через VPN» работают, остальное напрямую; настройка выключает', () => {
  const st = { enabled: false, currentServerId: 's_1', servers: [S1, S2], rules: [rule('youtube.com', 'proxy', 's_2'), rule('ru', 'direct')] };
  const plan = routingPlan(normalize(st));
  assert.equal(plan.rulesOnly, true);
  assert.equal(plan.needCore, true);
  assert.equal(plan.viaVpn, 1);
  const go = find(st);
  assert.equal(go('www.youtube.com'), B);
  assert.equal(go('example.com'), 'DIRECT');

  const off = routingPlan(normalize({ ...st, settings: { rulesWhenOff: false } }));
  assert.equal(off.pac, null, 'правила при выключенном VPN отключены — прокси не нужен');
  assert.equal(off.needCore, false);
});

test('VPN выключен и только правила «без VPN» — прокси и ядро не нужны', () => {
  const plan = routingPlan(normalize({ servers: [S1], currentServerId: 's_1', rules: [rule('ru', 'direct')] }));
  assert.equal(plan.pac, null);
  assert.equal(plan.needCore, false);
});

test('зоны ru и рф, кириллический домен', () => {
  const go = find({ enabled: true, currentServerId: 's_1', servers: [S1], rules: [rule('ru', 'direct'), rule('xn--p1ai', 'direct'), rule('xn--e1afmkfd.xn--p1ai', 'proxy')] });
  assert.equal(go('sberbank.ru'), 'DIRECT');
  assert.equal(go('www.xn--80aswg.xn--p1ai'), 'DIRECT', 'сайт.рф — зона рф');
  assert.equal(go('xn--e1afmkfd.xn--p1ai'), A, 'пример.рф — своё правило конкретнее зоны');
  assert.equal(go('rutracker.org'), A, 'не зона ru');
});

test('«Этот сайт»: куда идёт и по какому правилу', () => {
  const st = normalize({ enabled: true, currentServerId: 's_1', servers: [S1, S2], rules: [rule('youtube.com', 'proxy', 's_2'), rule('ru', 'direct')] });
  assert.deepEqual(routeFor(st, 'm.youtube.com'), { kind: 'vpn', server: S2, rule: st.rules[0], via: null });
  assert.deepEqual(routeFor(st, 'ya.ru'), { kind: 'direct', rule: st.rules[1], via: null });
  assert.deepEqual(routeFor(st, 'example.com'), { kind: 'vpn', server: S1, rule: null });
  assert.equal(routeFor(st, '192.168.1.1').kind, 'local');
  const off = normalize({ ...st, enabled: false, settings: { rulesWhenOff: false } });
  assert.deepEqual(routeFor(off, 'youtube.com'), { kind: 'direct', rule: null, inactive: st.rules[0] });
});

test('имя с точкой в конце — тот же сайт: окно отвечает так же, как PAC (ya.ru. = ya.ru)', () => {
  const st = normalize({ enabled: true, currentServerId: 's_1', servers: [S1, S2], rules: [rule('youtube.com', 'proxy', 's_2'), rule('ru', 'direct')] });
  const go = find(st);
  const pairs = [['ya.ru.', 'ya.ru'], ['m.youtube.com.', 'm.youtube.com'], ['WWW.YouTube.COM.', 'www.youtube.com'], ['example.com.', 'example.com'],
    ['printer.local.', 'printer.local'], ['localhost.', 'localhost'], ['intranet.', 'intranet'], ['192.168.1.1.', '192.168.1.1'], ['[::1]', '::1']];
  for (const [dotted, plain] of pairs) {
    const r = routeFor(st, dotted);
    assert.deepEqual(r, routeFor(st, plain), dotted);
    assert.equal(go(dotted), go(plain), `PAC: ${dotted}`);
    assert.equal(go(dotted), r.kind === 'vpn' ? `SOCKS5 127.0.0.1:${r.server.localPort}` : 'DIRECT', `${dotted}: окно — ${r.kind}`);
  }
  assert.deepEqual(routeFor(st, 'ya.ru.'), { kind: 'direct', rule: st.rules[1], via: null }, 'раньше окно говорило «правила нет»');
  assert.equal(routeFor(st, 'm.youtube.com.').server, S2);
  assert.equal(routeFor(st, 'printer.local.').kind, 'local');
  assert.deepEqual(['Ya.RU.', '[2001:DB8::1]', 'example.com', '', null].map(pacHost), ['ya.ru', '2001:db8::1', 'example.com', '', '']);
  assert.deepEqual(['localhost.', 'printer.local.', 'intranet.', 'example.com.'].map(isLocalHost), [true, true, true, false]);
});

test('поиск по готовой таблице отвечает так же, как findRoute: таблица — одна на весь список имён', () => {
  const rules = [
    { ...rule('youtube.com', 'proxy', 's_2'), siteDomains: ['googlevideo.com', 'ytimg.com'] },
    { ...rule('ytimg.com', 'direct'), siteDomains: [] },
    { ...rule('off.com', 'proxy', null, false), siteDomains: ['offcdn.com'] },
    rule('org', 'direct'),
  ];
  const ru = ['ru', 'vk.com'];
  const hosts = ['www.youtube.com', 'rr1---sn-a.googlevideo.com', 'i.ytimg.com', 'offcdn.com', 'off.com', 'wikipedia.org', 'ya.ru', 'm.vk.com', 'example.com', 'YouTube.com.'];
  for (const list of [ru, []]) {
    const table = ruleTable(rules, list);
    for (const h of hosts) assert.deepEqual(routeIn(table, h), findRoute(rules, h, list), h);
  }
  const table = ruleTable(rules);
  assert.deepEqual(hosts.map((h) => routeIn(table, h)?.rule?.domain ?? null),
    ['youtube.com', 'youtube.com', 'ytimg.com', null, null, 'org', null, null, null, 'youtube.com'], 'пометки в списке «Домены этой вкладки»');
  assert.equal(routeIn(ruleTable(rules, ru), 'ya.ru').ru, 'ru');
});

test('экспорт правил: сервер по имени, без секретов', () => {
  const data = exportRules([rule('a.com', 'proxy', 's_2'), rule('b.com', 'direct', null, false)], [S1, S2]);
  assert.equal(data.type, 'rules');
  assert.deepEqual(data.rules, [
    { domain: 'a.com', action: 'proxy', server: 'DE', enabled: true, siteDomains: [], siteDomainsRemoved: [] },
    { domain: 'b.com', action: 'direct', server: null, enabled: false, siteDomains: [], siteDomainsRemoved: [] },
  ]);
  assert.ok(!JSON.stringify(data).includes('secret'), 'ссылок серверов в файле нет');
});

test('наборы доменов: правильный файл, домены в punycode', () => {
  const { sets } = JSON.parse(readFileSync(new URL('../extension/lib/domain-sets.json', import.meta.url)));
  assert.ok(sets.length >= 3);
  const yt = sets.find((s) => s.id === 'youtube');
  assert.deepEqual(yt.domains, ['youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtu.be', 'youtube-nocookie.com', 'yt3.googleusercontent.com']);
  const ru = sets.find((s) => s.id === 'ru-direct');
  assert.equal(ru.action, 'direct');
  assert.ok(ru.domains.includes('ru') && ru.domains.includes('xn--p1ai') && ru.domains.includes('su'));
  for (const s of sets) for (const d of s.domains) assert.match(d, /^[a-z0-9.-]+$/, `${s.id}: ${d}`);
});

// --- правила в controller.js ---

test('добавление правил: адреса → домены, один домен — одно правило', async () => {
  const { c, store } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' } });
  await c.init();
  let r = await c.addRules(['https://www.youtube.com/watch?v=1', 'YouTube.com', 'рф', 'плохой домен!', '# комментарий', ''], 'proxy', 's_2');
  assert.deepEqual([r.added, r.updated, r.skipped.length], [2, 0, 1]);
  assert.equal(r.skipped[0].reason, 'не похоже на домен');
  assert.deepEqual(store.local.rules.map((x) => [x.domain, x.action, x.serverId, x.enabled]), [
    ['youtube.com', 'proxy', 's_2', true],
    ['xn--p1ai', 'proxy', 's_2', true],
  ]);
  r = await c.addRules(['youtube.com'], 'direct', 's_2');
  assert.deepEqual([r.added, r.updated], [0, 1]);
  assert.deepEqual(store.local.rules[0], { ...store.local.rules[0], action: 'direct', serverId: null }, 'у «без VPN» сервера нет');
  await assert.rejects(c.addRules(['a.com'], 'proxy', 'нет'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(c.addRules(['a.com'], 'куда-то'), (e) => e.code === 'BAD_RULE');
});

test('VPN выключен + правило «через VPN»: PAC только для правила, ядро работает, статус «работают правила»', async () => {
  const { c, store, proxy, events } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' } });
  await c.init();
  events.length = 0;
  await c.addRules(['youtube.com'], 'proxy');
  assert.deepEqual(events, ['pac', 'apply']);
  assert.match(proxy.pac, /var DEFAULT = "DIRECT";/);
  assert.match(proxy.pac, /"youtube\.com":"SOCKS5 127\.0\.0\.1:27101"/);
  assert.equal(store.session.status.state, 'rules');
  assert.equal(store.session.status.viaVpn, 1);

  events.length = 0;
  await c.setSetting('rulesWhenOff', false);
  assert.deepEqual(events, ['clear', 'stop'], 'настройку выключили — прокси убран, ядро остановлено');
  assert.equal(store.session.status.state, 'off');
  await assert.rejects(c.setSetting('rulesWhenOff', 'да'), (e) => e.code === 'BAD_SETTING');
});

test('правило выключили и удалили — прокси и ядро больше не нужны', async () => {
  const { c, store, events } = setup({ local: { servers: [S1], currentServerId: 's_1' } });
  await c.init();
  await c.addRules(['youtube.com'], 'proxy');
  const id = store.local.rules[0].id;
  events.length = 0;
  await c.updateRule(id, { enabled: false });
  assert.deepEqual(events, ['clear', 'stop']);
  await c.updateRule(id, { enabled: true, action: 'proxy', serverId: 's_1' });
  assert.equal(store.local.rules[0].serverId, 's_1');
  events.length = 0;
  await c.removeRules([id]);
  assert.deepEqual(events, ['clear', 'stop']);
  assert.deepEqual(store.local.rules, []);
  await assert.rejects(c.updateRule('нет', { enabled: true }), (e) => e.code === 'NOT_FOUND');
});

test('VPN включён: правило «без VPN» попадает в PAC, ядро не перезапускается', async () => {
  const { c, proxy, host } = setup({ local: { enabled: true, servers: [S1], currentServerId: 's_1' } });
  await c.init();
  const before = host.calls.filter((x) => x.cmd === 'apply').at(-1).params;
  await c.addRules(['api.ipify.org'], 'direct');
  assert.match(proxy.pac, /"api\.ipify\.org":"DIRECT"/);
  assert.match(proxy.pac, /var DEFAULT = "SOCKS5 127\.0\.0\.1:27101";/);
  assert.deepEqual(host.calls.filter((x) => x.cmd === 'apply').at(-1).params, before);
});

test('импорт правил: сервер по имени, выключенные остаются выключенными, чужой файл — ошибка', async () => {
  const { c, store } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' } });
  await c.init();
  const res = await c.importRules({
    type: 'rules',
    rules: [
      { domain: 'a.com', action: 'proxy', server: 'DE', enabled: true },
      { domain: 'b.com', action: 'proxy', server: 'Нет такого', enabled: true },
      { domain: 'c.com', action: 'direct', server: null, enabled: false },
      { domain: 'd.com', action: 'куда-то' },
    ],
  });
  assert.deepEqual([res.added, res.updated, res.skipped.length], [3, 0, 1]);
  const byDomain = Object.fromEntries(store.local.rules.map((r) => [r.domain, r]));
  assert.equal(byDomain['a.com'].serverId, 's_2');
  assert.equal(byDomain['b.com'].serverId, null, 'сервер не нашёлся — через текущий');
  assert.equal(byDomain['c.com'].enabled, false);
  await assert.rejects(c.importRules({ servers: [] }), (e) => e.code === 'BAD_FILE');
});
