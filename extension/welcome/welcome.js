// «Начало работы» (SPEC 3.6): три шага — компаньон, ссылка, включение. Шаг отмечается, когда сделан.

import { addSummary, noFlags, send } from '../lib/format.js';
import { normalize } from '../lib/storage.js';
import { applyTheme } from '../lib/theme.js';
import { designOf, pageUrl } from '../lib/design.js';
import { hostText } from '../lib/hostmsg.js';
import { startPage, t, usePageLanguage } from '../lib/i18n.js';
import { initMenu } from '../popup/ui.js';
import { initLangButton } from '../popup/langbtn.js';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, MIN_HOST_VERSION, installSteps, olderThan, outdatedMessage } from '../lib/companion.js';

// Тема — та же, что у нового окна (настройка themeLcd); пока она не прочитана, страница не показывается.
applyTheme('themeLcd').finally(() => document.documentElement.classList.add('ready'));
startPage(); // надписи разметки — сразу; язык из настроек уточняется в render()
const $ = (id) => document.getElementById(id);

// Как поставить компаньон (SPEC-STORE.md, 1.3): шаги, кнопка «Скачать» (архив последнего выпуска)
// и страница выпуска — без команд.
function renderSteps() {
  $('installSteps').replaceChildren(...installSteps().map((s) => Object.assign(document.createElement('li'), { textContent: s })));
}
renderSteps();
$('download').href = DOWNLOAD_ZIP_URL;
$('releasePage').href = DOWNLOAD_URL;

function done(step, yes) {
  $(step).dataset.done = String(yes);
}

// say — строка состояния шага. Беда (kind 'error') — предупреждение в рамке, остальное — строкой.
function say(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.dataset.kind = kind;
  node.classList.toggle('lcd-alert', kind === 'error');
}

// hostResp — последний ответ компаньона на «hello»: по нему строка состояния собирается заново,
// когда меняется язык.
let hostResp;
let langSetting = 'auto'; // настройка language: для галочки в меню кнопки языка

function renderHost() {
  if (hostResp === undefined) return; // ещё проверяем — в разметке «Проверяю…»
  const resp = hostResp;
  const r = resp?.ok ? resp.result : null;
  const outdated = !!r && olderThan(r.hostVersion, MIN_HOST_VERSION);
  const ok = !!r && !r.singboxError && !outdated;
  done('step1', ok);
  $('howto').hidden = ok; // установщик и ставит, и обновляет компаньон вместе с ядрами
  if (ok) say('hostState', t('welcome.host.ok', { host: r.hostVersion, singbox: r.singboxVersion }), 'ok');
  else {
    say('hostState', outdated ? t('welcome.host.outdated', { message: outdatedMessage(r.hostVersion) })
      : r ? hostText(r.singboxError, r.singboxError.message) : resp?.error?.message || t('welcome.host.down'), 'error');
  }
}

async function checkHost() {
  hostResp = undefined;
  say('hostState', t('welcome.checking'));
  hostResp = await send({ type: 'hello' });
  renderHost();
}

async function render() {
  const st = normalize(await chrome.storage.local.get(null));
  const { status } = await chrome.storage.session.get('status');
  // Язык из настроек (его могли сменить в окне расширения): надписи разметки заменяются сами,
  // шаги установки и состояние компаньона — собрать заново.
  langSetting = st.settings.language;
  if (usePageLanguage(st.settings.language)) {
    renderSteps();
    renderHost();
  }
  done('step2', st.servers.length > 0);
  done('step3', st.enabled && status?.state === 'on');
  $('ruDirect').checked = st.settings.ruDirect;
  $('openFull').href = pageUrl(designOf(st.settings), '?full#rules'); // окно на всю вкладку — в выбранном оформлении
  $('enable').disabled = !st.servers.length;
  $('enable').textContent = t(st.enabled ? 'home.power.turnOff' : 'home.power.turnOn');
  say('vpnState', !st.servers.length ? t('home.power.needServer')
    : st.enabled ? (status?.state === 'on' ? t('welcome.vpn.on') : status?.state === 'error' ? noFlags(t('welcome.vpn.error', { error: status.message })) : t('home.status.connecting')) : t('home.status.off'),
  status?.state === 'on' && st.enabled ? 'ok' : status?.state === 'error' && st.enabled ? 'error' : '');
}

$('recheck').addEventListener('click', checkHost);
$('addBtn').addEventListener('click', async () => {
  const text = $('links').value.trim();
  if (!text) return;
  $('addBtn').disabled = true;
  const out = $('addResult');
  out.hidden = false;
  out.textContent = t('add.parsing');
  const resp = await send({ type: 'addLinks', text });
  $('addBtn').disabled = false;
  out.dataset.kind = resp?.ok ? '' : 'error';
  out.textContent = noFlags(resp?.ok ? addSummary(resp.result) : resp?.error?.message || t('common.failed'));
  if (resp?.ok) $('links').value = '';
});
// «Российские сайты — без VPN» — та же настройка, что переключатель на «Главной» окна расширения.
$('ruDirect').addEventListener('change', async (e) => {
  const resp = await send({ type: 'setSetting', key: 'ruDirect', value: e.target.checked });
  if (!resp?.ok) render(); // не сохранилось — вернуть галочку как было
});
$('enable').addEventListener('click', async () => {
  const st = normalize(await chrome.storage.local.get(null));
  await send({ type: 'toggle', enabled: !st.enabled });
});
chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'local' || area === 'session') render();
});
initMenu();
initLangButton($('langBtn'), () => langSetting);
checkHost();
render();
