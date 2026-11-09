// «Начало работы» (SPEC 3.6): три шага — компаньон, ссылка, включение. Шаг отмечается, когда сделан.

import { addSummary, send } from '../lib/format.js';
import { normalize } from '../lib/storage.js';
import { applyTheme } from '../lib/theme.js';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, INSTALL_STEPS, MIN_HOST_VERSION, olderThan, outdatedMessage } from '../lib/companion.js';

applyTheme();
const $ = (id) => document.getElementById(id);

// Как поставить компаньон (SPEC-STORE.md, 1.3): шаги, кнопка «Скачать» (архив последнего выпуска)
// и страница выпуска — без команд.
$('installSteps').replaceChildren(...INSTALL_STEPS.map((s) => Object.assign(document.createElement('li'), { textContent: s })));
$('download').href = DOWNLOAD_ZIP_URL;
$('releasePage').href = DOWNLOAD_URL;

function done(step, yes) {
  $(step).dataset.done = String(yes);
}

async function checkHost() {
  $('hostState').textContent = 'Проверяю…';
  $('hostState').dataset.kind = '';
  const resp = await send({ type: 'hello' });
  const r = resp?.ok ? resp.result : null;
  const outdated = !!r && olderThan(r.hostVersion, MIN_HOST_VERSION);
  const ok = !!r && !r.singboxError && !outdated;
  done('step1', ok);
  $('howto').hidden = ok; // установщик и ставит, и обновляет компаньон вместе с ядрами
  if (ok) {
    $('hostState').textContent = `Компаньон на связи: ${r.hostVersion}, sing-box ${r.singboxVersion}`;
    $('hostState').dataset.kind = 'ok';
  } else {
    $('hostState').textContent = outdated ? `${outdatedMessage(r.hostVersion)}. Установите новую версию — серверы и настройки сохранятся.`
      : r ? r.singboxError.message : resp?.error?.message || 'Компаньон не отвечает';
    $('hostState').dataset.kind = 'error';
  }
}

async function render() {
  const st = normalize(await chrome.storage.local.get(null));
  const { status } = await chrome.storage.session.get('status');
  done('step2', st.servers.length > 0);
  done('step3', st.enabled && status?.state === 'on');
  $('enable').disabled = !st.servers.length;
  $('enable').textContent = st.enabled ? 'Выключить VPN' : 'Включить VPN';
  $('vpnState').textContent = !st.servers.length ? 'Сначала добавьте сервер'
    : st.enabled ? (status?.state === 'on' ? 'Подключено' : status?.state === 'error' ? `Ошибка: ${status.message}` : 'Подключение…') : 'Выключено';
  $('vpnState').dataset.kind = status?.state === 'on' && st.enabled ? 'ok' : status?.state === 'error' && st.enabled ? 'error' : '';
}

$('recheck').addEventListener('click', checkHost);
$('addBtn').addEventListener('click', async () => {
  const text = $('links').value.trim();
  if (!text) return;
  $('addBtn').disabled = true;
  const out = $('addResult');
  out.hidden = false;
  out.textContent = 'Разбираю ссылки…';
  const resp = await send({ type: 'addLinks', text });
  $('addBtn').disabled = false;
  out.dataset.kind = resp?.ok ? '' : 'error';
  out.textContent = resp?.ok ? addSummary(resp.result) : resp?.error?.message || 'Не получилось';
  if (resp?.ok) $('links').value = '';
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
