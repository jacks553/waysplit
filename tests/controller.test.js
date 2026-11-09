// Тесты extension/lib/controller.js (reconcile) с подделками chrome.* и компаньона.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_MS } from '../extension/lib/controller.js';
import { S1, S2, applies, err, setup } from './fakes.js';


test('включение: сначала PAC, потом ядро; статус «подключено»', async () => {
  const { c, store, proxy, host, alarms, timers, events } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1, S2] } });
  await c.init();
  assert.deepEqual(events, ['pac', 'apply']);
  assert.match(proxy.pac, /var DEFAULT = "SOCKS5 127\.0\.0\.1:27101";/);
  assert.deepEqual(host.calls[0].params, {
    servers: [{ id: 's_1', link: S1.link, localPort: 27101 }, { id: 's_2', link: S2.link, localPort: 27102 }],
    logLevel: 'warn',
    need: ['s_1'],
  }, 'в ядро — все серверы, только id, ссылка и порт; нужен — текущий');
  assert.equal(store.session.status.state, 'on');
  assert.equal(store.session.status.serverId, 's_1');
  assert.equal(store.session.started, true);
  assert.equal(host.keepAlive, true, 'компаньон держим, пока нужно ядро');
  assert.equal(alarms.on, true);
  assert.equal(timers.list.find((t) => t.kind === 'interval')?.ms, HEARTBEAT_MS);
});

test('выключение: сначала убрать прокси, потом остановить ядро', async () => {
  const { c, store, host, alarms, timers, events } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1] } });
  await c.init();
  events.length = 0;
  await c.toggle(false);
  assert.deepEqual(events, ['clear', 'stop']);
  assert.equal(store.session.status.state, 'off');
  assert.equal(store.local.enabled, false);
  assert.equal(host.keepAlive, false);
  assert.equal(alarms.on, false);
  assert.equal(timers.list.length, 0, 'heartbeat и повторы остановлены');
});

test('выключено с самого начала: прокси убирается, компаньон не трогаем', async () => {
  const { c, store, events } = setup({ local: { servers: [S1], currentServerId: 's_1' } });
  await c.init();
  assert.deepEqual(events, ['clear']);
  assert.equal(store.session.status.state, 'off');
});

test('«открыть напрямую» при недоступном сервере — запасной DIRECT в PAC', async () => {
  const { c, proxy } = setup({ local: { enabled: true, currentServerId: 's_2', servers: [S1, S2], settings: { onFailure: 'direct' } } });
  await c.init();
  assert.match(proxy.pac, /var DEFAULT = "SOCKS5 127\.0\.0\.1:27102; DIRECT";/);
});

test('тот же PAC второй раз не ставится, ядро не перезапускается без нужды', async () => {
  const { c, events } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1] } });
  await c.init();
  await c.reconcile();
  assert.deepEqual(events, ['pac', 'apply', 'apply'], 'apply повторяется (компаньон сам не перезапускает тот же список), PAC — нет');
});

test('прокси управляет другое расширение — предупреждение', async () => {
  const { c, store } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1] }, control: 'controlled_by_other_extensions' });
  await c.init();
  assert.equal(store.session.status.conflict, true);
});

test('ошибка ядра: понятный текст, PAC остаётся — напрямую ничего не утечёт', async () => {
  const { c, store, proxy, events } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1] },
    host: { apply: () => { throw err('PORT_BUSY', 'Порт 27101 занят другой программой'); } },
  });
  await c.init();
  assert.equal(store.session.status.state, 'error');
  assert.equal(store.session.status.code, 'PORT_BUSY');
  assert.equal(store.session.status.message, 'Порт 27101 занят другой программой');
  assert.ok(proxy.pac, 'PAC на месте');
  assert.ok(!events.includes('clear'));
});

test('текущий сервер не вошёл в конфиг — ошибка про него', async () => {
  const { c, store } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1, S2] },
    host: { apply: () => ({ hostVersion: '1.0.0', running: true, servers: { s_2: 27102 }, errors: [{ id: 's_1', message: 'транспорт xhttp не поддерживается sing-box' }] }) },
  });
  await c.init();
  assert.equal(store.session.status.state, 'error');
  assert.match(store.session.status.message, /xhttp/);
});

test('компаньон не установлен: ошибка и повторы с паузой 1, 3, 10 с', async () => {
  const { c, store, host, timers } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1] },
    host: { apply: () => { throw err('HOST_NOT_FOUND', 'Компаньон не установлен'); } },
  });
  await c.init();
  assert.equal(store.session.status.code, 'HOST_NOT_FOUND');
  assert.equal(timers.list.find((t) => t.kind === 'timeout').ms, 1000);
  await timers.fire('timeout');
  await c.running;
  assert.equal(applies(host), 2);
  assert.equal(timers.list.find((t) => t.kind === 'timeout').ms, 3000);
  host.handlers.apply = (p) => ({ hostVersion: '1.0.0', running: true, servers: { s_1: 27101 }, errors: [] });
  await timers.fire('timeout');
  await c.running;
  assert.equal(store.session.status.state, 'on');
  assert.equal(c.attempt, 0, 'после успеха паузы начинаются заново');
});

test('обрыв связи с компаньоном — переподключение', async () => {
  const { c, store, host, timers } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1] } });
  await c.init();
  host.connected = false;
  host.onDisconnect(err('HOST_EXITED', 'Компаньон неожиданно завершился'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.session.status.state, 'connecting');
  assert.equal(store.session.status.message, 'Компаньон перезапускается…');
  await timers.fire('timeout');
  await c.running;
  assert.equal(applies(host), 2);
  assert.equal(store.session.status.state, 'on');
});

test('heartbeat: ядро упало — поднять снова; компаньон завис — отключить и начать заново', async () => {
  const { c, host, timers, events } = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1] } });
  await c.init();
  host.handlers.status = () => ({ running: false });
  await timers.fire('interval');
  await c.running;
  assert.equal(applies(host), 2);

  host.handlers.status = () => { throw err('TIMEOUT', 'Компаньон не ответил за 5 с'); };
  await timers.fire('interval');
  await c.running;
  assert.ok(events.includes('disconnect'));
  assert.equal(applies(host), 3);
});

test('вызовы reconcile сливаются: пока идёт один, остальные — один повтор', async () => {
  let release;
  const { c, host } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1] },
    host: { apply: () => new Promise((r) => { release = () => r({ hostVersion: '1.0.0', running: true, servers: { s_1: 27101 }, errors: [] }); }) },
  });
  const first = c.reconcile();
  for (let i = 0; i < 5; i++) c.reconcile();
  await new Promise((r) => setTimeout(r, 0));
  release();
  await new Promise((r) => setTimeout(r, 0));
  release();
  await first;
  assert.equal(applies(host), 2);
});

test('нет сервера: состояние «нет сервера», ядро не нужно', async () => {
  const { c, store, events } = setup({ local: { enabled: true } });
  await c.init();
  assert.equal(store.session.status.state, 'no_server');
  assert.deepEqual(events, ['clear']);
});

test('автоподключение: «выключено» — в новой сессии VPN выключается; «как было» — остаётся', async () => {
  const off = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1], settings: { autoConnect: 'off' } } });
  await off.c.init();
  assert.equal(off.store.local.enabled, false);

  const same = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1], settings: { autoConnect: 'off' } }, session: { started: true } });
  await same.c.init();
  assert.equal(same.store.local.enabled, true, 'фон просто проснулся посреди сессии — не выключаем');

  const restore = setup({ local: { enabled: true, currentServerId: 's_1', servers: [S1] } });
  await restore.c.init();
  assert.equal(restore.store.local.enabled, true);
  assert.equal(restore.store.session.status.state, 'on');
});

test('добавление ссылок: повторы, постоянные порты, текущий сервер, подписки без секретов', async () => {
  const parsed = (key, name) => ({ key, name, link: `vless://x@${name}.example.com:443`, protocol: 'vless', address: `${name}.example.com`, port: 443, transport: 'tcp', security: 'reality' });
  const { c, store } = setup({
    local: { servers: [{ ...S1, key: 'k0' }], currentServerId: 's_1' },
    host: {
      parse_links: () => ({
        servers: [parsed('k1', 'a'), parsed('k0', 'старый'), parsed('k2', 'b'), parsed('k1', 'a2')],
        errors: [{ line: 3, text: 'vless://d47d…@x.example.com:443?…', reason: 'транспорт xhttp не поддерживается sing-box' }],
        subscriptions: ['https://sub.example.com/api/sub/SECRET-TOKEN'],
      }),
    },
  });
  await c.init();
  const res = await c.addLinks('…');
  assert.equal(res.added, 2);
  assert.deepEqual(res.names, ['a', 'b']);
  assert.deepEqual(res.skipped.map((s) => s.reason), [
    'транспорт xhttp не поддерживается sing-box',
    'нет такой команды', // подделка компаньона не умеет fetch_subscription — ошибка подписки идёт в пропущенные
    'такой сервер уже есть',
    'такой сервер уже есть',
  ]);
  assert.ok(!JSON.stringify(res).includes('SECRET-TOKEN'), 'адрес подписки скрыт');
  const servers = store.local.servers;
  assert.deepEqual(servers.map((s) => s.localPort), [27101, 27102, 27103]);
  assert.equal(new Set(servers.map((s) => s.id)).size, 3);
  assert.match(servers[1].id, /^s_[a-z0-9]{4}$/);
  assert.equal(store.local.currentServerId, 's_1', 'выбранный сервер не меняется');

  const empty = setup({ host: { parse_links: () => ({ servers: [parsed('k9', 'z')], errors: [] }) } });
  await empty.c.init();
  await empty.c.addLinks('…');
  assert.equal(empty.store.local.currentServerId, empty.store.local.servers[0].id, 'первый добавленный становится текущим');
});

test('быстрый пинг сохраняет время ответа у сервера', async () => {
  const { c, store, host } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1] },
    host: { ping: (p) => ({ results: [{ id: p.serverIds[0], ms: 48 }] }) },
  });
  await c.init();
  const r = await c.pingCurrent();
  assert.equal(r.ms, 48);
  assert.equal(store.local.servers[0].lastPingMs, 48);
  assert.deepEqual(host.calls.findLast((x) => x.cmd === 'ping').params.serverIds, ['s_1']);
});

test('старый компаньон: ядро останавливается, ошибка «обновите», без повторов', async () => {
  const { c, store, host, timers, events } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1] },
    host: { apply: () => ({ hostVersion: '0.9.0', running: true, restarted: true, servers: { s_1: 27101 }, errors: [] }) },
  });
  await c.init();
  assert.deepEqual(events, ['pac', 'apply', 'stop']);
  assert.equal(store.session.status.state, 'error');
  assert.equal(store.session.status.code, 'HOST_OUTDATED');
  assert.match(store.session.status.message, /версия 0\.9\.0, нужна 1\.0\.0 или новее/);
  assert.equal(timers.list.filter((t) => t.kind === 'timeout').length, 0, 'повтор старый компаньон не исправит');
  // Обновили: старый компаньон завершился, фон переподключается — уже к новому.
  host.handlers.apply = (p) => ({ hostVersion: '1.0.0', running: true, restarted: true, servers: { s_1: 27101 }, errors: [] });
  host.onDisconnect({ code: 'HOST_EXITED', message: 'завершился' });
  await timers.fire('timeout');
  await c.running;
  assert.equal(store.session.status.state, 'on');
});

test('компаньон без версии в ответе (до 1.0.0) — тоже старый', async () => {
  const { c, store } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1] },
    host: { apply: () => ({ running: true, servers: { s_1: 27101 }, errors: [] }) },
  });
  await c.init();
  assert.equal(store.session.status.code, 'HOST_OUTDATED');
  assert.match(store.session.status.message, /старая версия/);
});
