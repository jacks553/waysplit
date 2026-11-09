// Тесты extension/lib/companion.js: сравнение версий компаньона и ссылка на загрузку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, INSTALL_STEPS, MIN_HOST_VERSION, REPO_URL, olderThan } from '../extension/lib/companion.js';

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
  assert.ok(INSTALL_STEPS[0].includes('«Скачать»') && INSTALL_STEPS[0].includes('Waysplit-companion.zip'));
  assert.ok(INSTALL_STEPS.some((s) => s.includes('Установить.cmd')));
  assert.ok(INSTALL_STEPS.every((s) => !/powershell|setup\.ps1|папк[еау] проекта/i.test(s)), 'без команд и путей к проекту');
});
