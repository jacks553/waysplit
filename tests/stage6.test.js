// Тесты этапа 6: подписки, защита WebRTC, значок, настройки, резервная копия, диагностика,
// «Домены этой вкладки».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSubscription, isDue, mergeSubscription } from '../extension/lib/subscriptions.js';
import { normalize } from '../extension/lib/storage.js';
import { TabDomains, siteOf } from '../extension/lib/tabdomains.js';
import { validSetting } from '../extension/lib/controller.js';
import { S1, S2, err, setup } from './fakes.js';

const info = (key, name, extra = {}) => ({
  key, name, link: `vless://x@${key}.example.com:443#${name}`, protocol: 'vless', address: `${key}.example.com`, port: 443, transport: 'tcp', security: 'reality', ...extra,
});
const SUB = { id: 'u_aaaa', name: 'sub.example.com', url: 'https://sub.example.com/s/SECRET', intervalHours: 12, updatedAt: null, info: null, lastError: null };

// --- подписки: слияние ---

test('обновление подписки: id сохраняются, новые получают порт, пропавшие удаляются, правила — на текущий', () => {
  const st = normalize({
    currentServerId: 's_old2',
    subscriptions: [SUB],
    servers: [
      { ...S1, key: 'manual' },
      { id: 's_old1', name: 'Старое имя', key: 'k1', link: 'старая', localPort: 27102, subscriptionId: 'u_aaaa' },
      { id: 's_old2', name: 'Своё имя', customName: true, key: 'k2', link: 'старая', localPort: 27103, subscriptionId: 'u_aaaa' },
    ],
    rules: [{ id: 'r_1', domain: 'a.com', action: 'proxy', serverId: 's_old2', enabled: true }],
  });
  const res = {
    servers: [info('k1', 'NL новое имя'), info('k3', 'DE'), info('manual', 'Повтор ручного')],
    errors: [{ text: 'vless://…', reason: 'транспорт xhttp не поддерживается sing-box' }],
    title: 'Моя подписка', info: { upload: 1, download: 2, total: 3, expire: 4 }, updateIntervalHours: 6,
  };
  const { patch, report } = mergeSubscription(st, 'u_aaaa', res, 5000);
  assert.deepEqual([report.added, report.kept, report.removed, report.rulesMoved], [1, 1, 1, 1]);
  assert.deepEqual(report.skipped.map((x) => x.reason), ['транспорт xhttp не поддерживается sing-box', 'такой сервер уже есть']);
  const byKey = Object.fromEntries(patch.servers.map((s) => [s.key, s]));
  assert.equal(byKey.k1.id, 's_old1', 'id сохранился');
  assert.equal(byKey.k1.name, 'NL новое имя', 'имя из подписки');
  assert.equal(byKey.k1.link, 'vless://x@k1.example.com:443#NL новое имя', 'ссылка обновилась');
  assert.equal(byKey.k1.localPort, 27102, 'порт тот же');
  assert.ok(!byKey.k2, 'пропавший из подписки сервер удалён');
  assert.equal(byKey.k3.subscriptionId, 'u_aaaa');
  assert.equal(byKey.k3.localPort, 27103, 'новый — на первый свободный порт');
  assert.match(byKey.k3.id, /^s_[a-z0-9]{4}$/);
  assert.equal(patch.rules[0].serverId, null, 'правило с удалённого сервера — на текущий');
  assert.equal(patch.currentServerId, 's_old1', 'текущий удалён — текущим стал сервер этой подписки');
  assert.deepEqual(patch.subscriptions[0], { ...SUB, name: 'Моя подписка', updatedAt: 5000, info: res.info, intervalHours: 6, lastError: null, viaVpn: false, device: false, announce: '', format: '' });
});

test('своё имя сервера и подписки обновление не меняет', () => {
  const st = normalize({
    subscriptions: [{ ...SUB, name: 'Моя', customName: true }],
    servers: [{ id: 's_old1', name: 'Своё', customName: true, key: 'k1', localPort: 27101, subscriptionId: 'u_aaaa' }],
  });
  const { patch } = mergeSubscription(st, 'u_aaaa', { servers: [info('k1', 'Из подписки')], errors: [], title: 'Новое название' }, 1);
  assert.equal(patch.servers[0].name, 'Своё');
  assert.equal(patch.subscriptions[0].name, 'Моя');
});

test('удаление подписки — вместе с серверами; срок обновления', () => {
  const st = normalize({
    currentServerId: 's_sub1', subscriptions: [SUB],
    servers: [S1, { id: 's_sub1', key: 'k1', localPort: 27102, subscriptionId: 'u_aaaa' }],
    rules: [{ id: 'r_1', domain: 'a.com', action: 'proxy', serverId: 's_sub1', enabled: true }],
  });
  const { patch, report } = dropSubscription(st, 'u_aaaa');
  assert.deepEqual(patch.servers.map((s) => s.id), ['s_1']);
  assert.equal(patch.currentServerId, 's_1');
  assert.deepEqual(patch.subscriptions, []);
  assert.deepEqual(report, { removed: 1, rulesMoved: 1 });
  assert.equal(isDue({ updatedAt: null }, 0), true);
  assert.equal(isDue({ updatedAt: 0, intervalHours: 12 }, 11 * 3600e3), false);
  assert.equal(isDue({ updatedAt: 0, intervalHours: 12 }, 12 * 3600e3), true);
});

// --- подписки: через фон ---

test('адрес подписки во «Вставьте ссылки»: скачивается, серверы с subscriptionId, повтор — те же id', async () => {
  const fetched = [];
  const { c, store } = setup({
    host: {
      parse_links: () => ({ servers: [], errors: [], subscriptions: ['https://sub.example.com/s/SECRET'] }),
      fetch_subscription: (p) => { fetched.push(p); return { servers: [info('k1', 'NL'), info('k2', 'DE')], errors: [], title: 'Подписка', info: null }; },
    },
  });
  await c.init();
  const res = await c.addLinks('https://sub.example.com/s/SECRET');
  assert.equal(res.subscriptions[0].name, 'Подписка');
  assert.equal(res.subscriptions[0].added, 2);
  assert.deepEqual(fetched[0], { url: 'https://sub.example.com/s/SECRET', userAgent: 'v2rayN/7.0', proxyServerId: '', device: false });
  const ids = store.local.servers.map((s) => s.id);
  assert.ok(store.local.servers.every((s) => s.subscriptionId === store.local.subscriptions[0].id));
  assert.equal(store.local.currentServerId, ids[0], 'первый сервер подписки стал текущим');
  const again = await c.addSubscription('https://sub.example.com/s/SECRET');
  assert.deepEqual([again.added, again.kept], [0, 2]);
  assert.deepEqual(store.local.servers.map((s) => s.id), ids, 'id те же');
  assert.equal(store.local.subscriptions.length, 1, 'та же подписка, не вторая');
});

test('подписка не скачалась: новая не остаётся, у старой — ошибка и запись в журнале', async () => {
  let fail = true;
  const { c, store } = setup({ host: { fetch_subscription: () => { if (fail) throw err('SUBSCRIPTION_FAILED', 'подписка не скачалась: сервер ответил «404»'); return { servers: [info('k1', 'NL')], errors: [] }; } } });
  await c.init();
  await assert.rejects(c.addSubscription('https://sub.example.com/x'), /404/);
  assert.deepEqual(store.local.subscriptions, []);
  fail = false;
  await c.addSubscription('https://sub.example.com/x');
  fail = true;
  const id = store.local.subscriptions[0].id;
  await assert.rejects(c.updateSubscription(id), /404/);
  assert.match(store.local.subscriptions[0].lastError, /404/);
  assert.match(store.session.events.at(-1).text, /не обновилась.*404/);
  await assert.rejects(c.addSubscription('ftp://x'), (e) => e.code === 'BAD_URL');
});

test('VPN включён: подписка при неудаче скачивается через текущий сервер; автообновление — только просроченные', async () => {
  const fetched = [];
  const subs = [{ ...SUB, id: 'u_due1', updatedAt: null }, { ...SUB, id: 'u_new1', url: 'https://b.example.com/x', updatedAt: 1000 }];
  const { c, clock } = setup({
    local: { enabled: true, servers: [S1], currentServerId: 's_1', subscriptions: subs },
    host: { fetch_subscription: (p) => { fetched.push(p); return { servers: [], errors: [] }; } },
  });
  await c.init();
  await c.updateDueSubscriptions();
  assert.deepEqual(fetched.map((p) => [p.url, p.proxyServerId]), [['https://sub.example.com/s/SECRET', 's_1']]);
  clock.t = 1000 + 12 * 3600e3;
  await c.updateDueSubscriptions();
  assert.equal(fetched.length, 3, 'через 12 ч обновились обе');
});

// --- настройки ---

test('настройки: проверка значений; новый диапазон портов — серверам новые порты', async () => {
  for (const [k, v, ok] of [['onFailure', 'direct', true], ['onFailure', 'куда-то', false], ['theme', 'dark', true], ['theme', 'синяя', false],
    ['portRangeStart', 28000, true], ['portRangeStart', 80, false], ['portRangeStart', 65400, false], ['logLevel', 'debug', true],
    ['subscriptionUA', '  ', false], ['subscriptionIntervalHours', 6, true], ['subscriptionIntervalHours', 0, false], ['autoConnect', 'off', true], ['нет', 1, false]]) {
    assert.equal(validSetting(k, v), ok, `${k}=${v}`);
  }
  const { c, store, host } = setup({ local: { enabled: true, servers: [S1, S2], currentServerId: 's_1' } });
  await c.init();
  await c.setSetting('portRangeStart', 28000);
  assert.deepEqual(store.local.servers.map((s) => s.localPort), [28000, 28001]);
  assert.deepEqual(host.calls.filter((x) => x.cmd === 'apply').at(-1).params.servers.map((s) => s.localPort), [28000, 28001]);
  await assert.rejects(c.setSetting('theme', 'синяя'), (e) => e.code === 'BAD_SETTING');
});

// --- защита WebRTC и значок ---

test('WebRTC: защита, пока VPN включён; выключили VPN или защиту — сняли', async () => {
  const { c, store, events } = setup({ local: { enabled: true, servers: [S1], currentServerId: 's_1' }, extras: true });
  await c.init();
  assert.deepEqual(events.slice(0, 2), ['pac', 'rtc-on']);
  assert.equal(store.session.status.webrtc, 'on');
  events.length = 0;
  await c.toggle(false);
  assert.ok(events.includes('rtc-off'));
  await c.toggle(true);
  events.length = 0;
  await c.setSetting('webrtcProtection', false);
  assert.deepEqual(events.filter((e) => e.startsWith('rtc')), ['rtc-off']);
});

test('WebRTC: настройкой управляет другое расширение — так и видно в состоянии', async () => {
  const { c, store } = setup({ local: { enabled: true, servers: [S1], currentServerId: 's_1' }, extras: true, rtc: 'other' });
  await c.init();
  assert.equal(store.session.status.webrtc, 'other');
});

test('значок: серый, зелёный, жёлтый, красный «!»', async () => {
  let started = false; // как настоящий компаньон: тот же список — ядро не перезапускается
  const apply = (p) => {
    const restarted = !started;
    started = true;
    return { hostVersion: '1.0.0', running: true, restarted, servers: Object.fromEntries(p.servers.map((s) => [s.id, s.localPort])), errors: [] };
  };
  const { c, ui, timers, clock } = setup({ local: { servers: [S1], currentServerId: 's_1' }, extras: true, host: { apply, stop: () => { started = false; return { running: false }; } } });
  await c.init();
  assert.equal(ui.icons.at(-1).state, 'off');
  await c.toggle(true);
  assert.equal(ui.icons.at(-1).state, 'on');
  assert.equal(ui.icons.at(-1).title, 'Waysplit — подключено');
  c.proxyError({ error: 'net::ERR_PROXY_CONNECTION_FAILED', fatal: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ui.icons.at(-1).state, 'on', 'ошибка в первые секунды после запуска ядра — ожидаемая, не краснеем');
  await c.running;
  clock.t += 5000;
  c.proxyError({ error: 'net::ERR_PROXY_CONNECTION_FAILED', fatal: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ui.icons.at(-1).state, 'error', 'ошибка прокси потом — красный');
  await c.running;
  clock.t += 16000;
  await timers.fire('timeout');
  assert.equal(ui.icons.at(-1).state, 'on', 'через 15 с снова зелёный');
  await c.toggle(false);
  await c.addRules(['a.com'], 'proxy');
  assert.equal(ui.icons.at(-1).state, 'rules');
});

test('значок: другое расширение управляет прокси — красный', async () => {
  const { c, ui, store } = setup({ local: { enabled: true, servers: [S1], currentServerId: 's_1' }, extras: true, control: 'controlled_by_other_extensions' });
  await c.init();
  assert.equal(ui.icons.at(-1).state, 'error');
  assert.match(ui.icons.at(-1).title, /другое расширение/);
  assert.match(store.session.events[0].text, /другое расширение/);
});

// --- резервная копия ---

test('резервная копия: в файле всё, восстановление заменяет данные, id и правила сохраняются', async () => {
  const rules = [{ id: 'r_1', domain: 'a.com', action: 'proxy', serverId: 's_2', enabled: false }, { id: 'r_2', domain: 'плохой домен', action: 'direct', serverId: null, enabled: true }];
  const src = setup({ local: { servers: [S1, { ...S2, subscriptionId: 'u_aaaa', customName: true }], currentServerId: 's_2', subscriptions: [SUB], rules, settings: { theme: 'dark' } } });
  const backup = await src.c.exportBackup();
  assert.equal(backup.type, 'backup');
  assert.deepEqual(backup.servers.map((s) => s.link), [S1.link, S2.link], 'ссылки в файле есть — это секреты, файл для себя');
  assert.equal(backup.settings.theme, 'dark');

  const dst = setup({
    local: { servers: [{ ...S1, id: 's_zzzz', key: 'other' }], rules: [] },
    host: { parse_links: (p) => ({ servers: p.text.split('\n').map((link, i) => ({ ...info(`b${i}`, `разобран ${i}`), link })), errors: [] }) },
  });
  await dst.c.init();
  const res = await dst.c.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(res, { servers: 2, skipped: 0, subscriptions: 1, rules: 1 });
  const st = dst.store.local;
  assert.deepEqual(st.servers.map((s) => [s.id, s.name, s.localPort, s.subscriptionId]), [['s_1', 'NL', 27101, null], ['s_2', 'DE', 27102, 'u_aaaa']]);
  assert.equal(st.currentServerId, 's_2');
  assert.deepEqual(st.rules.map((r) => [r.domain, r.serverId, r.enabled]), [['a.com', 's_2', false]], 'неверное правило пропущено');
  assert.equal(st.subscriptions[0].url, SUB.url);
  assert.equal(st.settings.theme, 'dark');
  await assert.rejects(dst.c.importBackup({ type: 'rules' }), (e) => e.code === 'BAD_FILE');
});

// --- диагностика ---

test('«Мой IP сейчас» при выключенном VPN: ядро на время проверки', async () => {
  const { c, events } = setup({ local: { servers: [S1], currentServerId: 's_1' }, host: { exit_ip: (p) => ({ ip: `203.0.113.7 через ${p.serverId}` }) } });
  await c.init();
  events.length = 0;
  const r = await c.exitIp();
  await c.running;
  assert.deepEqual(r, { ip: '203.0.113.7 через s_1', server: 'NL' });
  assert.deepEqual(events, ['apply', 'exit_ip', 'stop']);
});

test('диагностика собирает версии, ядро, журналы и события', async () => {
  const { c } = setup({ host: { hello: () => ({ hostVersion: '0.4.0' }), logs: () => ({ host: 'строки', singbox: '' }) } });
  await c.init();
  await c.log('info', 'событие');
  const d = await c.diagnostics();
  assert.equal(d.hello.hostVersion, '0.4.0');
  assert.equal(d.core.running, true);
  assert.equal(d.logs.host, 'строки');
  assert.equal(d.events.at(-1).text, 'событие');
});

// --- «Домены этой вкладки» ---

test('домены вкладки: собираются по вкладкам, новая страница — заново, сохраняются в session', async () => {
  const session = {};
  const td = new TabDomains({ getSession: async (k) => session[k], setSession: async (o) => Object.assign(session, o) });
  await td.seen({ tabId: 5, type: 'main_frame', url: 'https://www.youtube.com/watch?v=1' });
  await td.seen({ tabId: 5, type: 'media', url: 'https://rr3---sn-abc.googlevideo.com/videoplayback' });
  await td.seen({ tabId: 5, type: 'image', url: 'https://i.ytimg.com/vi/1.jpg' });
  await td.seen({ tabId: -1, type: 'other', url: 'https://update.example.com/' });
  await td.seen({ tabId: 7, type: 'script', url: 'https://cdn.example.org/a.js' });
  assert.deepEqual(await td.list(5), ['www.youtube.com', 'rr3---sn-abc.googlevideo.com', 'i.ytimg.com']);
  await td.seen({ tabId: 5, type: 'main_frame', url: 'https://example.com/' });
  assert.deepEqual(await td.list(5), ['example.com'], 'новая страница — список заново');
  await td.forget(7);
  assert.deepEqual(await td.list(7), []);
  await new Promise((r) => setTimeout(r, 600));
  const restored = new TabDomains({ getSession: async (k) => session[k], setSession: async () => {} });
  assert.deepEqual(await restored.list(5), ['example.com'], 'фон уснул и проснулся — список на месте');
});

test('домен «сайта» для правила', () => {
  assert.equal(siteOf('rr3---sn-abc.googlevideo.com'), 'googlevideo.com');
  assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('lk.gosuslugi.com.ru'), 'gosuslugi.com.ru');
  assert.equal(siteOf('youtube.com'), 'youtube.com');
  assert.equal(siteOf('192.168.1.1'), '192.168.1.1');
  assert.equal(siteOf('2001:db8::1'), '2001:db8::1');
});
