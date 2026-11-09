package subinfo

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"waysplit/host/internal/device"
	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
)

// Options — как проверять подписку.
type Options struct {
	Device  *device.Device // nil — без заголовков устройства
	Proxy   *url.URL       // nil — напрямую; иначе через локальный прокси (порт сервера в ядре)
	Timeout time.Duration  // на один запрос; 0 — 20 с
	Clients []Client       // nil — все из Clients
}

// Result — итог одного способа.
type Result struct {
	Client      string   `json:"client"`
	UserAgent   string   `json:"userAgent"`
	Device      bool     `json:"device"` // отправлялись заголовки устройства
	Status      int      `json:"status"` // 0 — ответа не было (см. Error)
	StatusText  string   `json:"statusText,omitempty"`
	ContentType string   `json:"contentType,omitempty"`
	Size        int      `json:"size"`
	Ms          int64    `json:"ms"`
	Redirects   int      `json:"redirects,omitempty"`
	Error       string   `json:"error,omitempty"`
	Headers     []Header `json:"headers,omitempty"`
	Body        *Body    `json:"body,omitempty"`
}

// Header — заголовок ответа (значение уже без секретов) и пояснение по-русски.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Note  string `json:"note,omitempty"`
}

// Run скачивает подписку всеми способами (сначала без заголовков устройства, потом — если
// задан Device — с ними), не больше 4 запросов одновременно. Порядок результатов — как способов.
func Run(ctx context.Context, rawURL string, o Options) []Result {
	HideURL(rawURL)
	clients := o.Clients
	if clients == nil {
		clients = Clients
	}
	type probe struct {
		c      Client
		device bool
	}
	var probes []probe
	for _, c := range clients {
		probes = append(probes, probe{c, false})
	}
	if o.Device != nil {
		for _, c := range clients {
			probes = append(probes, probe{c, true})
		}
	}
	results := make([]Result, len(probes))
	parallel := func(idx []int) {
		sem := make(chan struct{}, 4)
		var wg sync.WaitGroup
		for _, i := range idx {
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				results[i] = one(ctx, rawURL, probes[i].c, probes[i].device, o)
			}()
		}
		wg.Wait()
	}
	n := len(clients)
	parallel(seq(0, n)) // без устройства
	if o.Device != nil && len(probes) > n {
		// Первый запрос с идентификатором — один и до конца: панель заводит устройство. Если
		// послать несколько сразу, она может успеть завести две записи об одном устройстве.
		results[n] = one(ctx, rawURL, probes[n].c, true, o)
		parallel(seq(n+1, len(probes)))
	}
	return results
}

func seq(from, to int) []int {
	var out []int
	for i := from; i < to; i++ {
		out = append(out, i)
	}
	return out
}

// HideURL запоминает адрес подписки и его части (имя сервера, токен в пути и параметрах)
// как секреты: в журнале и отчёте они заменяются на «***».
func HideURL(rawURL string) {
	hostlog.AddSecret(rawURL)
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return
	}
	hostlog.AddSecret(u.Host)
	hostlog.AddSecret(u.Hostname())
	for _, part := range strings.Split(u.Path, "/") {
		if len(part) >= 6 {
			hostlog.AddSecret(part)
		}
	}
	for _, vals := range u.Query() {
		for _, v := range vals {
			if len(v) >= 6 {
				hostlog.AddSecret(v)
			}
		}
	}
}

// one — один способ: запрос — links.Get (тот же, что при скачивании подписки).
func one(ctx context.Context, rawURL string, c Client, device bool, o Options) Result {
	r := Result{Client: c.Name, UserAgent: c.UserAgent, Device: device}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	var hdr http.Header
	if device && o.Device != nil {
		hdr = o.Device.Header()
	}
	t0 := time.Now()
	resp, err := links.Get(ctx, links.Request{URL: rawURL, UserAgent: c.UserAgent, Proxy: o.Proxy, Header: hdr, Timeout: timeout})
	r.Ms = time.Since(t0).Milliseconds()
	if resp != nil {
		r.Redirects = resp.Redirects
	}
	switch {
	case errors.Is(err, links.ErrBadURL), errors.Is(err, links.ErrDeviceInsecure):
		r.Error = err.Error()
		return r
	case err != nil:
		r.Error = links.NetError(err)
		return r
	}
	r.Status = resp.Status
	r.StatusText = http.StatusText(resp.Status)
	r.ContentType = hostlog.Mask(resp.Header.Get("Content-Type"))
	r.Headers = maskHeaders(resp.Header)
	if resp.ReadErr != nil {
		r.Error = "ответ оборвался: " + links.NetError(resp.ReadErr)
	}
	if resp.TooBig {
		r.Error = "ответ больше 10 МБ — дальше не читал"
	}
	r.Size = len(resp.Body)
	r.Body = Analyze(resp.Body, resp.Header.Get("Content-Type"))
	return r
}

// --- заголовки ---

var (
	urlRe      = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s;,"'<>]+`)
	tokenRe    = regexp.MustCompile(`[A-Za-z0-9_+/=-]{20,}`)
	filenameRe = regexp.MustCompile(`(?i)(filename\*?=)("[^"]*"|[^;]+)`)
	hasDigit   = regexp.MustCompile(`[0-9]`)
	hasLetter  = regexp.MustCompile(`[A-Za-z]`)
)

// maskHeaders — все заголовки ответа, кроме cookie, по алфавиту; значения без секретов.
func maskHeaders(h http.Header) []Header {
	names := make([]string, 0, len(h))
	for name := range h {
		names = append(names, name)
	}
	sort.Strings(names)
	var out []Header
	for _, name := range names {
		lname := strings.ToLower(name)
		if lname == "set-cookie" || lname == "cookie" {
			continue
		}
		for _, v := range h[name] {
			out = append(out, Header{Name: lname, Value: maskValue(lname, v), Note: headerNote(lname, v)})
		}
	}
	return out
}

func maskValue(name, v string) string {
	switch name {
	case "profile-title", "announce":
		if strings.HasPrefix(strings.TrimSpace(v), "base64:") {
			return clip(hostlog.Mask(links.DecodeTitle(v))) + "  [было в base64]"
		}
		return clip(hostlog.Mask(v))
	case "subscription-userinfo", "profile-update-interval", "subscription-refill-date", "content-length",
		"x-hwid-active", "x-hwid-not-supported", "x-hwid-max-devices-reached", "x-hwid-limit":
		return clip(hostlog.Mask(v)) // только числа и true/false — маска токенов не нужна
	}
	v = hostlog.Mask(v)
	v = urlRe.ReplaceAllStringFunc(v, func(u string) string {
		if i := strings.Index(u, "://"); i >= 0 {
			return u[:i+3] + "***/…"
		}
		return "***"
	})
	v = filenameRe.ReplaceAllString(v, `${1}"…"`)
	v = tokenRe.ReplaceAllStringFunc(v, func(t string) string {
		if hasDigit.MatchString(t) && hasLetter.MatchString(t) {
			return t[:4] + "…"
		}
		return t
	})
	return clip(v)
}

func clip(s string) string {
	if r := []rune(s); len(r) > 300 {
		return string(r[:300]) + "…"
	}
	return s
}

// headerNote — пояснение к заголовкам, важным для подписки.
func headerNote(name, v string) string {
	v = strings.TrimSpace(v)
	switch name {
	case "subscription-userinfo":
		inf := links.ParseUserInfo(v)
		if inf == nil {
			return "трафик и срок — не разобрать"
		}
		var parts []string
		if inf.Total > 0 {
			parts = append(parts, "трафик "+fmtBytes(inf.Upload+inf.Download)+" из "+fmtBytes(inf.Total))
		} else {
			parts = append(parts, "трафик "+fmtBytes(inf.Upload+inf.Download)+", без лимита")
		}
		if inf.Expire > 0 {
			parts = append(parts, "до "+time.Unix(inf.Expire, 0).Format("02.01.2006"))
		}
		return strings.Join(parts, ", ")
	case "profile-update-interval":
		if n, err := strconv.Atoi(v); err == nil {
			return "обновлять раз в " + strconv.Itoa(n) + " ч"
		}
	case "subscription-refill-date":
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return "дата пополнения трафика: " + time.Unix(n, 0).Format("02.01.2006")
		}
	case "profile-title":
		return "название подписки"
	case "announce":
		return "сообщение провайдера"
	case "announce-url":
		return "ссылка к сообщению провайдера"
	case "profile-web-page-url":
		return "страница подписки"
	case "support-url":
		return "поддержка провайдера"
	case "routing":
		return "правила маршрутизации для клиента"
	case "x-hwid-active":
		return "на панели включена привязка к устройствам (HWID)"
	case "x-hwid-not-supported":
		if v == "true" {
			return "клиент не прислал идентификатор устройства (x-hwid)"
		}
	case "x-hwid-max-devices-reached":
		if v == "true" {
			return "лимит устройств исчерпан"
		}
	case "x-hwid-limit":
		if v == "true" {
			// В коде Remnawave ставится при любом отказе по устройствам (для совместимости
			// с v2RayTun) — это не признак заполненного лимита; заполненный — x-hwid-max-devices-reached.
			return "панель отказала по правилам устройств (общий признак для v2RayTun, не «лимит заполнен»)"
		}
	}
	return ""
}

func fmtBytes(n int64) string {
	const gb = 1 << 30
	if n >= gb {
		return comma(float64(n)/gb) + " ГБ"
	}
	return comma(float64(n)/(1<<20)) + " МБ"
}

// comma — число с одним знаком после запятой, по-русски: 93,3.
func comma(f float64) string {
	return strings.Replace(strconv.FormatFloat(f, 'f', 1, 64), ".", ",", 1)
}
