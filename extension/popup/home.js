// Вкладка «Главная»: большая кнопка VPN, статус, строка «Сервер», блок «Этот сайт»
// (переключатель «через VPN / без VPN», сервер для сайта, «Домены этой вкладки»), ошибки и шаги
// установки компаньона.

import { addSummary, fillActions, freshPing, parseAction, pingBars, pingReason, send, splitFlag } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { routeFor, routeIn, ruleServer, ruleTable } from '../lib/rules.js';
import { siteOf } from '../lib/tabdomains.js';
import { stillAttached } from '../lib/sitedomains.js';
import { normalizeDomain, parents, toUnicode } from '../lib/domains.js';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, MIN_HOST_VERSION, docsUrl, installSteps, olderThan, outdatedMessage } from '../lib/companion.js';
import { $, barsEl, el, faviconEl, flagEl, icon, setIcon, toast } from './ui.js';
import { S, currentServer, defineTab, showTab, vpnOn } from './state.js';
import { openPicker } from './picker.js';
import { openDiag } from './diag.js';
import { SITE_PERMS, checkPerm, renderPermCards } from './siteperm.js';

const LOG_HINT = { text: 'hint.log', go: 'diag', goText: 'hint.openDiag' };

// Что делать при ошибке: подсказка (text, goText — ключи словаря); install — шаги установки
// компаньона и «Скачать» (SPEC-STORE.md, 1.3: без путей к папкам и команд); go — куда ведёт ссылка
// под подсказкой, url — ключ словаря с адресом страницы сайта проекта (у каждого языка своя).
const HINTS = {
  HOST_NOT_FOUND: { text: 'hint.HOST_NOT_FOUND', install: true },
  HOST_FORBIDDEN: { text: 'hint.HOST_FORBIDDEN', install: true },
  HOST_START_FAILED: { text: 'hint.HOST_START_FAILED', install: true },
  HOST_OUTDATED: { text: 'hint.HOST_OUTDATED', install: true },
  SINGBOX_NOT_FOUND: { text: 'hint.SINGBOX_NOT_FOUND', install: true },
  SINGBOX_FAILED: { text: 'hint.SINGBOX_FAILED', url: 'hint.faq.url', goText: 'hint.faq' },
  PORT_BUSY: { text: 'hint.PORT_BUSY', go: 'settings', goText: 'common.openSettings' },
  START_TIMEOUT: LOG_HINT,
  START_FAILED: LOG_HINT,
  CONFIG_INVALID: LOG_HINT,
  CORE_STOPPED: LOG_HINT,
};

let ping = { serverId: null, ms: null, error: '', reason: '' }; // быстрый пинг текущего сервера
let busy = false;
// hostProblem — компаньон не установлен или устарел, а серверов ещё нет (кнопка VPN неактивна,
// ошибки состояния не будет): шаги установки — сразу (SPEC-STORE.md, 1.3).
let hostProblem = null;
let problemGo = null;

function render() {
  const view = S.view;
  const server = currentServer();
  const st = S.status;
  let state = 'off';
  if (view.enabled) state = st?.enabled ? st.state : 'connecting';
  else if (st && !st.enabled && (st.state === 'rules' || st.state === 'error')) state = st.state; // VPN выключен, работают правила
  if (state === 'on' && st.serverId !== server?.id) state = 'connecting'; // сервер только что сменили
  if (state === 'on' && server && ping.serverId !== server.id) {
    const fresh = freshPing(server); // пинг моложе минуты — без нового запроса через сервер
    if (fresh) ping = { serverId: server.id, ...fresh, reason: pingReason(server) };
  }
  if (state === 'on' && ping.serverId === server?.id && ping.error) state = 'warn';

  const power = $('power');
  power.dataset.state = state;
  power.setAttribute('aria-pressed', String(view.enabled));
  power.setAttribute('aria-label', t(view.enabled ? 'home.power.turnOff' : 'home.power.turnOn'));
  power.disabled = busy || (!server && !view.enabled);
  power.title = server || view.enabled ? '' : t('home.power.needServer');

  const name = server?.name || '';
  const texts = {
    off: [t('home.status.off'), t(server ? 'home.detail.off' : 'home.detail.offNoServer')],
    no_server: [t('home.status.no_server'), t('home.detail.no_server')],
    connecting: [t('home.status.connecting'), name],
    on: [ping.serverId === server?.id && ping.ms ? t('home.status.onPing', { server: name, ms: ping.ms }) : t('home.status.on', { server: name }), t('home.detail.on')],
    warn: [t('home.status.warn'), warnDetail(name)],
    error: [t('home.status.error'), st?.message || ''],
    // Одна строка: на «Главной» мало места (две строки сдвигают блок «Этот сайт» за край окна).
    rules: [t('home.status.rules'), t('home.detail.rules', { n: st?.viaVpn ?? 0 })],
  };
  const [title, detail] = texts[state] || texts.off;
  $('status').textContent = title;
  $('status').dataset.state = state;
  $('detail').textContent = state === 'error' ? '' : detail;

  $('conflict').hidden = !st?.conflict;
  // Защита WebRTC должна стоять, а ею управляет другое расширение.
  $('webrtcWarn').hidden = !(view.enabled && view.settings.webrtcProtection && (st?.webrtc === 'other' || st?.webrtc === 'blocked'));
  if (state === 'error') showProblem(st.code, st.message);
  else if (hostProblem) showProblem(hostProblem.code, hostProblem.message);
  else $('problem').hidden = true;

  $('serverRow').hidden = !server;
  if (server) {
    $('srvFlag').replaceWith(Object.assign(flagEl(server), { id: 'srvFlag' }));
    $('srvName').textContent = splitFlag(server.name).name;
    $('srvName').title = server.name;
    $('srvBars').replaceChildren(barsEl(server));
    // Сервер не ответил на пинг — словами, а не только бледными полосками.
    $('srvLabel').replaceChildren(t('home.server'), ...(pingBars(server).n === 0 ? [' · ', el('span', { className: 'srv-fail', textContent: t('common.noAnswer') })] : []));
  }
  $('homeAdd').hidden = view.servers.length > 0;
  // «Российские сайты — без VPN» — настройка ruDirect (та же галочка — в «Настройках»).
  $('ruSwitch').hidden = !view.servers.length;
  $('ruSwitch').setAttribute('aria-checked', String(view.settings.ruDirect));
  renderSite();
  renderPermCards();

  if (state === 'on' && ping.serverId !== server.id) checkPing(server.id);
}

// warnDetail — текущий сервер не ответил: почему (если известно) и что будет с сайтами. Причина —
// по коду фразы: «сервер не отвечает» повторять незачем, у «…(возможно, заблокирован UDP)» — только
// уточнение из скобок; причина незнакома — текст ошибки как есть.
function warnDetail(name) {
  const reason = { ping_no_response: '', ping_no_response_udp: t('home.warn.reasonUdp') }[ping.reason] ?? ping.error;
  const what = t(S.view.settings.onFailure === 'direct' ? 'home.warn.direct' : 'home.warn.block');
  return reason ? t('home.warn.detailReason', { server: name, reason, what }) : t('home.warn.detail', { server: name, what });
}

function showProblem(code, message) {
  $('problemText').textContent = message;
  const hint = HINTS[code] || {};
  $('hint').hidden = !hint.text;
  $('hint').textContent = hint.text ? t(hint.text) : '';
  problemGo = hint.go || hint.url ? hint : null;
  $('problemGo').hidden = !problemGo;
  $('problemGo').textContent = hint.goText ? t(hint.goText) : '';
  $('steps').hidden = !hint.install;
  $('steps').replaceChildren(...(hint.install ? installSteps() : []).map((s) => el('li', { textContent: s })));
  $('downloadRow').hidden = !hint.install;
  $('download').href = DOWNLOAD_ZIP_URL;
  $('releasePage').href = DOWNLOAD_URL;
  $('problem').hidden = false;
}

$('problemGo').addEventListener('click', () => {
  if (!problemGo) return;
  if (problemGo.url) chrome.tabs.create({ url: docsUrl(problemGo.url) });
  else if (problemGo.go === 'diag') {
    showTab('settings');
    openDiag();
  } else showTab(problemGo.go);
});

// --- «Этот сайт» ---

// fillDomains — варианты домена для правила: сам адрес и домены выше (video.example.com → example.com).
function fillDomains() {
  const base = normalizeDomain(S.site.host).domain;
  const options = base ? parents(base).filter((d) => d.includes('.')) : [];
  $('siteDomain').replaceChildren(...options.map((d) => el('option', { value: d, textContent: toUnicode(d) })));
  $('siteDomain').disabled = options.length < 2;
}

// siteIcon — значок сайта рядом с доменом: сам значок — сайта целиком (такой есть в памяти Chrome),
// а буква, пока значка нет, — первая буква показанного домена (bank.example.net → «B»).
function siteIcon(domain) {
  const base = normalizeDomain(S.site.host).domain || S.site.host;
  const label = domain || base;
  if ($('siteIcon').dataset.label === label) return;
  const node = Object.assign(faviconEl(siteOf(base), label), { id: 'siteIcon' });
  node.dataset.label = label;
  $('siteIcon').replaceWith(node);
}

const exactRule = (domain) => S.view.rules.find((r) => r.domain === domain) || null;

function renderSite() {
  const view = S.view;
  $('site').hidden = !S.site || !view.servers.length;
  if ($('site').hidden) return;
  if (!$('siteDomain').options.length) fillDomains();
  const domain = $('siteDomain').value;
  siteIcon(domain);
  const r = routeFor(view, S.site.host, S.ruDomains);
  const exact = exactRule(domain);
  const local = r.kind === 'local';
  const on = vpnOn();

  // sleeping — правило «через VPN» есть, но сработать не может: VPN выключен, а правила при
  // выключенном VPN отключены. off — правило для этого домена отключено. В жёлтой строке — кнопка
  // «Включить правила» / «Включить правило».
  const sleeping = !local && r.inactive?.action === 'proxy' ? r.inactive : null;
  const off = !local && exact && !exact.enabled ? exact : null;

  let why;
  if (local) why = t('home.why.local');
  else if (r.rule) {
    // Части строки — через « · »: чьё правило, куда идёт сайт, сколько к правилу привязано доменов.
    // via — сайт идёт по правилу другого сайта: его домен привязан к тому правилу («домен сайта»).
    const parts = [
      r.via ? t('home.why.ruleVia', { domain: toUnicode(r.rule.domain), via: toUnicode(r.via) }) : t('home.why.rule', { domain: toUnicode(r.rule.domain) }),
      r.kind === 'vpn' ? t('home.why.throughServer', { server: r.server.name }) : t('common.withoutVpn'),
    ];
    if (!r.via && r.rule.siteDomains.length) parts.push(t('n.siteDomains', { n: r.rule.siteDomains.length }));
    why = parts.join(' · ');
  } else if (r.ru) why = t('home.why.ru');
  else if (r.inactive?.action === 'direct') why = `${t('home.why.rule', { domain: toUnicode(r.inactive.domain) })} · ${t('common.withoutVpn')}`;
  else if (sleeping) why = t('home.why.sleeping', { domain: toUnicode(sleeping.domain) });
  else why = t(on ? 'home.why.noRuleVpn' : 'home.why.noRuleDirect'); // одна строка: «Главная» должна помещаться в окно
  $('siteWhy').textContent = why;

  warnFix = sleeping ? { setting: true } : off ? { ruleId: off.id } : null;
  $('siteWarn').hidden = !warnFix;
  if (sleeping) {
    $('siteWarnText').textContent = t('home.warn.sleeping');
    $('siteWarnFix').textContent = t('home.warn.enableRules');
    $('siteWarnFix').title = t('home.warn.enableRules.title');
  } else if (off) {
    $('siteWarnText').textContent = t('home.warn.ruleOff', { domain: toUnicode(off.domain) });
    $('siteWarnFix').textContent = t('home.warn.enableRule');
    $('siteWarnFix').title = t('home.warn.enableRule');
  }

  $('siteControls').hidden = local || !domain;
  const viaVpn = r.kind === 'vpn';
  $('siteSwitch').setAttribute('aria-checked', String(viaVpn));
  $('siteSwitchText').textContent = t(viaVpn ? 'action.proxy' : 'action.direct');
  // Кнопка справа — куда идёт сайт: флаг сервера или «без VPN». Правило сейчас не действует —
  // флаг сервера из правила, приглушённо.
  const idle = viaVpn ? null : sleeping || (off?.action === 'proxy' ? off : null);
  const target = viaVpn ? r.server : idle ? ruleServer(idle, view.servers, currentServer()) : null;
  const btn = $('siteServer');
  const shown = target ? flagEl(target) : el('span', { className: 'flag direct-ic' });
  if (!target) shown.innerHTML = icon('direct');
  shown.id = 'siteFlag';
  $('siteFlag').replaceWith(shown);
  btn.classList.toggle('dim', !!(idle && target));
  btn.title = idle && target ? t('home.siteServer.idle', { server: target.name })
    : target ? t('home.siteServer.named', { server: target.name }) : t('home.siteServer.direct');
  $('ruleRemove').hidden = !exact;

  // Автосбор привязал к правилу этого сайта новые домены — уже сделанные запросы к ним прошли
  // по-старому: нужна перезагрузка вкладки. Только про домены, которые ещё привязаны: правило
  // могли удалить.
  const fresh = stillAttached(view.rules, S.siteNew[S.site.tabId]);
  $('siteNew').hidden = !fresh.length;
  $('siteNew').title = fresh.map(toUnicode).join(', ');
}

// warnFix — что включает кнопка в жёлтой строке: настройку «Правила работают, когда VPN выключен»
// или отключённое правило.
let warnFix = null;
$('siteWarnFix').addEventListener('click', async () => {
  if (!warnFix) return;
  const resp = warnFix.setting
    ? await send({ type: 'setSetting', key: 'rulesWhenOff', value: true })
    : await send({ type: 'updateRule', id: warnFix.ruleId, patch: { enabled: true } });
  if (!resp?.ok) toast(resp?.error?.message || t('common.failed'), 'error');
  else {
    toast(t(warnFix.setting ? 'home.toast.rulesOn' : 'home.toast.ruleOn'));
    $('reload').hidden = false;
  }
});

async function setSiteRule(action, serverId = null) {
  const domain = $('siteDomain').value;
  const resp = await send({ type: 'addRules', domains: [domain], action, serverId });
  if (resp?.ok) $('reload').hidden = false;
  else showProblem(resp?.error?.code, resp?.error?.message || t('common.failed'));
}

$('ruSwitch').addEventListener('click', async () => {
  const value = !S.view.settings.ruDirect;
  const resp = await send({ type: 'setSetting', key: 'ruDirect', value });
  if (!resp?.ok) toast(resp?.error?.message || t('common.failed'), 'error');
  else toast(t(value ? 'ru.toast.on' : 'ru.toast.off'), 'keep');
});

$('siteSwitch').addEventListener('click', () => {
  const viaVpn = $('siteSwitch').getAttribute('aria-checked') === 'true';
  setSiteRule(viaVpn ? 'direct' : 'proxy');
});
$('siteServer').addEventListener('click', () => {
  openPicker({ kind: 'site', domain: $('siteDomain').value, onDone: () => { $('reload').hidden = false; } });
});
$('ruleRemove').addEventListener('click', async () => {
  const exact = exactRule($('siteDomain').value);
  if (!exact) return;
  const resp = await send({ type: 'removeRules', ids: [exact.id] });
  if (resp?.ok) $('reload').hidden = false;
});
$('siteDomain').addEventListener('change', renderSite);

// «Домены этой вкладки» (SPEC 3.3): к каким доменам обращалась вкладка — правила галочками.
// Разрешение (наблюдать за запросами и видеть адреса сайтов) Chrome спрашивает при первом нажатии.
const TD_PERMS = SITE_PERMS; // то же разрешение, что у автосбора «доменов сайта»

$('tdButton').addEventListener('click', async () => {
  const open = $('td').hidden;
  $('td').hidden = !open;
  $('tdButton').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('tdList').replaceChildren();
  $('tdActions').hidden = true;
  let granted = await chrome.permissions.contains(TD_PERMS);
  if (!granted) {
    $('tdNote').textContent = t('home.td.needPerm');
    try {
      granted = await chrome.permissions.request(TD_PERMS); // окно может закрыться, пока Chrome спрашивает
    } catch {
      granted = false;
    }
    checkPerm();
    $('tdNote').textContent = t(granted ? 'home.td.granted' : 'home.td.denied');
    if (granted) $('reload').hidden = false;
    return;
  }
  await renderTabDomains();
});

async function renderTabDomains() {
  const resp = await send({ type: 'tabDomains', tabId: S.site.tabId });
  const hosts = resp?.ok ? resp.result : [];
  if (!hosts.length) {
    $('tdNote').textContent = t('home.td.empty');
    $('reload').hidden = false;
    return;
  }
  const sites = new Map();
  for (const h of hosts) sites.set(siteOf(h), (sites.get(siteOf(h)) || 0) + 1);
  const own = siteOf(S.site.host);
  const list = [...sites.keys()].sort((a, b) => (a === own ? -1 : b === own ? 1 : a.localeCompare(b)));
  $('tdNote').textContent = t('home.td.count', { n: list.length });
  const table = ruleTable(S.view.rules); // одна на весь список
  $('tdList').replaceChildren(...list.map((site) => {
    const box = el('input', { type: 'checkbox', value: site });
    const rule = routeIn(table, site)?.rule;
    const label = el('label', {}, box, faviconEl(site),
      el('span', { className: 'td-name', textContent: toUnicode(site), title: t('home.td.requests', { n: sites.get(site) }) }));
    if (rule) label.append(el('span', { className: 'td-rule', textContent: t(rule.action === 'direct' ? 'common.withoutVpn' : 'common.throughVpn') }));
    return el('li', {}, label);
  }));
  fillActions($('tdAction'), S.view.servers, 'proxy:');
  $('tdActions').hidden = false;
}

$('tdAdd').addEventListener('click', async () => {
  const domains = [...$('tdList').querySelectorAll('input:checked')].map((x) => x.value);
  if (!domains.length) {
    $('tdNote').textContent = t('home.td.pickOne');
    return;
  }
  const resp = await send({ type: 'addRules', domains, ...parseAction($('tdAction').value) });
  if (!resp?.ok) {
    $('tdNote').textContent = resp?.error?.message || t('common.failed');
    return;
  }
  await renderTabDomains(); // обновить пометки «без VPN» / «через VPN»
  $('tdNote').textContent = t('home.td.added', { added: resp.result.added, updated: resp.result.updated });
  $('reload').hidden = false;
});

$('reloadTab').addEventListener('click', async () => {
  if (S.site) await chrome.tabs.reload(S.site.tabId);
  $('reload').hidden = true;
});
$('siteNewReload').addEventListener('click', async () => {
  $('siteNew').hidden = true;
  if (!S.site) return;
  send({ type: 'clearSiteNew', tabId: S.site.tabId });
  await chrome.tabs.reload(S.site.tabId);
});

// --- кнопка VPN, сервер, пинг ---

// Быстрый пинг текущего сервера, когда VPN подключён (SPEC, раздел 3.2).
async function checkPing(serverId) {
  ping = { serverId, ms: null, error: '', reason: '' };
  const resp = await send({ type: 'pingCurrent' });
  if (ping.serverId !== serverId) return;
  if (resp?.ok && resp.result.ms) ping.ms = resp.result.ms;
  else {
    ping.error = resp?.ok ? resp.result.error || t('common.noAnswer') : resp?.error?.message || t('common.noAnswer');
    ping.reason = (resp?.ok && resp.result.reason) || '';
  }
  render();
}

$('power').addEventListener('click', async () => {
  busy = true;
  render();
  ping = { serverId: null, ms: null, error: '', reason: '' };
  await send({ type: 'toggle', enabled: !S.view.enabled });
  busy = false;
  render();
});

$('serverRow').addEventListener('click', () => openPicker({ kind: 'main' }));
setIcon(document.querySelector('#serverRow .chev'), 'chev');
setIcon(document.querySelector('#siteServer .chev'), 'down');

// Серверов ещё нет — поле для ссылок прямо на главной.
$('homeAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('homeLinks').value.trim();
  if (!text) return;
  $('homeAddBtn').disabled = true;
  const out = $('homeAddResult');
  out.hidden = false;
  out.dataset.kind = '';
  out.textContent = t('add.parsing');
  const resp = await send({ type: 'addLinks', text });
  $('homeAddBtn').disabled = false;
  if (!resp?.ok) {
    out.dataset.kind = 'error';
    out.textContent = resp?.error?.message || t('common.failed');
    if (HINTS[resp?.error?.code]?.install) {
      hostProblem = { code: resp.error.code, message: resp.error.message };
      render();
    }
    return;
  }
  hostProblem = null;
  const { added } = resp.result;
  const fromSubs = resp.result.subscriptions.reduce((n, x) => n + x.added + x.kept, 0);
  out.textContent = addSummary(resp.result);
  out.dataset.kind = added || fromSubs ? '' : 'error';
  if (added) $('homeLinks').value = '';
});

// checkHost — серверов ещё нет: на месте ли компаньон и не старый ли он. Есть серверы — об этом
// скажет состояние VPN при включении.
export async function checkHost() {
  if (S.view.servers.length) return;
  const resp = await send({ type: 'hello' });
  if (resp?.ok) {
    if (olderThan(resp.result.hostVersion, MIN_HOST_VERSION)) hostProblem = { code: 'HOST_OUTDATED', message: outdatedMessage(resp.result.hostVersion) };
  } else if (HINTS[resp?.error?.code]?.install) {
    hostProblem = { code: resp.error.code, message: resp.error.message };
  }
  if (hostProblem) render();
}

defineTab('home', render);
