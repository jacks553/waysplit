// Тесты extension/lib/native.js: npm test (или node --test "tests/**/*.test.js")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeHost, HostError, chromeError, HOST_NAME } from '../extension/lib/native.js';

// Подделка chrome.runtime: порт запоминает отправленное, тест сам отвечает и обрывает связь.
function fakeRuntime() {
  const rt = {
    lastError: undefined,
    ports: [],
    connectNative(name) {
      const port = {
        name, sent: [], msgL: [], discL: [], closed: false,
        onMessage: { addListener: (f) => port.msgL.push(f) },
        onDisconnect: { addListener: (f) => port.discL.push(f) },
        postMessage(m) {
          if (port.closed) throw new Error('Attempting to use a disconnected port object');
          port.sent.push(m);
        },
        disconnect() { port.closed = true; },
        reply(m) { port.msgL.forEach((f) => f(m)); },
        die(text) { // компаньон отвалился, Chrome кладёт причину в lastError
          port.closed = true;
          rt.lastError = text ? { message: text } : undefined;
          port.discL.forEach((f) => f());
          rt.lastError = undefined;
        },
      };
      rt.ports.push(port);
      return port;
    },
  };
  return rt;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('запрос и ответ по id', async () => {
  const rt = fakeRuntime();
  const host = new NativeHost({ runtime: rt });
  const p = host.request('hello', { a: 1 });
  const port = rt.ports[0];
  assert.equal(port.name, HOST_NAME);
  assert.deepEqual(port.sent, [{ a: 1, id: 1, cmd: 'hello' }]);
  port.reply({ id: 1, ok: true, result: { hostVersion: '0.2.0' } });
  assert.deepEqual(await p, { hostVersion: '0.2.0' });
  host.disconnect();
});

test('ответы не по порядку попадают к своим запросам', async () => {
  const rt = fakeRuntime();
  const host = new NativeHost({ runtime: rt });
  const a = host.request('a');
  const b = host.request('b');
  assert.equal(rt.ports.length, 1, 'один порт на все запросы');
  rt.ports[0].reply({ id: 2, ok: true, result: 'B' });
  rt.ports[0].reply({ id: 1, ok: true, result: 'A' });
  assert.equal(await a, 'A');
  assert.equal(await b, 'B');
  host.disconnect();
});

test('ошибка компаньона приходит с кодом и текстом', async () => {
  const rt = fakeRuntime();
  const host = new NativeHost({ runtime: rt });
  const p = host.request('start');
  rt.ports[0].reply({ id: 1, ok: false, error: { code: 'PORT_BUSY', message: 'Порт 27105 занят другой программой' } });
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'PORT_BUSY' && e.message === 'Порт 27105 занят другой программой');
  host.disconnect();
});

test('таймаут, опоздавший ответ не ломает следующие', async () => {
  const rt = fakeRuntime();
  const host = new NativeHost({ runtime: rt });
  await assert.rejects(host.request('slow', {}, 30), (e) => e.code === 'TIMEOUT' && /не ответил/.test(e.message));
  rt.ports[0].reply({ id: 1, ok: true, result: 'поздно' });
  const p = host.request('hello');
  rt.ports[0].reply({ id: 2, ok: true, result: 'вовремя' });
  assert.equal(await p, 'вовремя');
  host.disconnect();
});

test('компаньон не установлен: понятная ошибка, ждущие запросы отклонены, потом новый порт', async () => {
  const rt = fakeRuntime();
  const host = new NativeHost({ runtime: rt });
  let notified = null;
  host.onDisconnect = (e) => { notified = e; };
  const p = host.request('hello');
  rt.ports[0].die('Specified native messaging host not found.');
  await assert.rejects(p, (e) => e.code === 'HOST_NOT_FOUND' && e.message === 'Компаньон не установлен');
  assert.equal(notified?.code, 'HOST_NOT_FOUND');
  assert.equal(host.connected, false);
  const q = host.request('hello');
  assert.equal(rt.ports.length, 2, 'после обрыва — новое подключение');
  rt.ports[1].reply({ id: 2, ok: true, result: 1 });
  assert.equal(await q, 1);
  host.disconnect();
});

test('без запросов порт закрывается сам, с keepAlive — нет', async () => {
  const rt = fakeRuntime();
  const host = new NativeHost({ runtime: rt, idleMs: 20 });
  const p = host.request('hello');
  rt.ports[0].reply({ id: 1, ok: true, result: 1 });
  await p;
  await sleep(50);
  assert.equal(rt.ports[0].closed, true, 'порт закрыт после простоя');
  assert.equal(host.connected, false);

  host.setKeepAlive(true);
  const q = host.request('hello');
  rt.ports[1].reply({ id: 2, ok: true, result: 2 });
  await q;
  await sleep(50);
  assert.equal(rt.ports[1].closed, false, 'keepAlive держит порт');

  host.setKeepAlive(false); // ядро больше не нужно — отпустить компаньон
  await sleep(50);
  assert.equal(rt.ports[1].closed, true, 'отпустили — порт закрылся после простоя');
});

test('тексты ошибок Chrome → коды', () => {
  const cases = {
    'Specified native messaging host not found.': 'HOST_NOT_FOUND',
    'Access to the specified native messaging host is forbidden.': 'HOST_FORBIDDEN',
    'Failed to start native messaging host.': 'HOST_START_FAILED',
    'Native host has exited.': 'HOST_EXITED',
    'Error when communicating with the native messaging host.': 'HOST_PROTOCOL',
    'Invalid native messaging host name specified.': 'HOST_NAME',
    'Что-то новое': 'HOST_DISCONNECTED',
    '': 'HOST_DISCONNECTED',
  };
  for (const [text, code] of Object.entries(cases)) {
    const e = chromeError(text);
    assert.equal(e.code, code, text);
    assert.match(e.message, /[а-яё]/i, 'сообщение по-русски');
  }
});
