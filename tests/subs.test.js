// Тесты совместимости подписок (SPEC-SUBS.md): «Проверить подписку».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S1, setup } from './fakes.js';

const SUB = { id: 'u_1', name: 'Тест', url: 'https://sub.example.com/api/sub/SECRET', intervalHours: 12, updatedAt: 1, info: null };

test('«Проверить подписку»: без идентификатора устройства, пока человек не попросил', async () => {
  const asked = [];
  const { c, store } = setup({
    local: { servers: [{ ...S1, subscriptionId: 'u_1' }], currentServerId: 's_1', subscriptions: [SUB] },
    host: { sub_info: (p) => { asked.push(p); return { report: 'Проверка подписки (адрес скрыт)', device: p.device, viaVpn: false }; } },
  });
  await c.init();
  const r = await c.checkSubscription('u_1');
  assert.deepEqual(asked[0], { url: SUB.url, device: false, proxyServerId: '' });
  assert.equal(r.report, 'Проверка подписки (адрес скрыт)');
  assert.equal(r.device, false);
  await c.checkSubscription('u_1', 'да'); // только настоящее true считается согласием
  assert.equal(asked[1].device, false);
  const r2 = await c.checkSubscription('u_1', true);
  assert.equal(asked[2].device, true);
  assert.equal(r2.device, true);
  assert.match(store.session.events.at(-1).text, /Проверка подписки «Тест» с идентификатором устройства/);
  assert.ok(!JSON.stringify(store.session.events).includes('SECRET'), 'адреса подписки в журнале нет');
  await assert.rejects(c.checkSubscription('u_nope'), /Такой подписки нет/);
});

// SPEC-SUBS, шаг 2: привязка к устройству и сообщение провайдера.
const NL = { key: 'k1', name: 'NL', link: 'vless://x@nl.example.com:443#NL', protocol: 'vless', address: 'nl.example.com', port: 443, transport: 'tcp', security: 'reality', core: 'sing-box' };

test('подписка с привязкой к устройству: запоминается, дальше — сразу с идентификатором', async () => {
  const asked = [];
  let used = true;
  const { c, store } = setup({
    local: { subscriptions: [{ ...SUB, updatedAt: null }] },
    host: { fetch_subscription: (p) => { asked.push(p.device); return { servers: [NL], errors: [], deviceUsed: used, announce: 'Пишите в поддержку' }; } },
  });
  await c.init();
  const r = await c.updateSubscription('u_1');
  assert.equal(asked[0], false, 'первый раз — без идентификатора (компаньон сам повторит с ним)');
  assert.equal(r.device, true);
  let sub = store.local.subscriptions[0];
  assert.equal(sub.device, true);
  assert.equal(sub.announce, 'Пишите в поддержку');
  assert.match(store.session.events.map((e) => e.text).join('\n'), /отдаёт серверы только устройствам — этот компьютер привязан/);
  used = false; // привязка не теряется, даже если компаньон не сообщил о ней снова
  await c.updateSubscription('u_1');
  assert.equal(asked[1], true, 'привязанная — сразу с идентификатором');
  sub = store.local.subscriptions[0];
  assert.equal(sub.device, true);
  const backup = await c.exportBackup();
  assert.equal(backup.subscriptions[0].device, true, 'в резервной копии — привязка (секретом не является)');
});

test('итог добавления подписки говорит о привязке', async () => {
  const { addSummary } = await import('../extension/lib/format.js');
  const text = addSummary({ added: 0, skipped: [], subscriptions: [{ name: 'П', added: 2, kept: 0, skipped: [], device: true }] });
  assert.match(text, /привязана к этому компьютеру как устройство/);
});
