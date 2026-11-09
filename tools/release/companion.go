package main

// Архив компаньона (SPEC-STORE.md, 1.2) — Waysplit-companion.zip для раздела Releases на GitHub.
// Имя без номера версии (решение автора): тогда постоянная ссылка
// https://github.com/<имя>/waysplit/releases/latest/download/Waysplit-companion.zip всегда ведёт
// на архив последнего выпуска (её открывает кнопка «Скачать» в расширении); версия — внутри
// («Прочитай меня.txt», waysplit-host.exe version, свойства файла).
//
// Внутри: собранный waysplit-host.exe (со значком и сведениями о версии — winres.go); ядра
// sing-box и Xray (cores.go: из официальных выпусков, сверенные по SHA-256, — установщику не нужен
// интернет); установщик (tools/companion), инструкция, лицензия Waysplit и полные тексты лицензий
// всего чужого кода, попавшего в exe (решение автора: их распространяем вместе с exe). Чужой код
// ищется при сборке (go list -deps), а не вручную: новая зависимость без файла лицензии остановит
// сборку. SHA256SUMS.txt — контрольные суммы всех файлов: по ним установщик проверяет, что архив
// распакован целиком и не повреждён.

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// archiveFiles — файлы установщика: откуда (от корня проекта) → имя в архиве. text — текст для
// Windows: переводы строк CRLF; bom — с меткой UTF-8 (PowerShell 5.1 без неё читает русские
// буквы неверно, старый Блокнот — тоже).
var archiveFiles = []struct {
	src, name string
	text, bom bool
}{
	{"tools/companion/install.cmd", "Установить.cmd", true, false},
	{"tools/companion/uninstall.cmd", "Удалить.cmd", true, false},
	{"tools/companion/waysplit-setup.ps1", "waysplit-setup.ps1", true, true},
	{"tools/companion/README.txt", "Прочитай меня.txt", true, true},
	{"LICENSE", "LICENSE.txt", true, false},
	{"tools/companion/GPL-3.0.txt", "sing-box-GPL-3.0.txt", true, false}, // в sing-box-LICENSE.txt — только уведомление
}

const hostExe = "waysplit-host.exe"

// companionZip — имя архива компаньона: одно для всех версий (постоянная ссылка на последний выпуск).
const companionZip = "Waysplit-companion.zip"

// goEnv — сборка только под Windows x64, без cgo (как и раньше в setup.ps1, но без путей
// с этого компьютера: -trimpath).
var goEnv = []string{"GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0"}

// goBinary — go из PATH; нет — из GOROOT или из обычного места установки (%LOCALAPPDATA%\Programs\go).
func goBinary() string {
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	if root := os.Getenv("GOROOT"); root != "" {
		return filepath.Join(root, "bin", "go.exe")
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "go", "bin", "go.exe")
}

func goCmd(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command(goBinary(), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), goEnv...)
	return cmd
}

var hostVersionRe = regexp.MustCompile(`(?m)^const version = "([^"]+)"`)

func hostVersion(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "host", "main.go"))
	if err != nil {
		return "", err
	}
	m := hostVersionRe.FindSubmatch(data)
	if m == nil {
		return "", fmt.Errorf("в host/main.go нет const version")
	}
	return string(m[1]), nil
}

// crlf — переводы строк Windows.
func crlf(data []byte) []byte {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	return bytes.ReplaceAll(data, []byte("\n"), []byte("\r\n"))
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func withBOM(data []byte) []byte {
	if bytes.HasPrefix(data, utf8BOM) {
		return data
	}
	return append(append([]byte{}, utf8BOM...), data...)
}

// --- лицензии чужого кода ---

type module struct{ path, version, dir string }

// depModules — модули, код которых попадает в exe (кроме самого Waysplit).
func depModules(hostDir string) ([]module, error) {
	out, err := goCmd(hostDir, "list", "-deps", "-f",
		`{{with .Module}}{{if not .Main}}{{.Path}}{{"\t"}}{{.Version}}{{"\t"}}{{.Dir}}{{end}}{{end}}`, ".").Output()
	if err != nil {
		return nil, fmt.Errorf("go list -deps: %w", err)
	}
	seen := map[string]bool{}
	var mods []module
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) != 3 || seen[f[0]] {
			continue
		}
		seen[f[0]] = true
		mods = append(mods, module{f[0], f[1], f[2]})
	}
	sort.Slice(mods, func(i, j int) bool { return mods[i].path < mods[j].path })
	return mods, nil
}

var (
	licenseName = regexp.MustCompile(`(?i)^(licen[cs]e|copying|notice|patents)([.\-_].*)?$`)
	mainLicense = regexp.MustCompile(`(?i)^(licen[cs]e|copying)`)
)

// licenseFiles — файлы лицензии в корне модуля; без LICENSE / COPYING — ошибка.
func licenseFiles(dir string) ([]string, error) {
	list, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	hasMain := false
	for _, e := range list {
		if e.IsDir() || !licenseName.MatchString(e.Name()) || strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		names = append(names, e.Name())
		hasMain = hasMain || mainLicense.MatchString(e.Name())
	}
	if !hasMain {
		return nil, fmt.Errorf("в %s нет файла LICENSE или COPYING", dir)
	}
	sort.Strings(names)
	return names, nil
}

// thirdPartyLicenses — текст THIRD-PARTY-LICENSES.txt: стандартная библиотека Go, модули и знак
// в значке exe (Material Symbols).
func thirdPartyLicenses(root string) ([]byte, []string, error) {
	hostDir := filepath.Join(root, "host")
	goroot, err := goCmd(hostDir, "env", "GOROOT").Output()
	if err != nil {
		return nil, nil, fmt.Errorf("go env GOROOT: %w", err)
	}
	gover, err := goCmd(hostDir, "env", "GOVERSION").Output()
	if err != nil {
		return nil, nil, fmt.Errorf("go env GOVERSION: %w", err)
	}
	mods, err := depModules(hostDir)
	if err != nil {
		return nil, nil, err
	}
	type part struct {
		title, url, dir string
		files           []string
	}
	parts := []part{{title: "Go standard library " + strings.TrimSpace(string(gover)), url: "https://go.dev", dir: strings.TrimSpace(string(goroot))}}
	for _, m := range mods {
		parts = append(parts, part{title: m.path + " " + m.version, url: "https://pkg.go.dev/" + m.path + "@" + m.version, dir: m.dir})
	}
	parts = append(parts, part{title: "Material Symbols (Google): знак call_split в значке waysplit-host.exe",
		url: "https://github.com/google/material-design-icons", dir: filepath.Join(root, "extension", "icons"),
		files: []string{"LICENSE-material-symbols.txt"}})
	var b strings.Builder
	b.WriteString("Чужой код и рисунки внутри waysplit-host.exe и полные тексты их лицензий\n")
	b.WriteString("Third-party code and artwork in waysplit-host.exe, with full license texts\n")
	b.WriteString(strings.Repeat("=", 80) + "\n\n")
	b.WriteString("Список составлен при сборке по go list -deps. Сам Waysplit — Apache License 2.0\n")
	b.WriteString("(LICENSE.txt). Ядра sing-box и Xray — отдельные программы, в waysplit-host.exe они\n")
	b.WriteString("не входят: лежат в архиве рядом, их лицензии и ссылки на исходный код — CORES.txt.\n")
	b.WriteString("Generated at build time from go list -deps. Waysplit itself is licensed under\n")
	b.WriteString("the Apache License 2.0 (LICENSE.txt). The sing-box and Xray cores are separate\n")
	b.WriteString("programs, not part of waysplit-host.exe; see CORES.txt for their licenses and sources.\n\n")
	b.WriteString("Состав / Contents:\n")
	var names []string
	for i := range parts {
		if parts[i].files == nil {
			files, err := licenseFiles(parts[i].dir)
			if err != nil {
				return nil, nil, fmt.Errorf("%s: %w", parts[i].title, err)
			}
			parts[i].files = files
		}
		b.WriteString("  - " + parts[i].title + "\n")
		names = append(names, parts[i].title)
	}
	for _, p := range parts {
		b.WriteString("\n\n" + strings.Repeat("#", 80) + "\n")
		b.WriteString(p.title + " — " + p.url + "\n")
		b.WriteString("Files: " + strings.Join(p.files, ", ") + "\n")
		b.WriteString(strings.Repeat("#", 80) + "\n")
		for _, f := range p.files {
			data, err := os.ReadFile(filepath.Join(p.dir, f))
			if err != nil {
				return nil, nil, err
			}
			b.WriteString("\n--- " + f + " ---\n\n")
			b.WriteString(strings.TrimRight(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") + "\n")
		}
	}
	return []byte(b.String()), names, nil
}

// --- сборка ---

// leaks — строки этого компьютера, которых не должно быть в exe (папка пользователя, проекта).
func leaks(exe []byte, root string) []string {
	low := bytes.ToLower(exe)
	var found []string
	for _, s := range []string{os.Getenv("USERPROFILE"), root, os.Getenv("GOPATH")} {
		if len(s) < 4 {
			continue
		}
		for _, v := range []string{s, filepath.ToSlash(s)} {
			if bytes.Contains(low, []byte(strings.ToLower(v))) {
				found = append(found, v)
			}
		}
	}
	if u := os.Getenv("USERNAME"); len(u) >= 3 {
		for _, v := range []string{`\users\` + u, `/users/` + u} {
			if bytes.Contains(low, []byte(strings.ToLower(v))) {
				found = append(found, v)
			}
		}
	}
	return found
}

// appFilesRe — список $AppFiles в установщике: эти файлы он копирует из архива.
var appFilesRe = regexp.MustCompile(`(?m)^\$AppFiles = @\(([^)]*)\)`)
var quotedRe = regexp.MustCompile(`'([^']+)'`)

// setupNames — какие файлы установщик ждёт в архиве (кроме $HostExe).
func setupNames(script []byte) ([]string, error) {
	m := appFilesRe.FindSubmatch(script)
	if m == nil {
		return nil, fmt.Errorf("в waysplit-setup.ps1 нет $AppFiles")
	}
	var names []string
	for _, q := range quotedRe.FindAllSubmatch(m[1], -1) {
		names = append(names, string(q[1]))
	}
	return names, nil
}

func buildCompanion(root, coresDir string, draft bool) error {
	version, err := hostVersion(root)
	if err != nil {
		return err
	}
	url, err := repoURL(root)
	if err != nil {
		return err
	}
	if err := checkPlaceholder(url, draft); err != nil {
		return err
	}
	cores, err := loadCores(root)
	if err != nil {
		return err
	}
	coreFiles, err := coreEntries(cores, coresDir)
	if err != nil {
		return err
	}
	icon, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(iconFile)))
	if err != nil {
		return fmt.Errorf("значок компаньона: %w (рисует go run ./icons)", err)
	}
	syso, err := winresObject(icon, version)
	if err != nil {
		return err
	}
	hostDir := filepath.Join(root, "host")

	tmp, err := os.MkdirTemp("", "waysplit-release-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	exePath := filepath.Join(tmp, hostExe)
	fmt.Println("собираю", hostExe, version)
	// Значок и сведения о версии: go build сам берёт *.syso из папки пакета. Файл живёт только на
	// время сборки (и в .gitignore), чтобы обычная сборка для разработки шла как раньше.
	sysoPath := filepath.Join(hostDir, sysoName)
	if err := os.WriteFile(sysoPath, syso, 0o644); err != nil {
		return err
	}
	defer os.Remove(sysoPath)
	build := goCmd(hostDir, "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", exePath, ".")
	build.Stdout, build.Stderr = os.Stdout, os.Stderr
	err = build.Run()
	os.Remove(sysoPath)
	if err != nil {
		return fmt.Errorf("go build: %w", err)
	}
	out, err := exec.Command(exePath, "version").Output()
	if err != nil {
		return fmt.Errorf("%s version: %w", hostExe, err)
	}
	if got := strings.TrimSpace(string(out)); got != "waysplit-host "+version {
		return fmt.Errorf("собранный компаньон говорит %q, ждали версию %s", got, version)
	}
	exe, err := os.ReadFile(exePath)
	if err != nil {
		return err
	}
	if bad := leaks(exe, root); len(bad) > 0 {
		return fmt.Errorf("в %s остались пути этого компьютера: %v", hostExe, bad)
	}
	if err := checkExeResources(exe, version); err != nil {
		return fmt.Errorf("%s: %w", hostExe, err)
	}

	licenses, mods, err := thirdPartyLicenses(root)
	if err != nil {
		return err
	}
	files := []entry{
		{hostExe, exe},
		{"THIRD-PARTY-LICENSES.txt", crlf(withBOM(licenses))},
	}
	for _, f := range archiveFiles {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(f.src)))
		if err != nil {
			return err
		}
		if f.name == "Прочитай меня.txt" {
			data = bytes.ReplaceAll(data, []byte("{{VERSION}}"), []byte(version))
			data = bytes.ReplaceAll(data, []byte("{{REPO_URL}}"), []byte(url))
			if bytes.Contains(data, []byte("{{")) {
				return fmt.Errorf("%s: осталась незаменённая {{…}}", f.src)
			}
		}
		if f.text {
			data = crlf(data)
		}
		if f.bom {
			data = withBOM(data)
		}
		files = append(files, entry{f.name, data})
	}
	files = append(files, coreFiles...)
	files = append(files, entry{"CORES.txt", crlf(withBOM(coresText(cores, url)))})
	files = append(files, entry{"SHA256SUMS.txt", sha256Sums(files)})
	inZip := map[string]bool{}
	for _, f := range files {
		inZip[f.name] = true
	}
	script, _ := os.ReadFile(filepath.Join(root, "tools", "companion", "waysplit-setup.ps1"))
	names, err := setupNames(script)
	if err != nil {
		return err
	}
	for _, n := range names {
		if !inZip[n] {
			return fmt.Errorf("установщик копирует %q, а в архиве такого файла нет", n)
		}
	}
	for _, c := range coreFiles {
		if !slices.Contains(names, c.name) {
			return fmt.Errorf("%s есть в архиве, а установщик его не копирует ($AppFiles в waysplit-setup.ps1)", c.name)
		}
	}

	name := companionZip
	zipPath := filepath.Join(root, "dist", name)
	stamp, dirty := commitTime(root)
	if err := writeZip(zipPath, files, stamp); err != nil {
		return err
	}
	sum, size, err := sha256File(zipPath)
	if err != nil {
		return err
	}
	if err := os.WriteFile(zipPath+".sha256", []byte(sum+"  "+name+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Printf("Готово: %s (%.1f МБ)\n", zipPath, float64(size)/(1<<20))
	fmt.Printf("  SHA-256 %s (файл %s.sha256)\n", sum, name)
	fmt.Println("  в архиве:")
	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	for _, f := range files {
		fmt.Printf("    %-28s %9d байт\n", f.name, len(f.data))
	}
	fmt.Println("  ядра (лицензии и исходный код — CORES.txt):")
	for _, c := range cores {
		fmt.Printf("    %s %s — %s\n", c.Name, c.Version, c.License)
	}
	fmt.Println("  чужой код в exe (лицензии — THIRD-PARTY-LICENSES.txt):")
	for _, m := range mods {
		fmt.Println("    " + m)
	}
	printDirty(dirty)
	return nil
}
