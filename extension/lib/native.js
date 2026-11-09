// Связь с компаньоном waysplit-host через native messaging (SPEC, разделы 4 и 5).
//
// Запрос {id, cmd, ...параметры} → ответ {id, ok, result} или {id, ok: false, error: {code, message}}.
// Один открытый порт на все запросы; ответы сопоставляются по id, у каждого запроса таймаут.

export const HOST_NAME = 'com.waysplit.host';
export const DEFAULT_TIMEOUT = 15000;

// Тексты ошибок Chrome (developer.chrome.com → Native messaging → Debug) → коды и понятные сообщения.
const CHROME_ERRORS = [
  ['Specified native messaging host not found', 'HOST_NOT_FOUND',
    'Компаньон не установлен'],
  ['Access to the specified native messaging host is forbidden', 'HOST_FORBIDDEN',
    'Компаньон не пускает это расширение: он установлен для другой его версии'],
  ['Failed to start native messaging host', 'HOST_START_FAILED',
    'Компаньон не запускается: возможно, его файлы удалены или их заблокировал антивирус'],
  ['Native host has exited', 'HOST_EXITED',
    'Компаньон неожиданно завершился (подробности — в host.log)'],
  ['Error when communicating with the native messaging host', 'HOST_PROTOCOL',
    'Ошибка связи с компаньоном (подробности — в host.log)'],
  ['Invalid native messaging host name specified', 'HOST_NAME',
    'Неверное имя компаньона в расширении'],
];

export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostError';
    this.code = code;
  }
}

// chromeError переводит текст ошибки Chrome в HostError.
export function chromeError(text) {
  const t = String(text || '');
  for (const [part, code, message] of CHROME_ERRORS) {
    if (t.includes(part)) return new HostError(code, message);
  }
  return new HostError('HOST_DISCONNECTED', t ? `Связь с компаньоном прервалась: ${t}` : 'Связь с компаньоном прервалась');
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
        reject(new HostError('TIMEOUT', `Компаньон не ответил за ${Math.round(timeoutMs / 1000)} с`));
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
    this.#drop(new HostError('HOST_CLOSED', 'Соединение с компаньоном закрыто'));
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
    else p.reject(new HostError(msg.error?.code || 'HOST_ERROR', msg.error?.message || 'Компаньон вернул ошибку'));
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
