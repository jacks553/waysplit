// Контраст цветов окна (extension/lib/common.css) в светлой и тёмной теме — по проверке доступности
// (ноябрь 2026): текст — не ниже 4,5:1, границы элементов — чтобы читалась форма. Считается по
// формуле WCAG из значений переменных, без браузера. Поменяли цвет — тест скажет, если он побледнел.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../extension/lib/common.css', import.meta.url), 'utf8');

// vars — переменные из блока стилей: { text: '#172033', … } (только цвета вида #rrggbb).
function vars(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}
const blockAfter = (marker) => {
  const at = css.indexOf(marker);
  assert.ok(at >= 0, `в common.css нет блока «${marker}»`);
  return css.slice(at, css.indexOf('}', at));
};
const light = vars(blockAfter(':root {'));
const dark = vars(blockAfter(':root[data-theme="dark"] {'));
const darkBySystem = vars(blockAfter(':root:not([data-theme="light"]) {'));

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [что, цвет, фон, не ниже]. Цвет — имя переменной или готовое значение.
const PAIRS = [
  ['основной текст на карточке', 'text', 'card', 4.5],
  ['основной текст на фоне окна', 'text', 'bg', 4.5],
  ['вторичный текст на карточке (и отключённое правило)', 'muted', 'card', 4.5],
  ['вторичный текст на фоне окна', 'muted', 'bg', 4.5],
  ['вторичный текст на голубой подложке', 'muted', 'accent-soft', 4.5],
  ['ссылка на карточке', 'accent', 'card', 4.5],
  ['ссылка на фоне окна', 'accent', 'bg', 4.5],
  ['жёлтая строка: текст на подложке', 'warn-text', 'warn-bg', 4.5],
  ['ошибка: текст на розовой подложке', 'err-text', 'err-bg', 4.5],
  ['«нет ответа» у сервера на карточке', 'err-text', 'card', 4.5],
  ['главный статус «Подключено»', 'status-ok', 'bg', 4.5],
  ['главный статус «работают правила»', 'status-warn', 'bg', 4.5],
  ['«Компаньон на связи» на «Начале работы» (на карточке)', 'status-ok', 'card', 4.5],
  ['белый текст на залитой кнопке', '#ffffff', 'btn', 4.5],
  ['белый текст на кнопке под мышью', '#ffffff', 'btn-hover', 4.5],
  ['подсказка в полях', 'placeholder', 'card', 4.5],
  ['красное сообщение об ошибке', 'toast-err-text', 'err', 4.5],
  ['обычное сообщение внизу окна', 'card', 'text', 4.5],
  ['дорожка выключенного переключателя (граница элемента)', 'switch-off', 'card', 2.9],
  ['границы полей и кнопок-контуров', 'field-line', 'card', 1.7],
];

for (const [theme, v] of [['светлая', light], ['тёмная', dark]]) {
  test(`контраст: ${theme} тема`, () => {
    for (const [what, fg, bg, min] of PAIRS) {
      const a = fg.startsWith('#') ? fg : v[fg];
      const b = v[bg];
      assert.ok(a && b, `${what}: нет переменной --${a ? bg : fg}`);
      const got = ratio(a, b);
      assert.ok(got >= min, `${what}: ${a} на ${b} — ${got.toFixed(2)}, нужно не ниже ${min}`);
    }
  });
}

test('тёмная тема по системе и выбранная в настройках — одни и те же цвета', () => {
  assert.deepEqual(darkBySystem, dark);
  for (const name of Object.keys(light)) assert.ok(name in dark, `в тёмной теме нет --${name}`);
});
