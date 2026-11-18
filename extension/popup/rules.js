// Вкладка «Правила» (SPEC-POPUP.md): поле «Введите домен» — и добавление, и поиск по списку;
// рядом — что делать с сайтом (без VPN, через VPN как у остальных, конкретный сервер) и «+».
// Строка правила: значок сайта (только из памяти Chrome), домен, куда идёт (нажатие — выбор
// сервера), корзина, «⋯» (отключить без удаления / включить, «Домены сайта»). Под доменом —
// «+N доменов сайта»: домены, привязанные к правилу (lib/sitedomains.js). «Готовые наборы»,
// импорт, экспорт и «Правила работают, когда VPN выключен» — в меню «⋯» вкладки.

import { parseAction, send, shownName, splitFlag } from '../lib/format.js';
import { has, t } from '../lib/i18n.js';
import { toUnicode } from '../lib/domains.js';
import { exportRules } from '../lib/rules.js';
import { $, el, icon, openMenu, setIcon, toast } from './ui.js';
import { S, closeScreen, defineTab, openScreen, serverById, vpnOn } from './state.js';
import { openPicker } from './picker.js';
import { openFull } from './full.js';
import { openSiteSetting, permGranted, renderPermCards, requestPerm } from './siteperm.js';

let sets = null;

// fillRuleActions — «Без VPN», «Через VPN» (текущий сервер — как у остальных), серверы по имени.
function fillRuleActions(select, value) {
  const opt = (v, text) => el('option', { value: v, textContent: text });
  select.replaceChildren(opt('direct', t('action.direct')), opt('proxy:', t('action.proxy')),
    ...S.view.servers.map((s) => opt(`proxy:${s.id}`, shownName(s.name))));
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
  $('rulesOff').textContent = t('rules.off');
  renderPermCards();
  // Напоминание, почему российские сайты идут без VPN, хотя правила для них нет.
  $('rulesRu').hidden = !view.settings.ruDirect;
  $('rulesRu').title = t('rules.ru.title');

  const q = queryText().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const list = view.rules
    .filter((r) => !q || r.domain.includes(q) || toUnicode(r.domain).includes(q))
    .sort((a, b) => toUnicode(a.domain).localeCompare(toUnicode(b.domain), 'ru'));
  $('rulesList').replaceChildren(...list.map(ruleItem));
  if (q && !list.length && view.rules.length) {
    $('rulesList').append(el('li', { className: 'empty', textContent: t('rules.noMatch') }));
  }
}

function ruleItem(r) {
  const shown = toUnicode(r.domain);
  const li = el('li', { className: `rule${r.enabled ? '' : ' off'}` });
  li.dataset.id = r.id;
  const name = el('span', { className: 'rule-main' }, el('span', { className: 'rule-domain', textContent: shown, title: shown }));
  const sub = [];
  if (!r.domain.includes('.')) sub.push(t('rules.zone'));
  if (shown !== r.domain) sub.push(r.domain);
  if (r.siteDomains.length) sub.push(t('n.siteDomains', { n: r.siteDomains.length }));
  if (!r.enabled) sub.push(t('rules.sub.off'));
  if (sub.length) name.append(el('span', { className: 'rule-sub', textContent: sub.join(' · ') }));

  // Главное в строке — куда идёт сайт: «без VPN», «VPN» (текущий сервер, как у остальных) или
  // флаг сервера; нажатие — выбор сервера. Включить и выключить правило — в меню «⋯» (переключатель
  // в строке путали с переключателем «через VPN / без VPN» на «Главной»).
  const target = el('button', { type: 'button', className: 'rule-target' });
  target.dataset.action = 'target';
  const server = r.action === 'proxy' && r.serverId ? serverById(r.serverId) : null;
  if (r.action === 'direct') {
    target.classList.add('direct');
    target.append(el('span', { textContent: t('rules.label.direct') }));
    target.title = t('rules.target.direct');
  } else if (server) {
    // Свой сервер: код страны и имя, например «DE Франкфурт» (у сервера без флага — только имя).
    target.classList.add('server');
    target.append(el('span', { className: 'target-name', textContent: shownName(server.name) }));
    target.title = t('rules.target.server', { server: shownName(server.name) });
  } else {
    target.classList.add('vpn');
    target.append(el('span', { textContent: 'VPN' }));
    target.title = t('rules.target.vpn');
  }
  target.setAttribute('aria-label', `${shown}: ${target.title}`);

  const del = el('button', { type: 'button', className: 'icon-btn danger', title: t('rules.remove') });
  del.dataset.action = 'remove';
  del.setAttribute('aria-label', t('rules.remove.aria', { domain: shown }));
  setIcon(del, 'trash');
  const more = el('button', { type: 'button', className: 'icon-btn', title: t('common.more') });
  more.dataset.action = 'more';
  more.setAttribute('aria-label', t('rules.actions.aria', { domain: shown }));
  more.setAttribute('aria-haspopup', 'menu');
  setIcon(more, 'more');
  li.append(name, target, del, more);
  return li;
}

// ruleMenu — «⋯» у правила: выключить без удаления (или включить), выбрать сервер, домены сайта.
function ruleMenu(anchor, r) {
  openMenu(anchor, [
    { label: t(r.enabled ? 'rules.menu.disable' : 'home.warn.enableRule'), run: () => setEnabled(r, !r.enabled) },
    { label: t('rules.menu.server'), run: () => openPicker({ kind: 'rule', ruleId: r.id }) },
    ...(r.domain.includes('.') ? [{ label: r.siteDomains.length ? t('rules.menu.sdCount', { n: r.siteDomains.length }) : t('rules.menu.sd'), run: () => openSiteDomains(r.id) }] : []),
  ]);
}

// openSiteDomains — экран «Домены сайта»: что привязано к правилу, убрать любой домен, вернуть
// убранные. Привязанные домены — часть правила: идут так же, как оно, и удаляются вместе с ним.
function openSiteDomains(ruleId) {
  const rule = () => S.view.rules.find((x) => x.id === ruleId) || null;
  const first = rule();
  if (!first) return;
  const say = (resp, text, kind = '') => toast(resp?.ok ? text : resp?.error?.message || t('common.failed'), resp?.ok ? kind : 'error');
  openScreen({
    title: t('sd.title'),
    sub: toUnicode(first.domain),
    className: 'sd-screen',
    build(sc) {
      sc.how = el('p', { className: 'hint' });
      sc.auto = el('p', { className: 'hint sd-auto' });
      sc.allow = el('button', { type: 'button', className: 'btn', textContent: t('common.allow'), hidden: true });
      sc.allow.addEventListener('click', async () => {
        toast(t(await requestPerm() ? 'sd.perm.granted' : 'sd.perm.denied'), 'keep');
      });
      sc.list = el('ul', { className: 'sd-list' });
      sc.list.addEventListener('click', async (e) => {
        const domain = e.target.closest('button[data-domain]')?.dataset.domain;
        if (!domain) return;
        say(await send({ type: 'removeSiteDomain', id: ruleId, domain }), t('sd.removedOne', { domain: toUnicode(domain) }), 'keep');
      });
      sc.empty = el('p', { className: 'empty sd-empty' });
      sc.removed = el('p', { className: 'hint sd-removed' });
      sc.restore = el('button', { type: 'button', className: 'link', textContent: t('sd.restore') });
      sc.restore.addEventListener('click', async () => {
        say(await send({ type: 'restoreSiteDomains', id: ruleId }), t('sd.restored'));
      });
      // Автосбор выключен — не «включите в „Настройках“» словами, а кнопка, которая туда ведёт.
      sc.toSettings = el('button', { type: 'button', className: 'link', textContent: t('common.openSettings'), hidden: true });
      sc.toSettings.addEventListener('click', openSiteSetting);
      sc.body.append(sc.how, sc.list, sc.empty, el('div', { className: 'sd-auto-row' }, sc.auto, sc.allow, sc.toSettings), el('div', { className: 'sd-removed-row' }, sc.removed, sc.restore));
    },
    render(sc) {
      const r = rule();
      if (!r) { // правило удалили, пока экран открыт
        setTimeout(closeScreen, 0);
        return;
      }
      const proxy = r.action === 'proxy';
      const server = proxy && r.serverId ? serverById(r.serverId) : null;
      sc.setTitle(r.siteDomains.length ? t('sd.titleCount', { n: r.siteDomains.length }) : t('sd.title'));
      sc.how.textContent = t('sd.how', {
        domain: toUnicode(r.domain),
        route: proxy ? `${t('common.throughVpn')}${server ? ` (${splitFlag(server.name).name})` : ''}` : t('common.withoutVpn'),
      });
      sc.list.replaceChildren(...r.siteDomains.map((d) => {
        const shown = toUnicode(d);
        const del = el('button', { type: 'button', className: 'icon-btn danger', title: t('sd.remove') });
        del.dataset.domain = d;
        del.setAttribute('aria-label', t('sd.remove.aria', { domain: shown }));
        setIcon(del, 'trash');
        return el('li', { className: 'sd-item' }, el('span', { className: 'sd-name', textContent: shown, title: shown }), del);
      }));
      sc.empty.hidden = r.siteDomains.length > 0;
      sc.empty.textContent = t('sd.empty');
      const auto = S.view.settings.autoSiteDomains;
      sc.allow.hidden = !(proxy && auto && !permGranted());
      sc.toSettings.hidden = !(proxy && !auto);
      sc.auto.textContent = t(!proxy ? 'sd.auto.direct' : !auto ? 'sd.auto.off' : !permGranted() ? 'sd.auto.perm' : 'sd.auto.on');
      const gone = r.siteDomainsRemoved;
      sc.removed.parentElement.hidden = !gone.length;
      sc.removed.textContent = t('sd.removedList', { list: gone.map(toUnicode).join(', ') });
    },
  });
}

async function setEnabled(r, enabled) {
  const resp = await send({ type: 'updateRule', id: r.id, patch: { enabled } });
  if (!resp?.ok) toast(resp?.error?.message || t('common.failed'), 'error');
  else toast(t(enabled ? 'rules.enabled' : 'rules.disabled', { domain: toUnicode(r.domain) }), enabled ? '' : 'keep');
}

// keepIf — сообщение-итог остаётся до закрытия, если в нём есть пропущенные строки с причинами.
const keepIf = (result) => (result.skipped.length ? 'keep' : '');

// summary — «Добавлено 2, обновлено 1, пропущено 1: example — не похоже на домен». key — какая
// надпись: просто итог, итог импорта («Импорт: добавлено…») или набора («Набор «…»: добавлено…»).
function summary(r, key = 'rules.summary', params = {}) {
  const reasons = [...new Set(r.skipped.map((s) => `${s.text} — ${s.reason}`))];
  return `${t(key, { ...params, added: r.added, updated: r.updated, skipped: r.skipped.length })}${reasons.length ? `: ${reasons.join('; ')}` : ''}`;
}

$('ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('ruleInput').value.trim();
  if (!text) {
    $('ruleInput').focus();
    return;
  }
  const resp = await send({ type: 'addRules', text, ...parseAction($('ruleAction').value) });
  if (!resp?.ok) {
    toast(resp?.error?.message || t('common.failed'), 'error');
    return;
  }
  const r = resp.result;
  toast(summary(r), r.added + r.updated ? keepIf(r) : 'error');
  if (r.added + r.updated) {
    $('ruleInput').value = '';
    grow();
    render();
  }
});

// Поле растёт, когда вставили несколько строк; Enter — добавить (Shift+Enter — новая строка).
function grow() {
  const box = $('ruleInput');
  box.rows = Math.min(4, Math.max(1, box.value.split('\n').length));
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
    // Корзина удаляет сразу, без вопроса, — поэтому в сообщении «Вернуть»: правило возвращается
    // таким, каким было, вместе с доменами сайта.
    resp = await send({ type: 'removeRules', ids: [id] });
    if (resp?.ok) {
      toast(t('rules.removed', { domain: toUnicode(r.domain) }), '', { action: { label: t('common.undo'), run: async () => {
        const back = await send({ type: 'restoreRules', rules: [r] });
        const ok = back?.ok && back.result.restored > 0;
        toast(ok ? t('rules.restored', { domain: toUnicode(r.domain) }) : back?.error?.message || t('rules.restoreFailed', { domain: toUnicode(r.domain) }), ok ? '' : 'error');
      } } });
    }
  } else if (action === 'target') openPicker({ kind: 'rule', ruleId: id });
  if (!resp?.ok) toast(resp?.error?.message || t('common.failed'), 'error');
});

// --- меню «⋯»: наборы, импорт, экспорт, правила при выключенном VPN ---

$('rulesMore').addEventListener('click', () => {
  openMenu($('rulesMore'), [
    { label: t('rules.menu.sets'), run: openSets },
    { label: t('rules.menu.import'), run: importRules },
    { label: t('rules.menu.export'), disabled: !S.view.rules.length, run: exportToFile },
    '-',
    { label: t('settings.rulesWhenOff'), checked: S.view.settings.rulesWhenOff, run: toggleWhenOff },
  ]);
});
setIcon($('rulesMore'), 'more');
setIcon(document.querySelector('#ruleForm .plus'), 'plus');

async function toggleWhenOff() {
  const value = !S.view.settings.rulesWhenOff;
  const resp = await send({ type: 'setSetting', key: 'rulesWhenOff', value });
  if (!resp?.ok) toast(resp?.error?.message || t('common.failed'), 'error');
  else toast(t(value ? 'rules.whenOff.on' : 'rules.whenOff.off'));
}

function exportToFile() {
  // В окне расширения сохранение файла может закрыть окно — на развёрнутой странице надёжнее.
  if (!S.full) return openFull('rules', 'export');
  const data = JSON.stringify(exportRules(S.view.rules, S.view.servers), null, 2);
  const a = el('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `waysplit-rules-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(t('rules.exported', { n: S.view.rules.length }));
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
      toast(t('file.notJson'), 'error');
      return;
    }
    const resp = await send({ type: 'importRules', data });
    toast(resp?.ok ? summary(resp.result, 'rules.summary.import') : resp?.error?.message || t('common.failed'), resp?.ok ? keepIf(resp.result) : 'error');
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

// setText — название и пояснение набора. У наборов с названием сайта (YouTube, Discord) название —
// в самом файле наборов, оно одно на все языки; у остальных — в словаре: set.<id>.name, set.<id>.note.
const setText = (set, field) => (has(`set.${set.id}.${field}`) ? t(`set.${set.id}.${field}`) : set[field] || '');

// openSets — «Готовые наборы»: сайты грузят видео и картинки с других доменов — набор добавит их все.
async function openSets() {
  const list = await loadSets();
  openScreen({
    title: t('sets.title'),
    build(sc) {
      sc.body.append(el('p', { className: 'hint', textContent: t('sets.hint') }),
        el('ul', { className: 'sets' }, ...list.map((set) => {
          const add = async (action) => {
            const resp = await send({ type: 'addRules', domains: set.domains, action, serverId: null });
            toast(resp?.ok ? summary(resp.result, 'rules.summary.set', { name: setText(set, 'name'), route: t(action === 'direct' ? 'common.withoutVpn' : 'common.throughVpn') })
              : resp?.error?.message || t('common.failed'), resp?.ok ? keepIf(resp.result) : 'error');
          };
          const button = (action, text, cls) => {
            const b = el('button', { type: 'button', className: cls, textContent: text, onclick: () => add(action) });
            b.dataset.act = action;
            return b;
          };
          const buttons = set.action
            ? [button(set.action, t(set.action === 'direct' ? 'sets.add.direct' : 'sets.add.proxy'), 'btn')]
            : [button('direct', t('action.direct'), 'ghost'), button('proxy', t('action.proxy'), 'btn')];
          const li = el('li', { className: 'set' }, el('p', { className: 'set-name', textContent: setText(set, 'name') }),
            el('p', { className: 'hint', textContent: setText(set, 'note') || set.domains.slice(0, 6).join(', ') }),
            el('p', { className: 'set-count', textContent: t('sets.count', { n: set.domains.length }) }),
            el('div', { className: 'tools' }, ...buttons));
          li.dataset.set = set.id;
          return li;
        })));
    },
  });
}

defineTab('rules', render);
