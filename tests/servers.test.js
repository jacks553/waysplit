// Тесты действий с серверами в extension/lib/controller.js (этап 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S1, S2, err, setup } from './fakes.js';

const pac = (proxy) => proxy.pac?.match(/var DEFAULT = "([^"]*)"/)?.[1];

test('выбор сервера: меняется только PAC, ядро получает тот же список (без перезапуска)', async () => {
  const { c, store, proxy, host, events } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1, S2] } });
  await c.init();
  const first = host.calls.find((x) => x.cmd === 'apply').params;
  events.length = 0;
  await c.select('s_2');
  assert.deepEqual(events, ['pac', 'apply']);
  assert.equal(pac(proxy), 'SOCKS5 127.0.0.1:27102');
  const last = host.calls.filter((x) => x.cmd === 'apply').at(-1).params;
  assert.deepEqual({ ...last, need: null }, { ...first, need: null }, 'тот же список — компаньон не перезапустит ядро');
  assert.deepEqual([first.need, last.need], [['s_1'], ['s_2']], 'нужный сервер — новый текущий (для Xray)');
  assert.equal(store.local.currentServerId, 's_2');
  assert.equal(store.session.status.state, 'on');
  assert.equal(store.session.status.serverId, 's_2');
  await assert.rejects(c.select('нет'), (e) => e.code === 'NOT_FOUND');
});

test('порядок в списке не трогает ядро: в ядро серверы идут по id', async () => {
  const { c, store, host, events } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S2, S1] } });
  await c.init();
  assert.deepEqual(host.calls[0].params.servers.map((s) => s.id), ['s_1', 's_2']);
  events.length = 0;
  await c.reorder(['s_1', 'нет', 's_1', 's_2']);
  assert.deepEqual(store.local.servers.map((s) => s.id), ['s_1', 's_2']);
  await c.reorder(['s_2']);
  assert.deepEqual(store.local.servers.map((s) => s.id), ['s_2', 's_1'], 'не названные — в конец');
  assert.deepEqual(events, [], 'ни PAC, ни ядро не трогали');
});

test('переименование: обрезает пробелы, пустое имя — ошибка', async () => {
  const { c, store } = setup({ local: { servers: [S1] } });
  await c.rename('s_1', '  🇳🇱 Амстердам  ');
  assert.equal(store.local.servers[0].name, '🇳🇱 Амстердам');
  await assert.rejects(c.rename('s_1', '   '), (e) => e.code === 'BAD_NAME');
  assert.equal(store.local.servers[0].name, '🇳🇱 Амстердам');
});

test('удаление текущего: текущим становится следующий, правила с него — на «текущий сервер»', async () => {
  const rules = [
    { id: 'r1', domain: 'a.com', action: 'proxy', serverId: 's_1', enabled: true },
    { id: 'r2', domain: 'b.com', action: 'proxy', serverId: 's_2', enabled: true },
    { id: 'r3', domain: 'c.com', action: 'direct', serverId: null, enabled: true },
  ];
  const { c, store, proxy, host } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1, S2], rules } });
  await c.init();
  const res = await c.remove('s_1');
  assert.equal(res.rulesMoved, 1);
  assert.deepEqual(store.local.rules.map((r) => r.serverId), [null, 's_2', null]);
  assert.equal(store.local.currentServerId, 's_2');
  assert.deepEqual(host.calls.filter((x) => x.cmd === 'apply').at(-1).params.servers.map((s) => s.id), ['s_2']);
  assert.equal(pac(proxy), 'SOCKS5 127.0.0.1:27102');

  await c.remove('s_2');
  assert.equal(store.local.currentServerId, null);
  assert.equal(store.session.status.state, 'no_server');
  assert.equal(host.calls.at(-1).cmd, 'stop');
});

test('пинг при выключенном VPN: ядро поднимается на время проверки и гасится', async () => {
  const { c, store, host, proxy, events } = setup({
    local: { servers: [S1, S2], currentServerId: 's_1' },
    host: { ping: () => ({ results: [{ id: 's_1', ms: 120 }, { id: 's_2', error: 'Сервер не отвечает' }] }) },
  });
  await c.init();
  events.length = 0;
  const res = await c.ping();
  await c.running;
  assert.deepEqual(events, ['apply', 'ping', 'stop']);
  assert.equal(proxy.pac, null, 'PAC не ставился: VPN выключен');
  assert.deepEqual(res.map((r) => r.ms || r.error), [120, 'Сервер не отвечает']);
  assert.deepEqual(store.local.servers.map((s) => [s.lastPingMs, s.lastPingError]), [[120, null], [null, 'Сервер не отвечает']]);
  assert.equal(store.session.status.state, 'off');
  assert.equal(host.keepAlive, false, 'компаньон отпущен');
  assert.deepEqual(host.calls.find((x) => x.cmd === 'ping').params.serverIds, ['s_1', 's_2']);
});

test('пинг при включённом VPN ядро не гасит', async () => {
  const { c, events } = setup({
    local: { enabled: true, servers: [S1], currentServerId: 's_1' },
    host: { ping: () => ({ results: [{ id: 's_1', ms: 50 }] }) },
  });
  await c.init();
  events.length = 0;
  assert.equal((await c.pingCurrent()).ms, 50);
  await c.running;
  assert.ok(!events.includes('stop'));
});

test('пинг без компаньона — понятная ошибка, статус VPN не портится', async () => {
  const { c, store } = setup({
    local: { servers: [S1], currentServerId: 's_1' },
    host: { apply: () => { throw err('HOST_NOT_FOUND', 'Компаньон не установлен'); } },
  });
  await c.init();
  await assert.rejects(c.ping(), (e) => e.code === 'HOST_NOT_FOUND');
  await c.running;
  assert.equal(store.session.status.state, 'off');
});

test('самый быстрый: выбирается сервер с наименьшим пингом', async () => {
  const { c, store } = setup({
    local: { enabled: true, servers: [S1, S2], currentServerId: 's_1' },
    host: { ping: () => ({ results: [{ id: 's_1', ms: 300 }, { id: 's_2', ms: 80 }] }) },
  });
  await c.init();
  const best = await c.fastest();
  assert.equal(best.id, 's_2');
  assert.equal(store.local.currentServerId, 's_2');

  const none = setup({ local: { servers: [S1] }, host: { ping: () => ({ results: [{ id: 's_1', error: 'нет' }] }) } });
  await none.c.init();
  await assert.rejects(none.c.fastest(), (e) => e.code === 'NO_ANSWER' && e.message === 'Ни один сервер не ответил');
});
