// Вкладка «Настройки» (SPEC 3.6, SPEC-POPUP.md): те же группы, что были на странице настроек,
// резервная копия; внизу — «Диагностика», «Помощь», «Сообщить об ошибке» и версии.
// Каждое изменение сразу уходит в фон (setSetting); неверное значение — сообщение и прежнее значение.

import { send } from '../lib/format.js';
import { PORT_RANGE } from '../lib/storage.js';
import { HELP_URL, ISSUES_URL } from '../lib/companion.js';
import { $, ask, el, setIcon, toast } from './ui.js';
import { S, defineTab } from './state.js';
import { openDiag } from './diag.js';
import { openFull } from './full.js';


let hello = null; // версии компаньона и ядер — спрашиваем один раз, когда вкладку открыли

function render() {
  const settings = S.view.settings;
  for (const r of document.querySelectorAll('input[name="onFailure"]')) r.checked = r.value === settings.onFailure;
  $('webrtcProtection').checked = settings.webrtcProtection;
  $('setRulesWhenOff').checked = settings.rulesWhenOff;
  for (const id of ['autoConnect', 'subscriptionUA', 'subscriptionIntervalHours', 'portRangeStart', 'logLevel', 'theme']) {
    if (document.activeElement !== $(id)) $(id).value = settings[id];
  }
  $('portRangeEnd').textContent = `(по ${settings.portRangeStart + PORT_RANGE - 1})`;
  renderVersions();
  if (!hello) {
    hello = { pending: true };
    send({ type: 'hello' }).then((resp) => {
      hello = resp?.ok ? resp.result : { error: resp?.error?.message || 'нет ответа' };
      renderVersions();
    });
  }
}

function renderVersions() {
  const parts = [`Расширение ${chrome.runtime.getManifest().version}`];
  if (hello?.hostVersion) {
    parts.push(`компаньон ${hello.hostVersion}`);
    if (hello.singboxVersion) parts.push(`sing-box ${hello.singboxVersion}`);
    if (hello.xrayVersion) parts.push(`Xray ${hello.xrayVersion}`);
  } else if (hello?.error) parts.push('компаньон не отвечает');
  $('versions').textContent = parts.join(' · ');
}

async function save(key, value, okText = 'Сохранено') {
  const resp = await send({ type: 'setSetting', key, value });
  if (resp?.ok) toast(okText);
  else {
    toast(resp?.error?.message || 'Не получилось', 'error');
    render(); // вернуть прежнее значение
  }
}

for (const r of document.querySelectorAll('input[name="onFailure"]')) {
  r.addEventListener('change', () => save('onFailure', r.value,
    r.value === 'block' ? 'Сервер недоступен — сайты не откроются напрямую' : 'Сервер недоступен — сайты откроются напрямую'));
}
$('webrtcProtection').addEventListener('change', (e) => save('webrtcProtection', e.target.checked));
// Та же настройка — и в меню «⋯» вкладки «Правила».
$('setRulesWhenOff').addEventListener('change', (e) => save('rulesWhenOff', e.target.checked, e.target.checked
  ? 'Правила работают и при выключенном VPN: сайты из правил «через VPN» идут через VPN, остальные — напрямую'
  : 'При выключенном VPN правила не действуют: все сайты идут напрямую'));
$('autoConnect').addEventListener('change', (e) => save('autoConnect', e.target.value));
$('logLevel').addEventListener('change', (e) => save('logLevel', e.target.value, 'Сохранено (ядро перезапустится с новым журналом)'));
$('theme').addEventListener('change', (e) => save('theme', e.target.value));
$('subscriptionUA').addEventListener('change', (e) => save('subscriptionUA', e.target.value.trim()));
$('subscriptionIntervalHours').addEventListener('change', (e) => save('subscriptionIntervalHours', Number(e.target.value)));
$('portRangeStart').addEventListener('change', (e) => save('portRangeStart', Number(e.target.value),
  'Сохранено: серверы получили порты из нового диапазона, ядро перезапустилось'));

// Резервная копия: в файле секреты — ссылки серверов и адреса подписок. С файлами — на
// развёрнутой странице: в окне расширения окно выбора файла закрывает окно.
async function saveBackup() {
  if (!S.full) return openFull('settings', 'backup-save');
  const resp = await send({ type: 'exportBackup' });
  if (!resp?.ok) {
    toast(resp?.error?.message || 'Не получилось', 'error');
    return;
  }
  const a = el('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(resp.result, null, 2)], { type: 'application/json' })),
    download: `waysplit-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Копия сохранена: серверов ${resp.result.servers.length}, подписок ${resp.result.subscriptions.length}, правил ${resp.result.rules.length}. В файле секреты — храните его как пароль.`);
}

function restoreBackup() {
  if (!S.full) return openFull('settings', 'backup-restore');
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('Файл не читается: это не JSON', 'error');
      return;
    }
    if (!(await ask({ title: 'Восстановить из копии?', text: 'Текущие серверы, подписки, правила и настройки будут заменены.', ok: 'Восстановить', danger: true }))) return;
    toast('Восстанавливаю…');
    const resp = await send({ type: 'importBackup', data });
    toast(resp?.ok
      ? `Восстановлено: серверов ${resp.result.servers}${resp.result.skipped ? ` (не распознано ${resp.result.skipped})` : ''}, подписок ${resp.result.subscriptions}, правил ${resp.result.rules}. Подписки обновятся сами.`
      : resp?.error?.message || 'Не получилось', resp?.ok ? '' : 'error');
  });
  input.click();
}

export const backupActions = { 'backup-save': saveBackup, 'backup-restore': restoreBackup };

$('exportBackup').addEventListener('click', saveBackup);
$('importBackup').addEventListener('click', restoreBackup);
$('openDiag').addEventListener('click', openDiag);
$('helpLink').href = HELP_URL;
$('issuesLink').href = ISSUES_URL;
setIcon(document.querySelector('#openDiag .chev'), 'chev');
for (const x of document.querySelectorAll('.list-row .ext')) setIcon(x, 'ext');

defineTab('settings', render);
