package main

// Регистрация компаньона в Chrome (SPEC, раздел 5; developer.chrome.com, Native messaging):
// манифест %LOCALAPPDATA%\Waysplit\com.waysplit.host.json и ключ реестра
// HKCU\Software\Google\Chrome\NativeMessagingHosts\com.waysplit.host (значение по умолчанию —
// путь к манифесту). Права администратора не нужны.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"waysplit/host/internal/singbox"
)

const (
	hostName = "com.waysplit.host"
	hostKey  = `Software\Google\Chrome\NativeMessagingHosts\` + hostName
)

type hostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func cmdInstall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	if strings.Contains(strings.ToLower(exe), `\go-build`) {
		return errors.New("install запускайте у собранной программы: host\\bin\\waysplit-host.exe install (не через go run)")
	}
	ids := extensionIDs()
	path, err := install(exe, ids, singbox.DataDir(), hostKey)
	if err != nil {
		return err
	}
	fmt.Println("Компаньон зарегистрирован в Chrome.")
	fmt.Println("  программа:   ", exe)
	fmt.Println("  манифест:    ", path)
	fmt.Println("  реестр:       HKCU\\" + hostKey)
	for _, id := range ids {
		fmt.Println("  расширение:   chrome-extension://" + id + "/")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "sing-box.exe")); err != nil {
		fmt.Println("\nВнимание: рядом с компаньоном нет sing-box.exe — без него VPN не заработает.")
	}
	fmt.Println("\nЕсли перенесёте папку с компаньоном, выполните install ещё раз.")
	finishMigration() // переход с LinkVPN: старая регистрация и старая папка данных (migrate.go)
	return nil
}

func cmdUninstall() error {
	removed, err := uninstall(singbox.DataDir(), hostKey, hostName)
	if err != nil {
		return err
	}
	if old, err := uninstall(oldDataDir(), oldHostKey, oldHostName); err == nil && old {
		removed = true // и старая регистрация LinkVPN (migrate.go)
	}
	if removed {
		fmt.Println("Регистрация компаньона в Chrome удалена.")
	} else {
		fmt.Println("Компаньон и так не был зарегистрирован.")
	}
	return nil
}

// install пишет манифест компаньона в dir и путь к нему — в реестр (HKCU\key).
// ids — каким расширениям можно подключаться (allowed_origins).
func install(exe string, ids []string, dir, key string) (string, error) {
	if len(ids) == 0 {
		return "", errors.New("нет ID расширения: выполните go run ./genkey в папке tools и пересоберите компаньон")
	}
	origins := make([]string, 0, len(ids))
	for _, id := range ids {
		if !validExtID(id) {
			return "", fmt.Errorf("неверный ID расширения %q: нужно 32 буквы a–p", id)
		}
		origins = append(origins, "chrome-extension://"+id+"/")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(hostManifest{
		Name:           hostName,
		Description:    "Waysplit: компаньон расширения (sing-box, Xray)",
		Path:           exe,
		Type:           "stdio",
		AllowedOrigins: origins,
	}, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, hostName+".json")
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return "", fmt.Errorf("не удалось записать %s: %w", path, err)
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, key, registry.SET_VALUE)
	if err != nil {
		return "", fmt.Errorf("не удалось создать ключ реестра HKCU\\%s: %w", key, err)
	}
	defer k.Close()
	if err := k.SetStringValue("", path); err != nil {
		return "", fmt.Errorf("не удалось записать в реестр: %w", err)
	}
	return path, nil
}

// uninstall убирает ключ реестра и манифест name.json из dir. removed — было что убирать.
func uninstall(dir, key, name string) (removed bool, err error) {
	switch err := registry.DeleteKey(registry.CURRENT_USER, key); {
	case err == nil:
		removed = true
	case !errors.Is(err, registry.ErrNotExist):
		return false, fmt.Errorf("не удалось удалить ключ реестра HKCU\\%s: %w", key, err)
	}
	switch err := os.Remove(filepath.Join(dir, name+".json")); {
	case err == nil:
		removed = true
	case !errors.Is(err, os.ErrNotExist):
		return removed, err
	}
	return removed, nil
}
