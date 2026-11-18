// Экран выбора сервера (SPEC-POPUP.md): основной сервер, сервер для сайта, сервер для правила.
// Вверху — поиск; избранные сверху, потом группы по подпискам, свои ссылки — отдельно. При открытии
// пинг видимых серверов обновляется сам, не чаще раза в минуту на сервер.

import { freshPing, hostPort, matches, pingBars, PROTOCOLS, securityText, send, shownName, splitFlag } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { ruleServer } from '../lib/rules.js';
import { toUnicode } from '../lib/domains.js';
import { barsEl, ccEl, el, setIcon, toast } from './ui.js';
import { S, closeScreen, currentServer, isFav, openScreen, serverById, vpnOn } from './state.js';

// metaEl — вторая строка в строке сервера. Текст — в своём элементе: только так он обрезается
// с многоточием (у самой строки display: flex, и текст прямо в ней обрезался бы без «…»).
function metaEl(text) {
  return el('span', { className: 'srv-meta' }, el('span', { className: 'srv-meta-text', textContent: text }));
}

// serverItem — строка сервера: флаг, имя, протокол мелко, полоски задержки, звёздочка.
// full — с адресом (вкладка «Серверы»); more — кнопка «⋯».
export function serverItem(s, { selected = false, full = false, more = false } = {}) {
  const li = el('li', { className: 'srv', tabIndex: 0 });
  li.dataset.id = s.id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(selected));
  const parts = [PROTOCOLS[s.protocol] || s.protocol, securityText(s.security)];
  if (full) parts.push(hostPort(s));
  // Сервер не ответил на пинг — словами и первым в строке, а не только бледными полосками; причина —
  // во всплывающей подсказке полосок. Остальной текст строки, если не помещается, — с многоточием.
  const failed = pingBars(s).n === 0;
  const meta = metaEl(`${failed ? ' · ' : ''}${parts.join(' · ')}`);
  if (failed) meta.prepend(el('span', { className: 'srv-fail', textContent: t('common.noAnswer') }));
  if (s.core === 'xray') meta.append(el('span', { className: 'tag', textContent: 'Xray', title: t('picker.xray.title') }));
  const fav = isFav(s);
  const star = el('button', { type: 'button', className: 'icon-btn star', title: t(fav ? 'fav.remove' : 'fav.add') });
  star.dataset.action = 'star';
  star.setAttribute('aria-pressed', String(fav));
  star.setAttribute('aria-label', t('fav.aria', { name: s.name }));
  setIcon(star, 'star');
  li.append(ccEl(s), el('span', { className: 'srv-main' },
    el('span', { className: 'srv-name', textContent: splitFlag(s.name).name, title: s.name }), meta), barsEl(s), star);
  if (more) {
    const b = el('button', { type: 'button', className: 'icon-btn more', title: t('common.actions') });
    b.dataset.action = 'more';
    b.setAttribute('aria-label', t('common.actions.aria', { name: s.name }));
    b.setAttribute('aria-haspopup', 'menu');
    setIcon(b, 'more');
    li.append(b);
  }
  return li;
}

// groupsOf — серверы по группам: избранное (если with fav), подписки по порядку, свои ссылки.
export function groupsOf(servers, { favorites = true } = {}) {
  const groups = [];
  const subIds = new Set(S.view.subscriptions.map((x) => x.id));
  const fav = favorites ? servers.filter(isFav) : [];
  const rest = favorites ? servers.filter((s) => !isFav(s)) : servers;
  if (fav.length) groups.push({ key: 'fav', title: t('group.fav'), list: fav });
  for (const sub of S.view.subscriptions) {
    const list = rest.filter((s) => s.subscriptionId === sub.id);
    if (list.length) groups.push({ key: sub.id, title: sub.name, sub, list });
  }
  const own = rest.filter((s) => !s.subscriptionId || !subIds.has(s.subscriptionId));
  if (own.length) groups.push({ key: 'own', title: t('group.own'), list: own });
  return groups;
}

// toggleFavorite — звёздочка в строке (общий обработчик для списков).
export async function toggleFavorite(id) {
  const s = serverById(id);
  if (!s) return;
  const resp = await send({ type: 'setFavorite', id, on: !isFav(s) });
  if (!resp?.ok) toast(resp?.error?.message || t('common.failed'), 'error');
}

// --- автопинг видимых строк ---

const asked = new Map(); // id → когда просили пинг (чтобы не просить, пока ответ не пришёл)
const ASK_GAP = 60_000;

function autoPing(root) {
  const visible = new Set();
  let timer = null;
  const flush = () => {
    const now = Date.now();
    const ids = [...visible].filter((id) => {
      const s = serverById(id);
      return s && !freshPing(s, now) && now - (asked.get(id) || 0) > ASK_GAP;
    });
    if (!ids.length) return;
    for (const id of ids) {
      asked.set(id, now);
      root.querySelector(`li[data-id="${id}"] .bars`)?.classList.add('pending');
    }
    send({ type: 'ping', ids }).then((resp) => {
      if (!resp?.ok) toast(t('picker.pingFailed', { error: resp?.error?.message || t('common.noAnswer') }), 'error');
    });
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target.dataset.id);
      else visible.delete(e.target.dataset.id);
    }
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  }, { root });
  return {
    observe: (list) => {
      io.disconnect();
      visible.clear();
      for (const li of list.querySelectorAll('li[data-id]')) io.observe(li);
    },
    stop: () => {
      io.disconnect();
      clearTimeout(timer);
    },
  };
}

// --- экран ---

// openPicker(mode): { kind: 'main' } — текущий сервер; { kind: 'site', domain, onDone } — сервер
// для сайта; { kind: 'rule', ruleId } — сервер для правила.
export function openPicker(mode) {
  let query = '';
  let pinger = null;
  const rule = () => S.view.rules.find((r) => r.id === mode.ruleId) || null;
  const exact = () => S.view.rules.find((r) => r.domain === mode.domain) || null;
  const title = mode.kind === 'site' ? t('picker.title.site', { domain: toUnicode(mode.domain) })
    : mode.kind === 'rule' ? t('picker.title.rule', { domain: toUnicode(rule()?.domain || '') }) : t('home.server');

  const pingBtn = el('button', { type: 'button', className: 'icon-btn', title: t('picker.pingAll') });
  pingBtn.setAttribute('aria-label', t('picker.pingAll'));
  setIcon(pingBtn, 'refresh');
  pingBtn.addEventListener('click', async () => {
    pingBtn.disabled = true;
    toast(t(S.view.enabled ? 'servers.pinging' : 'picker.pingingOff'));
    const resp = await send({ type: 'ping' });
    pingBtn.disabled = false;
    toast(resp?.ok ? t('servers.pinged', { ok: resp.result.filter((r) => r.ms).length, all: resp.result.length }) : resp?.error?.message || t('common.failed'), resp?.ok ? '' : 'error');
  });

  // chosen — что сейчас выбрано: id сервера, 'same' (как у остальных), 'direct', 'current'.
  function chosen() {
    if (mode.kind === 'main') return S.view.currentServerId;
    if (mode.kind === 'site') {
      const r = exact();
      if (!r) return 'same';
      if (r.action === 'direct') return 'direct';
      return ruleServer(r, S.view.servers, currentServer())?.id ?? 'same';
    }
    const r = rule();
    if (!r) return null;
    if (r.action === 'direct') return 'direct';
    return r.serverId && serverById(r.serverId) ? r.serverId : 'current';
  }

  function specials() {
    if (mode.kind === 'site') {
      return [
        { key: 'same', title: t('picker.same'), sub: t(vpnOn() ? 'picker.same.on' : 'picker.same.off') },
        { key: 'direct', title: t('action.direct'), sub: t('picker.direct.site') },
      ];
    }
    if (mode.kind === 'rule') {
      const cur = currentServer();
      return [
        { key: 'current', title: t('action.proxyCurrent'), sub: cur ? t('picker.current.now', { server: shownName(cur.name) }) : t('picker.current.none') },
        { key: 'direct', title: t('action.direct'), sub: t('picker.direct.rule') },
      ];
    }
    return [];
  }

  async function pick(key) {
    if (!key) return;
    let resp = { ok: true };
    if (mode.kind === 'main') {
      if (key !== S.view.currentServerId) resp = await send({ type: 'select', id: key });
    } else if (mode.kind === 'site') {
      const r = exact();
      if (key === 'same') resp = r ? await send({ type: 'removeRules', ids: [r.id] }) : resp;
      else if (key === 'direct') resp = await send({ type: 'addRules', domains: [mode.domain], action: 'direct' });
      else resp = await send({ type: 'addRules', domains: [mode.domain], action: 'proxy', serverId: key });
    } else {
      const patch = key === 'direct' ? { action: 'direct', serverId: null } : { action: 'proxy', serverId: key === 'current' ? null : key };
      resp = await send({ type: 'updateRule', id: mode.ruleId, patch });
    }
    if (!resp?.ok) {
      toast(resp?.error?.message || t('common.failed'), 'error');
      return;
    }
    mode.onDone?.();
    closeScreen();
  }

  const screen = openScreen({
    title,
    actions: [pingBtn],
    className: 'picker',
    fixed: true,
    build(sc) {
      const search = el('input', { className: 'search', type: 'search', placeholder: t('servers.search'), autocomplete: 'off' });
      search.setAttribute('aria-label', t('picker.search.aria'));
      const list = el('div', { className: 'pick-list panel-scroll' });
      sc.body.append(el('div', { className: 'pick-search' }, search), list);
      search.addEventListener('input', () => {
        query = search.value;
        sc.render();
      });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const first = list.querySelector('li');
          pick(first?.dataset.key || first?.dataset.id);
        }
        if (e.key === 'Escape' && search.value) {
          e.preventDefault();
          e.stopPropagation();
          search.value = '';
          query = '';
          sc.render();
        }
      });
      list.addEventListener('click', (e) => {
        const star = e.target.closest('[data-action="star"]');
        const li = e.target.closest('li');
        if (!li) return;
        if (star) toggleFavorite(li.dataset.id);
        else pick(li.dataset.key || li.dataset.id);
      });
      list.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li')) {
          e.preventDefault();
          pick(e.target.dataset.key || e.target.dataset.id);
        }
      });
      pinger = autoPing(list);
      sc.onClose = () => pinger.stop();
      sc.list = list;
      sc.search = search;
    },
    render(sc) {
      if (mode.kind === 'rule' && !rule()) { // правило удалили, пока экран был открыт
        queueMicrotask(closeScreen);
        return;
      }
      const servers = S.view.servers;
      sc.setSub(t('n.servers', { n: servers.length }));
      const sel = chosen();
      const found = servers.filter((s) => matches(s, query));
      const parts = [];
      const sp = query ? [] : specials();
      if (sp.length) {
        parts.push(el('ul', { className: 'srv-list' }, ...sp.map((x) => {
          const li = el('li', { className: 'srv special', tabIndex: 0 });
          li.dataset.key = x.key;
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', String(sel === x.key));
          // Особая строка — без кода страны, место под него оставлено: имена стоят ровно.
          li.append(el('span', { className: 'cc none' }), el('span', { className: 'srv-main' }, el('span', { className: 'srv-name', textContent: x.title }), metaEl(x.sub)));
          return li;
        })));
      }
      for (const g of groupsOf(found)) {
        // Название — в своём элементе: длинное название подписки обрезается многоточием, пунктир остаётся.
        parts.push(el('h3', { className: 'group-title' }, el('span', { className: 'group-name', textContent: g.title, title: g.title })));
        parts.push(el('ul', { className: 'srv-list' }, ...g.list.map((s) => serverItem(s, { selected: sel === s.id }))));
      }
      if (!found.length) parts.push(el('p', { className: 'empty', textContent: t(servers.length ? 'common.nothingFound' : 'picker.noServers') }));
      const keep = sc.list.scrollTop;
      sc.list.replaceChildren(...parts);
      sc.list.scrollTop = keep;
      pinger.observe(sc.list);
    },
  });
  if (mode.kind === 'main') screen.search.focus({ preventScroll: true });
  // К выбранному: прокрутить так, чтобы он был посередине списка.
  const chosenRow = screen.list.querySelector('li[aria-selected="true"]');
  if (chosenRow) {
    const r = chosenRow.getBoundingClientRect();
    const b = screen.list.getBoundingClientRect();
    screen.list.scrollTop += r.top - b.top - (b.height - r.height) / 2;
  }
  return screen;
}
