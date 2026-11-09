// Тесты этапа 8 (SPEC-XRAY.md) в расширении: какие серверы «нужны» (их ядро должно работать),
// пометка Xray у сервера, ядро из подписки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingPlan } from '../extension/lib/rules.js';
import { serverMeta } from '../extension/lib/format.js';
import { mergeSubscription } from '../extension/lib/subscriptions.js';
import { normalize } from '../extension/lib/storage.js';
import { S1, S2, setup } from './fakes.js';

const X = { ...S2, id: 's_3', localPort: 27103, address: 'x.example.com', port: 443, transport: 'xhttp', core: 'xray', link: 'vless://x@x.example.com:443?type=xhttp#X' };
const rule = (id, domain, action, serverId = null, enabled = true) => ({ id, domain, action, serverId, enabled });

test('need: текущий сервер и серверы правил «через VPN»; «без VPN» и выключенные — нет', () => {
  const st = normalize({
    enabled: true, currentServerId: 's_1', servers: [S1, S2, X],
    rules: [rule('r1', 'a.test', 'proxy', 's_3'), rule('r2', 'b.test', 'direct'), rule('r3', 'c.test', 'proxy', 's_2', false), rule('r4', 'd.test', 'proxy')],
  });
  assert.deepEqual(routingPlan(st).need, ['s_1', 's_3']);
  // VPN выключен, правила работают: только серверы правил (правило без сервера — текущий).
  assert.deepEqual(routingPlan({ ...st, enabled: false }).need, ['s_1', 's_3']);
  // Правила при выключенном VPN отключены — ничего не нужно.
  assert.deepEqual(routingPlan({ ...st, enabled: false, settings: { ...st.settings, rulesWhenOff: false } }).need, []);
});

test('пинг: пока меряем, сервер в need; после — нет', async () => {
  let duringPing = null;
  const { c, host } = setup({
    local: { enabled: true, currentServerId: 's_1', servers: [S1, X] },
    host: { ping: (p) => { duringPing = host.calls.filter((x) => x.cmd === 'apply').at(-1).params.need; return { results: p.serverIds.map((id) => ({ id, ms: 50 })) }; } },
  });
  await c.init();
  await c.ping(['s_3']);
  assert.deepEqual(duringPing, ['s_1', 's_3'], 'во время пинга нужен и сервер Xray');
  await c.reconcile();
  assert.deepEqual(host.calls.filter((x) => x.cmd === 'apply').at(-1).params.need, ['s_1'], 'после пинга — снова только текущий');
});

test('пометка Xray у сервера и ядро из подписки', () => {
  assert.match(serverMeta(X), / · Xray$/);
  assert.doesNotMatch(serverMeta({ ...X, core: 'sing-box' }), /Xray/);
  const st = normalize({ servers: [], subscriptions: [{ id: 'u_1', name: 'П', url: 'https://sub.example.com/s' }] });
  const f = { key: 'k1', name: 'EU', link: X.link, protocol: 'vless', address: 'x.example.com', port: 443, transport: 'xhttp', security: 'tls', core: 'xray' };
  const { patch } = mergeSubscription(st, 'u_1', { servers: [f], errors: [] }, 1);
  assert.equal(patch.servers[0].core, 'xray');
  const again = mergeSubscription({ ...st, ...patch }, 'u_1', { servers: [{ ...f, core: undefined }], errors: [] }, 2);
  assert.equal(again.patch.servers[0].core, 'sing-box', 'старый компаньон без поля core — sing-box');
});
