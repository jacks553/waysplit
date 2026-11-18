// Вкладка «Серверы» (SPEC-POPUP.md): подписки и свои серверы группами, поиск, «Пинг всех»,
// «Самый быстрый», выбор нажатием на строку, действия — в меню «⋯» (пинг, переименовать,
// скопировать ссылку, выше / ниже, удалить), порядок — и перетаскиванием. Экраны: «Добавить»,
// «Подписка» (сведения, обновить, проверить, переименовать, удалить).

import { addSummary, fmtBytes, fmtDate, maskUrl, matches, send, subError } from '../lib/format.js';
import { fill, slot, t } from '../lib/i18n.js';
import { $, ask, el, openMenu, setIcon, toast } from './ui.js';
import { S, defineTab, isFav, openScreen, closeScreen, serverById } from './state.js';
import { groupsOf, serverItem, toggleFavorite } from './picker.js';

let editing = null; // id сервера, у которого сейчас меняют имя
let dragId = null;

const subOf = (id) => S.view.subscriptions.find((x) => x.id === id) || null;
const subServers = (id) => S.view.servers.filter((s) => s.subscriptionId === id);

// subLine — короткая строка подписки в списке серверов: «23,4 из 200 ГБ, до 31.01.2027» — чтобы дата не
// обрезалась. Число серверов в ней не пишется (оно видно по списку); данных о трафике и сроке нет —
// остаётся число серверов.
function subLine(sub) {
  const info = sub.info;
  const used = info ? info.upload + info.download : 0;
  const GB = 1 << 30;
  const num = (n) => (n / GB).toFixed(1).replace(/\.0$/, '').replace('.', t('fmt.decimal'));
  const parts = [];
  if (info?.total > 0) parts.push(info.total >= GB ? t('sub.line.gbOf', { used: num(used), total: num(info.total) }) : t('sub.line.of', { used: fmtBytes(used), total: fmtBytes(info.total) }));
  else if (used > 0) parts.push(fmtBytes(used));
  if (info?.expire > 0) parts.push(t(info.expire * 1000 < Date.now() ? 'sub.fact.expired' : 'sub.fact.until', { date: fmtDate(info.expire * 1000, false) }));
  return parts.length ? parts.join(', ') : t('n.servers', { n: subServers(sub.id).length });
}

function render() {
  if (editing !== null) return; // не мешать вводу имени
  const view = S.view;
  const q = $('srvSearch').value;
  const found = view.servers.filter((s) => matches(s, q));
  const filtered = found.length !== view.servers.length;
  $('srvCount').textContent = view.servers.length ? String(view.servers.length) : '';
  $('srvEmpty').hidden = view.servers.length > 0 || view.subscriptions.length > 0;
  $('srvHint').hidden = !view.servers.length;
  $('pingAll').disabled = $('fastest').disabled = !view.servers.length;

  const parts = [];
  const groups = groupsOf(found, { favorites: false });
  // Подписка без серверов (или все отфильтрованы поиском) — заголовок всё равно нужен.
  for (const sub of view.subscriptions) {
    if (q || groups.some((g) => g.key === sub.id)) continue;
    const own = groups.findIndex((g) => g.key === 'own');
    groups.splice(own < 0 ? groups.length : own, 0, { key: sub.id, title: sub.name, sub, list: [] });
  }
  for (const g of groups) {
    // Заголовок группы: название, число серверов, справа пунктир до края (его рисуют стили).
    parts.push(g.sub ? subHead(g.sub) : el('h3', { className: 'group-title' },
      el('span', { textContent: g.title }), el('span', { className: 'count', textContent: String(g.list.length) })));
    const ul = el('ul', { className: 'srv-list' }, ...g.list.map((s) => {
      const li = serverItem(s, { selected: s.id === view.currentServerId, full: true, more: true });
      li.dataset.group = g.key;
      li.draggable = !filtered;
      return li;
    }));
    parts.push(ul);
  }
  if (q && !found.length) parts.push(el('p', { className: 'empty', textContent: t('common.nothingFound') }));
  $('srvGroups').replaceChildren(...parts);
}

// subHead — заголовок группы подписки: имя, факты, сообщение провайдера, ошибка, «⋯».
function subHead(sub) {
  const more = el('button', { type: 'button', className: 'icon-btn more', title: t('sub.actions') });
  more.dataset.action = 'subMore';
  more.setAttribute('aria-label', t('sub.actions.aria', { name: sub.name }));
  more.setAttribute('aria-haspopup', 'menu');
  setIcon(more, 'more');
  const open = el('button', { type: 'button', className: 'sub-open', title: t('sub.details') },
    el('span', { className: 'sub-name', textContent: sub.name }),
    el('span', { className: 'sub-facts', textContent: subLine(sub) }));
  open.dataset.action = 'subOpen';
  const head = el('div', { className: 'sub-head' }, open, more);
  head.dataset.sub = sub.id;
  const notes = [];
  if (sub.lastError) notes.push(el('p', { className: 'sub-note error', textContent: t('sub.failed', { error: subError(sub) }) }));
  if (sub.announce) notes.push(el('p', { className: 'sub-note', textContent: t('sub.announce', { text: sub.announce }) }));
  return el('div', { className: 'sub-block' }, head, ...notes);
}

// --- действия ---

async function run(msg, okText) {
  const resp = await send(msg);
  if (!resp?.ok) {
    toast(resp?.error?.message || t('common.failed'), 'error');
    return null;
  }
  if (okText) toast(typeof okText === 'function' ? okText(resp.result) : okText);
  return resp.result ?? true;
}

function serverMenu(anchor, s) {
  const ids = S.view.servers.map((x) => x.id);
  const group = anchor.closest('li').dataset.group;
  const mates = [...$('srvGroups').querySelectorAll(`li[data-group="${group}"]`)].map((li) => li.dataset.id);
  const at = mates.indexOf(s.id);
  const filtered = $('srvSearch').value.trim() !== '';
  openMenu(anchor, [
    { label: t('servers.menu.ping'), run: () => run({ type: 'ping', ids: [s.id] }, (r) => (r[0]?.ms ? t('servers.ping.ok', { name: s.name, ms: r[0].ms }) : t('servers.ping.failed', { name: s.name, error: r[0]?.error || '' }))) },
    { label: t('common.rename'), run: () => startRename(s.id) },
    { label: t('servers.menu.copy'), run: () => copyLink(s) },
    { label: t(isFav(s) ? 'fav.remove' : 'fav.add'), run: () => toggleFavorite(s.id) },
    '-',
    { label: t('servers.menu.up'), disabled: filtered || at <= 0, run: () => move(ids, mates, at, at - 1) },
    { label: t('servers.menu.down'), disabled: filtered || at < 0 || at >= mates.length - 1, run: () => move(ids, mates, at, at + 1) },
    '-',
    { label: t('common.delete'), danger: true, run: () => removeServer(s) },
  ]);
}

async function copyLink(s) {
  try {
    await navigator.clipboard.writeText(s.link);
    toast(t('servers.copied'), 'keep');
  } catch (err) {
    toast(t('common.copyFailed', { error: err.message }), 'error');
  }
}

async function removeServer(s) {
  if (!(await ask({ title: t('servers.remove.title', { name: s.name }), text: t('servers.remove.text'), ok: t('common.delete'), danger: true }))) return;
  await run({ type: 'remove', id: s.id }, (r) => (r.rulesMoved ? t('servers.removedMoved', { name: s.name, n: r.rulesMoved }) : t('servers.removed', { name: s.name })));
}

// move — порядок внутри группы: группа — это места её серверов в общем списке.
function move(ids, mates, from, to) {
  const order = [...mates];
  const [x] = order.splice(from, 1);
  order.splice(to, 0, x);
  reorderGroup(ids, mates, order, x);
}

async function reorderGroup(ids, mates, order, focusId) {
  const slots = new Set(mates);
  let k = 0;
  const next = ids.map((id) => (slots.has(id) ? order[k++] : id));
  S.view.servers = next.map((id) => serverById(id)); // сразу показать, не дожидаясь хранилища
  render();
  $('srvGroups').querySelector(`li[data-id="${focusId}"]`)?.focus();
  await run({ type: 'reorder', ids: next });
}

// Переименование прямо в строке: Enter — сохранить, Esc — отменить, уход с поля — сохранить.
function startRename(id) {
  const li = $('srvGroups').querySelector(`li[data-id="${id}"]`);
  const s = serverById(id);
  if (!li || !s) return;
  editing = id;
  li.draggable = false;
  const input = el('input', { className: 'rename', value: s.name, maxLength: 100 });
  input.setAttribute('aria-label', t('servers.rename.aria'));
  li.querySelector('.srv-name').replaceWith(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    if (editing !== id) return;
    editing = null;
    const name = input.value.trim();
    if (save && name && name !== s.name) await run({ type: 'rename', id, name }, t('servers.renamed'));
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Esc здесь — отмена, а не «назад»
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

$('srvGroups').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const sub = subOf(e.target.closest('[data-sub]')?.dataset.sub);
  if (action === 'subOpen' && sub) return openSub(sub.id);
  if (action === 'subMore' && sub) return subMenu(e.target.closest('button'), sub);
  const li = e.target.closest('li[data-id]');
  if (!li || e.target.closest('input')) return;
  const s = serverById(li.dataset.id);
  if (!s) return;
  if (action === 'star') toggleFavorite(s.id);
  else if (action === 'more') serverMenu(e.target.closest('button'), s);
  else if (s.id !== S.view.currentServerId) run({ type: 'select', id: s.id }, t('servers.selected', { name: s.name }));
});
$('srvGroups').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li[data-id]')) {
    e.preventDefault();
    e.target.click();
  }
});

// Перетаскивание — внутри своей группы.
$('srvGroups').addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li || editing !== null) {
    e.preventDefault();
    return;
  }
  dragId = li.dataset.id;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
$('srvGroups').addEventListener('dragover', (e) => {
  const li = e.target.closest('li[data-id]');
  const from = dragId && $('srvGroups').querySelector(`li[data-id="${dragId}"]`);
  if (!from || !li || li.dataset.group !== from.dataset.group) return;
  e.preventDefault();
  clearDropMarks();
  if (li.dataset.id === dragId) return;
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
$('srvGroups').addEventListener('drop', (e) => {
  e.preventDefault();
  const li = e.target.closest('li[data-id]');
  const before = li?.classList.contains('drop-before');
  clearDropMarks();
  if (!dragId || !li || li.dataset.id === dragId) return;
  const group = li.dataset.group;
  const mates = [...$('srvGroups').querySelectorAll(`li[data-group="${group}"]`)].map((x) => x.dataset.id);
  const order = mates.filter((id) => id !== dragId);
  let at = order.indexOf(li.dataset.id);
  if (!before) at++;
  order.splice(at, 0, dragId);
  reorderGroup(S.view.servers.map((s) => s.id), mates, order, dragId);
});
$('srvGroups').addEventListener('dragend', () => {
  dragId = null;
  clearDropMarks();
  $('srvGroups').querySelector('.dragging')?.classList.remove('dragging');
});
function clearDropMarks() {
  $('srvGroups').querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
}

$('srvSearch').addEventListener('input', render);

// Пусто: под текстом — такая же кнопка «Добавить», как в заголовке.
$('srvAddEmpty').addEventListener('click', () => $('srvAdd').click());

$('pingAll').addEventListener('click', async () => {
  $('pingAll').disabled = true;
  toast(t(S.view.enabled ? 'servers.pinging' : 'servers.pingingOff'));
  await run({ type: 'ping' }, (r) => t('servers.pinged', { ok: r.filter((x) => x.ms).length, all: r.length }));
  $('pingAll').disabled = false;
});

$('fastest').addEventListener('click', async () => {
  $('fastest').disabled = true;
  toast(t('servers.fastest.run'));
  const done = await run({ type: 'fastest' }, (r) => t('servers.fastest.done', { name: serverById(r.id)?.name || r.id, ms: r.ms }));
  $('fastest').disabled = false;
  // Список сразу прокручивается к выбранной строке (она залита), без анимации. Строка перерисовывается,
  // когда из хранилища приходит новый текущий сервер, — поэтому чуть позже ответа.
  if (done) setTimeout(() => document.querySelector('#srvGroups .srv[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' }), 300);
});

// --- экран «Добавить» ---

function openAdd() {
  openScreen({
    title: t('add.title'),
    className: 'add-screen',
    build(sc) {
      const links = el('textarea', { id: 'addLinks', rows: 6, spellcheck: false, placeholder: t('add.placeholder') });
      links.setAttribute('aria-label', t('add.aria'));
      const btn = el('button', { id: 'addBtn', type: 'submit', className: 'btn', textContent: t('common.add') });
      const out = el('p', { id: 'addResult', className: 'add-result', hidden: true });
      const form = el('form', { className: 'add-form' },
        el('label', { className: 'row-label', textContent: t('add.label') }),
        links, btn, out,
        el('p', { className: 'hint', textContent: t('add.hint') }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = links.value.trim();
        if (!text) return;
        btn.disabled = true;
        out.hidden = false;
        out.dataset.kind = '';
        out.textContent = t('add.parsing');
        const resp = await send({ type: 'addLinks', text });
        btn.disabled = false;
        if (!resp?.ok) {
          out.dataset.kind = 'error';
          out.textContent = resp?.error?.message || t('common.failed');
          return;
        }
        const ok = resp.result.added + resp.result.subscriptions.length;
        out.textContent = addSummary(resp.result);
        out.dataset.kind = ok ? '' : 'error';
        if (ok) links.value = '';
      });
      sc.body.append(form);
      queueMicrotask(() => links.focus());
    },
  });
}

$('srvAdd').addEventListener('click', openAdd);

// --- подписка: меню и экран ---

// Форматы подписки не списком ссылок (SPEC-SUBS): компаньон переводит их серверы в ссылки.
const SUB_FORMATS = { 'xray-json': 'Xray JSON', 'singbox-json': 'sing-box JSON', 'clash-yaml': 'Clash / Mihomo YAML' };

function subMenu(anchor, sub) {
  openMenu(anchor, [
    { label: t('sub.update'), run: () => updateSub(sub) },
    { label: t('sub.menu.details'), run: () => openSub(sub.id) },
    { label: t('common.rename'), run: () => renameSub(sub) },
    '-',
    { label: t('common.delete'), danger: true, run: () => removeSub(sub) },
  ]);
}

async function updateSub(sub) {
  toast(t('sub.updating', { name: sub.name }));
  // Итог одной строкой: основное, потом уточнения — через «; » и в скобках.
  await run({ type: 'updateSubscription', id: sub.id }, (r) => t('sub.updated', { name: r.name, added: r.added, removed: r.removed, kept: r.kept, skipped: r.skipped.length })
    + (r.rulesMoved ? `; ${t('sub.rulesMoved', { n: r.rulesMoved })}` : '')
    + (r.viaVpn ? ` (${t('sub.updated.viaVpn')})` : '')
    + (r.device ? `; ${t('sub.updated.device')}` : ''));
}

async function renameSub(sub) {
  const name = await ask({ title: t('sub.rename.title'), value: sub.name, ok: t('common.save') });
  if (name !== null && name.trim() && name.trim() !== sub.name) await run({ type: 'renameSubscription', id: sub.id, name }, t('sub.renamed'));
}

async function removeSub(sub) {
  const count = subServers(sub.id).length;
  if (!(await ask({ title: t('sub.remove.title', { name: sub.name }), text: t('sub.remove.text', { n: count }), ok: t('common.delete'), danger: true }))) return false;
  const r = await run({ type: 'removeSubscription', id: sub.id }, (x) => t('sub.removed', { n: x.removed }) + (x.rulesMoved ? `; ${t('sub.rulesMoved', { n: x.rulesMoved })}` : ''));
  return !!r;
}

function fact(name, value, cls = '') {
  return [el('dt', { textContent: name }), el('dd', { className: cls, textContent: value, title: cls === 'url' ? value : '' })];
}

// openSub — «сведения о подписке»: всё о ней, действия и проверка (SPEC-SUBS.md, шаг 1).
function openSub(id) {
  openScreen({
    title: subOf(id)?.name || t('sub.title'),
    className: 'sub-screen',
    build(sc) {
      const facts = el('dl', { id: 'subFacts', className: 'facts' });
      const notes = el('div', { className: 'sub-notes' });
      const actions = el('div', { className: 'tools' },
        el('button', { type: 'button', className: 'btn', textContent: t('sub.update'), onclick: () => updateSub(subOf(id)) }),
        el('button', { type: 'button', className: 'ghost', textContent: t('common.rename'), onclick: () => renameSub(subOf(id)) }),
        el('button', { type: 'button', className: 'ghost danger', textContent: t('common.delete'), onclick: async () => { if (await removeSub(subOf(id))) closeScreen(); } }));
      // Проверка подписки: отчёт компаньона без секретов.
      const device = el('input', { id: 'subCheckDevice', type: 'checkbox' });
      // Залитая кнопка на экране одна — «Обновить»; проверка — контурная.
      const runBtn = el('button', { id: 'subCheckRun', type: 'button', className: 'ghost', textContent: t('sub.check.run') });
      const copyBtn = el('button', { id: 'subCheckCopy', type: 'button', className: 'ghost', textContent: t('sub.check.copy'), hidden: true });
      const state = el('p', { id: 'subCheckState', className: 'note', hidden: true });
      const report = el('pre', { id: 'subCheckReport', className: 'log report', hidden: true, tabIndex: 0 });
      const say = (text, kind = '') => {
        state.hidden = !text;
        state.textContent = text;
        state.dataset.kind = kind;
      };
      runBtn.addEventListener('click', async () => {
        if (device.checked && !(await ask({ title: t('sub.check.ask.title'), text: t('sub.check.ask.text'), ok: t('sub.check.ask.ok') }))) return;
        runBtn.disabled = true;
        report.hidden = copyBtn.hidden = true;
        say(t('sub.check.running'));
        const resp = await send({ type: 'checkSubscription', id, device: device.checked });
        runBtn.disabled = false;
        if (!resp?.ok) {
          say(resp?.error?.message || t('sub.check.failed'), 'error');
          return;
        }
        const r = resp.result;
        // Сам отчёт пока составляет компаньон и только по-русски: в окне на другом языке — пометка
        // об этом (в русском словаре она пустая).
        say([`${t('sub.check.done')}${r.device ? `, ${t('sub.check.done.device')}` : ''}${r.viaVpn ? ` (${t('sub.check.done.viaVpn')})` : ''}.`,
          t('sub.check.done.summary'), t('sub.check.reportLang')].filter(Boolean).join(' '));
        report.textContent = r.report;
        report.hidden = copyBtn.hidden = false;
      });
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(report.textContent);
          say(t('sub.check.copied'));
        } catch (e) {
          say(t('common.copyFailed', { error: e.message }), 'error');
        }
      });
      const check = el('fieldset', { className: 'group' }, el('legend', { textContent: t('sub.check.legend') }),
        el('p', { className: 'hint', textContent: t('sub.check.hint') }),
        el('label', { className: 'check' }, device, fill(el('span', {}, slot('strong', el('b', { textContent: t('sub.check.device.strong') }))), t('sub.check.device'))),
        el('div', { className: 'tools' }, runBtn, copyBtn), state, report);
      sc.body.append(facts, notes, actions, check);
      sc.facts = facts;
      sc.notes = notes;
    },
    render(sc) {
      const sub = subOf(id);
      if (!sub) { // подписку удалили
        queueMicrotask(closeScreen);
        return;
      }
      sc.setTitle(sub.name);
      sc.setSub(t('n.servers', { n: subServers(id).length }));
      const info = sub.info;
      const rows = [
        ...fact(t('sub.f.url'), maskUrl(sub.url), 'url'),
        ...fact(t('sub.f.updated'), sub.updatedAt ? fmtDate(sub.updatedAt) : t('sub.f.never')),
        ...fact(t('sub.f.auto'), t('sub.f.every', { h: sub.intervalHours })),
      ];
      if (info?.total > 0) rows.push(...fact(t('sub.f.traffic'), t('sub.f.trafficOf', { used: fmtBytes(info.upload + info.download), total: fmtBytes(info.total) })));
      else if (info && info.upload + info.download > 0) rows.push(...fact(t('sub.f.traffic'), fmtBytes(info.upload + info.download)));
      if (info?.expire > 0) {
        const expired = info.expire * 1000 < Date.now();
        rows.push(...fact(t('sub.f.term'), t(expired ? 'sub.f.expired' : 'sub.fact.until', { date: fmtDate(info.expire * 1000, false) }), expired ? 'error' : ''));
      }
      if (SUB_FORMATS[sub.format]) rows.push(...fact(t('sub.f.format'), SUB_FORMATS[sub.format]));
      if (sub.viaVpn) rows.push(...fact(t('sub.f.fetched'), t('sub.f.viaVpn')));
      if (sub.device) rows.push(...fact(t('sub.f.device'), t('sub.f.deviceText')));
      sc.facts.replaceChildren(...rows);
      const notes = [];
      if (sub.announce) notes.push(el('p', { className: 'sub-note', textContent: t('sub.announce', { text: sub.announce }) }));
      if (sub.lastError) notes.push(el('p', { className: 'sub-note error', textContent: t('sub.failed', { error: subError(sub) }) }));
      sc.notes.replaceChildren(...notes);
    },
  });
}

defineTab('servers', render);
