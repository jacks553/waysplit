// Вкладка «Серверы» (SPEC-POPUP.md): подписки и свои серверы группами, поиск, «Пинг всех»,
// «Самый быстрый», выбор нажатием на строку, действия — в меню «⋯» (пинг, переименовать,
// скопировать ссылку, выше / ниже, удалить), порядок — и перетаскиванием. Экраны: «Добавить»,
// «Подписка» (сведения, обновить, проверить, переименовать, удалить).

import { SERVER_WORDS, addSummary, fmtBytes, fmtDate, maskUrl, matches, plural, send } from '../lib/format.js';
import { $, ask, el, openMenu, setIcon, toast } from './ui.js';
import { S, defineTab, isFav, openScreen, closeScreen, serverById } from './state.js';
import { groupsOf, serverItem, toggleFavorite } from './picker.js';

let editing = null; // id сервера, у которого сейчас меняют имя
let dragId = null;

const subOf = (id) => S.view.subscriptions.find((x) => x.id === id) || null;
const subServers = (id) => S.view.servers.filter((s) => s.subscriptionId === id);

// subFacts — коротко о подписке: серверов, трафик, срок.
function subFacts(sub, long = false) {
  const facts = [plural(subServers(sub.id).length, SERVER_WORDS)];
  const info = sub.info;
  if (info?.total > 0) facts.push(`трафик ${fmtBytes(info.upload + info.download)} из ${fmtBytes(info.total)}`);
  else if (info && info.upload + info.download > 0) facts.push(`трафик ${fmtBytes(info.upload + info.download)}`);
  if (info?.expire > 0) facts.push(`${info.expire * 1000 < Date.now() ? 'срок истёк' : 'до'} ${fmtDate(info.expire * 1000, false)}`);
  if (sub.device) facts.push('привязана к этому компьютеру');
  if (long && sub.updatedAt) facts.push(`обновлена ${fmtDate(sub.updatedAt)}`);
  return facts.join(' · ');
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
    parts.push(g.sub ? subHead(g.sub) : el('h3', { className: 'group-title', textContent: `${g.title} · ${g.list.length}` }));
    const ul = el('ul', { className: 'srv-list' }, ...g.list.map((s) => {
      const li = serverItem(s, { selected: s.id === view.currentServerId, full: true, more: true });
      li.dataset.group = g.key;
      li.draggable = !filtered;
      return li;
    }));
    parts.push(ul);
  }
  if (q && !found.length) parts.push(el('p', { className: 'empty', textContent: 'Ничего не найдено' }));
  $('srvGroups').replaceChildren(...parts);
}

// subHead — заголовок группы подписки: имя, факты, сообщение провайдера, ошибка, «⋯».
function subHead(sub) {
  const more = el('button', { type: 'button', className: 'icon-btn more', title: 'Действия с подпиской' });
  more.dataset.action = 'subMore';
  more.setAttribute('aria-label', `Действия с подпиской ${sub.name}`);
  more.setAttribute('aria-haspopup', 'menu');
  setIcon(more, 'more');
  const open = el('button', { type: 'button', className: 'sub-open', title: 'Сведения о подписке' },
    el('span', { className: 'sub-name', textContent: sub.name }),
    el('span', { className: 'sub-facts', textContent: subFacts(sub) }));
  open.dataset.action = 'subOpen';
  const head = el('div', { className: 'sub-head' }, open, more);
  head.dataset.sub = sub.id;
  const notes = [];
  if (sub.lastError) notes.push(el('p', { className: 'sub-note error', textContent: `Не обновилась: ${sub.lastError}` }));
  if (sub.announce) notes.push(el('p', { className: 'sub-note', textContent: `Сообщение провайдера: ${sub.announce}` }));
  return el('div', { className: 'sub-block' }, head, ...notes);
}

// --- действия ---

async function run(msg, okText) {
  const resp = await send(msg);
  if (!resp?.ok) {
    toast(resp?.error?.message || 'Не получилось', 'error');
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
    { label: 'Проверить пинг', run: () => run({ type: 'ping', ids: [s.id] }, (r) => (r[0]?.ms ? `${s.name}: ${r[0].ms} мс` : `${s.name}: нет ответа — ${r[0]?.error || ''}`)) },
    { label: 'Переименовать', run: () => startRename(s.id) },
    { label: 'Скопировать ссылку', run: () => copyLink(s) },
    { label: isFav(s) ? 'Убрать из избранного' : 'В избранное', run: () => toggleFavorite(s.id) },
    '-',
    { label: 'Выше', disabled: filtered || at <= 0, run: () => move(ids, mates, at, at - 1) },
    { label: 'Ниже', disabled: filtered || at < 0 || at >= mates.length - 1, run: () => move(ids, mates, at, at + 1) },
    '-',
    { label: 'Удалить', danger: true, run: () => removeServer(s) },
  ]);
}

async function copyLink(s) {
  try {
    await navigator.clipboard.writeText(s.link);
    toast('Ссылка скопирована. В ней секреты сервера — не пересылайте её чужим.', 'keep');
  } catch (err) {
    toast(`Не удалось скопировать: ${err.message}`, 'error');
  }
}

async function removeServer(s) {
  if (!(await ask({ title: `Удалить сервер «${s.name}»?`, text: 'Правила, которые шли через него, перейдут на текущий сервер.', ok: 'Удалить', danger: true }))) return;
  await run({ type: 'remove', id: s.id }, (r) => `Сервер «${s.name}» удалён.${r.rulesMoved ? ` Правил, переключённых на текущий сервер: ${r.rulesMoved}.` : ''}`);
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
  input.setAttribute('aria-label', 'Новое имя сервера');
  li.querySelector('.srv-name').replaceWith(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    if (editing !== id) return;
    editing = null;
    const name = input.value.trim();
    if (save && name && name !== s.name) await run({ type: 'rename', id, name }, 'Имя сохранено');
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
  else if (s.id !== S.view.currentServerId) run({ type: 'select', id: s.id }, `Текущий сервер: ${s.name}`);
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

$('pingAll').addEventListener('click', async () => {
  $('pingAll').disabled = true;
  toast(S.view.enabled ? 'Проверяю пинг всех серверов…' : 'Проверяю пинг всех серверов (ядро запускается на время проверки)…');
  await run({ type: 'ping' }, (r) => `Ответили ${r.filter((x) => x.ms).length} из ${r.length}`);
  $('pingAll').disabled = false;
});

$('fastest').addEventListener('click', async () => {
  $('fastest').disabled = true;
  toast('Проверяю пинг и выбираю самый быстрый…');
  await run({ type: 'fastest' }, (r) => `Выбран самый быстрый: ${serverById(r.id)?.name || r.id} (${r.ms} мс)`);
  $('fastest').disabled = false;
});

// --- экран «Добавить» ---

function openAdd() {
  openScreen({
    title: 'Добавить серверы',
    className: 'add-screen',
    build(sc) {
      const links = el('textarea', { id: 'addLinks', rows: 6, spellcheck: false, placeholder: 'vless://…\nhysteria2://…\nhttps://… — подписка' });
      links.setAttribute('aria-label', 'Ссылки серверов или адрес подписки');
      const btn = el('button', { id: 'addBtn', type: 'submit', className: 'btn', textContent: 'Добавить' });
      const out = el('p', { id: 'addResult', className: 'add-result', hidden: true });
      const form = el('form', { className: 'add-form' },
        el('label', { className: 'row-label', textContent: 'Вставьте ссылки серверов или адрес подписки — можно несколько, по одной на строку' }),
        links, btn, out,
        el('p', { className: 'hint', textContent: 'Подойдут ссылки vless:// и hysteria2:// и адрес подписки https:// от вашего провайдера — в любом формате: список ссылок (в том числе base64), Xray JSON, sing-box JSON, Clash / Mihomo YAML.' }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = links.value.trim();
        if (!text) return;
        btn.disabled = true;
        out.hidden = false;
        out.dataset.kind = '';
        out.textContent = 'Разбираю ссылки…';
        const resp = await send({ type: 'addLinks', text });
        btn.disabled = false;
        if (!resp?.ok) {
          out.dataset.kind = 'error';
          out.textContent = resp?.error?.message || 'Не получилось';
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
    { label: 'Обновить', run: () => updateSub(sub) },
    { label: 'Сведения и проверка', run: () => openSub(sub.id) },
    { label: 'Переименовать', run: () => renameSub(sub) },
    '-',
    { label: 'Удалить', danger: true, run: () => removeSub(sub) },
  ]);
}

async function updateSub(sub) {
  toast(`Обновляю подписку «${sub.name}»…`);
  await run({ type: 'updateSubscription', id: sub.id }, (r) => `Подписка «${r.name}» обновлена: новых ${r.added}, удалено ${r.removed}, без изменений ${r.kept}, пропущено ${r.skipped.length}${r.rulesMoved ? `; правил переключено на текущий сервер: ${r.rulesMoved}` : ''}${r.viaVpn ? ' (напрямую не скачалась — скачана через VPN)' : ''}${r.device ? '; подписка привязана к этому компьютеру как устройство' : ''}`);
}

async function renameSub(sub) {
  const name = await ask({ title: 'Имя подписки', value: sub.name, ok: 'Сохранить' });
  if (name !== null && name.trim() && name.trim() !== sub.name) await run({ type: 'renameSubscription', id: sub.id, name }, 'Имя подписки сохранено');
}

async function removeSub(sub) {
  const count = subServers(sub.id).length;
  if (!(await ask({ title: `Удалить подписку «${sub.name}»?`, text: `Вместе с ней удалятся её серверы (${count}).`, ok: 'Удалить', danger: true }))) return false;
  const r = await run({ type: 'removeSubscription', id: sub.id }, (x) => `Подписка удалена, серверов удалено: ${x.removed}${x.rulesMoved ? `; правил переключено на текущий сервер: ${x.rulesMoved}` : ''}`);
  return !!r;
}

function fact(name, value, cls = '') {
  return [el('dt', { textContent: name }), el('dd', { className: cls, textContent: value })];
}

// openSub — «сведения о подписке»: всё о ней, действия и проверка (SPEC-SUBS.md, шаг 1).
function openSub(id) {
  openScreen({
    title: subOf(id)?.name || 'Подписка',
    className: 'sub-screen',
    build(sc) {
      const facts = el('dl', { id: 'subFacts', className: 'facts' });
      const notes = el('div', { className: 'sub-notes' });
      const actions = el('div', { className: 'tools' },
        el('button', { type: 'button', className: 'btn btn-small', textContent: 'Обновить', onclick: () => updateSub(subOf(id)) }),
        el('button', { type: 'button', className: 'ghost', textContent: 'Переименовать', onclick: () => renameSub(subOf(id)) }),
        el('button', { type: 'button', className: 'ghost danger', textContent: 'Удалить', onclick: async () => { if (await removeSub(subOf(id))) closeScreen(); } }));
      // Проверка подписки: отчёт компаньона без секретов.
      const device = el('input', { id: 'subCheckDevice', type: 'checkbox' });
      // Залитая кнопка на экране одна — «Обновить»; проверка — контурная.
      const runBtn = el('button', { id: 'subCheckRun', type: 'button', className: 'ghost', textContent: 'Проверить подписку' });
      const copyBtn = el('button', { id: 'subCheckCopy', type: 'button', className: 'ghost', textContent: 'Скопировать отчёт', hidden: true });
      const state = el('p', { id: 'subCheckState', className: 'note', hidden: true });
      const report = el('pre', { id: 'subCheckReport', className: 'log report', hidden: true });
      const say = (text, kind = '') => {
        state.hidden = !text;
        state.textContent = text;
        state.dataset.kind = kind;
      };
      runBtn.addEventListener('click', async () => {
        if (device.checked && !(await ask({ title: 'Отправить провайдеру идентификатор устройства?', text: 'Провайдер может засчитать этот компьютер как ещё одно устройство.', ok: 'Отправить' }))) return;
        runBtn.disabled = true;
        report.hidden = copyBtn.hidden = true;
        say('Проверяю: подписка скачивается разными способами, это до минуты…');
        const resp = await send({ type: 'checkSubscription', id, device: device.checked });
        runBtn.disabled = false;
        if (!resp?.ok) {
          say(resp?.error?.message || 'Проверить не получилось', 'error');
          return;
        }
        const r = resp.result;
        say(`Готово${r.device ? ', с идентификатором устройства' : ''}${r.viaVpn ? ' (напрямую сервер подписки не ответил — проверено через VPN)' : ''}. Итог — в начале отчёта.`);
        report.textContent = r.report;
        report.hidden = copyBtn.hidden = false;
      });
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(report.textContent);
          say('Отчёт скопирован — в нём нет адреса подписки, ссылок серверов и паролей.');
        } catch (e) {
          say(`Не удалось скопировать: ${e.message}`, 'error');
        }
      });
      const check = el('fieldset', { className: 'group' }, el('legend', { textContent: 'Проверка подписки' }),
        el('p', { className: 'hint', textContent: 'Если подписка не даёт серверов или даёт не те: Waysplit скачает её так, как это делают разные приложения (v2rayN, Happ, v2rayNG, Hiddify, sing-box, Clash), и покажет, что пришло. В отчёте нет адреса подписки, ссылок серверов и паролей — его можно переслать.' }),
        el('label', { className: 'check' }, device, el('span', { innerHTML: 'Попробовать и с идентификатором устройства — <b>провайдер может засчитать его как ещё одно устройство</b> в вашем лимите.' })),
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
      sc.setSub(plural(subServers(id).length, SERVER_WORDS));
      const info = sub.info;
      const rows = [
        ...fact('Адрес', maskUrl(sub.url)),
        ...fact('Обновлена', sub.updatedAt ? fmtDate(sub.updatedAt) : 'ещё не обновлялась'),
        ...fact('Автообновление', `раз в ${sub.intervalHours} ч`),
      ];
      if (info?.total > 0) rows.push(...fact('Трафик', `${fmtBytes(info.upload + info.download)} из ${fmtBytes(info.total)}`));
      else if (info && info.upload + info.download > 0) rows.push(...fact('Трафик', fmtBytes(info.upload + info.download)));
      if (info?.expire > 0) rows.push(...fact('Срок', `${info.expire * 1000 < Date.now() ? 'истёк' : 'до'} ${fmtDate(info.expire * 1000, false)}`, info.expire * 1000 < Date.now() ? 'error' : ''));
      if (SUB_FORMATS[sub.format]) rows.push(...fact('Формат', SUB_FORMATS[sub.format]));
      if (sub.viaVpn) rows.push(...fact('Скачана', 'через VPN (напрямую сервер подписки не ответил)'));
      if (sub.device) rows.push(...fact('Устройство', 'подписка привязана к этому компьютеру как устройство'));
      sc.facts.replaceChildren(...rows);
      const notes = [];
      if (sub.announce) notes.push(el('p', { className: 'sub-note', textContent: `Сообщение провайдера: ${sub.announce}` }));
      if (sub.lastError) notes.push(el('p', { className: 'sub-note error', textContent: `Не обновилась: ${sub.lastError}` }));
      sc.notes.replaceChildren(...notes);
    },
  });
}

defineTab('servers', render);
