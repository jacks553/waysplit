package main

// Расширение для ручной установки — Waysplit-extension.zip для выпуска на GitHub (решение автора
// 2026-11-09: дать попробовать до проверки в магазине). Это папка extension/ как есть, с полем key
// в manifest.json: у распакованной копии тот же постоянный ID, что у версии для разработки, и
// компаньон её пускает. Закрытого ключа в папке расширения нет (он в tools/genkey и в git не
// попадает) — сборка это проверяет, как и служебные файлы. Архив для магазина (без key) — отдельно,
// в выпуск не идёт. Имя без версии — постоянная ссылка …/releases/latest/download/Waysplit-extension.zip.
// Файлы — в корне архива: «Извлечь всё» в Windows кладёт их в папку Waysplit-extension, её и
// выбирают в chrome://extensions.

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const extensionZip = "Waysplit-extension.zip"

// idFromKey — ID расширения Chrome по полю key: SHA-256 от открытого ключа (DER), первые 32
// шестнадцатеричные цифры, 0–f заменены буквами a–p.
func idFromKey(key string) (string, error) {
	der, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(der) == 0 {
		return "", errors.New("поле key в manifest.json — не base64")
	}
	sum := sha256.Sum256(der)
	var b strings.Builder
	for _, c := range hex.EncodeToString(sum[:16]) {
		if c >= 'a' {
			b.WriteRune('a' + 10 + c - 'a')
		} else {
			b.WriteRune('a' + c - '0')
		}
	}
	return b.String(), nil
}

var devIDRe = regexp.MustCompile(`extensionID = "([a-p]{32})"`)

// devExtensionID — ID версии для разработки из host/extid.go (его пускает компаньон).
func devExtensionID(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "host", "extid.go"))
	if err != nil {
		return "", err
	}
	m := devIDRe.FindSubmatch(data)
	if m == nil {
		return "", errors.New("в host/extid.go нет extensionID")
	}
	return string(m[1]), nil
}

// secretFile — то, чего в архиве расширения быть не должно: ключи, локальные ссылки, копии.
var secretFile = regexp.MustCompile(`(?i)(\.(pem|key|p12|pfx|crt|der)$|\.local\.|private|waysplit-backup|linkvpn-backup|\.bak$|\.log$)`)

func buildExtension(root string, draft bool) error {
	url, err := repoURL(root)
	if err != nil {
		return err
	}
	if err := checkPlaceholder(url, draft); err != nil {
		return err
	}
	files, m, err := extensionFiles(root, true)
	if err != nil {
		return err
	}
	bad := extensionProblems(files, m)
	key, _ := m["key"].(string)
	id, err := idFromKey(key)
	if err != nil {
		bad = append(bad, err.Error())
	}
	dev, err := devExtensionID(root)
	if err != nil {
		return err
	}
	if id != dev {
		bad = append(bad, fmt.Sprintf("ID по полю key — %q, а компаньон пускает %q (host/extid.go): пересоздайте ключ (tools/genkey) или поправьте key", id, dev))
	}
	for _, f := range files {
		if secretFile.MatchString(f.name) {
			bad = append(bad, f.name+": такому файлу (ключ, ссылки, копия, журнал) в архиве не место")
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("архив расширения не собран:\n  %s", strings.Join(bad, "\n  "))
	}
	license, err := os.ReadFile(filepath.Join(root, "LICENSE"))
	if err != nil {
		return err
	}
	files = append(files, entry{"LICENSE.txt", crlf(license)})

	out := filepath.Join(root, "dist", extensionZip)
	stamp, dirty := commitTime(root)
	if err := writeZip(out, files, stamp); err != nil {
		return err
	}
	if err := verifyExtensionZip(out, dev); err != nil {
		os.Remove(out)
		return err
	}
	sum, size, err := sha256File(out)
	if err != nil {
		return err
	}
	if err := os.WriteFile(out+".sha256", []byte(sum+"  "+extensionZip+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Printf("Готово: %s (%.1f КБ)\n", out, float64(size)/1024)
	fmt.Printf("  версия %s, файлов %d, ID %s (как у версии для разработки — компаньон его пускает)\n", m["version"], len(files), id)
	fmt.Printf("  SHA-256 %s (файл %s.sha256)\n", sum, extensionZip)
	fmt.Println("  поле key на месте, ключей и служебных файлов нет, кода из интернета нет")
	printDirty(dirty)
	return nil
}

// verifyExtensionZip — готовый архив: manifest.json в корне, с key нужного ID, пути через «/».
func verifyExtensionZip(path, wantID string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		if strings.Contains(f.Name, `\`) {
			return fmt.Errorf("в архиве путь с «\\»: %s", f.Name)
		}
		names = append(names, f.Name)
		if f.Name != "manifest.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		var m map[string]any
		err = json.NewDecoder(rc).Decode(&m)
		rc.Close()
		if err != nil {
			return fmt.Errorf("manifest.json в архиве: %w", err)
		}
		key, _ := m["key"].(string)
		if id, err := idFromKey(key); err != nil || id != wantID {
			return fmt.Errorf("manifest.json в архиве: ID %q, нужен %q", id, wantID)
		}
	}
	sort.Strings(names)
	if i := sort.SearchStrings(names, "manifest.json"); i >= len(names) || names[i] != "manifest.json" {
		return errors.New("в корне архива нет manifest.json")
	}
	return nil
}
