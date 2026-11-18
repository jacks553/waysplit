// Тема оформления (SPEC 3.6): как в системе, светлая или тёмная. У каждого оформления окна своя
// настройка темы (lib/storage.js): theme — классического окна, themeLcd — нового окна и страницы
// «Начало работы».
//
// Классическое окно (classic/common.css): без data-theme у <html> — как в системе, "light" и "dark"
// перекрывают системную тему. Новое окно (lib/common.css): без data-theme и с "dark" — тёмное
// (оно тёмное изначально, поэтому до чтения настройки светлый корпус не мелькает), "light" —
// светлое, "system" — как в системе.

function set(theme, lcd) {
  const root = document.documentElement;
  if (lcd) root.dataset.theme = theme === 'light' || theme === 'system' ? theme : 'dark';
  else if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

// applyTheme(key) — key: 'theme' (классическое окно) или 'themeLcd' (новое окно, «Начало работы»).
export async function applyTheme(key = 'theme') {
  const lcd = key === 'themeLcd';
  const { settings } = await chrome.storage.local.get('settings');
  set(settings?.[key], lcd);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) set(changes.settings.newValue?.[key], lcd);
  });
}
