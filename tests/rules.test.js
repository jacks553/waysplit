// Тесты extension/lib/rules.js и правил в controller.js (этап 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { exportRules, findRule, pacRules, routeFor, routingPlan } from '../extension/lib/rules.js';
import { buildPac } from '../extension/lib/pac.js';
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
  assert.equal(findRule(rules, 'www.google.com').domain, 'google.com');
  assert.equal(findRule(rules, 'mail.google.com').domain, 'mail.google.com');
  assert.equal(findRule(rules, 'a.mail.google.com').domain, 'mail.google.com');
  assert.equal(findRule(rules, 'ya.ru').domain, 'ru', 'выключенное ya.ru не мешает правилу на зону');
  assert.equal(findRule(rules, 'example.com'), null);
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
  assert.deepEqual(routeFor(st, 'm.youtube.com'), { kind: 'vpn', server: S2, rule: st.rules[0] });
  assert.deepEqual(routeFor(st, 'ya.ru'), { kind: 'direct', rule: st.rules[1] });
  assert.deepEqual(routeFor(st, 'example.com'), { kind: 'vpn', server: S1, rule: null });
  assert.equal(routeFor(st, '192.168.1.1').kind, 'local');
  const off = normalize({ ...st, enabled: false, settings: { rulesWhenOff: false } });
  assert.deepEqual(routeFor(off, 'youtube.com'), { kind: 'direct', rule: null, inactive: st.rules[0] });
});

test('экспорт правил: сервер по имени, без секретов', () => {
  const data = exportRules([rule('a.com', 'proxy', 's_2'), rule('b.com', 'direct', null, false)], [S1, S2]);
  assert.equal(data.type, 'rules');
  assert.deepEqual(data.rules, [
    { domain: 'a.com', action: 'proxy', server: 'DE', enabled: true },
    { domain: 'b.com', action: 'direct', server: null, enabled: false },
  ]);
  assert.ok(!JSON.stringify(data).includes('secret'), 'ссылок серверов в файле нет');
});

test('наборы доменов: правильный файл, домены в punycode', () => {
  const { sets } = JSON.parse(readFileSync(new URL('../extension/lib/domain-sets.json', import.meta.url)));
  assert.ok(sets.length >= 3);
  const yt = sets.find((s) => s.id === 'youtube');
  assert.deepEqual(yt.domains, ['youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtu.be', 'youtube-nocookie.com']);
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
