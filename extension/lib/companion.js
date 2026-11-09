// Компаньон глазами пользователя (SPEC-STORE.md, 1.2–1.3): где его скачать, как поставить
// и какая версия нужна этому расширению.

// REPO_URL — репозиторий на GitHub (заглушку имени GITHUB_USER tools/release не пропускает).
export const REPO_URL = 'https://github.com/jacks553/waysplit';
// Страница последнего выпуска: список изменений и SHA-256 архива.
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest`;
// Сам архив последнего выпуска — постоянная ссылка: у архива нет номера версии в имени, его
// собирает и выкладывает .github/workflows/release.yml.
export const DOWNLOAD_ZIP_URL = `${REPO_URL}/releases/latest/download/Waysplit-companion.zip`;
// «Помощь» и «Сообщить об ошибке» в окне расширения: README и Issues на GitHub.
export const HELP_URL = `${REPO_URL}#readme`;
export const ISSUES_URL = `${REPO_URL}/issues`;

// MIN_HOST_VERSION — самый старый компаньон, с которым работает это расширение.
export const MIN_HOST_VERSION = '1.0.0';

// Шаги установки — одни и те же на «Начале работы» и в окне расширения (кнопка «Скачать» — рядом).
export const INSTALL_STEPS = [
  'Нажмите «Скачать» — загрузится архив Waysplit-companion.zip.',
  'Распакуйте его: правой кнопкой → «Извлечь всё».',
  'Запустите «Установить.cmd». Если Windows покажет «Система Windows защитила ваш компьютер», нажмите «Подробнее» → «Выполнить в любом случае».',
];

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
  return `Компаньон устарел (${version ? `версия ${version}` : 'старая версия'}, нужна ${MIN_HOST_VERSION} или новее)`;
}
