// Вкладка «Правила» (SPEC-POPUP.md): поле «Введите домен» — и добавление, и поиск по списку;
// рядом — что делать с сайтом (без VPN, через VPN как у остальных, конкретный сервер) и «+».
// Строка правила: значок сайта (только из памяти Chrome), домен, куда идёт (нажатие — выбор
// сервера), корзина, «⋯» (отключить без удаления / включить). «Готовые наборы», импорт, экспорт и
// «Правила работают, когда VPN выключен» — в меню «⋯» вкладки.

import { send, splitFlag } from '../lib/format.js';
import { toUnicode } from '../lib/domains.js';
import { exportRules } from '../lib/rules.js';
import { $, el, faviconEl, flagEl, icon, openMenu, setIcon, toast } from './ui.js';
import { S, defineTab, openScreen, serverById, vpnOn } from './state.js';
import { openPicker } from './picker.js';
import { openFull } from './full.js';

let sets = null;

// fillRuleActions — «Без VPN», «Через VPN» (текущий сервер — как у остальных), серверы по имени.
function fillRuleActions(select, value) {
  const opt = (v, text) => el('option', { value: v, textContent: text });
  select.replaceChildren(opt('direct', 'Без VPN'), opt('proxy:', 'Через VPN'),
    ...S.view.servers.map((s) => opt(`proxy:${s.id}`, s.name)));
  select.value = [...select.options].some((o) => o.value === value) ? value : 'direct';
}

const queryText = () => {
  const lines = $('ruleInput').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return lines.length === 1 ? lines[0].toLowerCase() : '';
};

function render() {
  const view = S.view;
  if (document.activeElement !== $('ruleAction')) fillRuleActions($('ruleAction'), $('ruleAction').value || 'direct');
  $('rulesCount').textContent = view.rules.length ? String(view.rules.length) : '';
  $('rulesEmpty').hidden = view.rules.length > 0;
  $('rulesHint').hidden = !view.rules.length;
  // Правила сейчас не действуют: VPN выключен, а при выключенном VPN они отключены.
  $('rulesOff').hidden = vpnOn() || view.settings.rulesWhenOff || !view.rules.length;
  $('rulesOff').textContent = 'VPN выключен, а правила при выключенном VPN отключены (меню ⋯) — сейчас все сайты идут напрямую.';

  const q = queryText().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const list = view.rules
    .filter((r) => !q || r.domain.includes(q) || toUnicode(r.domain).includes(q))
    .sort((a, b) => toUnicode(a.domain).localeCompare(toUnicode(b.domain), 'ru'));
  $('rulesList').replaceChildren(...list.map(ruleItem));
  if (q && !list.length && view.rules.length) {
    $('rulesList').append(el('li', { className: 'empty', textContent: 'Таких правил нет — нажмите «+», чтобы добавить' }));
  }
}

function ruleItem(r) {
  const shown = toUnicode(r.domain);
  const li = el('li', { className: `rule${r.enabled ? '' : ' off'}` });
  li.dataset.id = r.id;
  const name = el('span', { className: 'rule-main' }, el('span', { className: 'rule-domain', textContent: shown, title: shown }));
  const sub = [];
  if (!r.domain.includes('.')) sub.push('вся зона');
  if (shown !== r.domain) sub.push(r.domain);
  if (!r.enabled) sub.push('выключено');
  if (sub.length) name.append(el('span', { className: 'rule-sub', textContent: sub.join(' · ') }));

  // Главное в строке — куда идёт сайт: «без VPN», «VPN» (текущий сервер, как у остальных) или
  // флаг сервера; нажатие — выбор сервера. Включить и выключить правило — в меню «⋯» (переключатель
  // в строке путали с переключателем «через VPN / напрямую» на «Главной»).
  const target = el('button', { type: 'button', className: 'rule-target' });
  target.dataset.action = 'target';
  const server = r.action === 'proxy' && r.serverId ? serverById(r.serverId) : null;
  if (r.action === 'direct') {
    target.classList.add('direct');
    target.insertAdjacentHTML('beforeend', icon('direct'));
    target.append(el('span', { textContent: 'без VPN' }));
    target.title = 'Без VPN — выбрать другое';
  } else if (server) {
    target.append(flagEl(server), el('span', { className: 'target-name', textContent: splitFlag(server.name).name }));
    target.title = `Через ${server.name} — выбрать другое`;
  } else {
    target.classList.add('vpn');
    target.append(el('span', { textContent: 'VPN' }));
    target.title = 'Через VPN — текущий сервер, как у остальных сайтов. Выбрать другое';
  }
  target.setAttribute('aria-label', `${shown}: ${target.title}`);

  const del = el('button', { type: 'button', className: 'icon-btn danger', title: 'Удалить правило' });
  del.dataset.action = 'remove';
  del.setAttribute('aria-label', `Удалить правило для ${shown}`);
  setIcon(del, 'trash');
  const more = el('button', { type: 'button', className: 'icon-btn', title: 'Ещё' });
  more.dataset.action = 'more';
  more.setAttribute('aria-label', `Действия с правилом для ${shown}`);
  more.setAttribute('aria-haspopup', 'menu');
  setIcon(more, 'more');
  li.append(faviconEl(r.domain), name, target, del, more);
  return li;
}

// ruleMenu — «⋯» у правила: выключить без удаления (или включить), выбрать сервер.
function ruleMenu(anchor, r) {
  openMenu(anchor, [
    { label: r.enabled ? 'Отключить правило' : 'Включить правило', run: () => setEnabled(r, !r.enabled) },
    { label: 'Выбрать сервер…', run: () => openPicker({ kind: 'rule', ruleId: r.id }) },
  ]);
}

async function setEnabled(r, enabled) {
  const resp = await send({ type: 'updateRule', id: r.id, patch: { enabled } });
  if (!resp?.ok) toast(resp?.error?.message || 'Не получилось', 'error');
  else toast(enabled ? `Правило для ${toUnicode(r.domain)} включено` : `Правило для ${toUnicode(r.domain)} отключено: сайт открывается как остальные, пока его снова не включат`);
}

// summary — «Добавлено 2, обновлено 1, пропущено 1: не похоже на домен».
function summary(r, prefix = '') {
  const reasons = [...new Set(r.skipped.map((s) => `${s.text} — ${s.reason}`))];
  return `${prefix}добавлено ${r.added}, обновлено ${r.updated}, пропущено ${r.skipped.length}${reasons.length ? `: ${reasons.join('; ')}` : ''}`;
}

const parse = (v) => (v === 'direct' ? { action: 'direct', serverId: null } : { action: 'proxy', serverId: v.slice(6) || null });

$('ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('ruleInput').value.trim();
  if (!text) {
    $('ruleInput').focus();
    return;
  }
  const resp = await send({ type: 'addRules', text, ...parse($('ruleAction').value) });
  if (!resp?.ok) {
    toast(resp?.error?.message || 'Не получилось', 'error');
    return;
  }
  const r = resp.result;
  toast(summary(r).replace(/^д/, 'Д'), r.added + r.updated ? '' : 'error');
  if (r.added + r.updated) {
    $('ruleInput').value = '';
    grow();
    render();
  }
});

// Поле растёт, когда вставили несколько строк; Enter — добавить (Shift+Enter — новая строка).
function grow() {
  const t = $('ruleInput');
  t.rows = Math.min(4, Math.max(1, t.value.split('\n').length));
}
$('ruleInput').addEventListener('input', () => {
  grow();
  render();
});
$('ruleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('ruleForm').requestSubmit();
  }
});

$('rulesList').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const id = e.target.closest('li[data-id]')?.dataset.id;
  const r = S.view.rules.find((x) => x.id === id);
  if (!action || !r) return;
  let resp = { ok: true };
  if (action === 'more') ruleMenu(e.target.closest('button'), r);
  else if (action === 'remove') {
    resp = await send({ type: 'removeRules', ids: [id] });
    if (resp?.ok) toast(`Правило для ${toUnicode(r.domain)} удалено`);
  } else if (action === 'target') openPicker({ kind: 'rule', ruleId: id });
  if (!resp?.ok) toast(resp?.error?.message || 'Не получилось', 'error');
});

// --- меню «⋯»: наборы, импорт, экспорт, правила при выключенном VPN ---

$('rulesMore').addEventListener('click', () => {
  openMenu($('rulesMore'), [
    { label: 'Готовые наборы…', run: openSets },
    { label: 'Импорт правил…', run: importRules },
    { label: 'Экспорт правил', disabled: !S.view.rules.length, run: exportToFile },
    '-',
    { label: 'Правила работают, когда VPN выключен', checked: S.view.settings.rulesWhenOff, run: toggleWhenOff },
  ]);
});
setIcon($('rulesMore'), 'more');

async function toggleWhenOff() {
  const value = !S.view.settings.rulesWhenOff;
  const resp = await send({ type: 'setSetting', key: 'rulesWhenOff', value });
  if (!resp?.ok) toast(resp?.error?.message || 'Не получилось', 'error');
  else toast(value ? 'Правила работают и при выключенном VPN: сайты из правил «через VPN» идут через VPN, остальные — напрямую'
    : 'При выключенном VPN правила не действуют: все сайты идут напрямую');
}

function exportToFile() {
  // В окне расширения сохранение файла может закрыть окно — на развёрнутой странице надёжнее.
  if (!S.full) return openFull('rules', 'export');
  const data = JSON.stringify(exportRules(S.view.rules, S.view.servers), null, 2);
  const a = el('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `waysplit-rules-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Правил в файле: ${S.view.rules.length}. Секретов в нём нет.`);
}

function importRules() {
  // Окно выбора файла закрывает окно расширения — выбирать файл на развёрнутой странице.
  if (!S.full) return openFull('rules', 'import');
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
    const resp = await send({ type: 'importRules', data });
    toast(resp?.ok ? summary(resp.result, 'Импорт: ') : resp?.error?.message || 'Не получилось', resp?.ok ? '' : 'error');
  });
  input.click();
}

export const rulesActions = { export: exportToFile, import: importRules };

async function loadSets() {
  if (sets) return sets;
  try {
    sets = (await (await fetch(chrome.runtime.getURL('lib/domain-sets.json'))).json()).sets;
  } catch {
    sets = [];
  }
  return sets;
}

// openSets — «Готовые наборы»: сайты грузят видео и картинки с других доменов — набор добавит их все.
async function openSets() {
  const list = await loadSets();
  openScreen({
    title: 'Готовые наборы',
    build(sc) {
      sc.body.append(el('p', { className: 'hint', textContent: 'Сайты грузят видео, картинки и скрипты с других доменов, и правила на один домен мало. Набор добавит правила сразу для всех его доменов.' }),
        el('ul', { className: 'sets' }, ...list.map((set) => {
          const add = async (action) => {
            const resp = await send({ type: 'addRules', domains: set.domains, action, serverId: null });
            toast(resp?.ok ? summary(resp.result, `Набор «${set.name}» (${action === 'direct' ? 'без VPN' : 'через VPN'}): `) : resp?.error?.message || 'Не получилось', resp?.ok ? '' : 'error');
          };
          const button = (action, text, cls) => {
            const b = el('button', { type: 'button', className: cls, textContent: text, onclick: () => add(action) });
            b.dataset.act = action;
            return b;
          };
          const buttons = set.action
            ? [button(set.action, set.action === 'direct' ? 'Добавить: без VPN' : 'Добавить: через VPN', 'btn btn-small')]
            : [button('direct', 'Без VPN', 'ghost'), button('proxy', 'Через VPN', 'btn btn-small')];
          const li = el('li', { className: 'card set' }, el('p', { className: 'set-name', textContent: set.name }),
            el('p', { className: 'hint', textContent: set.note || set.domains.slice(0, 6).join(', ') }),
            el('p', { className: 'set-count', textContent: `доменов: ${set.domains.length}` }),
            el('div', { className: 'tools' }, ...buttons));
          li.dataset.set = set.id;
          return li;
        })));
    },
  });
}

defineTab('rules', render);
