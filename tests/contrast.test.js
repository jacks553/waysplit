// Контраст цветов окна в стиле «кнопочный телефон» (design/lcd/STYLE.md, переменные — в
// extension/lib/common.css): текст — не ниже 4,5:1, границы и значки состояния — чтобы читалась
// форма. Считается по формуле WCAG из значений переменных, без браузера. Поменяли цвет — тест
// скажет, если он побледнел. Экран проверяется на обоих фонах: подсветка горит и погашена.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../extension/lib/common.css', import.meta.url), 'utf8');

// vars — переменные из блока стилей: { ink: '#1c2416', … } (только цвета вида #rrggbb).
function vars(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}
const blockAfter = (marker) => {
  const at = css.indexOf(marker);
  assert.ok(at >= 0, `в common.css нет блока «${marker}»`);
  return css.slice(at, css.indexOf('}', at));
};
// Новое оформление изначально тёмное: блок :root задаёт цвета экрана (они одни на обе темы) и тёмный
// корпус, светлая тема — только корпус (data-theme="light", и "system" при светлой теме системы).
const dark = vars(blockAfter(':root {'));
const light = { ...dark, ...vars(blockAfter(':root[data-theme="light"] {')) };
const lightBySystem = vars(blockAfter(':root[data-theme="system"] {'));

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [что, цвет, фон, не ниже]. Пороги прежние: текст 4,5; значки состояния 2,9; границы 1,7.
const SCREEN = [
  ['текст на экране, подсветка горит', 'ink', 'lcd', 4.5],
  ['текст на экране, подсветка погашена', 'ink', 'lcd-off', 4.5],
  ['приглушённый текст, подсветка горит', 'ink-muted-on', 'lcd', 4.5],
  ['приглушённый текст, подсветка погашена', 'ink-muted-off', 'lcd-off', 4.5],
  ['текст на залитом (выбранная кнопка, пункт меню, сообщение), подсветка горит', 'lcd', 'ink', 4.5],
  ['текст на залитом, подсветка погашена', 'lcd-off', 'ink', 4.5],
  ['текст на залитой кнопке под мышью, подсветка горит', 'lcd', 'ink-fill-hover', 4.5],
  ['текст на залитой кнопке под мышью, подсветка погашена', 'lcd-off', 'ink-fill-hover', 4.5],
];
const BODY = [
  ['название и кнопка языка на корпусе', 'body-text', 'body', 4.5],
  ['значки в шапке и подпись у лампочки', 'body-muted', 'body', 4.5],
  ['подпись клавиши вкладки', 'key-text', 'key', 4.5],
  ['подпись клавиши открытой вкладки', 'key-on-text', 'key-on', 4.5],
  ['значок на клавише питания', 'power-icon', 'power', 4.5],
  ['клавиша питания на корпусе (форма клавиши)', 'power', 'body', 2.9],
  ['клавиша открытой вкладки на корпусе', 'key-on', 'body', 2.9],
  ['лампочка: VPN включён', 'led-on', 'body', 2.9],
  ['лампочка: работают только правила', 'led-rules', 'body', 2.9],
  ['лампочка: ошибка', 'led-error', 'body', 2.9],
  ['рамка кнопки языка', 'line', 'body', 1.7],
];

function checkPairs(v, pairs) {
  for (const [what, fg, bg, min] of pairs) {
    assert.ok(v[fg] && v[bg], `${what}: в common.css нет --${fg} или --${bg}`);
    const r = ratio(v[fg], v[bg]);
    assert.ok(r >= min, `${what}: --${fg} ${v[fg]} на --${bg} ${v[bg]} — ${r.toFixed(2)}:1, нужно не ниже ${min}`);
  }
}

test('контраст: экран (один в обеих темах), подсветка горит и погашена', () => {
  checkPairs(light, SCREEN);
  // Числа из STYLE.md: чернила 9,9 и 7,4; приглушённый текст на своём фоне 4,9.
  const near = (a, b) => Math.abs(a - b) < 0.06;
  assert.ok(near(ratio(light.ink, light.lcd), 9.9) && near(ratio(light.ink, light['lcd-off']), 7.4), 'чернила на экране: 9,9 и 7,4, как в STYLE.md');
  assert.ok(near(ratio(light['ink-muted-on'], light.lcd), 4.9) && near(ratio(light['ink-muted-off'], light['lcd-off']), 4.9), 'приглушённый текст: 4,9 на обоих фонах');
});

for (const [theme, v] of [['светлая', light], ['тёмная', dark]]) {
  test(`контраст: корпус, ${theme} тема`, () => checkPairs(v, BODY));
}

test('светлая тема задана одинаково для выбранной вручную и для «как в системе»', () => {
  assert.deepEqual(lightBySystem, vars(blockAfter(':root[data-theme="light"] {')));
  assert.ok(/@media \(prefers-color-scheme: light\) \{\s*:root\[data-theme="system"\] \{/.test(css), '«как в системе» светлеет только при светлой теме системы');
});

test('корпус изначально тёмный: без data-theme действует тёмная тема, отдельного блока для неё нет', () => {
  assert.equal(dark.body, '#313b48');
  assert.ok(!css.includes(':root[data-theme="dark"]') && !css.includes('prefers-color-scheme: dark'), 'тёмная тема — сам блок :root');
});

test('цвета экрана в светлой теме не переопределяются: тема меняет только корпус', () => {
  const own = vars(blockAfter(':root[data-theme="light"] {'));
  for (const name of ['lcd', 'lcd-off', 'ink', 'ink-muted-on', 'ink-muted-off', 'ink-fill-hover']) {
    assert.ok(!(name in own), `--${name} в светлой теме не задаётся`);
  }
});
