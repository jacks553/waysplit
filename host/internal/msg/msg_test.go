package msg

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// dict — ключи host.* из словаря расширения: код фразы → текст.
func dict(t *testing.T, lang string) map[string]string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "extension", "lib", "i18n", lang+".js")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("словарь %s: %v", path, err)
	}
	line := regexp.MustCompile(`^\s*'host\.(\w+)': '((?:[^'\\]|\\.)*)',$`)
	out := map[string]string{}
	for _, s := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		if strings.Contains(s, "'host.") {
			m := line.FindStringSubmatch(s)
			if m == nil {
				t.Fatalf("%s: непонятная строка %q", lang, s)
			}
			out[m[1]] = strings.NewReplacer(`\'`, `'`, `\\`, `\`, `\n`, "\n").Replace(m[2])
		}
	}
	return out
}

func placeholders(s string) []string {
	var out []string
	for _, m := range placeholder.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

// Русские фразы в словаре — буква в букву фразы компаньона: компаньон до 1.2.0 и расширение
// до 1.2.0 видят готовый русский текст, и он должен совпадать с тем, что расширение собирает по коду.
func TestDictionaries(t *testing.T) {
	ruDict, enDict := dict(t, "ru"), dict(t, "en")
	for _, id := range IDs() {
		if got, ok := ruDict[id]; !ok {
			t.Errorf("в ru.js нет host.%s", id)
		} else if got != ru[id] {
			t.Errorf("host.%s в ru.js %q, у компаньона %q", id, got, ru[id])
		}
		if got, ok := enDict[id]; !ok {
			t.Errorf("в en.js нет host.%s", id)
		} else if fmt.Sprint(placeholders(got)) != fmt.Sprint(placeholders(ru[id])) {
			t.Errorf("host.%s: вставки в en.js %v, у компаньона %v", id, placeholders(got), placeholders(ru[id]))
		}
	}
	for _, d := range []map[string]string{ruDict, enDict} {
		for id := range d {
			if _, ok := ru[id]; !ok {
				t.Errorf("в словаре лишний ключ host.%s: у компаньона такой фразы нет", id)
			}
		}
	}
}

// Каждая вставка шаблона — слово, и в шаблоне нет непарных скобок.
func TestTemplates(t *testing.T) {
	for _, id := range IDs() {
		rest := placeholder.ReplaceAllString(ru[id], "")
		if strings.ContainsAny(rest, "{}") {
			t.Errorf("%s: непарная фигурная скобка в %q", id, ru[id])
		}
	}
}

func TestRu(t *testing.T) {
	if got := New("port_busy", "port", 27105).Ru(); got != "Порт 27105 занят другой программой" {
		t.Errorf("port_busy: %q", got)
	}
	inner := New("net_dns", "host", "sub.example.com")
	if got := New("sub_net", "reason", inner).Ru(); got != "подписка не скачалась: адрес сервера подписки не найден (sub.example.com)" {
		t.Errorf("вложенная фраза: %q", got)
	}
	if got := New("raw", "error", "что-то своё").Ru(); got != "что-то своё" {
		t.Errorf("raw: %q", got)
	}
	if got := New("bad_port").Ru(); got != "неверный порт «{port}»" {
		t.Errorf("без значения вставка остаётся как есть: %q", got)
	}
}

func TestNewUnknown(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("New с неизвестным кодом должен паниковать")
		}
	}()
	New("no_such_phrase")
}

func TestJSON(t *testing.T) {
	v := map[string]any{"error": New("sub_net", "reason", New("net_timeout"))}
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"error":{"msg":"sub_net","params":{"reason":{"msg":"net_timeout"}}}}`
	if string(data) != want {
		t.Errorf("JSON %s, нужно %s", data, want)
	}
}

func TestMap(t *testing.T) {
	src := New("sub_net", "reason", New("raw", "error", "https://a/secret"))
	got := src.Map(func(s string) string { return strings.ReplaceAll(s, "secret", "***") })
	if got.Ru() != "подписка не скачалась: https://a/***" {
		t.Errorf("Map: %q", got.Ru())
	}
	if src.Ru() != "подписка не скачалась: https://a/secret" {
		t.Errorf("Map испортил исходную фразу: %q", src.Ru())
	}
	if n := New("no_port").Map(strings.ToUpper); n.Ru() != "в ссылке нет порта" {
		t.Errorf("Map без вставок: %q", n.Ru())
	}
}

func TestOfFrom(t *testing.T) {
	err := E("bad_port", "port", "x")
	if err.Error() != "неверный порт «x»" {
		t.Errorf("E: %q", err.Error())
	}
	wrapped := fmt.Errorf("обёртка: %w", err)
	if p, ok := Of(wrapped); !ok || p.ID != "bad_port" {
		t.Errorf("Of(обёрнутая) = %v, %v", p, ok)
	}
	if _, ok := Of(errors.New("просто текст")); ok {
		t.Error("Of нашёл фразу у обычной ошибки")
	}
	if _, ok := Of(nil); ok {
		t.Error("Of(nil) нашёл фразу")
	}
	if p := From(errors.New("сбой")); p.ID != "raw" || p.Ru() != "сбой" {
		t.Errorf("From(обычная) = %v", p)
	}
	if p := From(wrapped); p.ID != "bad_port" {
		t.Errorf("From(с фразой) = %v", p)
	}
}

func TestIDs(t *testing.T) {
	ids := IDs()
	if !sort.StringsAreSorted(ids) || len(ids) != len(ru) {
		t.Errorf("IDs: %d кодов, по алфавиту: %v", len(ids), sort.StringsAreSorted(ids))
	}
	if Template("port_busy") == "" || Template("no_such") != "" {
		t.Error("Template")
	}
}
