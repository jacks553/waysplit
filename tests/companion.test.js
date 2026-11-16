// Тесты extension/lib/companion.js: сравнение версий компаньона и ссылка на загрузку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCS_URL, DOWNLOAD_URL, DOWNLOAD_ZIP_URL, ISSUES_URL, MIN_HOST_VERSION, REPO_URL, docsUrl, helpUrl, installSteps, olderThan } from '../extension/lib/companion.js';
import { setLanguage } from '../extension/lib/i18n.js';

test('olderThan сравнивает части версии как числа', () => {
  assert.equal(olderThan('0.9.0', '1.0.0'), true);
  assert.equal(olderThan('1.0.0', '1.0.0'), false);
  assert.equal(olderThan('1.0.1', '1.0.0'), false);
  assert.equal(olderThan('1.10.0', '1.9.0'), false, '10 > 9, а не «1» < «9»');
  assert.equal(olderThan('1.2', '1.2.1'), true);
  assert.equal(olderThan('', '1.0.0'), true, 'нет версии — старый');
  assert.equal(olderThan(undefined, '1.0.0'), true);
  assert.equal(olderThan('2.0.0-beta', '1.0.0'), false);
});

test('ссылки на загрузку — последний выпуск на GitHub и его архив под постоянным именем', () => {
  assert.match(REPO_URL, /^https:\/\/github\.com\/[A-Za-z0-9-]+\/waysplit$/);
  assert.ok(!REPO_URL.includes('GITHUB_USER'), 'имя на GitHub вписано');
  assert.equal(DOWNLOAD_URL, `${REPO_URL}/releases/latest`);
  // Имя файла без версии: так его выкладывает .github/workflows/release.yml.
  assert.equal(DOWNLOAD_ZIP_URL, `${REPO_URL}/releases/latest/download/Waysplit-companion.zip`);
  assert.match(MIN_HOST_VERSION, /^\d+\.\d+\.\d+$/);
  const steps = installSteps();
  assert.ok(steps[0].includes('«Скачать»') && steps[0].includes('Waysplit-companion.zip'));
  assert.ok(steps.some((s) => s.includes('Установить.cmd')));
  assert.ok(steps.every((s) => !/powershell|setup\.ps1|папк[еау] проекта/i.test(s)), 'без команд и путей к проекту');
});

test('«Помощь» и «Частые вопросы» ведут на страницу сайта проекта на языке окна, «Сообщить об ошибке» — на Issues', () => {
  assert.equal(DOCS_URL, 'https://jacks553.github.io/waysplit');
  assert.equal(ISSUES_URL, `${REPO_URL}/issues`);
  setLanguage('ru');
  assert.equal(helpUrl(), `${DOCS_URL}/ru/help.html`);
  assert.equal(docsUrl('hint.faq.url'), `${DOCS_URL}/ru/help.html#faq`);
  setLanguage('en');
  assert.equal(helpUrl(), `${DOCS_URL}/en/help.html`);
  assert.equal(docsUrl('hint.faq.url'), `${DOCS_URL}/en/help.html#faq`);
  setLanguage('ru');
});
