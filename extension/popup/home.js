// Вкладка «Главная»: большая кнопка VPN, статус, строка «Сервер», блок «Этот сайт»
// (переключатель «через VPN / напрямую», сервер для сайта, «Домены этой вкладки»), ошибки и шаги
// установки компаньона.

import { addSummary, fillActions, freshPing, parseAction, send, splitFlag } from '../lib/format.js';
import { findRule, routeFor, ruleServer } from '../lib/rules.js';
import { siteOf } from '../lib/tabdomains.js';
import { normalizeDomain, parents, toUnicode } from '../lib/domains.js';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, INSTALL_STEPS, MIN_HOST_VERSION, REPO_URL, olderThan, outdatedMessage } from '../lib/companion.js';
import { $, barsEl, el, faviconEl, flagEl, icon, setIcon, toast } from './ui.js';
import { S, currentServer, defineTab, showTab, vpnOn } from './state.js';
import { openPicker } from './picker.js';
import { openDiag } from './diag.js';

const LOG_HINT = { text: 'Подробности — в журнале ядра.', go: 'diag', goText: 'Открыть диагностику' };

// Что делать при ошибке: подсказка; install — шаги установки компаньона и «Скачать»
// (SPEC-STORE.md, 1.3: без путей к папкам и команд); go — куда ведёт ссылка под подсказкой.
const HINTS = {
  HOST_NOT_FOUND: { text: 'Waysplit подключается к серверам через программу-компаньон. Установите её:', install: true },
  HOST_FORBIDDEN: { text: 'Установите компаньон заново — тогда он пустит эту версию расширения:', install: true },
  HOST_START_FAILED: { text: 'Установите компаньон заново:', install: true },
  HOST_OUTDATED: { text: 'Обновите компаньон — серверы и настройки сохранятся:', install: true },
  SINGBOX_NOT_FOUND: { text: 'Установите компаньон заново — ядра лежат в его архиве:', install: true },
  SINGBOX_FAILED: { text: 'Возможно, sing-box заблокировал антивирус.', url: `${REPO_URL}#частые-вопросы`, goText: 'Частые вопросы' },
  PORT_BUSY: { text: 'Закройте программу, которая заняла порт (например, другой VPN-клиент), или поменяйте начало диапазона портов и включите снова.', go: 'settings', goText: 'Открыть настройки' },
  START_TIMEOUT: LOG_HINT,
  START_FAILED: LOG_HINT,
  CONFIG_INVALID: LOG_HINT,
  CORE_STOPPED: LOG_HINT,
};

let ping = { serverId: null, ms: null, error: '' }; // быстрый пинг текущего сервера
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
    if (fresh) ping = { serverId: server.id, ...fresh };
  }
  if (state === 'on' && ping.serverId === server?.id && ping.error) state = 'warn';

  const power = $('power');
  power.dataset.state = state;
  power.setAttribute('aria-pressed', String(view.enabled));
  power.setAttribute('aria-label', view.enabled ? 'Выключить VPN' : 'Включить VPN');
  power.disabled = busy || (!server && !view.enabled);
  power.title = server || view.enabled ? '' : 'Сначала добавьте сервер';

  const name = server?.name || '';
  const texts = {
    off: ['Выключено', server ? 'Нажмите, чтобы включить' : 'Добавьте сервер, чтобы включить VPN'],
    no_server: ['Нет сервера', 'Добавьте сервер'],
    connecting: ['Подключение…', name],
    on: [`Подключено · ${name}${ping.serverId === server?.id && ping.ms ? ` · ${ping.ms} мс` : ''}`, 'Весь трафик Chrome идёт через сервер'],
    warn: ['Сервер не отвечает', warnDetail(name, ping.error)],
    error: ['Ошибка', st?.message || ''],
    rules: ['Выключено · работают правила', `Через VPN идут только сайты из правил (правил «через VPN»: ${st?.viaVpn ?? 0})`],
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
  }
  $('homeAdd').hidden = view.servers.length > 0;
  renderSite();

  if (state === 'on' && ping.serverId !== server.id) checkPing(server.id);
}

// warnDetail — текущий сервер не ответил: почему (если известно) и что будет с сайтами.
function warnDetail(name, error) {
  const reason = error.replace(/^Сервер не отвечает\s*/, '').replace(/^\((.*)\)$/, '$1');
  const what = S.view.settings.onFailure === 'direct'
    ? 'Сайты открываются напрямую, без VPN.'
    : 'Сайты не откроются, пока он недоступен: выберите другой сервер.';
  return `«${name}» не ответил${reason ? ` (${reason})` : ''}. ${what}`;
}

function showProblem(code, message) {
  $('problemText').textContent = message;
  const hint = HINTS[code] || {};
  $('hint').hidden = !hint.text;
  $('hint').textContent = hint.text || '';
  problemGo = hint.go || hint.url ? hint : null;
  $('problemGo').hidden = !problemGo;
  $('problemGo').textContent = hint.goText || '';
  $('steps').hidden = !hint.install;
  $('steps').replaceChildren(...(hint.install ? INSTALL_STEPS : []).map((s) => el('li', { textContent: s })));
  $('downloadRow').hidden = !hint.install;
  $('download').href = DOWNLOAD_ZIP_URL;
  $('releasePage').href = DOWNLOAD_URL;
  $('problem').hidden = false;
}

$('problemGo').addEventListener('click', () => {
  if (!problemGo) return;
  if (problemGo.url) chrome.tabs.create({ url: problemGo.url });
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
  $('siteIcon').replaceWith(Object.assign(faviconEl(siteOf(base || S.site.host)), { id: 'siteIcon' }));
}

const exactRule = (domain) => S.view.rules.find((r) => r.domain === domain) || null;

function renderSite() {
  const view = S.view;
  $('site').hidden = !S.site || !view.servers.length;
  if ($('site').hidden) return;
  if (!$('siteDomain').options.length) fillDomains();
  const domain = $('siteDomain').value;
  const r = routeFor(view, S.site.host);
  const exact = exactRule(domain);
  const local = r.kind === 'local';
  const on = vpnOn();

  // sleeping — правило «через VPN» есть, но сработать не может: VPN выключен, а правила при
  // выключенном VPN отключены. off — правило для этого домена отключено. В жёлтой строке — «Включить».
  const sleeping = !local && r.inactive?.action === 'proxy' ? r.inactive : null;
  const off = !local && exact && !exact.enabled ? exact : null;

  let why;
  if (local) why = 'Локальный адрес — всегда напрямую';
  else if (r.rule) {
    const via = r.kind === 'vpn' ? ` · через ${r.server.name}` : ' · без VPN';
    why = `По правилу для ${toUnicode(r.rule.domain)}${via}`;
  } else if (r.inactive?.action === 'direct') why = `По правилу для ${toUnicode(r.inactive.domain)} · без VPN`;
  else if (sleeping) why = `Правило для ${toUnicode(sleeping.domain)} есть, но сейчас не действует`;
  else why = `Правила нет — как у остальных сайтов (${on ? 'через текущий сервер' : 'напрямую: VPN выключен'})`;
  $('siteWhy').textContent = why;

  warnFix = sleeping ? { setting: true } : off ? { ruleId: off.id } : null;
  $('siteWarn').hidden = !warnFix;
  if (sleeping) {
    $('siteWarnText').textContent = 'VPN выключен, а правила при выключенном VPN отключены — сайт идёт напрямую.';
    $('siteWarnFix').title = 'Включить «Правила работают, когда VPN выключен»';
  } else if (off) {
    $('siteWarnText').textContent = `Правило для ${toUnicode(off.domain)} отключено — сайт открывается как остальные.`;
    $('siteWarnFix').title = 'Включить правило';
  }

  $('siteControls').hidden = local || !domain;
  const viaVpn = r.kind === 'vpn';
  $('siteSwitch').setAttribute('aria-checked', String(viaVpn));
  $('siteSwitchText').textContent = viaVpn ? 'Через VPN' : 'Напрямую';
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
  btn.title = idle && target ? `По правилу — через ${target.name}, но сейчас правило не действует. Выбрать сервер`
    : target ? `Сервер для сайта: ${target.name}` : 'Сайт идёт без VPN — выбрать сервер';
  $('ruleRemove').hidden = !exact;
}

// warnFix — что включает кнопка в жёлтой строке: настройку «Правила работают, когда VPN выключен»
// или отключённое правило.
let warnFix = null;
$('siteWarnFix').addEventListener('click', async () => {
  if (!warnFix) return;
  const resp = warnFix.setting
    ? await send({ type: 'setSetting', key: 'rulesWhenOff', value: true })
    : await send({ type: 'updateRule', id: warnFix.ruleId, patch: { enabled: true } });
  if (!resp?.ok) toast(resp?.error?.message || 'Не получилось', 'error');
  else {
    toast(warnFix.setting ? 'Правила работают и при выключенном VPN' : 'Правило включено');
    $('reload').hidden = false;
  }
});

async function setSiteRule(action, serverId = null) {
  const domain = $('siteDomain').value;
  const resp = await send({ type: 'addRules', domains: [domain], action, serverId });
  if (resp?.ok) $('reload').hidden = false;
  else showProblem(resp?.error?.code, resp?.error?.message || 'Не получилось');
}

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
const TD_PERMS = { permissions: ['webRequest'], origins: ['<all_urls>'] };

$('tdButton').addEventListener('click', async () => {
  const open = $('td').hidden;
  $('td').hidden = !open;
  $('tdButton').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('tdList').replaceChildren();
  $('tdActions').hidden = true;
  let granted = await chrome.permissions.contains(TD_PERMS);
  if (!granted) {
    $('tdNote').textContent = 'Нужно разрешение видеть, к каким сайтам обращается вкладка. Chrome спросит один раз.';
    try {
      granted = await chrome.permissions.request(TD_PERMS); // окно может закрыться, пока Chrome спрашивает
    } catch {
      granted = false;
    }
    $('tdNote').textContent = granted
      ? 'Разрешение получено. Обновите вкладку — расширение запомнит, к каким доменам она обращается, — и нажмите кнопку ещё раз.'
      : 'Без разрешения список не собрать. Можно нажать ещё раз.';
    if (granted) $('reload').hidden = false;
    return;
  }
  await renderTabDomains();
});

async function renderTabDomains() {
  const resp = await send({ type: 'tabDomains', tabId: S.site.tabId });
  const hosts = resp?.ok ? resp.result : [];
  if (!hosts.length) {
    $('tdNote').textContent = 'Пока пусто: обновите вкладку, чтобы собрать домены, и нажмите кнопку ещё раз.';
    $('reload').hidden = false;
    return;
  }
  const sites = new Map();
  for (const h of hosts) sites.set(siteOf(h), (sites.get(siteOf(h)) || 0) + 1);
  const own = siteOf(S.site.host);
  const list = [...sites.keys()].sort((a, b) => (a === own ? -1 : b === own ? 1 : a.localeCompare(b)));
  $('tdNote').textContent = `Вкладка обращалась к ${list.length} сайтам. Отметьте нужные:`;
  $('tdList').replaceChildren(...list.map((site) => {
    const box = el('input', { type: 'checkbox', value: site });
    const rule = findRule(S.view.rules, site);
    const label = el('label', {}, box, faviconEl(site),
      el('span', { className: 'td-name', textContent: toUnicode(site), title: `запросов к адресам сайта: ${sites.get(site)}` }));
    if (rule) label.append(el('span', { className: 'td-rule', textContent: rule.action === 'direct' ? 'без VPN' : 'через VPN' }));
    return el('li', {}, label);
  }));
  fillActions($('tdAction'), S.view.servers, 'proxy:');
  $('tdActions').hidden = false;
}

$('tdAdd').addEventListener('click', async () => {
  const domains = [...$('tdList').querySelectorAll('input:checked')].map((x) => x.value);
  if (!domains.length) {
    $('tdNote').textContent = 'Отметьте хотя бы один домен.';
    return;
  }
  const resp = await send({ type: 'addRules', domains, ...parseAction($('tdAction').value) });
  if (!resp?.ok) {
    $('tdNote').textContent = resp?.error?.message || 'Не получилось';
    return;
  }
  await renderTabDomains(); // обновить пометки «без VPN» / «через VPN»
  $('tdNote').textContent = `Добавлено правил: ${resp.result.added}, обновлено: ${resp.result.updated}. Обновите вкладку.`;
  $('reload').hidden = false;
});

$('reloadTab').addEventListener('click', async () => {
  if (S.site) await chrome.tabs.reload(S.site.tabId);
  $('reload').hidden = true;
});

// --- кнопка VPN, сервер, пинг ---

// Быстрый пинг текущего сервера, когда VPN подключён (SPEC, раздел 3.2).
async function checkPing(serverId) {
  ping = { serverId, ms: null, error: '' };
  const resp = await send({ type: 'pingCurrent' });
  if (ping.serverId !== serverId) return;
  if (resp?.ok && resp.result.ms) ping.ms = resp.result.ms;
  else ping.error = resp?.ok ? resp.result.error || 'нет ответа' : resp?.error?.message || 'нет ответа';
  render();
}

$('power').addEventListener('click', async () => {
  busy = true;
  render();
  ping = { serverId: null, ms: null, error: '' };
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
  out.textContent = 'Разбираю ссылки…';
  const resp = await send({ type: 'addLinks', text });
  $('homeAddBtn').disabled = false;
  if (!resp?.ok) {
    out.dataset.kind = 'error';
    out.textContent = resp?.error?.message || 'Не получилось';
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
