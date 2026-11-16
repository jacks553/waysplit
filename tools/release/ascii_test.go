package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// notASCII — первые не-ASCII знаки текста с номерами строк (пусто — их нет).
func notASCII(text string) []string {
	var bad []string
	for i, line := range strings.Split(text, "\n") {
		for _, r := range line {
			if r > 127 {
				bad = append(bad, "строка "+itoa(i+1)+": "+strings.TrimSpace(line))
				break
			}
		}
		if len(bad) == 5 {
			break
		}
	}
	return bad
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

var enTextRe = regexp.MustCompile(`(?s)\n  en = @\{\n(.*?)\n  \}\n`)

// Английские сообщения установщика и файлы Install.cmd и Uninstall.cmd — только ASCII: тогда они
// показываются верно в консоли с любой кодовой страницей (в английской Windows нет русских букв).
func TestInstallerEnglishIsASCII(t *testing.T) {
	dir := filepath.Join("..", "companion")
	script, err := os.ReadFile(filepath.Join(dir, "waysplit-setup.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	m := enTextRe.FindSubmatch(script)
	if m == nil {
		t.Fatal("в waysplit-setup.ps1 нет таблицы английских сообщений (en = @{ … })")
	}
	en := string(m[1])
	if n := strings.Count(en, " = '"); n < 30 {
		t.Fatalf("в таблице английских сообщений только %d строк: таблица разобрана не целиком", n)
	}
	if bad := notASCII(en); len(bad) > 0 {
		t.Errorf("английские сообщения установщика: не только ASCII:\n  %s", strings.Join(bad, "\n  "))
	}
	// В русской и английской таблицах одни и те же ключи.
	ru := regexp.MustCompile(`(?s)\n  ru = @\{\n(.*?)\n  \}\n`).FindSubmatch(script)
	if ru == nil {
		t.Fatal("в waysplit-setup.ps1 нет таблицы русских сообщений")
	}
	keyRe := regexp.MustCompile(`(?m)^\s+(\w+)\s+= '`)
	keys := func(s string) string {
		var out []string
		for _, k := range keyRe.FindAllStringSubmatch(s, -1) {
			out = append(out, k[1])
		}
		return strings.Join(out, " ")
	}
	if keys(string(ru[1])) != keys(en) {
		t.Errorf("ключи сообщений в русской и английской таблицах разные:\n  ru: %s\n  en: %s", keys(string(ru[1])), keys(en))
	}
	for _, f := range []string{"install.cmd", "uninstall.cmd"} {
		data, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			t.Fatal(err)
		}
		if bad := notASCII(string(data)); len(bad) > 0 {
			t.Errorf("%s: не только ASCII:\n  %s", f, strings.Join(bad, "\n  "))
		}
	}
}
