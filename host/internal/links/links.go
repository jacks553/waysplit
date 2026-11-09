// Package links разбирает ссылки серверов (vless://, hysteria2:// и hy2://) и подписки.
//
// Разбор проверяет только саму ссылку. Поддерживает ли её конкретное ядро (sing-box),
// решает пакет singbox: так позже можно будет отдать часть серверов другому ядру.
// Новый протокол — это функция разбора в таблице parsers.
package links

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"waysplit/host/internal/hostlog"
)

// Server — разобранная ссылка сервера. Поля с json-тегами уходят в расширение,
// остальные нужны только для сборки конфига (расширение хранит саму ссылку).
type Server struct {
	Protocol  string   `json:"protocol"`  // "vless" | "hysteria2"
	Name      string   `json:"name"`      // из #фрагмента
	Address   string   `json:"address"`   // домен или IP (IPv6 без скобок)
	Port      int      `json:"port"`      // основной порт
	Transport string   `json:"transport"` // vless: tcp, ws, grpc, httpupgrade, http, xhttp…; hysteria2: udp
	Security  string   `json:"security"`  // none | tls | reality
	Link      string   `json:"link"`
	Warnings  []string `json:"warnings,omitempty"`

	// VLESS
	UUID       string `json:"-"`
	Flow       string `json:"-"`
	Encryption string `json:"-"`
	// Hysteria2
	Password     string      `json:"-"`
	Ports        []PortRange `json:"-"` // все порты и диапазоны, если их больше одного
	Obfs         string      `json:"-"`
	ObfsPassword string      `json:"-"`
	PinSHA256    string      `json:"-"`
	// TLS и Reality
	SNI         string   `json:"-"`
	ALPN        []string `json:"-"`
	Fingerprint string   `json:"-"` // fp
	Insecure    bool     `json:"-"`
	PublicKey   string   `json:"-"` // pbk
	ShortID     string   `json:"-"` // sid
	PQV         string   `json:"-"`
	SpiderX     string   `json:"-"` // spx (Reality)
	PinnedCert  string   `json:"-"` // pcs — SHA-256 сертификата (Xray: pinnedPeerCertSha256)
	VerifyName  string   `json:"-"` // vcn — имя для проверки сертификата (Xray: verifyPeerCertByName)
	// Транспорт
	HeaderType  string `json:"-"`
	Path        string `json:"-"`
	Host        string `json:"-"`
	ServiceName string `json:"-"`
	EarlyData   int    `json:"-"` // ?ed= из path у ws
	Mode        string `json:"-"` // xhttp: auto | packet-up | stream-up | stream-one
	Extra       string `json:"-"` // xhttp: JSON с дополнительными настройками (из ссылки, уже раскодирован)

	Ignored []string `json:"-"` // параметры, которые разбор не знает
	Line    int      `json:"-"` // номер строки в тексте, откуда взят сервер
}

// PortRange — порт или диапазон портов (From == To для одного порта).
type PortRange struct{ From, To int }

// HostPort — «адрес:порт», IPv6 в квадратных скобках.
func (s *Server) HostPort() string {
	if strings.Contains(s.Address, ":") {
		return "[" + s.Address + "]:" + strconv.Itoa(s.Port)
	}
	return s.Address + ":" + strconv.Itoa(s.Port)
}

// Key — по нему ищутся дубликаты и одинаковые серверы при обновлении подписки:
// протокол + адрес + порт + uuid/пароль.
func (s *Server) Key() string {
	secret := s.UUID
	if s.Protocol == "hysteria2" {
		secret = s.Password
	}
	return s.Protocol + "|" + strings.ToLower(s.Address) + "|" + strconv.Itoa(s.Port) + "|" + secret
}

// KeyHash — Key без секретов (16 hex-символов SHA-256): его хранит расширение, чтобы
// находить повторы и тот же сервер при обновлении подписки.
func (s *Server) KeyHash() string {
	sum := sha256.Sum256([]byte(s.Key()))
	return hex.EncodeToString(sum[:8])
}

type parseFunc func(r *rawLink, link string) (*Server, error)

var parsers = map[string]parseFunc{
	"vless":     parseVLESS,
	"hysteria2": parseHysteria2,
	"hy2":       parseHysteria2,
}

// Протоколы, которые узнаём, но пока не поддерживаем (SPEC, раздел 9).
var notYet = map[string]string{
	"vmess": "VMess", "trojan": "Trojan", "ss": "Shadowsocks", "ssr": "ShadowsocksR",
	"tuic": "TUIC", "hysteria": "Hysteria (первая версия)", "wireguard": "WireGuard", "wg": "WireGuard",
	"socks": "SOCKS", "socks5": "SOCKS", "anytls": "AnyTLS", "naive+https": "Naive",
}

// ErrSubscription — строка оказалась адресом подписки, а не ссылкой сервера.
var ErrSubscription = errors.New("это ссылка на подписку, а не на сервер")

// Parse разбирает одну ссылку сервера.
func Parse(line string) (*Server, error) {
	link := cleanLine(line)
	if link == "" {
		return nil, errors.New("пустая строка")
	}
	if IsSubscriptionURL(link) {
		return nil, ErrSubscription
	}
	scheme, _, ok := strings.Cut(link, "://")
	if !ok || scheme == "" {
		return nil, errors.New("не похоже на ссылку сервера")
	}
	p := parsers[strings.ToLower(scheme)]
	if p == nil {
		if name, ok := notYet[strings.ToLower(scheme)]; ok {
			return nil, fmt.Errorf("протокол %s пока не поддерживается", name)
		}
		return nil, errors.New("ссылка не распознана")
	}
	r, err := splitLink(link)
	if err != nil {
		return nil, err
	}
	s, err := p(r, link)
	if err != nil {
		return nil, err
	}
	hostlog.AddSecret(s.UUID)
	hostlog.AddSecret(s.Password)
	hostlog.AddSecret(s.ObfsPassword)
	if len(s.Ignored) > 0 {
		hostlog.Printf("%s: неизвестные параметры пропущены: %s", hostlog.MaskLink(link), strings.Join(s.Ignored, ", "))
	}
	return s, nil
}

// IsSubscriptionURL — строка начинается с http:// или https://.
func IsSubscriptionURL(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// LineError — строка, которую не удалось добавить, и причина.
type LineError struct {
	Line   int    `json:"line"`   // номер строки, с 1
	Text   string `json:"text"`   // строка без секретов, укороченная
	Reason string `json:"reason"` // понятная причина по-русски
}

// TextResult — итог разбора нескольких строк.
type TextResult struct {
	Servers       []*Server   `json:"servers"`
	Errors        []LineError `json:"errors"`
	Subscriptions []string    `json:"subscriptions,omitempty"` // адреса подписок из текста
}

// ParseText разбирает текст, где на каждой строке ссылка. Пустые строки и строки,
// начинающиеся с «#» или «//», пропускаются. Повторы одного сервера не добавляются.
func ParseText(text string) *TextResult {
	res := &TextResult{Servers: []*Server{}, Errors: []LineError{}}
	seen := map[string]int{}
	for i, line := range strings.Split(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(text), "\n") {
		line = cleanLine(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		if IsSubscriptionURL(line) {
			hostlog.AddSecret(line)
			res.Subscriptions = append(res.Subscriptions, line)
			continue
		}
		s, err := Parse(line)
		if err != nil {
			res.Errors = append(res.Errors, LineError{Line: i + 1, Text: Preview(line), Reason: err.Error()})
			continue
		}
		if first, dup := seen[s.Key()]; dup {
			res.Errors = append(res.Errors, LineError{Line: i + 1, Text: Preview(line), Reason: fmt.Sprintf("такой сервер уже есть (строка %d)", first)})
			continue
		}
		seen[s.Key()] = i + 1
		s.Line = i + 1
		res.Servers = append(res.Servers, s)
	}
	return res
}

// Preview — строка для сообщений об ошибке: без секретов и не длиннее 120 символов.
func Preview(line string) string {
	line = cleanLine(line)
	if strings.Contains(line, "://") {
		if IsSubscriptionURL(line) {
			line = hostlog.MaskURL(line)
		} else {
			line = hostlog.MaskLink(line)
		}
	} else {
		line = hostlog.Mask(line)
	}
	if r := []rune(line); len(r) > 120 {
		line = string(r[:117]) + "…"
	}
	return line
}

// cleanLine убирает по краям строки пробелы, BOM и невидимые символы, которые прилипают
// при копировании. Внутри строки их не трогаем: в эмодзи имени бывает невидимая склейка.
func cleanLine(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\ufeff', '\u200b', '\u200c', '\u200d', '\u2060':
			return true
		}
		return unicode.IsSpace(r)
	})
}

func defaultName(proto string, s *Server) string {
	return proto + " " + s.HostPort()
}
