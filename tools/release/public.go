package main

// Публичный репозиторий (SPEC-STORE.md, 3): чистая история из одного коммита и проверка на
// секреты поиском по всем файлам (а не по .gitignore).
//
//	go run ./release public                  — выгрузить последний коммит в dist/public и проверить;
//	go run ./release public -author "Имя <123+имя@users.noreply.github.com>"
//	                                         — то же и git init + один коммит от служебного адреса GitHub.
//
// Выгружается то, что в последнем коммите (git archive HEAD), кроме внутренних заметок
// privateFiles: в них подробности о компьютере, провайдере и проверках автора.
//
// Проверка:
//   - запрещённые файлы: ссылки и подписки (*.local.*), ключи (*.pem, *.key), резервные копии,
//     журналы, программы и архивы;
//   - ваши секреты — их значения берутся из ваших файлов на этом компьютере (links.local.txt,
//     subs-test.local.txt и другие *.local.*, идентификатор устройства, почта из git, имя
//     пользователя Windows) и ищутся в каждом файле. Значения не печатаются — только где нашлось;
//   - похожее на секреты (UUID, публичные IP, почта, ссылки на серверы не из примеров, закрытые
//     ключи) — для просмотра глазами, значения сокращены.
// Ваш секрет или запрещённый файл — ошибка; похожее — список «посмотреть».

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// privateFiles — внутренние заметки автора: в публичный репозиторий не идут.
var privateFiles = []string{"PROGRESS.md", "SPEC*.md"}

// forbiddenNames — таких файлов в публичном репозитории быть не должно.
var forbiddenNames = []string{"*.local.*", "links.local.txt", "*.pem", "*.key", "*backup*.json", "*.bak", "*.log",
	"*.exe", "*.dll", "*.zip", ".env", "id_rsa*", "device-id", "private-key*"}

const publicMark = ".waysplit-public" // метка папки выгрузки: только её можно стирать перед новой

func isPrivate(name string) bool {
	for _, p := range privateFiles {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	return false
}

func isForbidden(name string) bool {
	base := strings.ToLower(path.Base(name))
	for _, p := range forbiddenNames {
		if ok, _ := path.Match(p, base); ok {
			return true
		}
	}
	return false
}

// --- ваши секреты ---

type secret struct {
	value, kind, source string
	fold                bool // искать без учёта регистра (адреса)
}

var exampleHost = regexp.MustCompile(`(?i)(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$`)

// secretsFromLinks — секреты из файла со ссылками и адресами подписок: ключи и пароли серверов,
// адреса серверов, адрес подписки и его токены.
func secretsFromLinks(data []byte, source string) []secret {
	var out []secret
	add := func(v, kind string, fold bool) {
		v = strings.TrimSpace(v)
		if len(v) >= 6 {
			out = append(out, secret{v, kind, source, fold})
		}
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || u.Scheme == "" {
			for _, f := range strings.Fields(line) {
				if len(f) >= 16 {
					add(f, "строка из файла", false)
				}
			}
			continue
		}
		host := u.Hostname()
		if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() || ip == nil && host != "" && !exampleHost.MatchString(host) {
			add(host, "адрес сервера", true)
		}
		if u.User != nil {
			add(u.User.Username(), "ключ или пароль сервера", false)
			if p, ok := u.User.Password(); ok {
				add(p, "пароль сервера", false)
			}
		}
		if u.Scheme == "http" || u.Scheme == "https" {
			add(strings.TrimRight(line, "/"), "адрес подписки", true)
			for _, seg := range strings.Split(u.Path, "/") {
				if len(seg) >= 8 {
					add(seg, "токен подписки", false)
				}
			}
			for _, vals := range u.Query() {
				for _, v := range vals {
					if len(v) >= 8 {
						add(v, "токен подписки", false)
					}
				}
			}
			continue
		}
		q := u.Query()
		for _, k := range []string{"pbk", "sid", "password", "obfs-password", "auth", "pcs", "spx"} {
			if v := q.Get(k); v != "" {
				add(v, "параметр сервера "+k, false)
			}
		}
	}
	return out
}

// mySecrets — что искать: из *.local.* в папке проекта, идентификатор устройства, почта из git,
// папка пользователя Windows.
func mySecrets(root string) ([]secret, []string) {
	var out []secret
	var sources []string
	files, _ := filepath.Glob(filepath.Join(root, "*.local.*"))
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		sources = append(sources, filepath.Base(f))
		out = append(out, secretsFromLinks(data, filepath.Base(f))...)
	}
	if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
		if data, err := os.ReadFile(filepath.Join(dir, "Waysplit", "device-id")); err == nil {
			for _, f := range strings.Fields(string(data)) {
				if len(f) >= 10 {
					out = append(out, secret{f, "идентификатор устройства", "device-id", false})
				}
			}
			sources = append(sources, "device-id")
		}
	}
	emails := map[string]bool{}
	if b, err := exec.Command("git", "-C", root, "config", "user.email").Output(); err == nil {
		emails[strings.TrimSpace(string(b))] = true
	}
	if b, err := exec.Command("git", "-C", root, "log", "--format=%ae%n%ce").Output(); err == nil {
		for _, e := range strings.Fields(string(b)) {
			emails[e] = true
		}
	}
	for e := range emails {
		if e != "" && !strings.HasSuffix(e, "@users.noreply.github.com") && !strings.HasSuffix(e, "@anthropic.com") {
			out = append(out, secret{e, "почта из git", "git", true})
		}
	}
	sources = append(sources, "почта из git")
	if p := os.Getenv("USERPROFILE"); len(p) > 3 {
		out = append(out, secret{p, "папка пользователя Windows", "USERPROFILE", true})
		out = append(out, secret{filepath.ToSlash(p), "папка пользователя Windows", "USERPROFILE", true})
		if u := os.Getenv("USERNAME"); len(u) >= 3 {
			out = append(out, secret{`\Users\` + u, "имя пользователя Windows", "USERNAME", true})
			out = append(out, secret{`/Users/` + u, "имя пользователя Windows", "USERNAME", true})
		}
	}
	// Без повторов.
	seen := map[string]bool{}
	uniq := out[:0]
	for _, s := range out {
		if !seen[s.value] {
			seen[s.value] = true
			uniq = append(uniq, s)
		}
	}
	return uniq, sources
}

// --- похожее на секреты ---

var (
	uuidRe   = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	ipv4Re   = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	emailRe  = regexp.MustCompile(`(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b`)
	keyRe    = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)
	serverRe = regexp.MustCompile(`(?i)\b(vless|vmess|trojan|ss|hysteria2|hy2|tuic)://[^\s"'<>` + "`" + `]+`)
	anyURLRe = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://\S+`) // «ключ@сервер» в ссылках — не почта
)

// publicIP — адрес в интернете (не частный, не локальный, не из диапазонов для документации).
func publicIP(s string) bool {
	ip := net.ParseIP(s).To4()
	if ip == nil {
		return false
	}
	for _, c := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"} {
		if _, n, _ := net.ParseCIDR(c); n.Contains(ip) {
			return false
		}
	}
	return true
}

// mask — значение для показа: начало и конец.
func mask(s string) string {
	r := []rune(s)
	if len(r) <= 8 {
		return string(r[:min(2, len(r))]) + "…"
	}
	return string(r[:4]) + "…" + string(r[len(r)-4:])
}

type finding struct {
	what  string
	where []string
}

// lookalikes — UUID, публичные IP, почта, ссылки на серверы не из примеров, закрытые ключи.
func lookalikes(name string, data []byte, add func(key, what, where string)) {
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		where := fmt.Sprintf("%s:%d", name, i+1)
		for _, m := range uuidRe.FindAllString(line, -1) {
			if strings.Trim(m, "0-") != "" {
				add("uuid "+strings.ToLower(m), "UUID "+mask(m), where)
			}
		}
		for _, m := range ipv4Re.FindAllString(line, -1) {
			if publicIP(m) {
				add("ip "+m, "IP "+mask(m), where)
			}
		}
		for _, m := range emailRe.FindAllString(anyURLRe.ReplaceAllString(line, " "), -1) {
			host := m[strings.LastIndex(m, "@")+1:]
			if !exampleHost.MatchString(host) && !strings.HasSuffix(strings.ToLower(host), "users.noreply.github.com") && !strings.HasSuffix(strings.ToLower(host), "anthropic.com") {
				add("mail "+strings.ToLower(m), "почта "+mask(m), where)
			}
		}
		if keyRe.MatchString(line) {
			add("key "+where, "закрытый ключ", where)
		}
		for _, m := range serverRe.FindAllString(line, -1) {
			h := serverHost(m)
			ip := net.ParseIP(h)
			if ip == nil && !hostnameRe.MatchString(h) || exampleHost.MatchString(h) || ip != nil && !publicIP(h) {
				continue // «vless://…» в тексте, шаблоны, примеры, локальные адреса
			}
			add("srv "+strings.ToLower(h), "ссылка на сервер "+mask(h), where)
		}
	}
}

// hostnameRe — похоже на настоящее имя сервера: латиница, цифры, дефисы, хотя бы одна точка.
var hostnameRe = regexp.MustCompile(`(?i)^[a-z0-9-]+(\.[a-z0-9-]+)+$`)

// serverHost — адрес сервера из ссылки; у vmess:// он внутри base64-JSON (поле add).
func serverHost(link string) string {
	if strings.HasPrefix(strings.ToLower(link), "vmess://") {
		payload := link[len("vmess://"):]
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if raw, err := enc.DecodeString(payload); err == nil {
				var v struct {
					Add string `json:"add"`
				}
				if json.Unmarshal(raw, &v) == nil {
					return strings.Trim(v.Add, "[]")
				}
			}
		}
		return ""
	}
	u, err := url.Parse(link)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// --- выгрузка ---

func gitOut(root string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", root}, args...)...).Output()
	return strings.TrimSpace(string(out)), err
}

var noreplyRe = regexp.MustCompile(`^(.+?) <((\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com)>$`)

func buildPublic(root, out, author, message string) error {
	if st, _ := gitOut(root, "status", "--porcelain"); st != "" {
		return errors.New("есть незакоммиченные изменения: выгружается последний коммит — сначала закоммитьте")
	}
	var authorName, authorEmail string
	if author != "" {
		m := noreplyRe.FindStringSubmatch(author)
		if m == nil {
			return fmt.Errorf("-author: нужен служебный адрес GitHub, вида \"Имя <123456+имя@users.noreply.github.com>\"")
		}
		authorName, authorEmail = m[1], m[2]
	}
	head, err := gitOut(root, "rev-parse", "--short", "HEAD")
	if err != nil {
		return fmt.Errorf("git: %w", err)
	}

	// Папка выгрузки: новая или наша прежняя (с меткой).
	if _, err := os.Stat(out); err == nil {
		if _, err := os.Stat(filepath.Join(out, publicMark)); err != nil {
			return fmt.Errorf("%s уже есть и это не прежняя выгрузка — выберите другую папку (-out)", out)
		}
		if err := os.RemoveAll(out); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, publicMark), []byte("выгрузка tools/release public; можно удалить\n"), 0o644); err != nil {
		return err
	}

	cmd := exec.Command("git", "-C", root, "archive", "--format=tar", "HEAD")
	tarData, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("git archive: %w", err)
	}
	tr := tar.NewReader(bytes.NewReader(tarData))
	var names, skipped, forbidden []string
	texts := map[string][]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		name := h.Name
		if isPrivate(name) {
			skipped = append(skipped, name)
			continue
		}
		if isForbidden(name) {
			forbidden = append(forbidden, name)
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			return err
		}
		dst := filepath.Join(out, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
		names = append(names, name)
		if !bytes.Contains(data, []byte{0}) {
			texts[name] = data
		}
	}
	// Проверка.
	secrets, sources := mySecrets(root)
	var hits []string
	look := map[string]*finding{}
	var lookKeys []string
	for _, name := range names {
		data, ok := texts[name]
		if !ok {
			continue
		}
		low := bytes.ToLower(data)
		for i, s := range secrets {
			hay, needle := data, []byte(s.value)
			if s.fold {
				hay, needle = low, bytes.ToLower(needle)
			}
			if idx := bytes.Index(hay, needle); idx >= 0 {
				line := bytes.Count(data[:idx], []byte("\n")) + 1
				hits = append(hits, fmt.Sprintf("%s:%d — %s №%d (из %s)", name, line, s.kind, i+1, s.source))
			}
		}
		lookalikes(name, data, func(key, what, where string) {
			f := look[key]
			if f == nil {
				f = &finding{what: what}
				look[key] = f
				lookKeys = append(lookKeys, key)
			}
			f.where = append(f.where, where)
		})
	}

	fmt.Printf("Выгружено %d файлов из коммита %s в %s\n", len(names), head, out)
	fmt.Printf("Не выгружены (внутренние заметки): %s\n", strings.Join(skipped, ", "))
	fmt.Printf("Ваши секреты для поиска: %d значений из %s (значения не печатаются)\n", len(secrets), strings.Join(sources, ", "))
	sort.Strings(hits)
	if len(forbidden) > 0 {
		fmt.Println("ЗАПРЕЩЁННЫЕ ФАЙЛЫ:")
		for _, f := range forbidden {
			fmt.Println("  " + f)
		}
	} else {
		fmt.Println("Запрещённых файлов (ссылки, ключи, копии, журналы, программы, архивы): нет")
	}
	if len(hits) > 0 {
		fmt.Println("НАЙДЕНЫ ВАШИ СЕКРЕТЫ:")
		for _, h := range hits {
			fmt.Println("  " + h)
		}
	} else {
		fmt.Println("Ваших секретов (ссылки, ключи, адреса серверов и подписки, идентификатор устройства, почта, папка пользователя): нет")
	}
	sort.Strings(lookKeys)
	if len(lookKeys) > 0 {
		fmt.Println("Похоже на секреты — посмотрите глазами (значения сокращены):")
		for _, k := range lookKeys {
			f := look[k]
			where := f.where
			more := ""
			if len(where) > 3 {
				more = fmt.Sprintf(" и ещё %d", len(where)-3)
				where = where[:3]
			}
			fmt.Printf("  %s — %s%s\n", f.what, strings.Join(where, ", "), more)
		}
	} else {
		fmt.Println("Похожего на секреты (UUID, публичные IP, почта, ссылки на серверы, закрытые ключи): нет")
	}
	if len(forbidden) > 0 || len(hits) > 0 {
		return errors.New("в выгрузке есть то, чего не должно быть в публичном репозитории (список выше)")
	}

	if author == "" {
		fmt.Println("Репозиторий не создан: для него нужен -author \"Имя <ID+имя@users.noreply.github.com>\".")
		return nil
	}
	env := append(os.Environ(), "GIT_AUTHOR_NAME="+authorName, "GIT_AUTHOR_EMAIL="+authorEmail,
		"GIT_COMMITTER_NAME="+authorName, "GIT_COMMITTER_EMAIL="+authorEmail)
	gitInit := exec.Command("git", "-C", out, "init", "-q", "-b", "main")
	gitInit.Env = env
	if b, err := gitInit.CombinedOutput(); err != nil {
		return fmt.Errorf("git init: %v\n%s", err, b)
	}
	// Метка папки выгрузки — не для репозитория.
	if err := os.WriteFile(filepath.Join(out, ".git", "info", "exclude"), []byte(publicMark+"\n"), 0o644); err != nil {
		return err
	}
	if strings.TrimSpace(message) == "" {
		message = "Waysplit " + mustManifestVersion(root)
	}
	for _, args := range [][]string{
		{"add", "-A"},
		{"-c", "user.name=" + authorName, "-c", "user.email=" + authorEmail,
			"commit", "-q", "-m", strings.ReplaceAll(message, "\r\n", "\n")},
	} {
		c := exec.Command("git", append([]string{"-C", out}, args...)...)
		c.Env = env
		if b, err := c.CombinedOutput(); err != nil {
			return fmt.Errorf("git %s: %v\n%s", args[0], err, b)
		}
	}
	ids, _ := gitOut(out, "log", "--format=%an <%ae> / %cn <%ce>")
	fmt.Printf("Создан репозиторий %s: один коммит, автор и коммиттер — %s\n", out, ids)
	return nil
}

var manifestVersionRe = regexp.MustCompile(`"version"\s*:\s*"([^"]+)"`)

func mustManifestVersion(root string) string {
	data, _ := os.ReadFile(filepath.Join(root, "extension", "manifest.json"))
	if m := manifestVersionRe.FindSubmatch(data); m != nil {
		return string(m[1])
	}
	return ""
}
