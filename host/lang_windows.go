package main

// Язык сообщений командной строки. Команды install и uninstall запускает установщик
// (tools/companion/waysplit-setup.ps1), их сообщения видит пользователь: они на двух языках.
// Остальные команды (parse, config, try, subinfo) — для разработки, они только по-русски.

import (
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// cliEnglish — сообщения по-английски. Язык задаёт установщик переменной WAYSPLIT_LANG (ru или en);
// без неё — по языку Windows: русский при русской Windows, иначе английский (как язык окна
// расширения «как в Chrome»).
func cliEnglish() bool {
	switch strings.ToLower(os.Getenv("WAYSPLIT_LANG")) {
	case "ru":
		return false
	case "en":
		return true
	}
	langs, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil || len(langs) == 0 {
		return true
	}
	return !strings.HasPrefix(strings.ToLower(langs[0]), "ru")
}

// say — текст на языке командной строки.
func say(ru, en string) string {
	if cliEnglish() {
		return en
	}
	return ru
}
