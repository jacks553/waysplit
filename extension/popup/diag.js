// Экран «Диагностика» (SPEC 3.6): версии, ID расширения, ядра, кто управляет прокси, WebRTC,
// «Мой IP сейчас», журналы (компаньон отдаёт их уже без секретов) и отчёт для отладки — тоже
// без секретов.

import { coreText, fmtDate, maskUrl, send, serverMeta } from '../lib/format.js';
import { normalize } from '../lib/storage.js';
import { el, setIcon } from './ui.js';
import { openScreen } from './state.js';

const CONTROL = {
  controlled_by_this_extension: 'Waysplit',
  controllable_by_this_extension: 'никто (настройки Chrome или системы)',
  controlled_by_other_extensions: 'другое расширение — отключите его',
  not_controllable: 'политика Chrome — расширениям нельзя',
};
const WEBRTC = { on: 'включена', off: 'выключена (VPN выключен или защита отключена)', other: 'не включилась: управляет другое расширение', blocked: 'не включилась: запрещено политикой', failed: 'ошибка' };
const STATE = { off: 'выключен', no_server: 'включён, но нет сервера', connecting: 'подключение…', on: 'подключено', rules: 'выключен, работают правила', error: 'ошибка' };

const fact = (name, value) => [el('dt', { textContent: name }), el('dd', { textContent: value })];

// report — отчёт для отладки. Ссылок серверов, uuid, паролей и адресов подписок в нём нет.
async function report(last) {
  const st = normalize(await chrome.storage.local.get(null));
  const { hello, core, status, logs, events } = last;
  const lines = [
    'Waysplit — отчёт для отладки (ссылок серверов, uuid, паролей и адресов подписок здесь нет)',
    `Время: ${fmtDate(Date.now())}`,
    `Расширение: ${chrome.runtime.getManifest().version}, ID ${chrome.runtime.id}`,
    `Браузер: ${navigator.userAgent}`,
    `Компаньон: ${hello.error ? `ошибка: ${hello.error}` : `${hello.hostVersion}, sing-box ${hello.singboxVersion || hello.singboxError?.message}, Xray ${hello.xrayVersion || hello.xrayError?.message || '—'}`}`,
    `Ядро: ${JSON.stringify(core)}`,
    `Состояние: ${JSON.stringify(status)}`,
    `Настройки: ${JSON.stringify(st.settings)}`,
    `VPN включён: ${st.enabled}, текущий сервер: ${st.currentServerId}`,
    `Серверы (${st.servers.length}):`,
    ...st.servers.map((s) => `  ${s.id} · ${s.name} · ${serverMeta(s)} · локальный порт ${s.localPort}${s.subscriptionId ? ` · подписка ${s.subscriptionId}` : ''}${s.lastPingMs ? ` · ${s.lastPingMs} мс` : s.lastPingError ? ` · ${s.lastPingError}` : ''}`),
    `Подписки (${st.subscriptions.length}):`,
    ...st.subscriptions.map((x) => `  ${x.id} · ${x.name} · ${maskUrl(x.url)} · ${x.updatedAt ? fmtDate(x.updatedAt) : 'не обновлялась'}${x.device ? ' · привязана как устройство' : ''}${x.lastError ? ` · ошибка: ${x.lastError}` : ''}`),
    `Правила: ${st.rules.length} (без VPN: ${st.rules.filter((r) => r.action === 'direct').length}, через VPN: ${st.rules.filter((r) => r.action === 'proxy').length}, выключено: ${st.rules.filter((r) => !r.enabled).length})`,
    `Избранных серверов: ${st.favorites.length}`,
    'События:',
    ...events.slice(-30).map((e) => `  ${fmtDate(e.at)} ${e.level} ${e.text}`),
    'Журнал компаньона:',
    logs.host || logs.error || '',
    'Журнал sing-box:',
    logs.singbox || '',
    'Журнал Xray:',
    logs.xray || '',
  ];
  return lines.join('\n').replace(/\b(vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\/\S+/gi, '$1://***'); // на всякий случай
}

export function openDiag() {
  let last = null;
  const refreshBtn = el('button', { id: 'diagRefresh', type: 'button', className: 'icon-btn', title: 'Обновить' });
  refreshBtn.setAttribute('aria-label', 'Обновить');
  setIcon(refreshBtn, 'refresh');
  openScreen({
    title: 'Диагностика',
    actions: [refreshBtn],
    className: 'diag',
    build(sc) {
      const facts = el('dl', { id: 'diagFacts', className: 'facts' }, ...fact('Расширение', `${chrome.runtime.getManifest().version} · ID ${chrome.runtime.id}`), ...fact('Компаньон', 'проверяю…'));
      const ipBtn = el('button', { id: 'myIp', type: 'button', className: 'ghost', textContent: 'Мой IP сейчас' });
      const ipOut = el('span', { id: 'myIpResult', className: 'note' });
      const copyBtn = el('button', { id: 'copyReport', type: 'button', className: 'btn btn-small', textContent: 'Скопировать отчёт для отладки' });
      const copyNote = el('p', { id: 'copyNote', className: 'hint', textContent: 'В отчёте нет ссылок серверов, uuid, паролей и адресов подписок.' });
      const logs = {};
      const logBlock = (key, title) => {
        logs[key] = el('pre', { id: `diag-${key}`, className: 'log' });
        return [el('h3', { className: 'group-title', textContent: title }), logs[key]];
      };
      sc.body.append(facts, el('div', { className: 'tools' }, ipBtn, ipOut), el('div', { className: 'tools' }, copyBtn), copyNote,
        ...logBlock('events', 'События'), ...logBlock('host', 'Журнал компаньона'), ...logBlock('singbox', 'Журнал sing-box'), ...logBlock('xray', 'Журнал Xray'));

      const refresh = async () => {
        refreshBtn.disabled = true;
        const resp = await send({ type: 'diagnostics' });
        refreshBtn.disabled = false;
        if (!resp?.ok) {
          facts.replaceChildren(...fact('Ошибка', resp?.error?.message || 'нет ответа'));
          return;
        }
        last = resp.result;
        const { hello, core, status, events } = last;
        const rows = [
          ...fact('Расширение', `${chrome.runtime.getManifest().version} · ID ${chrome.runtime.id}`),
          ...fact('Компаньон', hello.error ? `не отвечает: ${hello.error}` : hello.hostVersion),
          ...fact('sing-box', hello.error ? '—' : hello.singboxError ? hello.singboxError.message : `${hello.singboxVersion} (${hello.singboxPath})`),
          ...fact('Xray', hello.error ? '—' : hello.xrayError ? `${hello.xrayError.message} (нужен только для серверов XHTTP)` : hello.xrayVersion ? `${hello.xrayVersion} (${hello.xrayPath})` : '— (компаньон старый)'),
          ...fact('Ядро sing-box', core.error ? `нет связи: ${core.error}` : coreText(core.cores?.['sing-box'] ?? core)),
          ...fact('Ядро Xray', core.error ? '—' : core.cores ? coreText(core.cores.xray, 'запускается, только когда нужен его сервер') : '—'),
          ...fact('VPN', status ? `${STATE[status.state] || status.state}${status.message ? ` — ${status.message}` : ''}` : '—'),
          ...fact('Прокси Chrome', CONTROL[status?.control] || status?.control || '—'),
          ...fact('Защита WebRTC', WEBRTC[status?.webrtc] || '—'),
        ];
        if (status?.proxyError) rows.push(...fact('Ошибка прокси', `${status.proxyError.error} (${fmtDate(status.proxyError.at)})`));
        facts.replaceChildren(...rows);
        const l = last.logs;
        logs.events.textContent = events.length ? events.map((e) => `${fmtDate(e.at)}  ${e.level === 'error' ? 'ОШИБКА ' : ''}${e.text}`).join('\n') : 'событий пока нет';
        logs.host.textContent = l.error ? `нет связи: ${l.error}` : l.host || 'пусто';
        logs.singbox.textContent = l.error ? '—' : l.singbox || 'пусто';
        logs.xray.textContent = l.error ? '—' : l.xray || 'пусто';
      };
      refreshBtn.addEventListener('click', refresh);
      ipBtn.addEventListener('click', async () => {
        ipBtn.disabled = true;
        ipOut.textContent = 'Узнаю…';
        const resp = await send({ type: 'exitIp' });
        ipBtn.disabled = false;
        ipOut.textContent = resp?.ok ? `Через «${resp.result.server}» сайты видят IP ${resp.result.ip}` : resp?.error?.message || 'Не получилось';
      });
      copyBtn.addEventListener('click', async () => {
        try {
          if (!last) await refresh();
          await navigator.clipboard.writeText(await report(last));
          copyNote.textContent = 'Отчёт скопирован — вставьте его в сообщение. Секретов в нём нет.';
        } catch (e) {
          copyNote.textContent = `Не удалось скопировать: ${e.message}`;
        }
      });
      refresh();
    },
  });
}
