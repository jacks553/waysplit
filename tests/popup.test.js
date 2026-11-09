// Тесты окна с вкладками (SPEC-POPUP.md): полоски задержки, флаг из имени, склонения, время
// работы ядра в диагностике, избранное (хранится по key сервера, переживает обновление подписки
// и попадает в резервную копию).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreText, fmtUptime, pingBars, plural, splitFlag } from '../extension/lib/format.js';
import { normalize } from '../extension/lib/storage.js';
import { S1, S2, setup } from './fakes.js';

test('полоски задержки: 400–800 мс через сервер — 3–4 полоски, нет ответа — серые', () => {
  const n = (ms) => pingBars({ lastPingMs: ms }).n;
  assert.deepEqual([n(48), n(412), n(599), n(600), n(800), n(999), n(1000), n(1599), n(1600), n(5000)], [4, 4, 4, 3, 3, 3, 2, 2, 1, 1]);
  assert.deepEqual(pingBars({ lastPingMs: 436 }), { n: 4, title: '436 мс' }, 'миллисекунды — подсказкой');
  assert.deepEqual(pingBars({ lastPingMs: null, lastPingError: 'таймаут' }), { n: 0, title: 'нет ответа: таймаут' });
  assert.deepEqual(pingBars({}), { n: -1, title: 'пинг ещё не проверялся' });
  assert.equal(pingBars(null).n, -1);
});

test('флаг страны из имени сервера', () => {
  assert.deepEqual(splitFlag('🇳🇱 Амстердам'), { flag: '🇳🇱', name: 'Амстердам' });
  assert.deepEqual(splitFlag('  🇩🇪Франкфурт '), { flag: '🇩🇪', name: 'Франкфурт' });
  assert.deepEqual(splitFlag('NL 🇳🇱 Amsterdam'), { flag: '🇳🇱', name: 'NL 🇳🇱 Amsterdam' }, 'флаг в середине — в имени остаётся');
  assert.deepEqual(splitFlag('Сервер без флага'), { flag: '', name: 'Сервер без флага' });
  assert.deepEqual(splitFlag('🇺🇸'), { flag: '🇺🇸', name: '🇺🇸' }, 'имя из одного флага не становится пустым');
  assert.deepEqual(splitFlag(undefined), { flag: '', name: '' });
});

test('склонения: 1 сервер, 2 сервера, 5 серверов, 11–14 серверов', () => {
  const s = (n) => plural(n, ['сервер', 'сервера', 'серверов']);
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 0].map(s),
    ['1 сервер', '2 сервера', '4 сервера', '5 серверов', '11 серверов', '12 серверов', '14 серверов', '21 сервер', '22 сервера', '25 серверов', '101 сервер', '111 серверов', '0 серверов']);
});

test('диагностика: время работы и порты ядра; нет числа — «—», а не NaN', () => {
  assert.deepEqual([fmtUptime(0), fmtUptime(59), fmtUptime(60), fmtUptime(754), fmtUptime(3600), fmtUptime(3725)],
    ['меньше минуты', 'меньше минуты', '1 мин', '12 мин', '1 ч 0 мин', '1 ч 2 мин']);
  for (const bad of [undefined, null, NaN, -5, '12']) assert.equal(fmtUptime(bad), '—', String(bad));
  // Так отвечает настоящий компаньон (status при работающем ядре).
  assert.equal(coreText({ running: true, pid: 24776, uptime: 1, ports: [27911, 27912] }), 'работает, PID 24776, меньше минуты, портов 2');
  assert.equal(coreText({ running: true, pid: 42 }), 'работает, PID 42, —, портов —');
  assert.equal(coreText({ running: false, uptime: 0 }), 'не запущено');
  assert.equal(coreText({ running: false, lastError: 'порт занят' }), 'не запущено (порт занят)');
  assert.equal(coreText({ running: false }, 'запускается, только когда нужен его сервер'), 'запускается, только когда нужен его сервер');
  assert.equal(coreText(null), '—');
});

test('избранное: новое поле с запасным значением — старые данные не ломаются', () => {
  assert.deepEqual(normalize({}).favorites, []);
  assert.deepEqual(normalize({ favorites: ['k1', 5, null, 'k2'] }).favorites, ['k1', 'k2']);
  assert.deepEqual(normalize({ favorites: 'k1' }).favorites, []);
});

test('звёздочка: в избранном — key сервера; ядро и прокси не трогаются', async () => {
  const { c, store, events } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' } });
  await c.init();
  events.length = 0;
  await c.setFavorite('s_2', true);
  await c.setFavorite('s_2', true); // повтор не дублирует
  await c.setFavorite('s_1', true);
  assert.deepEqual(store.local.favorites, ['k2', 'k1']);
  await c.setFavorite('s_2', false);
  assert.deepEqual(store.local.favorites, ['k1']);
  assert.deepEqual(events, [], 'ни PAC, ни компаньон');
  await assert.rejects(c.setFavorite('s_nope', true), (e) => e.code === 'NOT_FOUND');
});

test('избранное переживает обновление подписки: сервер узнаётся по key', async () => {
  const NL = { key: 'k1', name: 'NL новое имя', link: 'vless://x@nl.example.com:443#NL', protocol: 'vless', address: 'nl.example.com', port: 443, transport: 'tcp', security: 'reality', core: 'sing-box' };
  const SUB = { id: 'u_1', name: 'Тест', url: 'https://sub.example.com/s/SECRET', intervalHours: 12, updatedAt: 1, info: null };
  const { c, store } = setup({
    local: { servers: [{ ...S1, subscriptionId: 'u_1' }], currentServerId: 's_1', subscriptions: [SUB] },
    host: { fetch_subscription: () => ({ servers: [NL], errors: [] }) },
  });
  await c.init();
  await c.setFavorite('s_1', true);
  await c.updateSubscription('u_1');
  assert.equal(store.local.servers[0].key, 'k1');
  assert.deepEqual(store.local.favorites, ['k1']);
});

test('резервная копия: избранное сохраняется и восстанавливается (только для восстановленных серверов)', async () => {
  const src = setup({ local: { servers: [S1, S2], currentServerId: 's_1', favorites: ['k2', 'k-gone'] } });
  const backup = await src.c.exportBackup();
  assert.deepEqual(backup.favorites, ['k2', 'k-gone']);
  const parsed = { [S1.link]: 'k1', [S2.link]: 'k2' };
  const dst = setup({
    local: { servers: [] },
    host: { parse_links: (p) => ({ servers: p.text.split('\n').map((link) => ({ key: parsed[link], name: 'x', link, protocol: 'vless', address: 'a.example.com', port: 443, security: 'none' })), errors: [] }) },
  });
  await dst.c.init();
  await dst.c.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(dst.store.local.favorites, ['k2'], 'ключ сервера, которого в копии нет, отброшен');
  const old = setup({ local: { servers: [S1], favorites: ['k1'] }, host: dst.host.handlers });
  await old.c.init();
  await old.c.importBackup({ ...JSON.parse(JSON.stringify(backup)), favorites: undefined });
  assert.deepEqual(old.store.local.favorites, [], 'старая копия без избранного — избранное пустое');
});
