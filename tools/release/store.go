package main

// Архив для Chrome Web Store (SPEC-STORE.md, 2.1). Магазин не принимает manifest с полем key,
// поэтому оно вырезается (в репозитории остаётся: у распакованной версии для разработки свой
// постоянный ID). Проверки — по документации магазина: manifest в корне архива, описание до
// 132 символов, значок 128×128 с рисунком 96×96 и прозрачными полями по 16 пикселей, в MV3 —
// никакого кода из интернета.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// keyLine — строка с полем key в manifest.json (вырезается целиком).
var keyLine = regexp.MustCompile(`(?m)^[ \t]*"key"[ \t]*:[ \t]*"[^"]*",?[ \t]*\r?\n`)

// stripKey убирает поле key, не трогая остальное оформление; проверяет, что получился тот же
// manifest без key.
func stripKey(raw []byte) ([]byte, map[string]any, error) {
	var orig map[string]any
	if err := json.Unmarshal(raw, &orig); err != nil {
		return nil, nil, fmt.Errorf("manifest.json — не JSON: %w", err)
	}
	out := keyLine.ReplaceAll(raw, nil)
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		return nil, nil, fmt.Errorf("manifest.json без key — не JSON: %w", err)
	}
	delete(orig, "key")
	if _, ok := got["key"]; ok || !reflect.DeepEqual(orig, got) {
		return nil, nil, errors.New("не удалось аккуратно вырезать key из manifest.json")
	}
	return out, got, nil
}

var versionRe = regexp.MustCompile(`^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$`)

// checkManifest — поля, которые магазин берёт из manifest.json и потом не даёт менять в панели.
func checkManifest(m map[string]any) []string {
	var bad []string
	str := func(k string) string { s, _ := m[k].(string); return s }
	if v, _ := m["manifest_version"].(float64); v != 3 {
		bad = append(bad, "manifest_version должен быть 3")
	}
	if n := utf8.RuneCountInString(str("name")); n == 0 || n > 75 {
		bad = append(bad, fmt.Sprintf("name: %d символов (нужно 1–75)", n))
	}
	if n := utf8.RuneCountInString(str("description")); n == 0 || n > 132 {
		bad = append(bad, fmt.Sprintf("description: %d символов (магазин берёт его как краткое описание, нужно 1–132)", n))
	}
	if !versionRe.MatchString(str("version")) {
		bad = append(bad, fmt.Sprintf("version %q: нужно до четырёх чисел через точку", str("version")))
	}
	for _, k := range []string{"key", "update_url"} {
		if _, ok := m[k]; ok {
			bad = append(bad, "в архиве для магазина не должно быть поля "+k)
		}
	}
	if icons, _ := m["icons"].(map[string]any); icons["128"] == nil {
		bad = append(bad, "нет значка 128 (icons.128)")
	}
	return bad
}

// manifestFiles — файлы, на которые ссылается manifest.json.
func manifestFiles(m map[string]any) []string {
	var out []string
	add := func(v any) {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	for _, v := range asMap(m["icons"]) {
		add(v)
	}
	action := asMap(m["action"])
	add(action["default_popup"])
	if icons, ok := action["default_icon"].(map[string]any); ok {
		for _, v := range icons {
			add(v)
		}
	} else {
		add(action["default_icon"])
	}
	add(asMap(m["options_ui"])["page"])
	add(asMap(m["background"])["service_worker"])
	sort.Strings(out)
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// skipFile — файлы, которые пользователю не нужны.
func skipFile(name string) bool {
	base := path.Base(name)
	return strings.HasPrefix(base, ".") || strings.EqualFold(base, "Thumbs.db") || strings.EqualFold(base, "desktop.ini") ||
		strings.HasSuffix(base, ".test.js") || strings.HasSuffix(base, ".map")
}

// remoteRules — признаки кода не из пакета расширения (developer.chrome.com, политики MV3:
// внешний <script>, eval и т. п.) и того, что CSP MV3 всё равно не пустит.
var remoteRules = []struct {
	re   *regexp.Regexp
	what string
	ext  string // в каких файлах искать: ".js", ".html", ".css"; пусто — во всех
}{
	{regexp.MustCompile(`(?i)<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?//`), "<script> с другого адреса", ".html"},
	{regexp.MustCompile(`(?i)<script\b[^>]*>\s*[^<\s]`), "встроенный <script> (в MV3 запрещён)", ".html"},
	{regexp.MustCompile(`(?i)\son[a-z]+\s*=\s*["']`), "обработчик в атрибуте (onclick=… в MV3 не работает)", ".html"},
	{regexp.MustCompile("\\bimport\\s*\\(\\s*['\"`]?(https?:)?//"), "import() с другого адреса", ".js"},
	{regexp.MustCompile(`\b(from|import)\s+['"](https?:)?//`), "import с другого адреса", ".js"},
	{regexp.MustCompile(`\bimportScripts\s*\(`), "importScripts", ".js"},
	{regexp.MustCompile(`\beval\s*\(`), "eval()", ".js"},
	{regexp.MustCompile(`\bnew\s+Function\s*\(`), "new Function()", ".js"},
	{regexp.MustCompile("\\bset(Timeout|Interval)\\s*\\(\\s*['\"`]"), "setTimeout/setInterval со строкой кода", ".js"},
	{regexp.MustCompile(`(?i)@import\s+(url\(\s*)?['"]?(https?:)?//`), "CSS @import с другого адреса", ".css"},
	{regexp.MustCompile(`(?i)url\(\s*['"]?(https?:)?//`), "CSS url() с другого адреса", ".css"},
	{regexp.MustCompile(`(?i)<link\b[^>]*\bhref\s*=\s*["']?(https?:)?//[^>]*>`), "<link> на другой адрес", ".html"},
}

// remoteCode — найденные нарушения: «файл: что».
func remoteCode(files []entry) []string {
	var bad []string
	for _, f := range files {
		ext := strings.ToLower(path.Ext(f.name))
		for _, r := range remoteRules {
			if r.ext != ext {
				continue
			}
			if loc := r.re.FindIndex(f.data); loc != nil {
				line := bytes.Count(f.data[:loc[0]], []byte("\n")) + 1
				bad = append(bad, fmt.Sprintf("%s:%d: %s", f.name, line, r.what))
			}
		}
	}
	return bad
}

// localRefs — src= и href= в HTML, которые ведут на файлы внутри расширения.
var refRe = regexp.MustCompile(`(?i)\b(?:src|href)\s*=\s*"([^"#?]+)"`)

func missingRefs(files []entry) []string {
	have := map[string]bool{}
	for _, f := range files {
		have[f.name] = true
	}
	var bad []string
	for _, f := range files {
		if !strings.HasSuffix(f.name, ".html") {
			continue
		}
		for _, m := range refRe.FindAllSubmatch(f.data, -1) {
			ref := string(m[1])
			if strings.Contains(ref, ":") || strings.HasPrefix(ref, "//") {
				continue // внешние ссылки (https:…) — это переходы, их ловит remoteCode, если это код
			}
			target := path.Clean(path.Join(path.Dir(f.name), ref))
			if strings.HasPrefix(ref, "/") {
				target = strings.TrimPrefix(path.Clean(ref), "/")
			}
			if !have[target] {
				bad = append(bad, fmt.Sprintf("%s → %s: файла нет", f.name, ref))
			}
		}
	}
	return bad
}

// checkStoreIcon — значок 128×128 по правилу магазина: рисунок 96×96, по 16 прозрачных пикселей.
func checkStoreIcon(data []byte) error {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("значок 128 — не PNG: %w", err)
	}
	b := img.Bounds()
	if b.Dx() != 128 || b.Dy() != 128 {
		return fmt.Errorf("значок 128 размером %d×%d", b.Dx(), b.Dy())
	}
	for y := 0; y < 128; y++ {
		for x := 0; x < 128; x++ {
			_, _, _, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			inArt := x >= 16 && x < 112 && y >= 16 && y < 112
			if !inArt && a != 0 {
				return fmt.Errorf("значок 128: пиксель (%d, %d) в полях не прозрачный (нужны поля по 16 пикселей)", x, y)
			}
		}
	}
	if _, _, _, a := img.At(b.Min.X+64, b.Min.Y+64).RGBA(); a == 0 {
		return errors.New("значок 128: в середине пусто")
	}
	return nil
}

// extensionFiles — файлы extension/ для архива: без скрытых папок и служебных файлов (skipFile).
// manifest — как есть (keepKey) или без поля key (магазин его не принимает); m — он же разобранный.
func extensionFiles(root string, keepKey bool) ([]entry, map[string]any, error) {
	extDir := filepath.Join(root, "extension")
	raw, err := os.ReadFile(filepath.Join(extDir, "manifest.json"))
	if err != nil {
		return nil, nil, err
	}
	clean, m, err := stripKey(raw)
	if err != nil {
		return nil, nil, err
	}
	if keepKey {
		clean = raw
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, nil, err
		}
	}
	var files []entry
	err = filepath.WalkDir(extDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(extDir, p)
		name := filepath.ToSlash(rel)
		if d.IsDir() {
			if name != "." && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if skipFile(name) {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if name == "manifest.json" {
			data = clean
		}
		files = append(files, entry{name, data})
		return nil
	})
	return files, m, err
}

// extensionProblems — общие проверки архива расширения: файлы из manifest.json на месте, кода из
// интернета нет, ссылки в HTML ведут на существующие файлы.
func extensionProblems(files []entry, m map[string]any) []string {
	var bad []string
	have := map[string][]byte{}
	for _, f := range files {
		have[f.name] = f.data
	}
	for _, ref := range manifestFiles(m) {
		if have[strings.TrimPrefix(ref, "/")] == nil {
			bad = append(bad, "manifest.json ссылается на "+ref+", а файла нет")
		}
	}
	if icon, _ := asMap(m["icons"])["128"].(string); icon != "" {
		if err := checkStoreIcon(have[icon]); err != nil {
			bad = append(bad, err.Error())
		}
	}
	bad = append(bad, remoteCode(files)...)
	bad = append(bad, missingRefs(files)...)
	return bad
}

func buildStore(root string, draft bool) error {
	files, m, err := extensionFiles(root, false)
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
	bad := append(checkManifest(m), extensionProblems(files, m)...)
	if len(bad) > 0 {
		return fmt.Errorf("архив для магазина не собран:\n  %s", strings.Join(bad, "\n  "))
	}

	version := m["version"].(string)
	out := filepath.Join(root, "store", "waysplit-"+version+".zip")
	stamp, dirty := commitTime(root)
	if err := writeZip(out, files, stamp); err != nil {
		return err
	}
	if err := verifyStoreZip(out); err != nil {
		os.Remove(out)
		return err
	}
	sum, size, err := sha256File(out)
	if err != nil {
		return err
	}
	fmt.Printf("Готово: %s\n", out)
	fmt.Printf("  версия %s, файлов %d, %.1f КБ, SHA-256 %s\n", version, len(files), float64(size)/1024, sum)
	fmt.Printf("  разрешения: %v; необязательные: %v; необязательные сайты: %v\n",
		m["permissions"], m["optional_permissions"], m["optional_host_permissions"])
	fmt.Println("  поле key убрано, кода из интернета нет, значок 128 — рисунок 96×96 с полями по 16 пикселей")
	printDirty(dirty)
	return nil
}

// verifyStoreZip — открыть готовый архив: manifest.json в корне, без key, пути через «/».
func verifyStoreZip(path string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	found := false
	for _, f := range zr.File {
		if strings.Contains(f.Name, `\`) {
			return fmt.Errorf("в архиве путь с «\\»: %s", f.Name)
		}
		if f.Name != "manifest.json" {
			continue
		}
		found = true
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
		if _, ok := m["key"]; ok {
			return errors.New("в архиве manifest.json с полем key")
		}
	}
	if !found {
		return errors.New("в корне архива нет manifest.json")
	}
	return nil
}
