package main

// Переход со старого имени LinkVPN (SPEC-RENAME.md). ID расширения тот же, поэтому серверы,
// правила и настройки в Chrome остаются. Компаньону нужно:
//   - перенести из старой папки данных %LOCALAPPDATA%\LinkVPN в новую всё, кроме журналов, —
//     главное, идентификатор устройства (иначе провайдер засчитает компьютер как новое устройство);
//   - снять старую регистрацию com.linkvpn.host (install снимает, uninstall — обе);
//   - убрать старую папку, когда она больше не нужна (install).
// Старое имя в коде — только здесь.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"waysplit/host/internal/singbox"
)

const (
	oldDataName = "LinkVPN"
	oldHostName = "com.linkvpn.host"
	oldHostKey  = `Software\Google\Chrome\NativeMessagingHosts\` + oldHostName
)

// oldDataDir — папка данных старой версии (рядом с новой).
func oldDataDir() string { return filepath.Join(filepath.Dir(singbox.DataDir()), oldDataName) }

// skipOnMigrate — что из старой папки не переносится: журналы, PID-файлы ядер старого
// компаньона (он может ещё работать), старая регистрация и временные файлы.
func skipOnMigrate(name string) bool {
	l := strings.ToLower(name)
	return strings.HasSuffix(l, ".log") || strings.HasSuffix(l, ".log.old") || strings.HasSuffix(l, ".pid") ||
		strings.HasSuffix(l, ".tmp") || l == oldHostName+".json" || strings.HasPrefix(l, "check-") || strings.HasPrefix(l, "xray-check-")
}

// migrateData копирует файлы из старой папки данных в новую. Файлы, которые в новой папке уже
// есть, не трогает (переносится один раз). moved — что перенесено.
func migrateData(oldDir, newDir string) (moved []string, err error) {
	entries, err := os.ReadDir(oldDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || skipOnMigrate(name) {
			continue
		}
		dst := filepath.Join(newDir, name)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(oldDir, name))
		if err != nil {
			return moved, err
		}
		if err := os.MkdirAll(newDir, 0o755); err != nil {
			return moved, err
		}
		if err := os.WriteFile(dst, data, 0o600); err != nil {
			return moved, err
		}
		moved = append(moved, name)
	}
	return moved, nil
}

// migrationNote — что сказать в журнале о переносе (main делает его до открытия журнала).
var migrationNote string

// migrateOnStart — перенос при любом запуске компаньона (до того, как он что-то создаст в новой папке).
func migrateOnStart() {
	moved, err := migrateData(oldDataDir(), singbox.DataDir())
	switch {
	case err != nil:
		migrationNote = "перенос из старой папки данных LinkVPN не удался: " + err.Error()
	case len(moved) > 0:
		migrationNote = "перенесено из старой папки данных LinkVPN: " + strings.Join(moved, ", ")
	}
}

// removeOldDataDir убирает старую папку данных, если в ней только наши файлы (журналы, конфиги,
// PID-файлы, идентификатор — он уже перенесён). left — что не удалось убрать (например, журнал,
// который держит ещё работающий старый компаньон) или чужие файлы.
func removeOldDataDir(oldDir, newDir string) (left []string) {
	entries, err := os.ReadDir(oldDir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		name := e.Name()
		path := filepath.Join(oldDir, name)
		ours := skipOnMigrate(name) || name == "device-id" || name == "config.json" || name == "xray.json"
		if !skipOnMigrate(name) && !sameFile(path, filepath.Join(newDir, name)) {
			ours = false // не перенесено (или в новой папке другое) — не удаляем
		}
		if e.IsDir() || !ours || os.Remove(path) != nil {
			left = append(left, path)
		}
	}
	if len(left) == 0 {
		if err := os.Remove(oldDir); err != nil {
			left = append(left, oldDir)
		}
	}
	return left
}

// sameFile — у файлов одинаковое содержимое (оба есть и читаются).
func sameFile(a, b string) bool {
	x, err1 := os.ReadFile(a)
	y, err2 := os.ReadFile(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// finishMigration — часть install: снять старую регистрацию и убрать старую папку.
func finishMigration() {
	if removed, err := uninstall(oldDataDir(), oldHostKey, oldHostName); err != nil {
		fmt.Println("\nВнимание: старую регистрацию LinkVPN снять не удалось:", err)
	} else if removed {
		fmt.Println("\nСтарая регистрация LinkVPN (" + oldHostName + ") снята.")
	}
	if _, err := os.Stat(oldDataDir()); err != nil {
		return
	}
	if left := removeOldDataDir(oldDataDir(), singbox.DataDir()); len(left) > 0 {
		fmt.Println("Старую папку данных LinkVPN убрать до конца не удалось — удалите сами, когда закроете Chrome:")
		for _, p := range left {
			fmt.Println("  " + p)
		}
	} else {
		fmt.Println("Старая папка данных LinkVPN перенесена в", singbox.DataDir(), "и удалена.")
	}
}
