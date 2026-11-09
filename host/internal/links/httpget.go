package links

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Request — запрос к адресу подписки.
type Request struct {
	URL       string
	UserAgent string        // "" — DefaultUserAgent
	Proxy     *url.URL      // nil — напрямую; иначе через локальный прокси (порт сервера в ядре)
	Header    http.Header   // свои заголовки (например, устройства: x-hwid… — только по https)
	Timeout   time.Duration // на весь запрос; 0 — 50 с
}

// Response — ответ сервера подписки. Тело — не больше 10 МБ (TooBig — было больше); ReadErr —
// тело оборвалось на середине. Redirects — сколько было перенаправлений.
type Response struct {
	Status     int
	StatusLine string // «404 Not Found»
	Header     http.Header
	Body       []byte
	TooBig     bool
	ReadErr    error
	Redirects  int
}

// ErrBadURL — адрес подписки не разобрать.
var ErrBadURL = errors.New("неверный адрес подписки")

// Get — общее для скачивания подписки (FetchWith) и её проверки (пакет subinfo): запрос,
// перенаправления (не больше 10; заголовки Go переносит на новый адрес, поэтому идентификатор
// устройства — только по https и после перенаправлений), чтение не больше 10 МБ.
// Ошибка — ответа не было вовсе (адрес, сеть, ErrDeviceInsecure); код не 200 — не ошибка.
func Get(ctx context.Context, r Request) (*Response, error) {
	ua := r.UserAgent
	if ua == "" {
		ua = DefaultUserAgent
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSpace(r.URL), nil)
	if err != nil {
		return nil, ErrBadURL
	}
	for k, v := range r.Header {
		req.Header[k] = v
	}
	device := hasDevice(req.Header)
	if device && !SecureForDevice(req.URL) {
		return nil, ErrDeviceInsecure
	}
	req.Header.Set("User-Agent", ua)
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = 50 * time.Second
	}
	tr := &http.Transport{TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: min(timeout, 30*time.Second)}
	if r.Proxy != nil {
		tr.Proxy = http.ProxyURL(r.Proxy)
	}
	defer tr.CloseIdleConnections()
	out := &Response{}
	client := &http.Client{Transport: tr, Timeout: timeout, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		out.Redirects = len(via)
		if len(via) >= 10 {
			return errors.New("слишком много перенаправлений")
		}
		if device && !SecureForDevice(next.URL) {
			return ErrDeviceInsecure
		}
		return nil
	}}
	resp, err := client.Do(req)
	if errors.Is(err, ErrDeviceInsecure) {
		return out, ErrDeviceInsecure
	}
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	out.Status, out.StatusLine, out.Header = resp.StatusCode, resp.Status, resp.Header
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if len(body) > maxBody {
		body, out.TooBig = body[:maxBody], true
	}
	out.Body, out.ReadErr = body, err
	return out, nil
}
