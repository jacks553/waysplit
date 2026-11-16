// Компаньон глазами пользователя (SPEC-STORE.md, 1.2–1.3): где его скачать, как поставить
// и какая версия нужна этому расширению.

import { t } from './i18n.js';

// REPO_URL — репозиторий на GitHub (заглушку имени GITHUB_USER tools/release не пропускает).
export const REPO_URL = 'https://github.com/jacks553/waysplit';
// Страница последнего выпуска: список изменений и SHA-256 архива.
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest`;
// Сам архив последнего выпуска — постоянная ссылка: у архива нет номера версии в имени, его
// собирает и выкладывает .github/workflows/release.yml.
export const DOWNLOAD_ZIP_URL = `${REPO_URL}/releases/latest/download/Waysplit-companion.zip`;
// DOCS_URL — сайт проекта на GitHub Pages (папка docs/ репозитория): помощь, частые вопросы,
// политика конфиденциальности.
export const DOCS_URL = 'https://jacks553.github.io/waysplit';
// docsUrl — страница сайта на языке окна: путь к ней — в словаре (help.url — «Помощь»,
// hint.faq.url — «Частые вопросы»). «Сообщить об ошибке» — Issues на GitHub.
export const docsUrl = (key) => `${DOCS_URL}${t(key)}`;
export const helpUrl = () => docsUrl('help.url');
export const ISSUES_URL = `${REPO_URL}/issues`;

// MIN_HOST_VERSION — самый старый компаньон, с которым работает это расширение.
export const MIN_HOST_VERSION = '1.0.0';

// PHRASES_HOST_VERSION — с этой версии компаньон присылает свои сообщения фразами с кодом
// (lib/hostmsg.js), и окно показывает их на своём языке; у компаньонов старее они только по-русски.
export const PHRASES_HOST_VERSION = '1.2.0';

// Шаги установки — одни и те же на «Начале работы» и в окне расширения (кнопка «Скачать» — рядом).
export const installSteps = () => [t('install.step1'), t('install.step2'), t('install.step3')];

// olderThan('0.9.0', '1.0.0') → true. Части сравниваются как числа; нет версии — старая.
export function olderThan(version, min) {
  const parse = (v) => String(v || '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  if (!version) return true;
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

// outdatedMessage — текст ошибки для старого компаньона.
export function outdatedMessage(version) {
  return version ? t('err.HOST_OUTDATED', { version, min: MIN_HOST_VERSION }) : t('err.HOST_OUTDATED.unknown', { min: MIN_HOST_VERSION });
}
