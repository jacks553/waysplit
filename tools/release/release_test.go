package main

import (
	"archive/zip"
	"bytes"
	"debug/pe"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestStripKey(t *testing.T) {
	raw := []byte("{\n  \"name\": \"X\",\n  \"key\": \"MIIB+/=\",\n  \"version\": \"1.0.0\"\n}\n")
	out, m, err := stripKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\n  \"name\": \"X\",\n  \"version\": \"1.0.0\"\n}\n"; string(out) != want {
		t.Errorf("получилось:\n%s", out)
	}
	if _, ok := m["key"]; ok {
		t.Error("key остался")
	}
}

// Настоящий manifest.json: key вырезается, всё остальное — как было.
func TestStripKeyRealManifest(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "extension", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	out, m, err := stripKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out, []byte(`"key"`)) {
		t.Error("key остался")
	}
	if bad := checkManifest(m); len(bad) > 0 {
		t.Errorf("manifest.json не годится для магазина: %v", bad)
	}
	var orig map[string]any
	json.Unmarshal(raw, &orig)
	if len(orig) != len(m)+1 {
		t.Errorf("полей было %d, стало %d", len(orig), len(m))
	}
}

func TestCheckManifest(t *testing.T) {
	m := map[string]any{"manifest_version": 3.0, "name": "Waysplit", "version": "1.0.0",
		"description": strings.Repeat("я", 133), "icons": map[string]any{"128": "i.png"}, "key": "x"}
	bad := strings.Join(checkManifest(m), "\n")
	for _, want := range []string{"description: 133", "поля key"} {
		if !strings.Contains(bad, want) {
			t.Errorf("нет ошибки «%s» в:\n%s", want, bad)
		}
	}
	m["description"] = strings.Repeat("я", 132)
	delete(m, "key")
	if bad := checkManifest(m); len(bad) > 0 {
		t.Errorf("лишние ошибки: %v", bad)
	}
	m["version"] = "1.0.0.0.1"
	if bad := checkManifest(m); len(bad) != 1 {
		t.Errorf("версия из пяти чисел: %v", bad)
	}
}

func TestRemoteCode(t *testing.T) {
	bad := []entry{
		{"a.html", []byte(`<script src="https://cdn.example.com/x.js"></script>`)},
		{"b.html", []byte("<script>\nalert(1)\n</script>")},
		{"c.js", []byte("const m = await import('https://example.com/m.js');")},
		{"d.js", []byte("import x from 'https://example.com/x.js';")},
		{"e.js", []byte("eval(text)")},
		{"f.js", []byte("const f = new Function('a', body);")},
		{"g.js", []byte("setTimeout('run()', 10)")},
		{"h.css", []byte("@import url('https://fonts.example.com/a.css');")},
		{"i.css", []byte("body { background: url(https://example.com/bg.png); }")},
		{"j.html", []byte(`<button onclick="go()">`)},
		{"k.js", []byte("importScripts('x.js')")},
	}
	got := strings.Join(remoteCode(bad), "\n")
	for _, f := range bad {
		if !strings.Contains(got, f.name+":") {
			t.Errorf("в %s ничего не нашлось:\n%s", f.name, got)
		}
	}
	good := []entry{
		{"a.html", []byte(`<script type="module" src="popup.js"></script><a href="https://github.com/x">GitHub</a>`)},
		{"b.js", []byte("import { x } from './lib/x.js';\nconst URL = 'https://www.gstatic.com/generate_204';\nsetTimeout(() => go(), 10);\nretrieval(1);")},
		{"c.css", []byte("@font-face { src: url(../fonts/a.woff2); }")},
	}
	if got := remoteCode(good); len(got) > 0 {
		t.Errorf("ложные срабатывания: %v", got)
	}
}

func TestMissingRefs(t *testing.T) {
	files := []entry{
		{"popup/popup.html", []byte(`<link href="../lib/common.css"><script src="popup.js"></script><img src="../icons/nope.png"><a href="https://x.y/">x</a><a href="#top">`)},
		{"popup/popup.js", nil},
		{"lib/common.css", nil},
	}
	got := missingRefs(files)
	if len(got) != 1 || !strings.Contains(got[0], "nope.png") {
		t.Errorf("ждали только nope.png: %v", got)
	}
}

// ID расширения по полю key — как у Chrome: у ручной копии из выпуска тот же ID, что у версии
// для разработки (его пускает компаньон).
func TestIDFromKeyRealManifest(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "extension", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	key, _ := m["key"].(string)
	id, err := idFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := devExtensionID(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if id != dev || len(id) != 32 || strings.Trim(id, "abcdefghijklmnop") != "" {
		t.Errorf("ID по key %q, в host/extid.go %q", id, dev)
	}
	if _, err := idFromKey("не base64"); err == nil {
		t.Error("плохой key — ошибка")
	}
}

func TestSecretFiles(t *testing.T) {
	for _, n := range []string{"private-key.pem", "lib/x.key", "links.local.txt", "waysplit-backup-2026.json", "host.log", "a.bak"} {
		if !secretFile.MatchString(n) {
			t.Errorf("%s — не место в архиве расширения", n)
		}
	}
	for _, n := range []string{"popup/popup.js", "icons/icon128.png", "lib/domain-sets.json", "manifest.json", "fonts/LICENSE-TwemojiCountryFlags.md"} {
		if secretFile.MatchString(n) {
			t.Errorf("%s — обычный файл расширения", n)
		}
	}
}

func TestCRLFAndBOM(t *testing.T) {
	if got := string(crlf([]byte("a\nb\r\nc"))); got != "a\r\nb\r\nc" {
		t.Errorf("crlf: %q", got)
	}
	once := withBOM([]byte("x"))
	if !bytes.Equal(withBOM(once), once) || !bytes.HasPrefix(once, utf8BOM) {
		t.Error("BOM должна быть ровно одна")
	}
}

func TestLicenseFiles(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"LICENSE", "NOTICE", "PATENTS", "README.md", "license_test.go"} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644)
	}
	got, err := licenseFiles(dir)
	if err != nil || strings.Join(got, ",") != "LICENSE,NOTICE,PATENTS" {
		t.Errorf("%v %v", got, err)
	}
	empty := t.TempDir()
	os.WriteFile(filepath.Join(empty, "NOTICE"), []byte("x"), 0o644)
	if _, err := licenseFiles(empty); err == nil {
		t.Error("без LICENSE — ошибка")
	}
}

// Всё, что установщик копирует из архива, в архиве есть.
func TestSetupNamesInArchive(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "companion", "waysplit-setup.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	names, err := setupNames(script)
	if err != nil || len(names) == 0 {
		t.Fatalf("%v %v", names, err)
	}
	have := map[string]bool{hostExe: true, "THIRD-PARTY-LICENSES.txt": true, "CORES.txt": true, "SHA256SUMS.txt": true}
	for _, f := range archiveFiles {
		have[f.name] = true
	}
	cores, err := loadCores(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cores {
		for _, f := range c.Files {
			have[f.Name] = true
			if !slices.Contains(names, f.Name) {
				t.Errorf("%s из ядра %s установщик не копирует", f.Name, c.Name)
			}
		}
	}
	for _, n := range names {
		if !have[n] {
			t.Errorf("установщик ждёт %q, а в архив он не кладётся", n)
		}
	}
}

// Установщик работает без интернета: в нём нет ничего, что скачивает.
func TestSetupOffline(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "companion", "waysplit-setup.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	low := strings.ToLower(string(script))
	for _, s := range []string{"invoke-webrequest", "invoke-restmethod", "webclient", "start-bitstransfer", "curl", "wget", "https://", "http://"} {
		if strings.Contains(low, s) {
			t.Errorf("в установщике %q — он должен работать без интернета", s)
		}
	}
}

// tools/cores.json: у ядер есть лицензия и ссылки на исходный код; CORES.txt их называет.
func TestCoresSpec(t *testing.T) {
	cores, err := loadCores(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	text := string(coresText(cores, "https://github.com/x/waysplit"))
	for _, c := range cores {
		if licenseFileOf(c) == "(нет файла лицензии)" {
			t.Errorf("%s: нет файла лицензии", c.Name)
		}
		for _, s := range []string{c.Version, c.SourceTree, c.SourceArchive, c.SourceName, c.ZipSha256, licenseFileOf(c)} {
			if !strings.Contains(text, s) {
				t.Errorf("в CORES.txt нет %q", s)
			}
		}
		if !strings.Contains(c.SourceArchive, c.Version) || !strings.Contains(c.SourceTree, c.Version) || !strings.Contains(c.Zip, c.Version) {
			t.Errorf("%s: ссылки не на версию %s", c.Name, c.Version)
		}
	}
	if !strings.Contains(text, "sing-box-GPL-3.0.txt") {
		t.Error("в CORES.txt нет ссылки на полный текст GPL-3.0")
	}
}

func TestCoreEntries(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.exe"), []byte("core"), 0o644)
	spec := []coreSpec{{Name: "a", Files: []coreFile{{Name: "a.exe", Sha256: sha256Hex([]byte("core"))}}}}
	got, err := coreEntries(spec, dir)
	if err != nil || len(got) != 1 || string(got[0].data) != "core" {
		t.Fatalf("%v %v", got, err)
	}
	spec[0].Files[0].Sha256 = sha256Hex([]byte("other"))
	if _, err := coreEntries(spec, dir); err == nil || !strings.Contains(err.Error(), "не тот файл") {
		t.Errorf("другой файл — ошибка: %v", err)
	}
	spec[0].Files[0].Name = "b.exe"
	if _, err := coreEntries(spec, dir); err == nil || !strings.Contains(err.Error(), "нет b.exe") {
		t.Errorf("нет файла — ошибка: %v", err)
	}
}

// SHA256SUMS.txt — как у sha256sum: по алфавиту, «хеш  имя», LF; так его читает и установщик.
func TestSha256Sums(t *testing.T) {
	got := string(sha256Sums([]entry{{"б.txt", []byte("2")}, {"a.exe", []byte("1")}}))
	want := sha256Hex([]byte("1")) + "  a.exe\n" + sha256Hex([]byte("2")) + "  б.txt\n"
	if got != want {
		t.Errorf("получилось:\n%s", got)
	}
}

func TestVersionNumbers(t *testing.T) {
	if n, err := versionNumbers("1.2.3"); err != nil || n != [4]uint32{1, 2, 3, 0} {
		t.Errorf("1.2.3: %v %v", n, err)
	}
	for _, v := range []string{"", "1.x", "1.2.3.4.5", "70000.0.0", "1.-2"} {
		if _, err := versionNumbers(v); err == nil {
			t.Errorf("%q: ждали ошибку", v)
		}
	}
}

// Значок и сведения о версии: .syso читается обратно, а собранный с ним exe несёт и то и другое.
func TestWinres(t *testing.T) {
	ico, err := os.ReadFile(filepath.Join("..", "..", filepath.FromSlash(iconFile)))
	if err != nil {
		t.Fatal(err)
	}
	syso, err := winresObject(ico, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	items, err := readResources(syso)
	if err != nil {
		t.Fatal(err)
	}
	count := map[uint32]int{}
	for _, it := range items {
		count[it.typ]++
		if it.typ == rtVersion {
			strs, err := readVersionStrings(it.data)
			if err != nil {
				t.Fatal(err)
			}
			for _, kv := range versionStrings("1.2.3") {
				if strs[kv[0]] != kv[1] {
					t.Errorf("%s: %q, нужно %q", kv[0], strs[kv[0]], kv[1])
				}
			}
		}
	}
	icons := int(le.Uint16(ico[4:]))
	if count[rtIcon] != icons || count[rtGroupIcon] != 1 || count[rtVersion] != 1 {
		t.Errorf("ресурсы: %v (картинок в .ico — %d)", count, icons)
	}
	f, err := pe.NewFile(bytes.NewReader(syso))
	if err != nil {
		t.Fatal(err)
	}
	if s := f.Sections[0]; s.Name != ".rsrc" || len(s.Relocs) != len(items) {
		t.Errorf("секция %s, перемещений %d, нужно .rsrc и %d", s.Name, len(s.Relocs), len(items))
	}

	// Сборка с компоновщиком Go: тот же путь, что у waysplit-host.exe.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module x\n\ngo 1.21\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, sysoName), syso, 0o644)
	if out, err := goCmd(dir, "build", "-o", "x.exe", ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	exe, err := os.ReadFile(filepath.Join(dir, "x.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkExeResources(exe, "1.2.3"); err != nil {
		t.Error(err)
	}
	if err := checkExeResources(exe, "1.2.4"); err == nil {
		t.Error("другая версия — ошибка")
	}
}

func TestWriteZipUTF8Names(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.zip")
	stamp := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	if err := writeZip(path, []entry{{"Установить.cmd", []byte("x")}, {"dir/a.txt", []byte("y")}}, stamp); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	if zr.File[0].Name != "dir/a.txt" || zr.File[1].Name != "Установить.cmd" {
		t.Errorf("имена: %s, %s", zr.File[0].Name, zr.File[1].Name)
	}
	if zr.File[1].Flags&0x800 == 0 {
		t.Error("у русского имени нет флага UTF-8")
	}
	if !zr.File[0].Modified.Equal(stamp) {
		t.Errorf("время %v", zr.File[0].Modified)
	}
	if err := writeZip(path, []entry{{`a\b.txt`, nil}}, stamp); err == nil {
		t.Error("путь с «\\» — ошибка")
	}
}

// j — строка из частей: так проверочные значения не выглядят в исходнике как секреты и не попадают
// в «похожее на секреты» при проверке самого репозитория (go run ./release public).
func j(parts ...string) string { return strings.Join(parts, "") }

func TestSecretsFromLinks(t *testing.T) {
	uuid := j("11111111-2222-", "4333-8444-555555555555")
	data := []byte(strings.Join([]string{
		"# комментарий",
		j("vless://", uuid, "@srv.my-vpn.ru:443?security=reality&pbk=PUBKEYPUBKEY&sid=ab12cd34#NL"),
		j("hysteria2://", "hunter2hunter2@203.0.113.9:443?sni=a.example.com#HY"),
		"https://panel.my-vpn.ru/api/sub/SECRETTOKEN123?x=1",
		j("vless://", "uuid-uuid-uuid@nl.example.com:443#пример"),
	}, string(rune(10))))
	kinds := map[string]string{}
	for _, s := range secretsFromLinks(data, "links.local.txt") {
		kinds[s.value] = s.kind
	}
	for v, kind := range map[string]string{
		uuid:              "ключ или пароль сервера",
		"srv.my-vpn.ru":   "адрес сервера",
		"PUBKEYPUBKEY":    "параметр сервера pbk",
		"ab12cd34":        "параметр сервера sid",
		"hunter2hunter2":  "ключ или пароль сервера",
		"203.0.113.9":     "адрес сервера",
		"SECRETTOKEN123":  "токен подписки",
		"panel.my-vpn.ru": "адрес сервера",
		"https://panel.my-vpn.ru/api/sub/SECRETTOKEN123?x=1": "адрес подписки",
	} {
		if kinds[v] != kind {
			t.Errorf("%s: %q, нужно %q", v, kinds[v], kind)
		}
	}
	if _, ok := kinds["nl.example.com"]; ok {
		t.Error("адрес из примеров — не секрет")
	}
}

func TestPublicIPAndNames(t *testing.T) {
	for ip, want := range map[string]bool{j("8.8.", "8.8"): true, "127.0.0.1": false, "10.1.2.3": false, "192.168.1.1": false,
		"203.0.113.5": false, "198.51.100.1": false, "172.20.0.1": false, "100.64.1.1": false, j("1.14.", "4.0"): true, "999.1.1.1": false} {
		if got := publicIP(ip); got != want {
			t.Errorf("publicIP(%s) = %v", ip, got)
		}
	}
	for _, n := range []string{"PROGRESS.md", "SPEC.md", "SPEC-STORE.md"} {
		if !isPrivate(n) {
			t.Errorf("%s — внутренняя заметка", n)
		}
	}
	if isPrivate("README.md") || isPrivate("docs/SPEC.md") {
		t.Error("README и файлы в папках — не заметки")
	}
	for _, n := range []string{"links.local.txt", "tools/genkey/private-key.pem", "waysplit-backup-2026.json", "host/bin/sing-box.exe", "host.log"} {
		if !isForbidden(n) {
			t.Errorf("%s — запрещён", n)
		}
	}
	if isForbidden("extension/icons/icon128.png") || isForbidden("tools/release/main.go") {
		t.Error("обычные файлы — не запрещены")
	}
}

func TestLookalikes(t *testing.T) {
	uuid := j("0f8a1c2e-3b4d-", "4e5f-8a9b-0c1d2e3f4a5b")
	ip := j("8.8.", "4.4")
	mail := j("petr@", "yandex.ru")
	vmess := base64.StdEncoding.EncodeToString([]byte(`{"add":"` + j("vm.", "real-host.io") + `","port":443}`))
	text := strings.Join([]string{
		j("id ", uuid),
		j("ip ", ip, " и 127.0.0.1"),
		j("mail ivan@mail.example.com и ", mail),
		j("vless://x@", "real.server.io:443 vless://x@nl.example.com:443 vless://… hysteria2://${host}:1"),
		j("-----BEGIN RSA ", "PRIVATE KEY-----"),
		j("vmess://", vmess, " vmess://bm90IGpzb24="),
	}, string(rune(10)))
	got := map[string]string{}
	lookalikes("a.go", []byte(text), func(key, what, where string) { got[key] = what + " @ " + where })
	for _, k := range []string{"uuid " + uuid, "ip " + ip, "mail " + mail, "srv real.server.io", "key a.go:5", "srv vm.real-host.io"} {
		if got[k] == "" {
			t.Errorf("не нашлось %s", k)
		}
	}
	for k, v := range got {
		if strings.Contains(v, "yandex.ru") || strings.Contains(v, "0c1d2e3f4a5b") {
			t.Errorf("значение не сокращено: %s → %s", k, v)
		}
	}
	if len(got) != 6 {
		t.Errorf("лишнее: %v", got)
	}
}

// TestPublicUpdate — первая выгрузка создаёт репозиторий из одного коммита, следующая ложится
// новым коммитом поверх его истории: изменённые и новые файлы обновлены, удалённые пропали,
// внутренние заметки не попали, без -message коммит поверх истории не делается.
func TestPublicUpdate(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(t.TempDir(), "public")
	git := func(dir string, args ...string) string {
		t.Helper()
		full := append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false"}, args...)
		b, err := exec.Command("git", full...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, b)
		}
		return strings.TrimSpace(string(b))
	}
	write := func(name, text string) {
		t.Helper()
		p := filepath.Join(root, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git(root, "init", "-q", "-b", "main")
	write(".gitattributes", "* text=auto eol=lf\n") // как в проекте: иначе git archive отдаст CRLF при core.autocrlf
	write("README.md", "первая версия\n")
	write("docs/old.html", "старая страница\n")
	write("PROGRESS.md", "внутренние заметки\n")
	write("extension/manifest.json", `{"version": "1.0.0"}`)
	git(root, "add", "-A")
	git(root, "commit", "-q", "-m", "один")

	const author = "tester <1+tester@users.noreply.github.com>"
	if err := buildPublic(root, out, author, ""); err != nil {
		t.Fatal(err)
	}
	if n := git(out, "rev-list", "--count", "HEAD"); n != "1" {
		t.Fatalf("после первой выгрузки коммитов %s, нужен 1", n)
	}
	first := git(out, "rev-parse", "HEAD")

	write("README.md", "вторая версия\n")
	os.Remove(filepath.Join(root, "docs", "old.html"))
	write("docs/new.html", "новая страница\n")
	write("PROGRESS.md", "ещё заметки\n")
	git(root, "add", "-A")
	git(root, "commit", "-q", "-m", "два")

	if err := buildPublic(root, out, author, ""); err == nil || !strings.Contains(err.Error(), "-message") {
		t.Fatalf("без -message поверх истории — нужна ошибка, а не %v", err)
	}
	if err := buildPublic(root, out, author, "Документация"); err != nil {
		t.Fatal(err)
	}
	if n := git(out, "rev-list", "--count", "HEAD"); n != "2" {
		t.Fatalf("коммитов %s, нужно 2 (новый поверх прежнего)", n)
	}
	if parent := git(out, "rev-parse", "HEAD~1"); parent != first {
		t.Errorf("прежний коммит переписан: %s, был %s", parent, first)
	}
	if got := git(out, "log", "-1", "--format=%s|%ae|%ce"); got != "Документация|1+tester@users.noreply.github.com|1+tester@users.noreply.github.com" {
		t.Errorf("последний коммит: %s", got)
	}
	if got := git(out, "diff", "--name-status", "HEAD~1", "HEAD"); got != "M\tREADME.md\nA\tdocs/new.html\nD\tdocs/old.html" {
		t.Errorf("изменения:\n%s", got)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "README.md")); string(b) != "вторая версия\n" {
		t.Errorf("README.md: %q", b)
	}
	if _, err := os.Stat(filepath.Join(out, "PROGRESS.md")); err == nil {
		t.Error("внутренние заметки попали в выгрузку")
	}
	if st := git(out, "status", "--porcelain"); st != "" {
		t.Errorf("после коммита остались изменения: %s", st)
	}
	// Повтор без изменений — коммита нет.
	if err := buildPublic(root, out, author, "ничего"); err != nil {
		t.Fatal(err)
	}
	if n := git(out, "rev-list", "--count", "HEAD"); n != "2" {
		t.Errorf("без изменений появился коммит: %s", n)
	}
}
