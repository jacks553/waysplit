package main

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// Переход с LinkVPN (SPEC-RENAME.md): переносится всё, кроме журналов, — главное, идентификатор
// устройства; старая папка убирается, только если в ней одни наши файлы.
func TestMigrateData(t *testing.T) {
	base := t.TempDir()
	oldDir, newDir := filepath.Join(base, "LinkVPN"), filepath.Join(base, "Waysplit")
	os.MkdirAll(oldDir, 0o755)
	write := func(dir, name, text string) { os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600) }
	write(oldDir, "device-id", "d47d7dee-9073-46b1-a078-dc5be5c1524b\n")
	write(oldDir, "config.json", "{}")
	write(oldDir, "host.log", "журнал")
	write(oldDir, "host.log.old", "старый журнал")
	write(oldDir, "sing-box.log", "x")
	write(oldDir, "sing-box.pid", "123")
	write(oldDir, "com.linkvpn.host.json", "{}")

	moved, err := migrateData(oldDir, newDir)
	sort.Strings(moved)
	if err != nil || !reflect.DeepEqual(moved, []string{"config.json", "device-id"}) {
		t.Fatalf("перенесено %v (%v); нужно config.json и device-id", moved, err)
	}
	if b, _ := os.ReadFile(filepath.Join(newDir, "device-id")); string(b) != "d47d7dee-9073-46b1-a078-dc5be5c1524b\n" {
		t.Fatalf("идентификатор устройства не тот: %q", b)
	}
	for _, name := range []string{"host.log", "sing-box.pid", "com.linkvpn.host.json"} {
		if _, err := os.Stat(filepath.Join(newDir, name)); err == nil {
			t.Errorf("%s не должен переноситься", name)
		}
	}
	// Второй раз ничего не переписывает.
	write(newDir, "config.json", `{"новый": true}`)
	if moved, _ := migrateData(oldDir, newDir); len(moved) != 0 {
		t.Errorf("повторный перенос: %v", moved)
	}

	// Чужой файл в старой папке — папка остаётся, с ним; наши файлы убраны.
	write(oldDir, "мой-файл.txt", "чужое")
	left := removeOldDataDir(oldDir, newDir)
	if !reflect.DeepEqual(left, []string{filepath.Join(oldDir, "config.json"), filepath.Join(oldDir, "мой-файл.txt")}) {
		t.Fatalf("осталось %v (config.json в новой папке другой — не удаляем; чужой файл — тоже)", left)
	}
	if _, err := os.Stat(filepath.Join(oldDir, "device-id")); err == nil {
		t.Error("перенесённый идентификатор в старой папке не убран")
	}
	os.Remove(filepath.Join(oldDir, "мой-файл.txt"))
	write(newDir, "config.json", "{}")
	if left := removeOldDataDir(oldDir, newDir); len(left) != 0 {
		t.Fatalf("осталось %v", left)
	}
	if _, err := os.Stat(oldDir); err == nil {
		t.Error("старая папка не удалена")
	}
	// Старой папки нет — ничего не делается.
	if moved, err := migrateData(oldDir, newDir); err != nil || len(moved) != 0 {
		t.Errorf("без старой папки: %v %v", moved, err)
	}
}
