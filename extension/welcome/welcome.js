// «Начало работы» (SPEC 3.6): три шага — компаньон, ссылка, включение. Шаг отмечается, когда сделан.

import { addSummary, send } from '../lib/format.js';
import { normalize } from '../lib/storage.js';
import { applyTheme } from '../lib/theme.js';
import { hostText } from '../lib/hostmsg.js';
import { startPage, t, usePageLanguage } from '../lib/i18n.js';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, MIN_HOST_VERSION, installSteps, olderThan, outdatedMessage } from '../lib/companion.js';

applyTheme();
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

// hostResp — последний ответ компаньона на «hello»: по нему строка состояния собирается заново,
// когда меняется язык.
let hostResp;

function renderHost() {
  if (hostResp === undefined) return; // ещё проверяем — в разметке «Проверяю…»
  const resp = hostResp;
  const r = resp?.ok ? resp.result : null;
  const outdated = !!r && olderThan(r.hostVersion, MIN_HOST_VERSION);
  const ok = !!r && !r.singboxError && !outdated;
  done('step1', ok);
  $('howto').hidden = ok; // установщик и ставит, и обновляет компаньон вместе с ядрами
  if (ok) {
    $('hostState').textContent = t('welcome.host.ok', { host: r.hostVersion, singbox: r.singboxVersion });
    $('hostState').dataset.kind = 'ok';
  } else {
    $('hostState').textContent = outdated ? t('welcome.host.outdated', { message: outdatedMessage(r.hostVersion) })
      : r ? hostText(r.singboxError, r.singboxError.message) : resp?.error?.message || t('welcome.host.down');
    $('hostState').dataset.kind = 'error';
  }
}

async function checkHost() {
  hostResp = undefined;
  $('hostState').textContent = t('welcome.checking');
  $('hostState').dataset.kind = '';
  hostResp = await send({ type: 'hello' });
  renderHost();
}

async function render() {
  const st = normalize(await chrome.storage.local.get(null));
  const { status } = await chrome.storage.session.get('status');
  // Язык из настроек (его могли сменить в окне расширения): надписи разметки заменяются сами,
  // шаги установки и состояние компаньона — собрать заново.
  if (usePageLanguage(st.settings.language)) {
    renderSteps();
    renderHost();
  }
  done('step2', st.servers.length > 0);
  done('step3', st.enabled && status?.state === 'on');
  $('ruDirect').checked = st.settings.ruDirect;
  $('enable').disabled = !st.servers.length;
  $('enable').textContent = t(st.enabled ? 'home.power.turnOff' : 'home.power.turnOn');
  $('vpnState').textContent = !st.servers.length ? t('home.power.needServer')
    : st.enabled ? (status?.state === 'on' ? t('welcome.vpn.on') : status?.state === 'error' ? t('welcome.vpn.error', { error: status.message }) : t('home.status.connecting')) : t('home.status.off');
  $('vpnState').dataset.kind = status?.state === 'on' && st.enabled ? 'ok' : status?.state === 'error' && st.enabled ? 'error' : '';
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
  out.textContent = resp?.ok ? addSummary(resp.result) : resp?.error?.message || t('common.failed');
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
checkHost();
render();
