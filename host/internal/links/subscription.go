package links

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"

	"waysplit/host/internal/hostlog"
)

// DefaultUserAgent — с ним панели (Marzban, Remnawave) отдают список ссылок, а не веб-страницу.
const DefaultUserAgent = "v2rayN/7.0"

// maxBody — больше этого подписка не бывает; защита от случайной огромной страницы.
const maxBody = 10 << 20

// ErrDeviceInsecure — идентификатор устройства не отправляется по адресу без шифрования.
var ErrDeviceInsecure = errors.New("идентификатор устройства по адресу без шифрования (http://) не отправляется")

// SecureForDevice — можно ли слать по этому адресу идентификатор устройства: только по https
// (правила Chrome Web Store: данные пользователя — по защищённому соединению) или на этот же
// компьютер (localhost — так работают проверки).
func SecureForDevice(u *url.URL) bool {
	if u == nil {
		return false
	}
	if strings.EqualFold(u.Scheme, "https") {
		return true
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// hasDevice — в заголовках есть идентификатор устройства.
func hasDevice(h http.Header) bool { return h.Get("X-Hwid") != "" }

// SubInfo — трафик и срок из заголовка subscription-userinfo (байты; срок — Unix-время, 0 — бессрочно).
type SubInfo struct {
	Upload   int64 `json:"upload"`
	Download int64 `json:"download"`
	Total    int64 `json:"total"`
	Expire   int64 `json:"expire"`
}

// Subscription — что пришло по адресу подписки.
type Subscription struct {
	*TextResult
	Info                *SubInfo `json:"info,omitempty"`
	Title               string   `json:"title,omitempty"`
	UpdateIntervalHours int      `json:"updateIntervalHours,omitempty"`
	Announce            string   `json:"announce,omitempty"` // сообщение провайдера — обычный текст
	// Заглушки: «серверы», которые никуда не ведут (0.0.0.0, порт 1) — так панель вместо серверов
	// передаёт сообщение («App not supported»). В Servers их нет, здесь — их имена.
	Stubs     []string    `json:"stubs,omitempty"`
	HappCrypt int         `json:"happCrypt,omitempty"` // строк happ://crypt… (зашифровано для приложения Happ)
	Device    DeviceState `json:"device"`
	Format    string      `json:"format,omitempty"` // "" — список ссылок; FormatXray / FormatSingbox / FormatClash
}

// DeviceState — что панель сказала про привязку к устройствам (заголовки ответа Remnawave,
// docs.rw «HWID device limit»).
type DeviceState struct {
	Active       bool `json:"active"`       // x-hwid-active: привязка включена
	NotSupported bool `json:"notSupported"` // x-hwid-not-supported: клиент не прислал x-hwid
	MaxReached   bool `json:"maxReached"`   // x-hwid-max-devices-reached: лимит устройств заполнен
}

func deviceState(h http.Header) DeviceState {
	yes := func(k string) bool { return strings.EqualFold(strings.TrimSpace(h.Get(k)), "true") }
	return DeviceState{Active: yes("X-Hwid-Active"), NotSupported: yes("X-Hwid-Not-Supported"), MaxReached: yes("X-Hwid-Max-Devices-Reached")}
}

// HTTPError — сервер подписки ответил не 200 (и что он сказал про устройства: Remnawave
// без x-hwid может ответить 404).
type HTTPError struct {
	Status string
	Device DeviceState
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("подписка не скачалась: сервер ответил «%s»", e.Status)
}

// IsStubAddr — адрес «сервера»-заглушки: 0.0.0.0, ::, пусто или порт 0–1. 127.0.0.1 — не
// признак: на нём бывают настоящие (тестовые) серверы.
func IsStubAddr(addr string, port int) bool {
	switch strings.Trim(strings.ToLower(strings.TrimSpace(addr)), "[]") {
	case "", "0.0.0.0", "::":
		return true
	}
	return port <= 1
}

// IsStub — сервер-заглушка (см. IsStubAddr).
func (s *Server) IsStub() bool { return IsStubAddr(s.Address, s.Port) }

// FetchWith скачивает подписку и разбирает её. proxy — адрес локального прокси (например,
// http://127.0.0.1:27101), если качать надо через VPN; nil — напрямую. extra — дополнительные
// заголовки запроса (например, заголовки устройства x-hwid… для панелей с привязкой к
// устройствам, SPEC-SUBS.md). Сам запрос — Get (общий с проверкой подписки).
func FetchWith(ctx context.Context, rawURL, userAgent string, proxy *url.URL, extra http.Header) (*Subscription, error) {
	hostlog.AddSecret(rawURL)
	resp, err := Get(ctx, Request{URL: rawURL, UserAgent: userAgent, Proxy: proxy, Header: extra})
	switch {
	case errors.Is(err, ErrBadURL), errors.Is(err, ErrDeviceInsecure):
		return nil, err
	case err != nil:
		hostlog.Printf("подписка %s: %v", hostlog.MaskURL(rawURL), err)
		return nil, fmt.Errorf("подписка не скачалась: %s", shortNetError(err))
	case resp.Status != http.StatusOK:
		return nil, &HTTPError{Status: resp.StatusLine, Device: deviceState(resp.Header)}
	case resp.ReadErr != nil:
		return nil, fmt.Errorf("подписка не скачалась: %s", shortNetError(resp.ReadErr))
	case resp.TooBig:
		return nil, errors.New("подписка слишком большая (больше 10 МБ)")
	}
	body := resp.Body
	text := DecodeBody(body)
	// Xray / sing-box JSON и Clash YAML — в ссылки (formats.go); веб-страница — ошибка.
	conv, format, skipped, err := ConvertBody(text, resp.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	sub := &Subscription{TextResult: ParseText(conv), Device: deviceState(resp.Header), Format: format}
	sub.Errors = append(sub.Errors, skipped...)
	sub.Subscriptions = nil // адреса подписок внутри подписки не ходим
	servers := sub.Servers[:0]
	for _, s := range sub.Servers {
		if s.IsStub() {
			sub.Stubs = append(sub.Stubs, strings.Join(strings.Fields(hostlog.Mask(s.Name)), " "))
			continue
		}
		servers = append(servers, s)
	}
	sub.Servers = servers
	for _, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(l)), "happ://crypt") {
			sub.HappCrypt++
		}
	}
	sub.Info = ParseUserInfo(resp.Header.Get("Subscription-Userinfo"))
	sub.Title = DecodeTitle(resp.Header.Get("Profile-Title"))
	sub.Announce = CleanAnnounce(resp.Header.Get("Announce"))
	if h, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Profile-Update-Interval"))); err == nil && h > 0 {
		sub.UpdateIntervalHours = h
	}
	return sub, nil
}

var (
	colorRe   = regexp.MustCompile(`#[0-9A-Fa-f]{6}\b`)
	controlRe = regexp.MustCompile(`[\x00-\x09\x0B-\x1F\x7F]`)
)

// CleanAnnounce — сообщение провайдера (заголовок announce) обычным текстом: base64: раскодирован,
// пометки цвета «#RRGGBB» (так их понимает v2RayTun) и служебные символы убраны, не длиннее
// 500 символов. Ссылки остаются текстом: окно их не открывает.
func CleanAnnounce(h string) string {
	s := DecodeTitle(h)
	s = controlRe.ReplaceAllString(colorRe.ReplaceAllString(strings.ReplaceAll(s, "\r\n", "\n"), ""), " ")
	s = strings.TrimSpace(hostlog.Mask(s))
	if r := []rune(s); len(r) > 500 {
		s = string(r[:500]) + "…"
	}
	return s
}

// DecodeBody превращает тело подписки в текст со ссылками: это либо просто текст,
// либо base64 (обычный или URL-safe, с «=» на конце или без).
func DecodeBody(body []byte) string {
	text := strings.TrimPrefix(string(body), "\ufeff")
	if strings.Contains(text, "://") {
		return text
	}
	compact := strings.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, text)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(compact); err == nil && utf8.Valid(b) && strings.Contains(string(b), "://") {
			return string(b)
		}
	}
	return text
}

// ParseUserInfo: «upload=1; download=2; total=3; expire=4» → SubInfo. Нет заголовка — nil.
func ParseUserInfo(h string) *SubInfo {
	if strings.TrimSpace(h) == "" {
		return nil
	}
	info := &SubInfo{}
	found := false
	for _, part := range strings.Split(h, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64) // бывает «1.5e+10»
		if err != nil {
			continue
		}
		n := int64(f)
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "upload":
			info.Upload = n
		case "download":
			info.Download = n
		case "total":
			info.Total = n
		case "expire":
			info.Expire = n
		default:
			continue
		}
		found = true
	}
	if !found {
		return nil
	}
	return info
}

// DecodeTitle: заголовок profile-title бывает просто текстом или «base64:…».
func DecodeTitle(h string) string {
	h = strings.TrimSpace(h)
	if rest, ok := strings.CutPrefix(h, "base64:"); ok {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if b, err := enc.DecodeString(strings.TrimSpace(rest)); err == nil && utf8.Valid(b) {
				return strings.TrimSpace(string(b))
			}
		}
		return ""
	}
	return h
}

// NetError — причина сетевой ошибки по-русски (для других пакетов, например диагностики подписок).
func NetError(err error) string { return shortNetError(err) }

// shortNetError — причина по-русски вместо «dial tcp: lookup …: no such host».
func shortNetError(err error) string {
	var dnsErr *net.DNSError
	var ue *url.Error
	switch {
	case errors.As(err, &dnsErr):
		return "адрес сервера подписки не найден (" + dnsErr.Name + ")"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ue) && ue.Timeout():
		return "сервер подписки не ответил вовремя"
	case errors.Is(err, syscall.ECONNREFUSED), strings.Contains(err.Error(), "refused"):
		return "сервер подписки не принимает подключения"
	case strings.Contains(err.Error(), "certificate"):
		return "у сервера подписки неверный сертификат"
	}
	return hostlog.Mask(err.Error())
}
