// Тесты extension/lib/domains.js: ввод → домен в punycode, обратно — для показа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, normalizeDomain, parents, toUnicode } from '../extension/lib/domains.js';

test('адрес или домен → домен: без схемы, пути, порта, www', () => {
  const cases = {
    'youtube.com': 'youtube.com',
    'YouTube.COM': 'youtube.com',
    'https://www.youtube.com/watch?v=abc#t=1': 'youtube.com',
    'http://m.youtube.com:8080/path': 'm.youtube.com',
    'www.example.org': 'example.org',
    'example.com.': 'example.com',
    '  api.ipify.org  ': 'api.ipify.org',
    '*.example.com': 'example.com',
    '.ru': 'ru',
    ru: 'ru',
    su: 'su',
    'рф': 'xn--p1ai',
    '.рф': 'xn--p1ai',
    'пример.рф': 'xn--e1afmkfd.xn--p1ai',
    'https://www.пример.рф/страница': 'xn--e1afmkfd.xn--p1ai',
    'xn--p1ai': 'xn--p1ai',
    'ftp://files.example.net/x': 'files.example.net',
    'www': 'www',
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.deepEqual(normalizeDomain(input), { domain: want }, input);
  }
});

test('неправильный ввод — понятная причина', () => {
  const cases = {
    '': 'пустая строка',
    '   ': 'пустая строка',
    'a b.com': 'не похоже на домен',
    'http://': 'не похоже на домен',
    'exa_mple.com': 'не похоже на домен',
    '-bad.com': 'не похоже на домен',
    '1.2.3.4': 'правила — для доменов, а не для IP-адресов',
    '[::1]': 'правила — для доменов, а не для IP-адресов',
    localhost: 'локальные адреса всегда идут напрямую',
    'printer.local': 'локальные адреса всегда идут напрямую',
    'router.lan': 'локальные адреса всегда идут напрямую',
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.deepEqual(normalizeDomain(input), { error: want }, JSON.stringify(input));
  }
});

test('punycode → буквы для показа (обратно к тому, что делает new URL)', () => {
  for (const name of ['рф', 'пример.рф', 'сайт.москва', 'münchen.de', 'bücher.example', '例え.jp', 'ёлка.рф']) {
    const puny = new URL(`http://${name}`).hostname;
    assert.notEqual(puny, name, `${name} должен стать punycode`);
    assert.equal(toUnicode(puny), name, puny);
  }
  assert.equal(toUnicode('youtube.com'), 'youtube.com');
  assert.equal(toUnicode('xn--zz!.com'), 'xn--zz!.com', 'битая метка остаётся как есть');
});

test('родительские домены', () => {
  assert.deepEqual(parents('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com', 'com']);
  assert.deepEqual(parents('ru'), ['ru']);
});

test('локальные адреса — как в PAC', () => {
  for (const h of ['localhost', 'intranet', 'nas.lan', 'printer.local', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.1.1', '::1', '[fe80::1]', 'fd00::5']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) {
    assert.equal(isLocalHost(h), false, h);
  }
});
