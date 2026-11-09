// Тема оформления (SPEC 3.6): системная, светлая или тёмная. Цвета — в lib/common.css:
// data-theme="light" / "dark" на <html> перекрывает системную тему.

function set(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export async function applyTheme() {
  const { settings } = await chrome.storage.local.get('settings');
  set(settings?.theme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) set(changes.settings.newValue?.theme);
  });
}
