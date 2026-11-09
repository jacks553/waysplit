package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestExtensionIDFormat(t *testing.T) {
	id := ExtensionID([]byte("любые байты"))
	if !regexp.MustCompile(`^[a-p]{32}$`).MatchString(id) {
		t.Fatalf("ID %q: нужно 32 буквы a–p", id)
	}
	// SHA-256("") = e3b0c44298…: e→o, 3→d, b→l, 0→a, c→m, 4→e, 4→e, 2→c, 9→j, 8→i
	if got := ExtensionID(nil); !strings.HasPrefix(got, "odlameecji") {
		t.Errorf("ID пустого ключа %q, ожидалось начало odlameecji", got)
	}
}

func TestSetManifestKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	os.WriteFile(path, []byte("{\n  \"name\": \"X\",\n  \"key\": \"старый\",\n  \"version\": \"1\"\n}\n"), 0o644)
	if err := setManifestKey(path, "НОВЫЙ+/="); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "{\n  \"name\": \"X\",\n  \"key\": \"НОВЫЙ+/=\",\n  \"version\": \"1\"\n}\n" {
		t.Errorf("получилось:\n%s", data)
	}
	os.WriteFile(path, []byte(`{"name": "X"}`), 0o644)
	if err := setManifestKey(path, "k"); err == nil {
		t.Error("нет поля key — должна быть ошибка")
	}
}
