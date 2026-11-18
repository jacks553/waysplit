// Вкладка «Главная» (вид — design/lcd/STYLE.md): на экране верхняя строка с сервером, крупный статус,
// «Российские сайты без VPN», блок «Этот сайт» (кнопки «Через VPN» и «Без VPN», сервер для сайта,
// «Домены этой вкладки»), ошибки и шаги установки компаньона; под экраном — клавиша питания с лампочкой.

import { addSummary, countryCode, fillActions, freshPing, noFlags, parseAction, pingBars, pingReason, send, shownName, splitFlag } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { routeFor, routeIn, ruleServer, ruleTable } from '../lib/rules.js';
import { siteOf } from '../lib/tabdomains.js';
import { stillAttached } from '../lib/sitedomains.js';
import { normalizeDomain, parents, toUnicode } from '../lib/domains.js';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, MIN_HOST_VERSION, docsUrl, installSteps, olderThan, outdatedMessage } from '../lib/companion.js';
import { $, barsEl, el, setIcon, toast } from './ui.js';
import { S, currentServer, defineTab, openScreen, showTab, updateLight, vpnOn } from './state.js';
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

// ERR_NAMES — крупная надпись при ошибке: короткое название беды (design/lcd/STYLE.md, «Состояния
// Главной») — ключ словаря home.err.<имя> по коду ошибки. Кода нет в таблице — слово «Ошибка».
// Причина и что делать — строкой ниже и в рамке под ней.
const ERR_NAMES = {
  HOST_NOT_FOUND: 'noCompanion', HOST_FORBIDDEN: 'denied', HOST_START_FAILED: 'hostStart', HOST_OUTDATED: 'outdated',
  HOST_EXITED: 'lost', HOST_DISCONNECTED: 'lost', HOST_CLOSED: 'lost', HOST_PROTOCOL: 'lost', HOST_NAME: 'lost', HOST_ERROR: 'lost',
  TIMEOUT: 'timeout', INTERNAL: 'internal', PROXY_FAILED: 'proxy', CORE_STOPPED: 'coreStopped', SERVER_INVALID: 'server',
  SINGBOX_NOT_FOUND: 'noCore', XRAY_NOT_FOUND: 'noCore', SINGBOX_FAILED: 'coreFailed', XRAY_FAILED: 'coreFailed', START_FAILED: 'coreFailed',
  START_TIMEOUT: 'slowStart', CONFIG_INVALID: 'config', PORT_BUSY: 'port',
};
const errorName = (code) => (ERR_NAMES[code] ? t(`home.err.${ERR_NAMES[code]}`) : t('home.status.error'));

let ping = { serverId: null, ms: null, error: '', reason: '' }; // быстрый пинг текущего сервера
let busy = false;
// hostProblem — компаньон не установлен или устарел, а серверов ещё нет (кнопка VPN неактивна,
// ошибки состояния не будет): шаги установки — сразу (SPEC-STORE.md, 1.3).
let hostProblem = null;
let problemGo = null;

// LED — лампочка у клавиши питания и её подпись (design/lcd/STYLE.md, «Состояния Главной»): зелёная —
// VPN включён, мигает — подключение, жёлтая — работают только правила, красная — ошибка (и сервер
// не отвечает), не горит — выключено. Состояние всегда продублировано надписью на экране.
const LED = {
  on: ['on', 'home.led.vpn'], connecting: ['blink', 'home.led.vpn'], rules: ['rules', 'home.led.rules'],
  warn: ['error', 'home.led.error'], error: ['error', 'home.led.error'], off: ['off', 'home.led.vpn'], no_server: ['off', 'home.led.vpn'],
};

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
  // Беда — ошибка состояния или «компаньона нет» (он нужен и при выключенном VPN: без него ничего
  // не работает): экран горит, лампочка красная, крупно — название беды.
  const trouble = state === 'error' ? { code: st.code, message: st.message } : state === 'warn' ? null : hostProblem;
  S.hostProblem = hostProblem;
  updateLight();
  const [led, ledLabel] = trouble ? LED.error : LED[state] || LED.off;
  $('powerZone').dataset.led = led;
  $('ledLabel').textContent = t(ledLabel);

  // На экране нет эмодзи: имя сервера — без флага.
  const name = server ? splitFlag(server.name).name : '';
  const texts = {
    off: [t('home.lcd.off'), t(server ? 'home.lcd.off.detail' : 'home.detail.offNoServer')],
    no_server: [t('home.status.no_server'), t('home.detail.no_server')],
    connecting: [t('home.status.connecting'), server ? shownName(server.name) : ''],
    on: [t('home.lcd.on'), t('home.lcd.on.detail')],
    warn: [t('home.err.noAnswer'), warnDetail(server ? shownName(server.name) : '')],
    error: [errorName(st?.code), st?.message || ''],
    rules: [t('home.lcd.off'), t('home.lcd.rules.detail', { n: st?.viaVpn ?? 0 })],
  };
  const [title, detail] = trouble && state !== 'error' ? [errorName(trouble.code), trouble.message || ''] : texts[state] || texts.off;
  const status = $('status');
  status.textContent = title;
  status.dataset.state = state;
  // Крупная надпись не помещается в строку — вторым крупным размером (22.22).
  status.classList.remove('small');
  status.classList.toggle('small', status.scrollWidth > status.clientWidth);
  $('detail').textContent = noFlags(detail);

  $('conflict').hidden = !st?.conflict;
  // Защита WebRTC должна стоять, а ею управляет другое расширение.
  $('webrtcWarn').hidden = !(view.enabled && view.settings.webrtcProtection && (st?.webrtc === 'other' || st?.webrtc === 'blocked'));
  if (trouble) {
    // Причина уже написана строкой под статусом: в рамке ниже остаются подсказка, шаги и ссылки.
    showProblem(trouble.code, trouble.message);
    $('problemText').hidden = true;
    $('problem').hidden = $('hint').hidden && $('problemGo').hidden && $('steps').hidden && $('downloadRow').hidden;
  } else $('problem').hidden = true;

  // Верхняя строка: сигнал, имя сервера, задержка (или «нет ответа»), уголок.
  $('serverRow').hidden = !server;
  if (server) {
    const bars = pingBars(server);
    const ms = ping.serverId === server.id && ping.ms ? ping.ms : server.lastPingMs > 0 ? server.lastPingMs : 0;
    $('srvBars').replaceChildren(barsEl(server));
    $('srvName').textContent = name;
    $('srvName').title = shownName(server.name);
    // Сервер не ответил на пинг — словами, а не только погасшими столбиками.
    $('srvMs').textContent = bars.n === 0 ? t('common.noAnswer') : ms ? t('fmt.ms', { ms }) : '';
    $('srvMs').classList.toggle('fail', bars.n === 0);
    $('serverRow').setAttribute('aria-label', `${t('home.server')}: ${name}, ${bars.title}`);
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
  $('problemText').hidden = false;
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

const exactRule = (domain) => S.view.rules.find((r) => r.domain === domain) || null;

function renderSite() {
  const view = S.view;
  $('site').hidden = !S.site || !view.servers.length;
  if ($('site').hidden) return;
  if (!$('siteDomain').options.length) fillDomains();
  const domain = $('siteDomain').value;
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
      r.kind === 'vpn' ? t('home.why.throughServer', { server: splitFlag(r.server.name).name }) : t('common.withoutVpn'),
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
  // Выбор из двух: нажата та кнопка, как сайт идёт сейчас.
  $('siteVpn').setAttribute('aria-pressed', String(viaVpn));
  $('siteDirect').setAttribute('aria-pressed', String(!viaVpn));
  // Кнопка справа — сервер для сайта: код страны (у сервера без флага — первая буква имени), без
  // сервера — прочерк. Правило сейчас не действует — код сервера из правила, приглушённо.
  const idle = viaVpn ? null : sleeping || (off?.action === 'proxy' ? off : null);
  const target = viaVpn ? r.server : idle ? ruleServer(idle, view.servers, currentServer()) : null;
  const btn = $('siteServer');
  $('siteFlag').textContent = target ? countryCode(target.name) || (splitFlag(target.name).name.trim()[0] || '?').toUpperCase() : '—';
  btn.classList.toggle('dim', !!(idle && target));
  btn.title = idle && target ? t('home.siteServer.idle', { server: shownName(target.name) })
    : target ? t('home.siteServer.named', { server: shownName(target.name) }) : t('home.siteServer.direct');
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

// «Через VPN» и «Без VPN»: нажатие на ненажатую кнопку создаёт или меняет правило для домена.
for (const [id, action] of [['siteVpn', 'proxy'], ['siteDirect', 'direct']]) {
  $(id).addEventListener('click', () => {
    if ($(id).getAttribute('aria-pressed') !== 'true') setSiteRule(action);
  });
}
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

// «Домены этой вкладки» — вложенный экран (design/lcd/STYLE.md): пояснение, список с флажками,
// внизу — выбор действия и «Добавить правила»; запрос разрешения и «пусто» — на нём же.
function openTabDomains() {
  openScreen({
    title: t('home.tabDomains'),
    sub: toUnicode(normalizeDomain(S.site.host).domain || S.site.host),
    className: 'td-screen',
    fixed: true,
    build(sc) {
      const note = el('p', { id: 'tdNote', className: 'hint' });
      const allow = el('button', { id: 'tdAllow', type: 'button', className: 'btn', textContent: t('common.allow'), hidden: true });
      // Пусто: контурная кнопка обновляет вкладку сайта и сама перечитывает список.
      const reload = el('button', { id: 'tdReload', type: 'button', className: 'ghost', textContent: t('common.reloadTab'), hidden: true });
      const list = el('ul', { id: 'tdList', className: 'td-list panel-scroll' });
      const action = el('select', { id: 'tdAction' });
      action.setAttribute('aria-label', t('home.td.action.aria'));
      const add = el('button', { id: 'tdAdd', type: 'button', className: 'btn', textContent: t('home.td.add') });
      sc.body.append(el('div', { className: 'td-top' }, note, allow, reload), list, el('div', { id: 'tdActions', className: 'td-actions', hidden: true }, action, add));
      allow.addEventListener('click', askTabPerm);
      reload.addEventListener('click', reloadForDomains);
      add.addEventListener('click', addTabRules);
    },
  });
}

// tdSay — строка вверху экрана: пояснение или, пока разрешения нет, предупреждение с действием.
function tdSay(text, alert = false) {
  const note = $('tdNote');
  if (!note) return; // экран закрыли
  note.textContent = text;
  note.parentElement.classList.toggle('lcd-alert', alert);
}

// askTabPerm — запрос разрешения видеть запросы вкладок (Chrome спрашивает по нажатию).
async function askTabPerm() {
  tdSay(t('home.td.needPerm'), true);
  $('tdAllow').hidden = true;
  let granted = false;
  try {
    granted = await chrome.permissions.request(TD_PERMS); // окно может закрыться, пока Chrome спрашивает
  } catch {
    granted = false;
  }
  checkPerm();
  if (!$('tdNote')) return; // экран закрыли
  // Разрешение получено: запросы вкладки расширение увидит после её обновления — кнопка «Обновить
  // вкладку». Отказали — кнопка «Разрешить» остаётся на экране.
  tdSay(t(granted ? 'home.tdScreen.granted' : 'home.tdScreen.denied'), !granted);
  $('tdAllow').hidden = granted;
  $('tdReload').hidden = !granted;
}

$('tdButton').addEventListener('click', async () => {
  openTabDomains();
  if (await chrome.permissions.contains(TD_PERMS)) await renderTabDomains();
  else await askTabPerm();
});

async function renderTabDomains() {
  const resp = await send({ type: 'tabDomains', tabId: S.site.tabId });
  const hosts = resp?.ok ? resp.result : [];
  if (!$('tdNote')) return; // экран закрыли
  if (!hosts.length) {
    tdSay(t('home.tdScreen.empty'));
    $('tdReload').hidden = false;
    $('tdList').replaceChildren();
    $('tdActions').hidden = true;
    return false;
  }
  $('tdReload').hidden = true;
  const sites = new Map();
  for (const h of hosts) sites.set(siteOf(h), (sites.get(siteOf(h)) || 0) + 1);
  const own = siteOf(S.site.host);
  const list = [...sites.keys()].sort((a, b) => (a === own ? -1 : b === own ? 1 : a.localeCompare(b)));
  tdSay(t('home.td.count', { n: list.length }));
  const table = ruleTable(S.view.rules); // одна на весь список
  $('tdList').replaceChildren(...list.map((site) => {
    const box = el('input', { type: 'checkbox', value: site });
    const rule = routeIn(table, site)?.rule;
    const label = el('label', {}, box,
      el('span', { className: 'td-name', textContent: toUnicode(site), title: t('home.td.requests', { n: sites.get(site) }) }));
    if (rule) label.append(el('span', { className: 'td-rule', textContent: t(rule.action === 'direct' ? 'common.withoutVpn' : 'common.throughVpn') }));
    return el('li', {}, label);
  }));
  fillActions($('tdAction'), S.view.servers, 'proxy:', shownName);
  $('tdActions').hidden = false;
  return true;
}

// reloadForDomains — «Обновить вкладку» на пустом экране: обновить вкладку сайта и перечитывать
// список, пока он не соберётся (фон записывает домены через полсекунды после запросов вкладки).
async function reloadForDomains() {
  $('tdReload').disabled = true;
  tdSay(t('home.tdScreen.reloading'));
  try {
    await chrome.tabs.reload(S.site.tabId);
  } catch { /* вкладку закрыли — список останется пустым */ }
  let found = false;
  for (let i = 0; i < 12 && !found && $('tdNote'); i++) {
    await new Promise((r) => setTimeout(r, 700));
    if (!$('tdNote')) return; // экран закрыли
    const resp = await send({ type: 'tabDomains', tabId: S.site.tabId });
    found = resp?.ok && resp.result.length > 0;
  }
  if (!$('tdNote')) return;
  $('tdReload').disabled = false;
  await renderTabDomains();
}

async function addTabRules() {
  const domains = [...$('tdList').querySelectorAll('input:checked')].map((x) => x.value);
  if (!domains.length) {
    tdSay(t('home.td.pickOne'));
    return;
  }
  const resp = await send({ type: 'addRules', domains, ...parseAction($('tdAction').value) });
  if (!resp?.ok) {
    tdSay(resp?.error?.message || t('common.failed'));
    return;
  }
  await renderTabDomains(); // обновить пометки «без VPN» / «через VPN»
  tdSay(t('home.td.added', { added: resp.result.added, updated: resp.result.updated }));
  $('reload').hidden = false;
}

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
setIcon(document.querySelector('#tdButton .chev'), 'chev');

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
