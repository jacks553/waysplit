// Package hostlog — журнал компаньона (%LOCALAPPDATA%\Waysplit\host.log) и маскировка секретов.
//
// В stdout пакет ничего не пишет: в режиме native messaging там только сообщения для Chrome.
package hostlog

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// maxSize — после стольких байт журнал переезжает в host.log.old и начинается заново.
const maxSize = 1 << 20

var (
	mu      sync.Mutex
	out     *os.File
	outPath string
	written int64

	secMu   sync.RWMutex
	secrets []string
)

// Open открывает журнал host.log в папке dir. Без журнала компаньон тоже работает,
// поэтому ошибку можно только показать.
func Open(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	if out != nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	outPath = filepath.Join(dir, "host.log")
	if fi, err := os.Stat(outPath); err == nil && fi.Size() > maxSize {
		os.Rename(outPath, outPath+".old")
	}
	f, err := os.OpenFile(outPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if fi, err := f.Stat(); err == nil {
		written = fi.Size()
	}
	out = f
	return nil
}

// Close закрывает журнал.
func Close() {
	mu.Lock()
	defer mu.Unlock()
	if out != nil {
		out.Close()
		out = nil
	}
}

// Printf пишет строку в журнал, предварительно спрятав секреты.
func Printf(format string, args ...any) {
	line := time.Now().Format("2006-01-02 15:04:05") + " " + Mask(fmt.Sprintf(format, args...)) + "\n"
	mu.Lock()
	defer mu.Unlock()
	if out == nil {
		return
	}
	if written+int64(len(line)) > maxSize {
		out.Close()
		os.Rename(outPath, outPath+".old")
		f, err := os.OpenFile(outPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			out = nil
			return
		}
		out, written = f, 0
	}
	n, _ := out.WriteString(line)
	written += int64(n)
}

// AddSecret запоминает строку (пароль, uuid, адрес подписки), которую нельзя показывать
// в журнале и отчётах. Слишком короткие строки не запоминаются: они замаскировали бы лишнее.
func AddSecret(s string) {
	s = strings.TrimSpace(s)
	if len([]rune(s)) < 4 {
		return
	}
	secMu.Lock()
	defer secMu.Unlock()
	for _, x := range secrets {
		if x == s {
			return
		}
	}
	secrets = append(secrets, s)
}

var (
	linkRe = regexp.MustCompile(`(?i)\b(vless|vmess|trojan|ss|hysteria2|hy2|hysteria|tuic)://[^\s"'<>]+`)
	uuidRe = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
)

// Mask прячет секреты: запомненные через AddSecret, ссылки серверов и всё, что похоже на uuid.
func Mask(s string) string {
	s = linkRe.ReplaceAllStringFunc(s, MaskLink)
	secMu.RLock()
	for _, x := range secrets {
		s = strings.ReplaceAll(s, x, "***")
	}
	secMu.RUnlock()
	return uuidRe.ReplaceAllStringFunc(s, func(u string) string { return u[:4] + "…" })
}

// MaskLink показывает ссылку сервера без секретов: протокол, адрес и имя остаются,
// uuid сокращается до первых 4 символов, пароль и параметры (?…) скрываются.
//
//	vless://d47d7dee-…@vpn.example.com:443?pbk=…#Имя → vless://d47d…@vpn.example.com:443?…#Имя
func MaskLink(link string) string {
	i := strings.Index(link, "://")
	if i < 0 {
		return "***"
	}
	scheme, rest := link[:i], link[i+3:]
	name := ""
	if j := strings.IndexByte(rest, '#'); j >= 0 {
		name, rest = rest[j:], rest[:j]
		if d, err := url.PathUnescape(name); err == nil {
			name = d
		}
	}
	query := ""
	if j := strings.IndexByte(rest, '?'); j >= 0 {
		query, rest = "?…", rest[:j]
	}
	at := strings.LastIndexByte(rest, '@')
	if at < 0 {
		// Нет «uuid@адрес» — значит, всё внутри одним куском (vmess://, ss:// в base64),
		// вместе с секретами. Показываем только протокол и имя.
		return scheme + "://…" + name
	}
	user := rest[:at]
	if strings.EqualFold(scheme, "vless") && len(user) >= 8 {
		user = user[:4] + "…"
	} else {
		user = "***"
	}
	return scheme + "://" + user + "@" + rest[at+1:] + query + name
}

// MaskURL показывает адрес подписки без секретной части: https://sub.example.com/…
func MaskURL(u string) string {
	i := strings.Index(u, "://")
	if i < 0 {
		return "***"
	}
	rest := u[i+3:]
	if j := strings.IndexAny(rest, "/?#"); j >= 0 {
		return u[:i+3] + rest[:j] + "/…"
	}
	return u
}
