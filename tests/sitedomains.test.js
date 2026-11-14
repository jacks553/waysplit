// Тесты «доменов сайта» (extension/lib/sitedomains.js, правила в rules.js и controller.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  FLUSH_MAX_MS, FLUSH_QUIET_MS, MAX_SITE_DOMAINS, SiteCollector, collectingRule, keyFor, setDomainsFor, siteData, stillAttached, tidySiteDomains,
} from '../extension/lib/sitedomains.js';
import { exportRules, findRoute, pacRules, routeFor, routingPlan } from '../extension/lib/rules.js';
import { buildPac } from '../extension/lib/pac.js';
import { normalize } from '../extension/lib/storage.js';
import { TabDomains, siteOf } from '../extension/lib/tabdomains.js';
import { S1, S2, SETS, setup } from './fakes.js';

const DATA = siteData(SETS);
const A = 'SOCKS5 127.0.0.1:27101';
const B = 'SOCKS5 127.0.0.1:27102';
const YT = ['googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtu.be', 'youtube-nocookie.com', 'yt3.googleusercontent.com'];

const rule = (domain, action = 'proxy', extra = {}) => ({ id: `r_${domain}`, domain, action, serverId: null, enabled: true, siteDomains: [], siteDomainsRemoved: [], ...extra });
const byDomain = (store, domain) => store.local.rules.find((r) => r.domain === domain);

// pacFind — «куда пойдёт этот сайт» по PAC, который расширение поставило в Chrome.
function pacFind(pac) {
  const ctx = vm.createContext({});
  vm.runInContext(pac, ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

// --- данные: наборы и два списка ---

test('файл наборов: главные домены входят в свой набор, списки — из годных доменов и не пересекаются с наборами', () => {
  assert.deepEqual(DATA.siteSets.map((s) => s.id), ['youtube', 'instagram', 'telegram', 'discord', 'chatgpt'], 'у «Российских сайтов» главных доменов нет');
  for (const s of DATA.siteSets) for (const m of s.main) assert.ok(s.domains.includes(m), `${s.id}: ${m}`);
  assert.deepEqual(SETS.sets.find((s) => s.id === 'youtube').main, ['youtube.com', 'youtu.be']);
  assert.ok(DATA.common.size > 60 && DATA.hostings.size > 30);
  for (const d of [...DATA.common, ...DATA.hostings]) assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, d);
  for (const d of ['google.com', 'gstatic.com', 'googleapis.com', 'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
    'googleadservices.com', 'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'cloudflare.com', 'facebook.net']) assert.ok(DATA.common.has(d), d);
  for (const d of ['cloudfront.net', 'amazonaws.com', 'akamaized.net', 'akamaihd.net', 'fastly.net', 'azureedge.net', 'b-cdn.net', 'github.io', 'pages.dev',
    'workers.dev', 'vercel.app', 'netlify.app', 'googleusercontent.com', 'blogspot.com']) assert.ok(DATA.hostings.has(d), d);
  // Домен набора не должен быть «общим»: набор привязывает свои домены всегда, а автосбор — никогда.
  for (const s of DATA.siteSets) for (const d of s.domains) assert.equal(keyFor(DATA, `x.${d}`) !== null || DATA.hostings.has(d.split('.').slice(-2).join('.')), true, d);
  assert.deepEqual([...DATA.noCollect].sort(), [...SETS.sets.find((s) => s.id === 'ru-direct').domains].sort());
});

test('автосбор: что привязывать для имени из запроса', () => {
  const cases = {
    // «сайт» — со всеми поддоменами
    'rr3---sn-4g5e6nzz.googlevideo.com': 'googlevideo.com',
    'i.ytimg.com': 'ytimg.com',
    'CDN.Example.COM': 'example.com',
    'static.bbc.co.uk': 'bbc.co.uk',
    'example.org': 'example.org',
    // общие сервисы — не привязываются (поправка 1)
    'www.google.com': null,
    'accounts.google.com': null,
    'fonts.gstatic.com': null,
    'fonts.googleapis.com': null,
    'www.google-analytics.com': null,
    'www.googletagmanager.com': null,
    'stats.g.doubleclick.net': null,
    'pagead2.googlesyndication.com': null,
    'www.googleadservices.com': null,
    'cdn.jsdelivr.net': null,
    'unpkg.com': null,
    'cdnjs.cloudflare.com': null,
    'challenges.cloudflare.com': null,
    'connect.facebook.net': null,
    'mc.yandex.com': null,
    'js.stripe.com': null,
    // общие хостинги — полным именем, а не всем доменом (поправка 2)
    'd123abc.cloudfront.net': 'd123abc.cloudfront.net',
    'bucket.s3.eu-west-1.amazonaws.com': 'bucket.s3.eu-west-1.amazonaws.com',
    'site-a.akamaized.net': 'site-a.akamaized.net',
    'someone.github.io': 'someone.github.io',
    'app.pages.dev': 'app.pages.dev',
    'yt3.googleusercontent.com': 'yt3.googleusercontent.com',
    'lh3.googleusercontent.com': 'lh3.googleusercontent.com',
    'blog.blogspot.com': 'blog.blogspot.com',
    'cloudfront.net': null,
    'www.github.io': null,
    // российские зоны и сайты — никогда (поправка 3)
    'ya.ru': null,
    'mc.yandex.ru': null,
    'xn--e1afmkfd.xn--p1ai': null,
    'site.su': null,
    'vk.com': null,
    'sun9-12.userapi.com': null,
    'yastatic.net': null,
    'avatars.mds.yandex.net': null,
    'i.mycdn.me': null,
    // локальные адреса и IP
    localhost: null,
    intranet: null,
    'printer.local': null,
    '192.168.1.10': null,
    '8.8.8.8': null,
    '[2001:db8::1]': null,
    '': null,
  };
  for (const [host, want] of Object.entries(cases)) assert.equal(keyFor(DATA, host), want, host);
});

test('набор срабатывает только от главного домена набора (и его поддоменов)', () => {
  assert.deepEqual(setDomainsFor(DATA, 'youtube.com'), YT);
  assert.deepEqual(setDomainsFor(DATA, 'youtu.be'), ['youtube.com', ...YT.filter((d) => d !== 'youtu.be')]);
  assert.deepEqual(setDomainsFor(DATA, 'instagram.com'), ['cdninstagram.com', 'fbcdn.net']);
  assert.deepEqual(setDomainsFor(DATA, 'web.telegram.org'), ['t.me', 'telegram.me', 'telesco.pe'], 'поддомен главного — тоже; домен выше себя не забирает');
  assert.deepEqual(setDomainsFor(DATA, 'm.youtube.com'), YT, 'весь youtube.com правилу на m.youtube.com не достаётся');
  for (const d of ['fbcdn.net', 'googlevideo.com', 'ytimg.com', 'cdninstagram.com', 'vk.com', 'ru', 'userapi.com', 'example.com', 'notyoutube.com']) {
    assert.deepEqual(setDomainsFor(DATA, d), [], d);
  }
});

test('какому правилу собирать домены вкладки: включённое «через VPN», не зона, самое конкретное', () => {
  const rules = [rule('youtube.com'), rule('bank.com', 'direct'), rule('org'), rule('off.com', 'proxy', { enabled: false }),
    rule('google.com'), rule('mail.google.com', 'direct')];
  assert.equal(collectingRule(rules, 'www.youtube.com').domain, 'youtube.com');
  assert.equal(collectingRule(rules, 'WWW.YouTube.com').domain, 'youtube.com');
  assert.equal(collectingRule(rules, 'bank.com'), null, 'правило «напрямую» — не собираем');
  assert.equal(collectingRule(rules, 'wikipedia.org'), null, 'правило на зону — не собираем');
  assert.equal(collectingRule(rules, 'off.com'), null, 'выключенное правило');
  assert.equal(collectingRule(rules, 'mail.google.com'), null, 'у почты своё правило «напрямую»');
  assert.equal(collectingRule(rules, 'docs.google.com').domain, 'google.com');
  assert.equal(collectingRule(rules, 'example.com'), null);
  assert.equal(collectingRule(rules, null), null);
});

// --- PAC и «Этот сайт» ---

test('PAC: домены сайта идут как правило; своё правило домена важнее привязки; выключенное правило — без них', () => {
  const rules = [
    rule('youtube.com', 'proxy', { serverId: 's_2', siteDomains: ['googlevideo.com', 'ytimg.com', 'shared.com'] }),
    rule('ytimg.com', 'direct'),
    rule('bank.com', 'direct', { siteDomains: ['bankcdn.com'] }),
    rule('off.com', 'proxy', { enabled: false, siteDomains: ['offcdn.com'] }),
    rule('second.com', 'proxy', { siteDomains: ['shared.com'] }),
  ];
  assert.deepEqual(pacRules(rules, [S1, S2], S1, 'block'), {
    'youtube.com': B, 'googlevideo.com': B, 'ytimg.com': 'DIRECT', 'shared.com': B, 'bank.com': 'DIRECT', 'bankcdn.com': 'DIRECT', 'second.com': A,
  });
  const st = normalize({ enabled: false, currentServerId: 's_1', servers: [S1, S2], rules });
  const plan = routingPlan(st);
  assert.equal(plan.viaVpn, 2, 'считаются правила, а не привязанные домены');
  assert.deepEqual(plan.need, ['s_1', 's_2']);
  const go = pacFind(buildPac(plan.pac));
  assert.equal(go('rr3---sn-abc.googlevideo.com'), B);
  assert.equal(go('i.ytimg.com'), 'DIRECT');
  assert.equal(go('img.bankcdn.com'), 'DIRECT');
  assert.equal(go('offcdn.com'), 'DIRECT');
  assert.equal(go('example.com'), 'DIRECT');

  assert.deepEqual(findRoute(rules, 'rr3.googlevideo.com'), { rule: rules[0], via: 'googlevideo.com' });
  assert.deepEqual(findRoute(rules, 'www.youtube.com'), { rule: rules[0], via: null });
  assert.equal(findRoute(rules, 'i.ytimg.com').rule.domain, 'ytimg.com');
  assert.equal(findRoute(rules, 'offcdn.com'), null);
  assert.deepEqual(routeFor(st, 'rr3.googlevideo.com'), { kind: 'vpn', server: S2, rule: st.rules[0], via: 'googlevideo.com' });
  assert.deepEqual(routeFor(st, 'img.bankcdn.com'), { kind: 'direct', rule: st.rules[2], via: 'bankcdn.com' });
});

test('порядок в привязках: домен со своим правилом (и на домен выше), повторы, зоны, IP и мусор убираются; один домен — у одного правила', () => {
  const rules = tidySiteDomains([
    rule('a.com', 'proxy', { siteDomains: ['cdn-a.com', 'CDN-A.com', 'b.com', 'img.b.com', 'deep.img.b.com', 'static.a.com', 'ru', '8.8.8.8', 'плохой домен!', 'shared.com', 'https://www.Pic.com/x'], siteDomainsRemoved: ['gone.com', 'gone.com', 'cdn-a.com', 5] }),
    rule('b.com', 'direct', { siteDomains: ['shared.com', 'a.com', 'cdn-b.com'], siteDomainsRemoved: 'не список' }),
    { id: 'r_old', domain: 'old.com', action: 'proxy', serverId: null, enabled: true },
  ]);
  assert.deepEqual(rules[0].siteDomains, ['cdn-a.com', 'shared.com', 'pic.com']);
  assert.deepEqual(rules[0].siteDomainsRemoved, ['gone.com']);
  assert.deepEqual(rules[1].siteDomains, ['cdn-b.com']);
  assert.deepEqual(rules[1].siteDomainsRemoved, []);
  assert.deepEqual([rules[2].siteDomains, rules[2].siteDomainsRemoved], [[], []]);
});

test('своё правило на домене выше снимает привязку: привязан d1.cloudfront.net — добавили правило cloudfront.net', async () => {
  const { c, store, proxy } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['site.com', 'youtube.com'], 'proxy', 's_2');
  const site = byDomain(store, 'site.com').id;
  await c.attachSiteDomains({ [site]: ['d1.cloudfront.net', 'img.cdn.example.net', 'sitecdn.com'] });
  assert.equal(pacFind(proxy.pac)('d1.cloudfront.net'), B, 'пока своего правила нет — как сайт');

  await c.addRules(['cloudfront.net'], 'direct');
  assert.deepEqual(byDomain(store, 'site.com').siteDomains, ['img.cdn.example.net', 'sitecdn.com'], 'привязка d1.cloudfront.net снята');
  assert.deepEqual(byDomain(store, 'site.com').siteDomainsRemoved, [], 'и не записана в «убранные вручную»');
  assert.doesNotMatch(proxy.pac, /d1\.cloudfront\.net/);
  let go = pacFind(proxy.pac);
  assert.equal(go('d1.cloudfront.net'), 'DIRECT', 'идёт по своему правилу cloudfront.net, а не по привязке');
  assert.equal(go('a.sitecdn.com'), B, 'остальные домены сайта — как были');

  // То же с доменом из набора: правило на googleusercontent.com важнее привязки yt3.googleusercontent.com.
  assert.ok(byDomain(store, 'youtube.com').siteDomains.includes('yt3.googleusercontent.com'));
  await c.addRules(['googleusercontent.com'], 'proxy', 's_1');
  assert.ok(!byDomain(store, 'youtube.com').siteDomains.includes('yt3.googleusercontent.com'));
  assert.equal(pacFind(proxy.pac)('yt3.googleusercontent.com'), A);

  // Своё правило удалили — автосбор снова может привязать домен; выключенное правило — всё ещё своё.
  await c.removeRules([byDomain(store, 'cloudfront.net').id]);
  assert.equal((await c.attachSiteDomains({ [site]: ['d1.cloudfront.net'] })).added, 1);
  await c.addRules(['cloudfront.net'], 'direct');
  await c.updateRule(byDomain(store, 'cloudfront.net').id, { enabled: false });
  assert.equal((await c.attachSiteDomains({ [site]: ['d1.cloudfront.net'] })).added, 0);
  // Правило на зону — тоже «домен выше».
  await c.addRules(['net'], 'direct');
  assert.deepEqual(byDomain(store, 'site.com').siteDomains, ['sitecdn.com']);
  go = pacFind(proxy.pac);
  assert.equal(go('img.cdn.example.net'), 'DIRECT');
});

// --- правила в controller.js ---

test('правило на главный домен набора получает домены набора; они в PAC; удалили правило — ушли и они', async () => {
  const { c, store, proxy } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['https://www.youtube.com/watch?v=1'], 'proxy', 's_2');
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomains, YT);
  assert.equal(store.local.rules.length, 1, 'привязанные домены — не отдельные правила');
  let go = pacFind(proxy.pac);
  assert.equal(go('rr1---sn-x.googlevideo.com'), B);
  assert.equal(go('yt3.googleusercontent.com'), B);
  assert.equal(go('lh3.googleusercontent.com'), 'DIRECT', 'остальной googleusercontent.com — как был');
  assert.equal(store.session.status.viaVpn, 1);

  // Действие и сервер меняются — домены сайта следуют за правилом.
  await c.updateRule(byDomain(store, 'youtube.com').id, { action: 'direct' });
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomains, YT);
  await c.toggle(true);
  go = pacFind(proxy.pac);
  assert.equal(go('i.ytimg.com'), 'DIRECT');
  assert.equal(go('example.com'), A);
  await c.toggle(false);

  await c.removeRules([byDomain(store, 'youtube.com').id]);
  assert.deepEqual(store.local.rules, []);
  assert.equal(proxy.pac, null, 'правил нет — прокси не нужен');
});

test('набор: не от любого домена набора, не для зон «Российских сайтов», без доменов со своим правилом', async () => {
  const { c, store } = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['fbcdn.net', 'googlevideo.com', 'vk.com'], 'proxy');
  for (const r of store.local.rules) assert.deepEqual(r.siteDomains, [], r.domain);

  await c.addRules(['ytimg.com'], 'direct');
  await c.addRules(['youtube.com'], 'proxy');
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomains, YT.filter((d) => d !== 'googlevideo.com' && d !== 'ytimg.com'), 'у googlevideo.com и ytimg.com — свои правила');
  await c.addRules(['instagram.com'], 'direct');
  assert.deepEqual(byDomain(store, 'instagram.com').siteDomains, ['cdninstagram.com'], 'fbcdn.net — своё правило; набор привязывается и к «напрямую»');

  // Домену дали своё правило — привязка к чужому снимается.
  await c.addRules(['ggpht.com'], 'direct');
  assert.ok(!byDomain(store, 'youtube.com').siteDomains.includes('ggpht.com'));
  // Правило добавили второй раз — домены сайта остаются и не двоятся.
  const before = byDomain(store, 'youtube.com').siteDomains;
  await c.addRules(['youtube.com'], 'proxy', 's_1');
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomains, before);
  // Поддомен главного домена: набор есть, но весь youtube.com ему не достаётся.
  await c.removeRules([byDomain(store, 'youtube.com').id]);
  await c.addRules(['m.youtube.com'], 'proxy');
  assert.deepEqual(byDomain(store, 'm.youtube.com').siteDomains, before);
});

test('разовая привязка при обновлении: правилам из версии 1.0.0 — домены их наборов, один раз', async () => {
  const old = (domain, action, enabled = true) => ({ id: `r_${domain}`, domain, action, serverId: null, enabled }); // как хранила 1.0.0
  const local = { servers: [S1], currentServerId: 's_1', rules: [old('youtube.com', 'proxy'), old('ytimg.com', 'direct'), old('fbcdn.net', 'proxy'), old('telegram.org', 'direct', false), old('ru', 'direct')] };
  const first = setup({ local, sets: SETS });
  await first.c.init();
  assert.deepEqual(byDomain(first.store, 'youtube.com').siteDomains, YT.filter((d) => d !== 'ytimg.com'), 'кроме домена со своим правилом');
  assert.deepEqual(byDomain(first.store, 'fbcdn.net').siteDomains, [], 'не главный домен набора');
  assert.deepEqual(byDomain(first.store, 'telegram.org').siteDomains, ['t.me', 'telegram.me', 'telesco.pe'], 'и выключенному правилу тоже');
  assert.deepEqual(byDomain(first.store, 'ru').siteDomains, []);
  assert.equal(first.store.local.siteSetsApplied, true);
  assert.match(first.proxy.pac, /"googlevideo\.com":"SOCKS5 127\.0\.0\.1:27101"/, 'сразу попало в PAC');

  // Убрали домен — следующий запуск фона его не возвращает: привязка была разовой.
  await first.c.removeSiteDomain('r_youtube.com', 'youtu.be');
  const second = setup({ local: first.store.local, sets: SETS });
  await second.c.init();
  assert.ok(!byDomain(second.store, 'youtube.com').siteDomains.includes('youtu.be'));
  assert.deepEqual(byDomain(second.store, 'youtube.com').siteDomainsRemoved, ['youtu.be']);

  // Новая установка: правил нет — только отметка.
  const fresh = setup({ local: {}, sets: SETS });
  await fresh.c.init();
  assert.deepEqual([fresh.store.local.siteSetsApplied, fresh.store.local.rules], [true, []]);
});

test('убрать домен сайта: он запоминается и не возвращается; «вернуть убранные» возвращает домены набора', async () => {
  const { c, store, proxy } = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['youtube.com'], 'proxy');
  const id = byDomain(store, 'youtube.com').id;
  await c.removeSiteDomain(id, 'googlevideo.com');
  assert.ok(!byDomain(store, 'youtube.com').siteDomains.includes('googlevideo.com'));
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomainsRemoved, ['googlevideo.com']);
  assert.doesNotMatch(proxy.pac, /googlevideo/);
  await c.removeSiteDomain(id, 'нет-такого.com'); // ничего не меняет
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomainsRemoved, ['googlevideo.com']);

  await c.addRules(['youtube.com'], 'proxy'); // правило добавили ещё раз — набор убранное не возвращает
  assert.equal((await c.attachSiteDomains({ [id]: ['googlevideo.com', 'video.googlevideo.com'] }, { 7: ['googlevideo.com'] })).added, 0, 'и автосбор тоже');
  assert.ok(!byDomain(store, 'youtube.com').siteDomains.includes('googlevideo.com'));
  assert.equal(store.session.siteNew, undefined);

  await c.restoreSiteDomains(id);
  assert.deepEqual(byDomain(store, 'youtube.com').siteDomainsRemoved, []);
  assert.ok(byDomain(store, 'youtube.com').siteDomains.includes('googlevideo.com'));
  assert.match(proxy.pac, /googlevideo/);
  await assert.rejects(c.removeSiteDomain('нет', 'a.com'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(c.restoreSiteDomains('нет'), (e) => e.code === 'NOT_FOUND');
});

test('автосбор: запись проверяет каждый домен заново; подсказка для вкладки; настройка выключает', async () => {
  const { c, store, proxy, events } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['site.com'], 'proxy', 's_2');
  await c.addRules(['bank.com', 'own.com'], 'direct');
  await c.addRules(['other.com'], 'proxy');
  const [site, bank, other] = ['site.com', 'bank.com', 'other.com'].map((d) => byDomain(store, d).id);
  events.length = 0;
  const res = await c.attachSiteDomains({
    [site]: ['sitecdn.com', 'SiteCDN.com', 'img.own.com', 'own.com', 'static.site.com', 'ru', '8.8.8.8', 'media.site-video.net'],
    [bank]: ['bankcdn.com'], // правило «напрямую» — не собираем
    [other]: ['sitecdn.com', 'othercdn.com'], // sitecdn.com уже привязан к site.com
    r_gone: ['x.com'],
  }, { 5: ['sitecdn.com', 'own.com'], 6: ['othercdn.com'], 9: ['bankcdn.com'] });
  assert.equal(res.added, 3);
  assert.deepEqual(byDomain(store, 'site.com').siteDomains, ['sitecdn.com', 'media.site-video.net']);
  assert.deepEqual(byDomain(store, 'bank.com').siteDomains, []);
  assert.deepEqual(byDomain(store, 'other.com').siteDomains, ['othercdn.com']);
  assert.deepEqual(store.session.siteNew, { 5: ['sitecdn.com'], 6: ['othercdn.com'] }, 'только то, что действительно привязано');
  assert.deepEqual(events, ['pac', 'apply'], 'новый PAC один раз; ядро то же');
  const go = pacFind(proxy.pac);
  assert.equal(go('a.sitecdn.com'), B);
  assert.equal(go('othercdn.com'), A);
  assert.ok(store.session.events.some((e) => e.text.includes('Домены сайта site.com: добавлено 2')));

  await c.attachSiteDomains({ [site]: ['more.com'] }, { 5: ['more.com'] });
  assert.deepEqual(store.session.siteNew[5], ['sitecdn.com', 'more.com']);
  await c.clearSiteNew(5);
  assert.deepEqual(store.session.siteNew, { 6: ['othercdn.com'] });
  await c.clearSiteNew(5); // второй раз — ничего

  // Выключенное правило и выключенная настройка — ничего не привязывается.
  await c.updateRule(site, { enabled: false });
  assert.equal((await c.attachSiteDomains({ [site]: ['late.com'] })).added, 0);
  await c.updateRule(site, { enabled: true });
  await c.setSetting('autoSiteDomains', false);
  assert.equal((await c.attachSiteDomains({ [site]: ['late.com'] })).added, 0);
  assert.deepEqual(byDomain(store, 'site.com').siteDomains, ['sitecdn.com', 'media.site-video.net', 'more.com'], 'уже привязанное остаётся');
  await assert.rejects(c.setSetting('autoSiteDomains', 'да'), (e) => e.code === 'BAD_SETTING');

  // Предел на правило.
  await c.setSetting('autoSiteDomains', true);
  const many = Array.from({ length: MAX_SITE_DOMAINS + 20 }, (_, i) => `cdn${i}.example`);
  await c.attachSiteDomains({ [other]: many });
  assert.equal(byDomain(store, 'other.com').siteDomains.length, MAX_SITE_DOMAINS);
});

test('экспорт и импорт правил и резервная копия — с доменами сайта; старые файлы — по наборам', async () => {
  const src = setup({ local: { servers: [S1, S2], currentServerId: 's_1' }, sets: SETS, host: { parse_links: () => ({ servers: [{ ...S1 }, { ...S2 }], errors: [] }) } });
  await src.c.init();
  await src.c.addRules(['youtube.com'], 'proxy', 's_2');
  await src.c.addRules(['site.com'], 'proxy');
  const yt = byDomain(src.store, 'youtube.com').id;
  await src.c.removeSiteDomain(yt, 'youtu.be');
  await src.c.attachSiteDomains({ [byDomain(src.store, 'site.com').id]: ['sitecdn.com'] });
  const want = { 'youtube.com': [YT.filter((d) => d !== 'youtu.be'), ['youtu.be']], 'site.com': [['sitecdn.com'], []] };
  const got = (store) => Object.fromEntries(store.local.rules.map((r) => [r.domain, [r.siteDomains, r.siteDomainsRemoved]]));

  // Файл правил → другая установка.
  const file = JSON.parse(JSON.stringify(exportRules(normalize(src.store.local).rules, src.store.local.servers)));
  assert.deepEqual(file.rules[0].siteDomains, want['youtube.com'][0]);
  const dst = setup({ local: { servers: [S1, S2], currentServerId: 's_1' }, sets: SETS });
  await dst.c.init();
  await dst.c.addRules(['sitecdn.com'], 'direct'); // здесь у этого домена уже своё правило
  const res = await dst.c.importRules(file);
  assert.deepEqual([res.added, res.updated], [2, 0]);
  assert.deepEqual(got(dst.store), { 'sitecdn.com': [[], []], 'youtube.com': want['youtube.com'], 'site.com': [[], []] }, 'убранный youtu.be набор не вернул; своё правило важнее');
  assert.equal(byDomain(dst.store, 'youtube.com').serverId, 's_2');

  // Файл правил из версии 1.0.0 (без доменов сайта) — по наборам.
  const v1 = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS });
  await v1.c.init();
  await v1.c.importRules({ type: 'rules', rules: [{ domain: 'youtube.com', action: 'proxy', server: null, enabled: false }, { domain: 'fbcdn.net', action: 'direct' }] });
  assert.deepEqual(got(v1.store), { 'youtube.com': [YT, []], 'fbcdn.net': [[], []] });
  assert.equal(byDomain(v1.store, 'youtube.com').enabled, false);

  // Резервная копия туда и обратно.
  const backup = JSON.parse(JSON.stringify(await src.c.exportBackup()));
  const back = setup({ local: { rules: [rule('junk.com', 'proxy', { siteDomains: ['junkcdn.com'] })] }, sets: SETS, host: { parse_links: () => ({ servers: [{ ...S1 }, { ...S2 }], errors: [] }) } });
  await back.c.init();
  await back.c.importBackup(backup);
  assert.deepEqual(got(back.store), want);
  assert.equal(back.store.local.settings.autoSiteDomains, true);

  // Копия из версии 1.0.0: правила без доменов сайта, в том числе с мусором в новых полях.
  const oldBackup = { ...backup, rules: [{ domain: 'instagram.com', action: 'proxy', serverId: 's_1', enabled: true }, { domain: 'x.com', action: 'direct', enabled: true, siteDomains: ['ok.com', 'x.com', 'ru', null] }] };
  await back.c.importBackup(oldBackup);
  assert.deepEqual(got(back.store), { 'instagram.com': [['cdninstagram.com', 'fbcdn.net'], []], 'x.com': [['ok.com'], []] });
});

// --- автосбор: SiteCollector ---

// stand — сборщик с подделками часов и хранилища. flushed — что он записал. more — прочее для
// сборщика (isPrivate — какая вкладка инкогнито).
function stand(rules, settings = {}, more = {}) {
  const clock = { t: 0, timer: null };
  const flushed = [];
  const state = { rules, settings: { autoSiteDomains: true, ...settings } };
  const col = new SiteCollector({
    load: async () => state,
    data: DATA,
    attach: async (batch, tabs) => { flushed.push({ at: clock.t, batch, tabs }); },
    timers: {
      setTimeout: (fn, ms) => { clock.timer = { fn, at: clock.t + ms }; return clock.timer; },
      clearTimeout: (t) => { if (clock.timer === t) clock.timer = null; },
    },
    now: () => clock.t,
    ...more,
  });
  // tick — время идёт; сработавший таймер запускается.
  const tick = async (ms) => {
    clock.t += ms;
    if (clock.timer && clock.timer.at <= clock.t) {
      const { fn } = clock.timer;
      clock.timer = null;
      await fn();
    }
  };
  return { col, clock, flushed, state, tick };
}

test('сборщик: что берёт и что пропускает', async () => {
  const rules = [
    rule('youtube.com', 'proxy', { siteDomains: ['ytimg.com'], siteDomainsRemoved: ['ggpht.com'] }),
    rule('bank.com', 'direct'),
    rule('own.com', 'direct', { enabled: false }),
    rule('other.com', 'proxy', { siteDomains: ['othercdn.com'] }),
  ];
  const { col, flushed, tick } = stand(rules);
  const see = (host, top = 'www.youtube.com', tab = 1) => col.seen(tab, top, host);
  await see('rr3---sn-a.googlevideo.com');
  await see('rr5---sn-b.googlevideo.com'); // тот же «сайт»
  await see('www.youtube.com'); // само правило
  await see('i.ytimg.com'); // уже привязан
  await see('yt3.ggpht.com'); // убран вручную
  await see('img.own.com'); // своё правило, пусть и выключенное
  await see('static.othercdn.com'); // привязан к другому правилу
  await see('www.google.com'); // общий сервис
  await see('fonts.gstatic.com');
  await see('d1.cloudfront.net'); // общий хостинг — полным именем
  await see('mc.yandex.ru'); // российская зона
  await see('192.168.0.1');
  await see('cdn.bank-static.com', 'bank.com', 2); // вкладка сайта «напрямую» — не собираем
  await see('whatever.com', 'example.com', 3); // у сайта вкладки правила нет
  await see('x.com', null, 4); // сайт вкладки неизвестен
  await see('y.com', 'youtube.com', -1); // запрос не из вкладки
  await see('cdn.other.net', 'other.com', 5);
  await see('rr1.googlevideo.com', 'other.com', 5); // уже ждёт записи у youtube.com
  assert.deepEqual(flushed, [], 'пока тихо — ничего не записано');
  await tick(FLUSH_QUIET_MS);
  assert.deepEqual(flushed, [{
    at: FLUSH_QUIET_MS,
    batch: { 'r_youtube.com': ['googlevideo.com', 'd1.cloudfront.net'], 'r_other.com': ['other.net'] },
    tabs: { 1: ['googlevideo.com', 'd1.cloudfront.net'], 5: ['other.net'] },
  }]);
  await tick(60000);
  assert.equal(flushed.length, 1, 'нового нет — записи нет');
});

test('сборщик: вторая вкладка того же сайта тоже получает подсказку, пока домен ждёт записи', async () => {
  const { col, flushed, tick } = stand([rule('youtube.com'), rule('other.com')]);
  await col.seen(1, 'www.youtube.com', 'rr3---sn-a.googlevideo.com');
  await col.seen(2, 'www.youtube.com', 'rr3---sn-a.googlevideo.com'); // то же имя — во второй вкладке
  await col.seen(3, 'm.youtube.com', 'rr5---sn-b.googlevideo.com'); // другое имя того же «сайта» — в третьей
  await col.seen(2, 'www.youtube.com', 'i.ytimg.com'); // новый домен первой нашла вторая вкладка
  await col.seen(1, 'www.youtube.com', 'i.ytimg.com');
  await col.seen(1, 'www.youtube.com', 'i.ytimg.com'); // повтор ничего не меняет
  await col.seen(4, 'other.com', 'rr1.googlevideo.com'); // вкладка другого сайта: домен достанется не её правилу
  await col.seen(5, 'example.com', 'rr1.googlevideo.com'); // у сайта вкладки правила нет
  await tick(FLUSH_QUIET_MS);
  assert.deepEqual(flushed.map((f) => [f.batch, f.tabs]), [[
    { 'r_youtube.com': ['googlevideo.com', 'ytimg.com'] },
    { 1: ['googlevideo.com', 'ytimg.com'], 2: ['googlevideo.com', 'ytimg.com'], 3: ['googlevideo.com'] },
  ]]);
  // Запись прошла — домен больше не ждёт: вкладке, которая обратилась к нему позже, подсказка не нужна.
  await col.seen(6, 'www.youtube.com', 'rr3---sn-a.googlevideo.com');
  await tick(FLUSH_MAX_MS);
  assert.equal(flushed.length, 1);
});

test('вкладка инкогнито: её домены к правилу не привязываются и подсказки ей нет; обычные вкладки — как раньше', async () => {
  const asked = [];
  const isPrivate = async (tabId) => {
    asked.push(tabId);
    if (tabId === 8) throw new Error('No tab with id: 8'); // вкладку уже закрыли — Chrome о ней не знает
    return tabId === 7;
  };
  const { col, flushed, tick } = stand([rule('youtube.com')], {}, { isPrivate });
  await col.seen(7, 'www.youtube.com', 'rr1---sn-a.googlevideo.com'); // вкладка инкогнито
  await col.seen(7, 'www.youtube.com', 'i.ytimg.com');
  await col.seen(8, 'www.youtube.com', 'yt3.ggpht.com'); // какая это вкладка, узнать не удалось — не собираем
  await tick(FLUSH_MAX_MS);
  assert.deepEqual(flushed, [], 'из инкогнито в правила (на диск) ничего не попадает');

  // То же имя из обычной вкладки собирается: вкладка инкогнито его не «заняла».
  await col.seen(1, 'www.youtube.com', 'rr1---sn-a.googlevideo.com');
  await col.seen(7, 'www.youtube.com', 'rr1---sn-a.googlevideo.com'); // инкогнито обратилась к домену, пока он ждёт записи
  await col.seen(7, 'www.youtube.com', 'rr5---sn-b.googlevideo.com');
  await tick(FLUSH_QUIET_MS);
  assert.deepEqual(flushed.map((f) => [f.batch, f.tabs]), [[{ 'r_youtube.com': ['googlevideo.com'] }, { 1: ['googlevideo.com'] }]], 'подсказки «обновите вкладку» у инкогнито нет');

  await col.seen(9, 'example.com', 'cdn.example.net'); // у сайта вкладки правила нет — и спрашивать незачем
  assert.deepEqual(asked, [7, 8, 1], 'про вкладку спрашиваем один раз, и только когда у её сайта есть правило');
  await col.seen(8, 'www.youtube.com', 'yt3.ggpht.com');
  assert.deepEqual(asked, [7, 8, 1, 8], 'неудачный ответ не запоминается');
  col.forget(7); // вкладку закрыли
  await col.seen(7, 'www.youtube.com', 'i.ytimg.com');
  assert.deepEqual(asked, [7, 8, 1, 8, 7]);
  await tick(FLUSH_MAX_MS);
  assert.equal(flushed.length, 1);
});

test('сборщик: запись — после тишины, но не позже 5 с после первого нового домена', async () => {
  const { col, flushed, tick, clock } = stand([rule('youtube.com')]);
  // Новые домены идут каждую секунду — тишины нет.
  for (let i = 0; i < 9; i++) {
    await col.seen(1, 'youtube.com', `cdn${i}.example`);
    await tick(1000);
  }
  await tick(1000);
  assert.equal(flushed.length, 2);
  assert.equal(flushed[0].at, FLUSH_MAX_MS, 'первая запись — ровно через 5 с после первого домена');
  assert.deepEqual(flushed[0].batch['r_youtube.com'], ['cdn0.example', 'cdn1.example', 'cdn2.example', 'cdn3.example', 'cdn4.example']);
  assert.deepEqual(flushed[1].batch['r_youtube.com'], ['cdn5.example', 'cdn6.example', 'cdn7.example', 'cdn8.example']);
  assert.ok(flushed[1].at - FLUSH_MAX_MS <= FLUSH_MAX_MS, 'и вторая — не позже 5 с после своего первого');
  // Один домен и тишина — через 2,5 с.
  const t0 = clock.t;
  await col.seen(1, 'youtube.com', 'late.example');
  await tick(FLUSH_QUIET_MS - 1);
  assert.equal(flushed.length, 2);
  await tick(1);
  assert.equal(flushed[2].at, t0 + FLUSH_QUIET_MS);
});

test('сборщик: настройка выключена — не собирает; правила изменились — читает заново', async () => {
  const { col, flushed, tick, state } = stand([rule('youtube.com')], { autoSiteDomains: false });
  await col.seen(1, 'youtube.com', 'cdn.example');
  await tick(FLUSH_MAX_MS);
  assert.deepEqual(flushed, []);
  state.settings = { autoSiteDomains: true };
  state.rules = [rule('youtube.com', 'proxy', { siteDomainsRemoved: ['cdn.example'] })];
  col.invalidate();
  await col.seen(1, 'youtube.com', 'cdn.example');
  await col.seen(1, 'youtube.com', 'new.example');
  await tick(FLUSH_QUIET_MS);
  assert.deepEqual(flushed.map((f) => f.batch), [{ 'r_youtube.com': ['new.example'] }]);
});

test('сайт вкладки: запоминается с новой страницей и переживает сон фона', async () => {
  const session = {};
  const store = { getSession: async (k) => session[k], setSession: async (o) => Object.assign(session, structuredClone(o)) };
  const td = new TabDomains(store);
  assert.equal(await td.seen({ tabId: -1, url: 'https://a.com/', type: 'xmlhttprequest' }), null);
  assert.deepEqual(await td.seen({ tabId: 3, url: 'https://cdn.a.com/x.js', type: 'script' }), { host: 'cdn.a.com', top: null, navigated: false }, 'страницу открыли до разрешения — сайт неизвестен');
  assert.deepEqual(await td.seen({ tabId: 3, url: 'https://www.youtube.com/watch', type: 'main_frame' }), { host: 'www.youtube.com', top: 'www.youtube.com', navigated: true });
  assert.deepEqual(await td.seen({ tabId: 3, url: 'https://i.ytimg.com/a.jpg', type: 'image' }), { host: 'i.ytimg.com', top: 'www.youtube.com', navigated: false });
  await new Promise((r) => setTimeout(r, 600)); // сохранение — с задержкой
  const woke = new TabDomains(store);
  assert.equal((await woke.seen({ tabId: 3, url: 'https://rr1.googlevideo.com/v', type: 'media' })).top, 'www.youtube.com');
  assert.deepEqual(await woke.list(3), ['www.youtube.com', 'i.ytimg.com', 'rr1.googlevideo.com']);
  await woke.forget(3);
  assert.equal((await woke.seen({ tabId: 3, url: 'https://x.com/a', type: 'image' })).top, null);
});

test('список доменов вкладок записывается, только когда изменился: повторные запросы к тем же именам — без записи', async () => {
  const session = {};
  const writes = [];
  const td = new TabDomains({ getSession: async (k) => session[k], setSession: async (o) => { writes.push(Object.keys(o).join('+')); Object.assign(session, structuredClone(o)); } });
  const settle = () => new Promise((r) => setTimeout(r, 600)); // запись — через 0,5 с после изменения
  await td.seen({ tabId: 3, url: 'https://www.youtube.com/watch', type: 'main_frame' });
  await td.seen({ tabId: 3, url: 'https://i.ytimg.com/a.jpg', type: 'image' });
  await settle();
  assert.deepEqual(writes, ['tabDomains+tabTops'], 'новая страница и новое имя — одна запись');
  // Видео идёт: вкладка снова и снова обращается к тем же именам.
  for (let i = 0; i < 20; i++) await td.seen({ tabId: 3, url: `https://i.ytimg.com/b${i}.jpg`, type: 'image' });
  await td.seen({ tabId: 3, url: 'https://www.youtube.com/api/stats', type: 'xmlhttprequest' });
  await settle();
  assert.equal(writes.length, 1, 'ничего не изменилось — записи нет');
  await td.seen({ tabId: 3, url: 'https://rr1.googlevideo.com/v', type: 'media' }); // новое имя
  await settle();
  assert.equal(writes.length, 2);
  await td.seen({ tabId: 4, url: 'https://i.ytimg.com/a.jpg', type: 'image' }); // имя знакомое, вкладка — новая
  await settle();
  assert.equal(writes.length, 3);
  await td.seen({ tabId: 3, url: 'https://www.youtube.com/watch?v=2', type: 'main_frame' }); // новая страница: список заново
  await settle();
  assert.equal(writes.length, 4);
  assert.deepEqual(session.tabDomains, { 3: ['www.youtube.com'], 4: ['i.ytimg.com'] });
  assert.deepEqual(session.tabTops, { 3: 'www.youtube.com' });
  await td.forget(99); // такой вкладки не было
  await settle();
  assert.equal(writes.length, 4);
  await td.forget(4);
  await settle();
  assert.equal(writes.length, 5);
  assert.deepEqual(session.tabDomains, { 3: ['www.youtube.com'] });
});

test('адрес с точкой в конце: вкладка и её домены запоминаются без точки — автосбор и «Домены этой вкладки» работают', async () => {
  const session = {};
  const td = new TabDomains({ getSession: async (k) => session[k], setSession: async (o) => Object.assign(session, structuredClone(o)) });
  const page = await td.seen({ tabId: 1, url: 'https://www.youtube.com./watch', type: 'main_frame' });
  assert.deepEqual(page, { host: 'www.youtube.com', top: 'www.youtube.com', navigated: true });
  const video = await td.seen({ tabId: 1, url: 'https://rr1---sn-a.googlevideo.com./videoplayback', type: 'media' });
  assert.deepEqual(video, { host: 'rr1---sn-a.googlevideo.com', top: 'www.youtube.com', navigated: false });
  assert.equal((await td.seen({ tabId: 1, url: 'http://[2001:db8::1]:8080/x', type: 'image' })).host, '2001:db8::1');
  assert.deepEqual((await td.list(1)).map(siteOf), ['youtube.com', 'googlevideo.com', '2001:db8::1'], 'раньше в списке было «com.» — галочка дала бы правило на всю зону');
  // Сайт вкладки находит своё правило — автосбор работает, как у адреса без точки.
  const { col, flushed, tick } = stand([rule('youtube.com')]);
  assert.equal(collectingRule([rule('youtube.com')], page.top).domain, 'youtube.com');
  await col.seen(1, video.top, video.host);
  await tick(FLUSH_QUIET_MS);
  assert.deepEqual(flushed.map((f) => f.batch), [{ 'r_youtube.com': ['googlevideo.com'] }]);
});

test('удалённое правило возвращается таким, каким было: с сервером, включённостью и доменами сайта', async () => {
  const { c, store, proxy } = setup({ local: { servers: [S1, S2], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['youtube.com'], 'proxy', 's_2');
  await c.addRules(['site.com'], 'direct');
  const yt = byDomain(store, 'youtube.com').id;
  await c.removeSiteDomain(yt, 'youtu.be');
  await c.updateRule(byDomain(store, 'site.com').id, { enabled: false });
  const saved = JSON.parse(JSON.stringify(store.local.rules)); // как их видит окно в момент удаления

  await c.removeRules(saved.map((r) => r.id));
  assert.deepEqual(store.local.rules, []);
  assert.equal(proxy.pac, null);
  assert.deepEqual(await c.restoreRules(saved), { restored: 2 });
  assert.deepEqual(store.local.rules, saved, 'те же id, действие, сервер, включённость, домены сайта и убранные');
  assert.equal(pacFind(proxy.pac)('rr1.googlevideo.com'), B, 'и сразу действует');
  assert.deepEqual(await c.restoreRules(saved), { restored: 0 }, 'второй раз — нечего возвращать');

  // Пока сообщение висело, для домена появилось другое правило — прежнее не возвращается.
  await c.removeRules([yt]);
  await c.addRules(['youtube.com'], 'direct');
  assert.deepEqual(await c.restoreRules([saved[0]]), { restored: 0 });
  assert.equal(byDomain(store, 'youtube.com').action, 'direct');
  // Сервер за это время удалили — правило возвращается «через текущий»; мусор не проходит.
  await c.removeRules([byDomain(store, 'youtube.com').id]);
  await c.remove('s_2');
  assert.deepEqual(await c.restoreRules([saved[0], { domain: 'плохой домен!', action: 'proxy' }, { domain: 'x.com', action: 'куда-то' }, null]), { restored: 1 });
  assert.equal(byDomain(store, 'youtube.com').serverId, null);
  assert.deepEqual(await c.restoreRules('не список'), { restored: 0 });
});

// --- подсказка «обновите вкладку» (storage.session.siteNew) ---

// slowHints — чтение siteNew отвечает не сразу, как настоящий chrome.storage: между чтением и
// записью успевает начаться другое действие. together(…действия) запускает их одновременно и
// отдаёт ответы на чтение по одному.
function slowHints(store) {
  const read = store.getSession;
  const gate = [];
  store.getSession = (k) => (k !== 'siteNew' ? read(k) : new Promise((done) => {
    const snapshot = structuredClone(store.session.siteNew);
    gate.push(() => done(snapshot));
  }));
  return async (...actions) => {
    const jobs = Promise.all(actions.map((f) => f()));
    let finished = false;
    jobs.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      await new Promise((r) => setTimeout(r, 0));
      gate.shift()?.();
    }
    await jobs;
  };
}

test('подсказка «обновите вкладку»: запись автосбора и снятие подсказки одновременно не затирают друг друга', async () => {
  const { c, store } = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['site.com'], 'proxy');
  const id = byDomain(store, 'site.com').id;
  const together = slowHints(store);

  store.session.siteNew = { 2: ['old.org'] };
  await together(() => c.attachSiteDomains({ [id]: ['race1.org'] }, { 1: ['race1.org'] }), () => c.clearSiteNew(2));
  assert.deepEqual(store.session.siteNew, { 1: ['race1.org'] }, 'автосбор начал раньше: подсказка вкладки 1 записана, вкладки 2 — снята');

  store.session.siteNew = { 2: ['old.org'] };
  await together(() => c.clearSiteNew(2), () => c.attachSiteDomains({ [id]: ['race2.org'] }, { 1: ['race2.org'] }));
  assert.deepEqual(store.session.siteNew, { 1: ['race2.org'] }, 'снятие началось раньше: итог тот же');

  // Две записи автосбора подряд — обе подсказки на месте.
  store.session.siteNew = {};
  await together(() => c.attachSiteDomains({ [id]: ['race3.org'] }, { 1: ['race3.org'] }), () => c.attachSiteDomains({ [id]: ['race4.org'] }, { 3: ['race4.org'] }));
  assert.deepEqual(store.session.siteNew, { 1: ['race3.org'], 3: ['race4.org'] });
});

test('подсказка — только про домены, которые ещё привязаны: правило удалили — подсказки нет, вернули — снова есть', async () => {
  const { c, store } = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['site.com'], 'proxy');
  const id = byDomain(store, 'site.com').id;
  await c.attachSiteDomains({ [id]: ['sitecdn.com', 'img.example.net'] }, { 5: ['sitecdn.com', 'img.example.net'] });
  // shown — что окно покажет в подсказке вкладки 5 (popup/home.js).
  const shown = () => stillAttached(normalize(store.local).rules, store.session.siteNew[5]);
  assert.deepEqual(shown(), ['sitecdn.com', 'img.example.net']);
  await c.removeSiteDomain(id, 'img.example.net');
  assert.deepEqual(shown(), ['sitecdn.com'], 'домен убрали вручную');

  const saved = JSON.parse(JSON.stringify(store.local.rules));
  await c.removeRules([id]);
  assert.deepEqual(shown(), [], 'правило удалили — обновлять вкладку незачем');
  await c.restoreRules(saved);
  assert.deepEqual(shown(), ['sitecdn.com'], '«Вернуть»: домен снова привязан, а вкладку так и не обновили');
  await c.addRules(['sitecdn.com'], 'direct');
  assert.deepEqual(shown(), [], 'домену дали своё правило');
  assert.deepEqual(stillAttached([], undefined), []);
  assert.deepEqual(stillAttached(normalize(store.local).rules, 'не список'), []);
});

test('подсказка не пишется закрытой вкладке: её закрыли, пока домены ждали записи; домены правилу остаются', async () => {
  const { c, store } = setup({ local: { servers: [S1], currentServerId: 's_1' }, sets: SETS });
  await c.init();
  await c.addRules(['site.com'], 'proxy');
  const id = byDomain(store, 'site.com').id;
  const res = await c.attachSiteDomains({ [id]: ['sitecdn.com'] }, { 5: ['sitecdn.com'], 9: ['sitecdn.com'] }, (tabId) => tabId !== 9);
  assert.equal(res.added, 1);
  assert.deepEqual(byDomain(store, 'site.com').siteDomains, ['sitecdn.com']);
  assert.deepEqual(store.session.siteNew, { 5: ['sitecdn.com'] }, 'вкладка 9 закрыта');

  // Какие вкладки открыты, фон знает от TabDomains: были запросы — открыта, закрыли — нет.
  const session = {};
  const td = new TabDomains({ getSession: async (k) => session[k], setSession: async (o) => Object.assign(session, structuredClone(o)) });
  assert.equal(td.has(9), false, 'ещё ничего не видели');
  await td.seen({ tabId: 9, url: 'https://site.com/', type: 'main_frame' });
  assert.deepEqual([td.has(9), td.has('9'), td.has(5)], [true, true, false]);
  await td.forget(9);
  assert.equal(td.has(9), false);
});

test('в «убранных вручную» не остаётся сам домен правила и его поддомены (мусор из файла)', () => {
  const [a, b] = tidySiteDomains([
    rule('a.com', 'proxy', { siteDomains: ['cdn-a.com'], siteDomainsRemoved: ['A.com', 'https://www.a.com/x', 'img.a.com', 'gone.com', 'b.com', 'nota.com'] }),
    rule('b.com', 'direct', { siteDomainsRemoved: ['b.com', 'a.com'] }),
  ]);
  assert.deepEqual(a.siteDomainsRemoved, ['gone.com', 'b.com', 'nota.com'], 'чужой домен, даже со своим правилом, остаётся: правило могут удалить');
  assert.deepEqual(b.siteDomainsRemoved, ['a.com']);
});
