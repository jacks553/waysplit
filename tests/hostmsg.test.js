// Фразы компаньона на языке окна (extension/lib/hostmsg.js) и совместимость в обе стороны:
// компаньон 1.2.0 присылает фразу рядом с прежним русским текстом, компаньоны 1.0.0 и 1.1.0 — только текст.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../extension/lib/i18n.js';
import { hostPhrase, hostText } from '../extension/lib/hostmsg.js';
import { HostError, NativeHost, replyError } from '../extension/lib/native.js';
import { coreText, subError } from '../extension/lib/format.js';
import { S1, setup } from './fakes.js';

const BUSY_RU = 'Порт 27105 занят другой программой';
const BUSY = { msg: 'port_busy', params: { port: 27105 } };
const SUB_RU = 'подписка не скачалась: сервер подписки не ответил вовремя';
const SUB_TIMEOUT = { msg: 'sub_net', params: { reason: { msg: 'net_timeout' } } };

test('фраза по коду: на языке окна, вложенная фраза тоже; незнакомая — текст компаньона как есть', () => {
  setLanguage('en');
  try {
    assert.equal(hostText(BUSY, BUSY_RU), 'Port 27105 is in use by another program');
    assert.equal(hostText(SUB_TIMEOUT, SUB_RU), 'could not download the subscription: the subscription server did not respond in time');
    assert.equal(hostText({ msg: 'raw', params: { error: 'dial tcp: i/o timeout' } }, 'dial tcp: i/o timeout'), 'dial tcp: i/o timeout');
    // Компаньон новее расширения: фразы нет в словаре — русский текст как есть.
    assert.equal(hostText({ msg: 'from_the_future' }, 'новая фраза'), 'новая фраза');
    assert.equal(hostText({ msg: 'sub_net', params: { reason: { msg: 'from_the_future' } } }, 'подписка не скачалась: новое'), 'подписка не скачалась: новое');
    // Компаньон 1.0.0 и 1.1.0: фразы нет — текст как есть, знакомые причины пинга — по тексту.
    assert.equal(hostText({}, BUSY_RU), BUSY_RU);
    assert.equal(hostText(null, 'Сервер не отвечает'), 'Server is not responding');
    assert.equal(hostText(undefined, undefined), '');
    // Что сохранять: фраза только знакомая, без лишних полей.
    assert.deepEqual(hostPhrase({ ...BUSY, error: BUSY_RU, id: 's_1' }, BUSY_RU), BUSY);
    assert.deepEqual(hostPhrase({ msg: 'no_uuid', reason: 'в ссылке нет uuid', line: 1 }, 'в ссылке нет uuid'), { msg: 'no_uuid' });
    assert.equal(hostPhrase({ msg: 'from_the_future' }, 'новая фраза'), null);
    setLanguage('ru');
    // По-русски фраза собирается буква в букву как у компаньона.
    assert.equal(hostText(BUSY, 'другое'), BUSY_RU);
    assert.equal(hostText(SUB_TIMEOUT, 'другое'), SUB_RU);
  } finally {
    setLanguage('ru');
  }
});

test('ответ компаньона «нет»: текст на языке окна и фраза для хранения; у старого компаньона — его текст', async () => {
  const replies = [];
  const runtime = {
    connectNative: () => {
      const port = {
        listeners: [],
        onMessage: { addListener: (f) => port.listeners.push(f) },
        onDisconnect: { addListener: () => {} },
        postMessage: (m) => replies.push(() => port.listeners.forEach((f) => f(m.reply(m.id)))),
        disconnect() {},
      };
      return port;
    },
  };
  setLanguage('en');
  try {
    const host = new NativeHost({ runtime });
    const ask = (error) => {
      const p = host.request('apply', { reply: (id) => ({ id, ok: false, error }) });
      replies.shift()();
      return p.catch((e) => e);
    };
    const fresh = await ask({ code: 'PORT_BUSY', message: BUSY_RU, ...BUSY });
    assert.ok(fresh instanceof HostError);
    assert.deepEqual([fresh.code, fresh.message, fresh.phrase], ['PORT_BUSY', 'Port 27105 is in use by another program', BUSY]);
    const old = await ask({ code: 'PORT_BUSY', message: BUSY_RU });
    assert.deepEqual([old.code, old.message, old.phrase], ['PORT_BUSY', BUSY_RU, null]);
    const empty = await ask({});
    assert.deepEqual([empty.code, empty.message], ['HOST_ERROR', 'The companion returned an error']);
    host.disconnect();
  } finally {
    setLanguage('ru');
  }
  assert.equal(replyError({ code: 'X', message: BUSY_RU, ...BUSY }).message, BUSY_RU);
});

test('строки, которые не стали серверами: причина на языке окна, у старого компаньона — как есть', async () => {
  const { c } = setup({
    local: { settings: { language: 'en' } },
    host: { parse_links: () => ({ servers: [], errors: [
      { line: 1, text: 'vless://a', reason: 'в ссылке нет uuid', msg: 'no_uuid' },
      { line: 2, text: 'vless://b', reason: 'flow=x не поддерживается sing-box', msg: 'sb_flow', params: { flow: 'x' } },
      { line: 3, text: 'vless://c', reason: 'в ссылке нет порта' }, // компаньон 1.1.0
    ] }) },
  });
  await c.init();
  const res = await c.addLinks('vless://a\nvless://b\nvless://c');
  assert.deepEqual(res.skipped.map((s) => s.reason), ['the link has no UUID', 'flow=x is not supported by sing-box', 'в ссылке нет порта']);
  setLanguage('ru');
});

test('подписка не скачалась: причина хранится фразой и читается на любом языке', async () => {
  const sub = { id: 'u_1', name: 'Тест', url: 'https://sub.example.com/s/SECRET', intervalHours: 12, updatedAt: 1, info: null, lastError: null };
  const { c, store } = setup({
    local: { servers: [], subscriptions: [sub], settings: { language: 'en' } },
    host: { fetch_subscription: () => { throw replyError({ code: 'SUBSCRIPTION_FAILED', message: SUB_RU, ...SUB_TIMEOUT }); } },
  });
  await c.init();
  await assert.rejects(c.updateSubscription('u_1'), { code: 'SUBSCRIPTION_FAILED' });
  const saved = store.local.subscriptions[0];
  assert.equal(saved.lastError, 'could not download the subscription: the subscription server did not respond in time');
  assert.deepEqual(saved.lastErrorMsg, SUB_TIMEOUT);
  setLanguage('ru');
  assert.equal(subError(saved), SUB_RU);
  // Запись прежней версии (фразы нет) — как записана.
  assert.equal(subError({ lastError: 'что-то по-русски' }), 'что-то по-русски');
  assert.equal(subError({ lastError: null, lastErrorMsg: SUB_TIMEOUT }), '');
});

test('сервер не запустился и ядро упало: причина на языке окна', async () => {
  const { c, store } = setup({
    local: { enabled: true, servers: [S1], currentServerId: 's_1', settings: { language: 'en' } },
    host: { apply: () => ({ hostVersion: '1.2.0', running: true, restarted: true, servers: {}, errors: [{ id: 's_1', message: 'flow=x не поддерживается sing-box', msg: 'sb_flow', params: { flow: 'x' } }] }) },
  });
  await c.init();
  await c.reconcile();
  assert.equal(store.session.status.message, 'This server did not start: flow=x is not supported by sing-box');
  setLanguage('en');
  assert.equal(coreText({ running: false, lastError: BUSY_RU, lastErrorMsg: BUSY }), 'not running (Port 27105 is in use by another program)');
  assert.equal(coreText({ running: false, lastError: BUSY_RU }), `not running (${BUSY_RU})`);
  setLanguage('ru');
});
