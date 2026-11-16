// Связь с компаньоном waysplit-host через native messaging (SPEC, разделы 4 и 5).
//
// Запрос {id, cmd, ...параметры} → ответ {id, ok, result} или {id, ok: false, error: {code, message}}.
// Один открытый порт на все запросы; ответы сопоставляются по id, у каждого запроса таймаут.

import { t } from './i18n.js';
import { hostPhrase, hostText } from './hostmsg.js';

export const HOST_NAME = 'com.waysplit.host';
export const DEFAULT_TIMEOUT = 15000;

// Тексты ошибок Chrome (developer.chrome.com → Native messaging → Debug) → коды; понятное
// сообщение — в словаре: err.<код>.
const CHROME_ERRORS = [
  ['Specified native messaging host not found', 'HOST_NOT_FOUND'],
  ['Access to the specified native messaging host is forbidden', 'HOST_FORBIDDEN'],
  ['Failed to start native messaging host', 'HOST_START_FAILED'],
  ['Native host has exited', 'HOST_EXITED'],
  ['Error when communicating with the native messaging host', 'HOST_PROTOCOL'],
  ['Invalid native messaging host name specified', 'HOST_NAME'],
];

// HostError — ошибка связи или ответ компаньона «нет». phrase — фраза компаньона ({ msg, params },
// lib/hostmsg.js), если он её прислал и словарь её знает: по ней ошибку можно сохранить и показать
// потом на другом языке. message — текст на языке окна.
export class HostError extends Error {
  constructor(code, message, phrase = null) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.phrase = phrase;
  }
}

// replyError — ошибка из ответа компаньона { code, message, msg?, params? }.
export function replyError(e) {
  const text = e?.message || '';
  return new HostError(e?.code || 'HOST_ERROR', text ? hostText(e, text) : t('err.HOST_ERROR'), text ? hostPhrase(e, text) : null);
}

// chromeError переводит текст ошибки Chrome в HostError.
export function chromeError(text) {
  const s = String(text || '');
  for (const [part, code] of CHROME_ERRORS) {
    if (s.includes(part)) return new HostError(code, t(`err.${code}`));
  }
  return new HostError('HOST_DISCONNECTED', s ? t('err.HOST_DISCONNECTED.why', { error: s }) : t('err.HOST_DISCONNECTED'));
}

export class NativeHost {
  // runtime — chrome.runtime (в тестах — подделка). idleMs — через сколько закрыть порт без запросов,
  // если keepAlive выключен: тогда компаньон не висит в памяти зря.
  constructor({ runtime = globalThis.chrome?.runtime, idleMs = 15000 } = {}) {
    this.runtime = runtime;
    this.idleMs = idleMs;
    this.keepAlive = false;
    this.port = null;
    this.nextId = 1;
    this.pending = new Map();
    this.idleTimer = null;
    this.onDisconnect = null; // (HostError) => void — для автопереподключения (этап 3)
  }

  get connected() {
    return this.port !== null;
  }

  // setKeepAlive(true) — держать компаньон (пока нужно ядро); false — отпустить: порт закроется
  // через idleMs без запросов, и компаньон завершится.
  setKeepAlive(on) {
    this.keepAlive = on;
    if (on) clearTimeout(this.idleTimer);
    else this.#scheduleIdle();
  }

  // request отправляет команду и ждёт ответ. Ошибки — HostError с кодом.
  request(cmd, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = this.#ensurePort();
      } catch (e) {
        reject(chromeError(e?.message));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError('TIMEOUT', t('err.TIMEOUT', { sec: Math.round(timeoutMs / 1000) })));
        this.#scheduleIdle();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      clearTimeout(this.idleTimer);
      try {
        port.postMessage({ ...params, id, cmd });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(chromeError(e?.message));
      }
    });
  }

  disconnect() {
    if (!this.port) return;
    const port = this.port;
    this.#drop(new HostError('HOST_CLOSED', t('err.HOST_CLOSED')));
    port.disconnect();
  }

  #ensurePort() {
    if (this.port) return this.port;
    const port = this.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((msg) => this.#onMessage(msg));
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      const err = chromeError(this.runtime.lastError?.message);
      this.#drop(err);
      this.onDisconnect?.(err);
    });
    this.port = port;
    return port;
  }

  #onMessage(msg) {
    const p = this.pending.get(msg?.id);
    if (!p) return; // ответ на запрос, который уже отвалился по таймауту
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(replyError(msg.error));
    this.#scheduleIdle();
  }

  // #drop забывает порт и отклоняет все ждущие запросы.
  #drop(err) {
    this.port = null;
    clearTimeout(this.idleTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  #scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.keepAlive || this.pending.size > 0 || !this.port) return;
    this.idleTimer = setTimeout(() => this.disconnect(), this.idleMs);
  }
}
