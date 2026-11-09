// Подделки chrome.* и компаньона для тестов Controller (не тест: имя без .test.js).
import assert from 'node:assert/strict';
import { Controller } from '../extension/lib/controller.js';

export const S1 = { id: 's_1', name: 'NL', link: 'vless://secret@nl.example.com:443', localPort: 27101, key: 'k1', protocol: 'vless' };
export const S2 = { id: 's_2', name: 'DE', link: 'vless://secret@de.example.com:443', localPort: 27102, key: 'k2', protocol: 'vless' };

// setup собирает Controller с подделками. events — общий журнал порядка действий.
// extras: true — ещё подделки защиты WebRTC (privacy) и значка (ui); rtc — что вернёт protect().
export function setup({ local = {}, session = {}, control = 'controlled_by_this_extension', host: handlers = {}, extras = false, rtc = 'on', now = 1000 } = {}) {
  const events = [];
  const store = {
    local: structuredClone(local),
    session: structuredClone(session),
    get: async () => structuredClone(store.local),
    set: async (patch) => { Object.assign(store.local, structuredClone(patch)); },
    getSession: async (k) => store.session[k],
    setSession: async (o) => { Object.assign(store.session, structuredClone(o)); },
  };
  const proxy = {
    pac: null,
    level: control, // что вернёт chrome.proxy.settings.get → levelOfControl
    setPac: async (data) => { events.push('pac'); proxy.pac = data; },
    clear: async () => { events.push('clear'); proxy.pac = null; },
    control: async () => proxy.level,
  };
  const host = {
    connected: false,
    keepAlive: false,
    onDisconnect: null,
    calls: [],
    handlers: {
      apply: (p) => ({ hostVersion: '1.0.0', running: true, restarted: true, servers: Object.fromEntries(p.servers.map((s) => [s.id, s.localPort])), errors: [] }),
      stop: () => ({ running: false }),
      status: () => ({ running: true }),
      ...handlers,
    },
    async request(cmd, params = {}) {
      host.connected = true;
      host.calls.push({ cmd, params });
      events.push(cmd);
      const f = host.handlers[cmd];
      if (!f) throw Object.assign(new Error('нет такой команды'), { code: 'UNKNOWN_CMD' });
      return f(params);
    },
    setKeepAlive(on) { host.keepAlive = on; },
    disconnect() { host.connected = false; events.push('disconnect'); },
  };
  const alarms = { on: null, start() { alarms.on = true; }, stop() { alarms.on = false; } };
  const timers = {
    list: [],
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout' }; timers.list.push(t); return t; },
    clearTimeout: (t) => { timers.list = timers.list.filter((x) => x !== t); },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval' }; timers.list.push(t); return t; },
    clearInterval: (t) => { timers.list = timers.list.filter((x) => x !== t); },
    // fire запускает таймер нужного вида (у timeout — и убирает его).
    async fire(kind) {
      const t = timers.list.find((x) => x.kind === kind);
      assert.ok(t, `нет таймера ${kind}`);
      if (kind === 'timeout') timers.list = timers.list.filter((x) => x !== t);
      await t.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  const privacy = { protect: async () => { events.push('rtc-on'); return rtc; }, release: async () => { events.push('rtc-off'); } };
  const ui = { icons: [], setIcon: async (state, title) => { ui.icons.push({ state, title }); } };
  const clock = { t: now };
  const c = new Controller({ store, proxy, host, alarms, timers, now: () => clock.t, ...(extras ? { privacy, ui } : {}) });
  return { c, store, proxy, host, alarms, timers, events, ui, clock };
}

export const err = (code, message) => Object.assign(new Error(message), { code });
export const applies = (host) => host.calls.filter((x) => x.cmd === 'apply').length;
