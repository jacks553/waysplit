// Экран «Диагностика» (SPEC 3.6): версии, ID расширения, ядра, кто управляет прокси, WebRTC,
// «Мой IP сейчас», журналы (компаньон отдаёт их уже без секретов) и отчёт для отладки — тоже
// без секретов.

import { coreText, fmtDate, maskUrl, pingError, send, serverMeta } from '../lib/format.js';
import { normalize } from '../lib/storage.js';
import { has, language, t } from '../lib/i18n.js';
import { hostText } from '../lib/hostmsg.js';
import { el, setIcon } from './ui.js';
import { openScreen } from './state.js';

// Кто управляет прокси Chrome (chrome.proxy, levelOfControl) → ключ словаря; Waysplit — без перевода.
const CONTROL = {
  controllable_by_this_extension: 'diag.control.none',
  controlled_by_other_extensions: 'diag.control.other',
  not_controllable: 'diag.control.policy',
};
const controlText = (c) => (c === 'controlled_by_this_extension' ? 'Waysplit' : CONTROL[c] ? t(CONTROL[c]) : c || '—');
// word — надпись словаря по ключу (состояние VPN, защита WebRTC); нет такой — fallback.
const word = (key, fallback) => (has(key) ? t(key) : fallback);

// coreError — почему ядро не найдено или не запускается (из ответа hello), на языке окна.
const coreError = (e) => (e ? hostText(e, e.message) : '');
const fact = (name, value) => [el('dt', { textContent: name }), el('dd', { textContent: value })];

// report — отчёт для отладки. Ссылок серверов, uuid, паролей и адресов подписок в нём нет.
async function report(last) {
  const st = normalize(await chrome.storage.local.get(null));
  const { hello, core, status, logs, events } = last;
  const lines = [
    t('report.head'),
    t('report.time', { v: fmtDate(Date.now()) }),
    t('report.ext', { version: chrome.runtime.getManifest().version, id: chrome.runtime.id }),
    t('report.browser', { v: navigator.userAgent }),
    t('report.language', { v: `${language()} (${st.settings.language}), Chrome ${chrome.i18n.getUILanguage()}` }),
    t('report.host', { v: hello.error ? t('report.error', { error: hello.error }) : `${hello.hostVersion}, sing-box ${hello.singboxVersion || coreError(hello.singboxError)}, Xray ${hello.xrayVersion || coreError(hello.xrayError) || '—'}` }),
    t('report.core', { v: JSON.stringify(core) }),
    t('report.status', { v: JSON.stringify(status) }),
    t('report.settings', { v: JSON.stringify(st.settings) }),
    t('report.vpn', { enabled: st.enabled, server: st.currentServerId }),
    t('report.servers', { n: st.servers.length }),
    ...st.servers.map((s) => `  ${[s.id, s.name, serverMeta(s), t('report.localPort', { port: s.localPort }), s.subscriptionId && t('report.sub', { id: s.subscriptionId }),
      s.lastPingMs ? t('fmt.ms', { ms: s.lastPingMs }) : pingError(s)].filter(Boolean).join(' · ')}`),
    t('report.subs', { n: st.subscriptions.length }),
    ...st.subscriptions.map((x) => `  ${[x.id, x.name, maskUrl(x.url), x.updatedAt ? fmtDate(x.updatedAt) : t('report.sub.never'), x.device && t('report.sub.device'),
      x.lastError && t('report.error', { error: hostText(x.lastErrorMsg, x.lastError) })].filter(Boolean).join(' · ')}`),
    t('report.rules', {
      all: st.rules.length, direct: st.rules.filter((r) => r.action === 'direct').length,
      proxy: st.rules.filter((r) => r.action === 'proxy').length, off: st.rules.filter((r) => !r.enabled).length,
    }),
    t('report.favs', { n: st.favorites.length }),
    t('report.events'),
    ...events.slice(-30).map((e) => `  ${fmtDate(e.at)} ${e.level} ${e.text}`),
    `${t('diag.log.host')}:`,
    logs.host || logs.error || '',
    `${t('diag.log.singbox')}:`,
    logs.singbox || '',
    `${t('diag.log.xray')}:`,
    logs.xray || '',
  ];
  return lines.join('\n').replace(/\b(vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\/\S+/gi, '$1://***'); // на всякий случай
}

export function openDiag() {
  let last = null;
  const refreshBtn = el('button', { id: 'diagRefresh', type: 'button', className: 'icon-btn', title: t('common.refresh') });
  refreshBtn.setAttribute('aria-label', t('common.refresh'));
  setIcon(refreshBtn, 'refresh');
  openScreen({
    title: t('settings.diag'),
    actions: [refreshBtn],
    className: 'diag',
    build(sc) {
      const facts = el('dl', { id: 'diagFacts', className: 'facts' }, ...fact(t('diag.f.ext'), `${chrome.runtime.getManifest().version} · ID ${chrome.runtime.id}`), ...fact(t('diag.f.host'), t('diag.checking')));
      const ipBtn = el('button', { id: 'myIp', type: 'button', className: 'ghost', textContent: t('diag.myIp') });
      const ipOut = el('span', { id: 'myIpResult', className: 'note' });
      const copyBtn = el('button', { id: 'copyReport', type: 'button', className: 'btn btn-small', textContent: t('diag.copy') });
      const copyNote = el('p', { id: 'copyNote', className: 'hint', textContent: t('diag.copy.note') });
      const logs = {};
      const logBlock = (key, title) => {
        logs[key] = el('pre', { id: `diag-${key}`, className: 'log' });
        return [el('h3', { className: 'group-title', textContent: title }), logs[key]];
      };
      sc.body.append(facts, el('div', { className: 'tools' }, ipBtn, ipOut), el('div', { className: 'tools' }, copyBtn), copyNote,
        ...logBlock('events', t('diag.events')), ...logBlock('host', t('diag.log.host')), ...logBlock('singbox', t('diag.log.singbox')), ...logBlock('xray', t('diag.log.xray')));

      const refresh = async () => {
        refreshBtn.disabled = true;
        const resp = await send({ type: 'diagnostics' });
        refreshBtn.disabled = false;
        if (!resp?.ok) {
          facts.replaceChildren(...fact(t('home.status.error'), resp?.error?.message || t('common.noAnswer')));
          return;
        }
        last = resp.result;
        const { hello, core, status, events } = last;
        const rows = [
          ...fact(t('diag.f.ext'), `${chrome.runtime.getManifest().version} · ID ${chrome.runtime.id}`),
          ...fact(t('diag.f.host'), hello.error ? t('diag.host.down', { error: hello.error }) : hello.hostVersion),
          ...fact('sing-box', hello.error ? '—' : hello.singboxError ? coreError(hello.singboxError) : `${hello.singboxVersion} (${hello.singboxPath})`),
          ...fact('Xray', hello.error ? '—' : hello.xrayError ? t('diag.xray.needed', { error: coreError(hello.xrayError) }) : hello.xrayVersion ? `${hello.xrayVersion} (${hello.xrayPath})` : t('diag.xray.oldHost')),
          ...fact(t('diag.f.coreSingbox'), core.error ? t('diag.noLink', { error: core.error }) : coreText(core.cores?.['sing-box'] ?? core)),
          ...fact(t('diag.f.coreXray'), core.error ? '—' : core.cores ? coreText(core.cores.xray, t('diag.xray.idle')) : '—'),
          ...fact('VPN', status ? `${word(`diag.state.${status.state}`, status.state)}${status.message ? ` — ${status.message}` : ''}` : '—'),
          ...fact(t('diag.f.proxy'), controlText(status?.control)),
          ...fact(t('settings.webrtc'), word(`diag.webrtc.${status?.webrtc}`, '—')),
        ];
        if (status?.proxyError) rows.push(...fact(t('diag.f.proxyError'), `${status.proxyError.error} (${fmtDate(status.proxyError.at)})`));
        facts.replaceChildren(...rows);
        const l = last.logs;
        logs.events.textContent = events.length ? events.map((e) => `${fmtDate(e.at)}  ${e.level === 'error' ? `${t('diag.events.error')} ` : ''}${e.text}`).join('\n') : t('diag.events.none');
        logs.host.textContent = l.error ? t('diag.noLink', { error: l.error }) : l.host || t('diag.empty');
        logs.singbox.textContent = l.error ? '—' : l.singbox || t('diag.empty');
        logs.xray.textContent = l.error ? '—' : l.xray || t('diag.empty');
      };
      refreshBtn.addEventListener('click', refresh);
      ipBtn.addEventListener('click', async () => {
        ipBtn.disabled = true;
        ipOut.textContent = t('diag.ip.asking');
        const resp = await send({ type: 'exitIp' });
        ipBtn.disabled = false;
        ipOut.textContent = resp?.ok ? t('diag.ip.result', { server: resp.result.server, ip: resp.result.ip }) : resp?.error?.message || t('common.failed');
      });
      copyBtn.addEventListener('click', async () => {
        try {
          if (!last) await refresh();
          await navigator.clipboard.writeText(await report(last));
          copyNote.textContent = t('diag.copied');
        } catch (e) {
          copyNote.textContent = t('common.copyFailed', { error: e.message });
        }
      });
      refresh();
    },
  });
}
