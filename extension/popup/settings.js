// Вкладка «Настройки» (SPEC 3.6, SPEC-POPUP.md): те же группы, что были на странице настроек,
// резервная копия; внизу — «Диагностика», «Помощь», «Сообщить об ошибке» и версии.
// Каждое изменение сразу уходит в фон (setSetting); неверное значение — сообщение и прежнее значение.

import { send } from '../lib/format.js';
import { PORT_RANGE } from '../lib/storage.js';
import { LANGS, language, t } from '../lib/i18n.js';
import { DOWNLOAD_URL, ISSUES_URL, PHRASES_HOST_VERSION, helpUrl, olderThan } from '../lib/companion.js';
import { $, ask, el, setIcon, toast } from './ui.js';
import { S, defineTab } from './state.js';
import { openDiag } from './diag.js';
import { openFull } from './full.js';
import { permGranted, requestPerm } from './siteperm.js';

let hello = null; // версии компаньона и ядер — спрашиваем один раз, когда вкладку открыли

// fillLanguages — варианты языка: «как в Chrome» и языки из словарей, каждый — своим названием
// («Русский», «English»): его узнают и те, кто не читает на языке окна.
let languagesFor = '';
function fillLanguages(chosen) {
  if (languagesFor === language()) return;
  languagesFor = language();
  const opt = (value, text) => el('option', { value, textContent: text });
  $('language').replaceChildren(opt('auto', t('settings.language.auto')), ...Object.values(LANGS).map((d) => opt(d.lang, d.name)));
  $('language').value = chosen; // список собран заново — вернуть выбранное
}

function render() {
  const settings = S.view.settings;
  fillLanguages(settings.language);
  $('helpLink').href = helpUrl(); // у каждого языка своя страница помощи
  for (const r of document.querySelectorAll('input[name="onFailure"]')) r.checked = r.value === settings.onFailure;
  $('webrtcProtection').checked = settings.webrtcProtection;
  $('setRulesWhenOff').checked = settings.rulesWhenOff;
  $('setRuDirect').checked = settings.ruDirect;
  $('autoSiteDomains').checked = settings.autoSiteDomains;
  $('autoSitePerm').hidden = !settings.autoSiteDomains || permGranted();
  for (const id of ['autoConnect', 'subscriptionUA', 'subscriptionIntervalHours', 'portRangeStart', 'logLevel', 'design', 'themeLcd', 'language']) {
    if (document.activeElement !== $(id)) $(id).value = settings[id];
  }
  $('portRangeEnd').textContent = t('settings.portsEnd', { port: settings.portRangeStart + PORT_RANGE - 1 });
  renderVersions();
  if (!hello) {
    hello = { pending: true };
    send({ type: 'hello' }).then((resp) => {
      hello = resp?.ok ? resp.result : { error: resp?.error?.message || t('common.noAnswer') };
      renderVersions();
    });
  }
}

function renderVersions() {
  const parts = [t('settings.ver.ext', { version: chrome.runtime.getManifest().version })];
  if (hello?.hostVersion) {
    parts.push(t('settings.ver.host', { version: hello.hostVersion }));
    if (hello.singboxVersion) parts.push(`sing-box ${hello.singboxVersion}`);
    if (hello.xrayVersion) parts.push(`Xray ${hello.xrayVersion}`);
  } else if (hello?.error) parts.push(t('settings.ver.hostDown'));
  $('versions').textContent = parts.join(' · ');
  // Компаньон старее 1.2.0 пишет свои сообщения только по-русски. В английском окне — строка о том,
  // что его стоит обновить (в русском словаре она пустая, и строки нет).
  const hint = hello?.hostVersion && olderThan(hello.hostVersion, PHRASES_HOST_VERSION) ? t('settings.ver.hostLang') : '';
  $('hostLang').hidden = !hint;
  $('hostLangLink').textContent = hint;
  $('hostLangLink').href = DOWNLOAD_URL;
}

// save — записать настройку; okKey — ключ словаря для сообщения об успехе.
async function save(key, value, okKey = 'common.saved') {
  const resp = await send({ type: 'setSetting', key, value });
  if (resp?.ok) toast(t(okKey));
  else {
    toast(resp?.error?.message || t('common.failed'), 'error');
    render(); // вернуть прежнее значение
  }
}

for (const r of document.querySelectorAll('input[name="onFailure"]')) {
  r.addEventListener('change', () => save('onFailure', r.value, `settings.onFailure.${r.value}.toast`));
}
$('webrtcProtection').addEventListener('change', (e) => save('webrtcProtection', e.target.checked));
// Та же настройка — и в меню «⋯» вкладки «Правила».
$('setRulesWhenOff').addEventListener('change', (e) => save('rulesWhenOff', e.target.checked, e.target.checked ? 'rules.whenOff.on' : 'rules.whenOff.off'));
// «Российские сайты — без VPN» — тот же переключатель, что на «Главной».
$('setRuDirect').addEventListener('change', (e) => save('ruDirect', e.target.checked, e.target.checked ? 'settings.ru.on' : 'settings.ru.off'));
// «Домены сайта»: автосбор для правил «через VPN». Нужно разрешение Chrome видеть запросы вкладок.
$('autoSiteDomains').addEventListener('change', (e) => save('autoSiteDomains', e.target.checked, e.target.checked ? 'settings.autoSite.on' : 'settings.autoSite.off'));
$('autoSitePermBtn').addEventListener('click', async () => {
  toast(t(await requestPerm() ? 'settings.perm.granted' : 'settings.perm.denied'), 'keep');
});
$('autoConnect').addEventListener('change', (e) => save('autoConnect', e.target.value));
$('logLevel').addEventListener('change', (e) => save('logLevel', e.target.value, 'settings.logLevel.saved'));
$('themeLcd').addEventListener('change', (e) => save('themeLcd', e.target.value));
// Оформление: после выбора окно само открывается в другом оформлении (popup.js), на этой же
// вкладке и с фокусом на этом же выборе. Сообщения «Сохранено» нет: перемену видно и так.
$('design').addEventListener('change', async (e) => {
  const resp = await send({ type: 'setSetting', key: 'design', value: e.target.value });
  if (!resp?.ok) {
    toast(resp?.error?.message || t('common.failed'), 'error');
    render();
  }
});
// Язык меняется сразу, без перезапуска: окно перечитывает настройки и заменяет надписи (state.js),
// фон — подсказку значка на панели и свои сообщения. Сообщения «Сохранено» нет: перемену видно и так.
$('language').addEventListener('change', async (e) => {
  const resp = await send({ type: 'setSetting', key: 'language', value: e.target.value });
  if (!resp?.ok) {
    toast(resp?.error?.message || t('common.failed'), 'error');
    render();
  }
});
$('subscriptionUA').addEventListener('change', (e) => save('subscriptionUA', e.target.value.trim()));
$('subscriptionIntervalHours').addEventListener('change', (e) => save('subscriptionIntervalHours', Number(e.target.value)));
$('portRangeStart').addEventListener('change', (e) => save('portRangeStart', Number(e.target.value), 'settings.ports.saved'));

// Резервная копия: в файле секреты — ссылки серверов и адреса подписок. С файлами — на
// развёрнутой странице: в окне расширения окно выбора файла закрывает окно.
async function saveBackup() {
  if (!S.full) return openFull('settings', 'backup-save');
  const resp = await send({ type: 'exportBackup' });
  if (!resp?.ok) {
    toast(resp?.error?.message || t('common.failed'), 'error');
    return;
  }
  const a = el('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(resp.result, null, 2)], { type: 'application/json' })),
    download: `waysplit-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(t('backup.saved', { servers: resp.result.servers.length, subs: resp.result.subscriptions.length, rules: resp.result.rules.length }));
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
      toast(t('file.notJson'), 'error');
      return;
    }
    if (!(await ask({ title: t('backup.ask.title'), text: t('backup.ask.text'), ok: t('backup.ask.ok'), danger: true }))) return;
    toast(t('backup.restoring'));
    const resp = await send({ type: 'importBackup', data });
    toast(resp?.ok
      ? t(resp.result.skipped ? 'backup.restoredSkipped' : 'backup.restored', { servers: resp.result.servers, skipped: resp.result.skipped, subs: resp.result.subscriptions, rules: resp.result.rules })
      : resp?.error?.message || t('common.failed'), resp?.ok ? '' : 'error');
  });
  input.click();
}

export const backupActions = { 'backup-save': saveBackup, 'backup-restore': restoreBackup };

$('exportBackup').addEventListener('click', saveBackup);
$('importBackup').addEventListener('click', restoreBackup);
$('openDiag').addEventListener('click', openDiag);
$('issuesLink').href = ISSUES_URL;
setIcon(document.querySelector('#openDiag .chev'), 'chev');
for (const x of document.querySelectorAll('.list-row .ext')) setIcon(x, 'ext');

defineTab('settings', render);
