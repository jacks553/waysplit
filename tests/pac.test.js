// Тесты extension/lib/pac.js: генерация PAC и его поведение (скрипт выполняется в отдельном контексте).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildPac, proxyString } from '../extension/lib/pac.js';

const VPN = 'SOCKS5 127.0.0.1:27101';

// run выполняет PAC так же изолированно, как Chrome, и возвращает FindProxyForURL.
function run(pac) {
  const ctx = vm.createContext({});
  vm.runInContext(pac, ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

test('строка прокси: блок или запасной DIRECT', () => {
  assert.equal(proxyString(27101), VPN);
  assert.equal(proxyString(27101, 'block'), VPN);
  assert.equal(proxyString(27105, 'direct'), 'SOCKS5 127.0.0.1:27105; DIRECT');
});

test('всё через текущий сервер, локальное — напрямую', () => {
  const find = run(buildPac({ defaultProxy: VPN }));
  const direct = [
    'localhost', 'LOCALHOST', 'app.localhost', 'intranet', 'printer.local', 'router.lan', 'nas.lan.',
    '127.0.0.1', '127.255.0.9', '10.0.0.1', '10.200.3.4', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.10.20',
    '::1', '[::1]', 'fc00::1', 'fd12:3456:789a::1', '[fd00::1]', 'fe80::1', 'febf::abcd',
  ];
  const proxied = [
    'example.com', 'www.youtube.com', 'api.ipify.org', 'example.com.', 'localhost.example.com', 'my.local.example.com',
    '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '1.2.3.4',
    '2001:db8::1', 'fec0::1', '::ffff:192.168.1.1', 'fc::1', '2a00:1450::1',
  ];
  for (const h of direct) assert.equal(find(h), 'DIRECT', h);
  for (const h of proxied) assert.equal(find(h), VPN, h);
});

test('VPN выключен — всё напрямую', () => {
  const find = run(buildPac());
  assert.equal(find('example.com'), 'DIRECT');
});

test('правила: поддомены и самое конкретное правило', () => {
  const find = run(buildPac({
    defaultProxy: VPN,
    rules: { 'google.com': 'SOCKS5 127.0.0.1:27102', 'mail.google.com': 'DIRECT', ru: 'DIRECT', 'xn--p1ai': 'DIRECT' },
  }));
  assert.equal(find('google.com'), 'SOCKS5 127.0.0.1:27102');
  assert.equal(find('www.google.com'), 'SOCKS5 127.0.0.1:27102');
  assert.equal(find('mail.google.com'), 'DIRECT');
  assert.equal(find('a.mail.google.com'), 'DIRECT');
  assert.equal(find('notgoogle.com'), VPN, 'не поддомен — правило не действует');
  assert.equal(find('yandex.ru'), 'DIRECT', 'правило на зону');
  assert.equal(find('xn--80ak6aa92e.xn--p1ai'), 'DIRECT', 'кириллическая зона в punycode');
  assert.equal(find('toString'), 'DIRECT', 'имя без точки — локальное, а не свойство объекта');
  assert.equal(find('constructor.com'), VPN, 'служебные имена объекта не считаются правилами');
});

test('одинаковые данные — одинаковый текст, ключи по порядку', () => {
  const a = buildPac({ defaultProxy: VPN, rules: { 'b.com': 'DIRECT', 'a.com': 'DIRECT' } });
  const b = buildPac({ defaultProxy: VPN, rules: { 'a.com': 'DIRECT', 'b.com': 'DIRECT' } });
  assert.equal(a, b);
  assert.ok(a.indexOf('"a.com"') < a.indexOf('"b.com"'));
});

test('PAC только из ASCII (иначе Chrome его не примет), не-ASCII экранируется', () => {
  const pac = buildPac({ defaultProxy: VPN, rules: { 'пример.рф': 'DIRECT' } });
  assert.match(pac, /^[\x00-\x7f]*$/, 'только ASCII');
  assert.equal(run(pac)('пример.рф'), 'DIRECT', 'экранированное правило по-прежнему работает');
});

test('PAC написан на ES5 и не делает DNS-запросов', () => {
  const pac = buildPac({ defaultProxy: VPN, rules: { 'a.com': 'DIRECT' } });
  assert.doesNotMatch(pac, /\b(let|const|class)\s|=>|`|\.\.\./, 'только ES5');
  assert.doesNotMatch(pac, /dnsResolve|isInNet|myIpAddress|isResolvable/, 'без DNS');
});
