package main

// Ядра в архиве компаньона (решение автора 2026-11-08: GitHub из России работает с перебоями, а
// установщик, который качает ядра с GitHub, у пользователя ломается). sing-box и Xray лежат в
// архиве готовыми — из официальных выпусков, сверенные по SHA-256 из tools/cores.json, рядом —
// их лицензии и ссылки на исходный код именно этих версий (CORES.txt); архивы исходников
// прикладываются к выпуску на GitHub (tools/ci.ps1 -Sources).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type coreFile struct {
	From   string `json:"from"`   // путь в официальном архиве
	Name   string `json:"name"`   // имя в архиве компаньона
	Sha256 string `json:"sha256"` // SHA-256 самого файла
}

type coreSpec struct {
	Name          string     `json:"name"`
	Version       string     `json:"version"`
	Author        string     `json:"author"`
	License       string     `json:"license"`
	Zip           string     `json:"zip"`
	ZipSha256     string     `json:"zipSha256"`
	SourceTree    string     `json:"sourceTree"`
	SourceArchive string     `json:"sourceArchive"`
	SourceName    string     `json:"sourceName"`
	Files         []coreFile `json:"files"`
}

// loadCores — tools/cores.json.
func loadCores(root string) ([]coreSpec, error) {
	data, err := os.ReadFile(filepath.Join(root, "tools", "cores.json"))
	if err != nil {
		return nil, err
	}
	var spec struct {
		Cores []coreSpec `json:"cores"`
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("tools/cores.json: %w", err)
	}
	if len(spec.Cores) == 0 {
		return nil, fmt.Errorf("tools/cores.json: нет ядер")
	}
	for _, c := range spec.Cores {
		if c.Name == "" || c.Version == "" || len(c.ZipSha256) != 64 || c.SourceTree == "" || c.SourceArchive == "" || len(c.Files) == 0 {
			return nil, fmt.Errorf("tools/cores.json: у ядра %q не хватает полей", c.Name)
		}
		for _, f := range c.Files {
			if f.Name == "" || len(f.Sha256) != 64 {
				return nil, fmt.Errorf("tools/cores.json: у файла %q ядра %s нет имени или SHA-256", f.From, c.Name)
			}
		}
	}
	return spec.Cores, nil
}

// coreEntries — файлы ядер из папки dir для архива; у каждого SHA-256 должна совпасть с cores.json.
func coreEntries(cores []coreSpec, dir string) ([]entry, error) {
	var out []entry
	for _, c := range cores {
		for _, f := range c.Files {
			data, err := os.ReadFile(filepath.Join(dir, f.Name))
			if err != nil {
				return nil, fmt.Errorf("нет %s в %s: соберите через tools\\build-companion.ps1 — он положит туда ядра из официальных выпусков (tools\\cores.json)", f.Name, dir)
			}
			if got := sha256Hex(data); got != f.Sha256 {
				return nil, fmt.Errorf("%s в %s — не тот файл (SHA-256 %s, а в tools/cores.json — %s)", f.Name, dir, got, f.Sha256)
			}
			out = append(out, entry{f.Name, data})
		}
	}
	return out, nil
}

// coresText — CORES.txt в архиве: какие ядра, откуда, по какой лицензии и где их исходный код.
func coresText(cores []coreSpec, repoURL string) []byte {
	var b strings.Builder
	b.WriteString("Ядра Waysplit / Waysplit cores\n")
	b.WriteString(strings.Repeat("=", 80) + "\n\n")
	b.WriteString("Waysplit подключается к серверам через два ядра — отдельные программы с открытым\n")
	b.WriteString("исходным кодом. Они лежат в этом архиве без изменений, из официальных выпусков их\n")
	b.WriteString("авторов; при сборке SHA-256 архивов выпусков и каждого файла сверены. Waysplit\n")
	b.WriteString("запускает их как отдельные программы.\n")
	b.WriteString("Waysplit runs two open-source cores as separate programs. They are included here\n")
	b.WriteString("unmodified, taken from their authors' official releases (SHA-256 of the release\n")
	b.WriteString("archives and of every file verified at build time).\n")
	for _, c := range cores {
		b.WriteString("\n" + strings.Repeat("-", 80) + "\n")
		b.WriteString(fmt.Sprintf("%s %s — %s\n", c.Name, c.Version, c.Author))
		switch c.License {
		case "GPL-3.0-or-later":
			b.WriteString("Лицензия / License: GNU GPL версии 3 или новее, с дополнительным условием\n")
			b.WriteString("  об имени — см. " + licenseFileOf(c) + "; полный текст GPL-3.0 — sing-box-GPL-3.0.txt.\n")
		case "MPL-2.0":
			b.WriteString("Лицензия / License: Mozilla Public License 2.0 — " + licenseFileOf(c) + ".\n")
		default:
			b.WriteString("Лицензия / License: " + c.License + " — " + licenseFileOf(c) + ".\n")
		}
		b.WriteString("Исходный код этой версии / Source code of this version:\n")
		b.WriteString("  " + c.SourceTree + "\n")
		b.WriteString("  архив / archive: " + c.SourceArchive + "\n")
		b.WriteString("  копия на странице выпуска Waysplit / copy on the Waysplit release page:\n")
		b.WriteString("  " + repoURL + "/releases — " + c.SourceName + "\n")
		b.WriteString("Официальный выпуск / Official release: " + c.Zip + "\n")
		b.WriteString("  SHA-256: " + c.ZipSha256 + "\n")
		b.WriteString("Файлы / Files:\n")
		for _, f := range c.Files {
			b.WriteString("  " + f.Name + " — SHA-256 " + f.Sha256 + "\n")
		}
	}
	return []byte(b.String())
}

func licenseFileOf(c coreSpec) string {
	for _, f := range c.Files {
		if strings.Contains(strings.ToLower(f.Name), "license") {
			return f.Name
		}
	}
	return "(нет файла лицензии)"
}

// sha256Sums — SHA256SUMS.txt: «хеш  имя» для каждого файла архива, по алфавиту (по ним установщик
// проверяет, что архив распакован целиком и не повреждён). Формат — как у sha256sum: переводы
// строк LF, без BOM, имена в UTF-8 — так его можно проверить и командой sha256sum -c.
func sha256Sums(files []entry) []byte {
	names := make([]string, 0, len(files))
	for _, f := range files {
		names = append(names, sha256Hex(f.data)+"  "+f.name+"\n")
	}
	sort.Slice(names, func(i, j int) bool { return names[i][66:] < names[j][66:] })
	return []byte(strings.Join(names, ""))
}
