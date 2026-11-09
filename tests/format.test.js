// Тесты extension/lib/format.js: подписи серверов и пинга.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PING_FRESH_MS, freshPing, hostPort, matches, pingView, serverMeta } from '../extension/lib/format.js';

test('адрес и подпись сервера', () => {
  assert.equal(hostPort({ address: 'nl.example.com', port: 443 }), 'nl.example.com:443');
  assert.equal(hostPort({ address: '2001:db8::1', port: 8443 }), '[2001:db8::1]:8443');
  assert.equal(serverMeta({ protocol: 'vless', security: 'reality', address: 'nl.example.com', port: 443 }), 'VLESS · Reality · nl.example.com:443');
  assert.equal(serverMeta({ protocol: 'hysteria2', security: 'tls', address: 'hy.example.com', port: 443 }), 'HY2 · TLS · hy.example.com:443');
  assert.equal(serverMeta({ protocol: 'vless', security: 'none', address: '198.51.100.7', port: 80 }), 'VLESS · без TLS · 198.51.100.7:80');
});

test('пинг: оценка по времени, нет ответа, не меряли', () => {
  assert.deepEqual(pingView({ lastPingMs: 48 }), { text: '48 мс', level: 'good' });
  assert.deepEqual(pingView({ lastPingMs: 350 }), { text: '350 мс', level: 'mid' });
  assert.deepEqual(pingView({ lastPingMs: 900 }), { text: '900 мс', level: 'bad' });
  assert.deepEqual(pingView({ lastPingMs: null, lastPingError: 'Сервер не отвечает' }), { text: 'нет ответа', level: 'fail', title: 'Сервер не отвечает' });
  assert.deepEqual(pingView({}), { text: '—', level: 'none' });
});

test('свежий пинг — моложе минуты; старше, будущий или не меряли — нет', () => {
  const now = 1_000_000;
  assert.deepEqual(freshPing({ lastPingMs: 48, lastPingAt: now - 10_000 }, now), { ms: 48, error: '' });
  assert.deepEqual(freshPing({ lastPingMs: null, lastPingError: 'нет ответа', lastPingAt: now - 59_000 }, now), { ms: null, error: 'нет ответа' });
  assert.equal(freshPing({ lastPingMs: 48, lastPingAt: now - PING_FRESH_MS }, now), null, 'ровно минута — уже не свежий');
  assert.equal(freshPing({ lastPingMs: 48, lastPingAt: now + 5_000 }, now), null, 'время из будущего (часы перевели) — не верим');
  assert.equal(freshPing({ lastPingMs: 48 }, now), null, 'когда мерили — неизвестно');
  assert.equal(freshPing({ lastPingAt: now - 1_000 }, now), null, 'ни времени, ни ошибки');
  assert.equal(freshPing(null, now), null);
});

test('поиск по имени и адресу без учёта регистра', () => {
  const s = { name: '🇳🇱 Амстердам', address: 'NL1.example.com' };
  assert.ok(matches(s, 'амстер'));
  assert.ok(matches(s, 'nl1'));
  assert.ok(matches(s, '  '));
  assert.ok(!matches(s, 'берлин'));
});
