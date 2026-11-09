package main

// Режим native messaging: Chrome запускает компаньон с аргументом
// chrome-extension://<ID>/ (и --parent-window=… на Windows) и общается через stdin/stdout.
// Команды — SPEC, раздел 5, «Протокол сообщений».

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"waysplit/host/internal/device"
	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/nm"
	"waysplit/host/internal/singbox"
	"waysplit/host/internal/subinfo"
	"waysplit/host/internal/xray"
)

func runNativeMessaging(origin string) {
	hostlog.Open(singbox.DataDir())
	defer hostlog.Close()
	hostlog.Printf("запуск из Chrome (%s), версия %s, PID %d", origin, version, os.Getpid())
	if migrationNote != "" {
		hostlog.Printf("%s", migrationNote)
	}

	// В stdout — только сообщения для Chrome. Настоящий stdout забираем себе,
	// а случайный вывод (fmt.Print где-нибудь) уходит в никуда.
	out := os.Stdout
	if devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0); err == nil {
		os.Stdout = devnull
	}

	h := &nmHost{}
	err := nm.Serve(context.Background(), os.Stdin, out, h.handle)
	if err != nil {
		hostlog.Printf("связь с Chrome оборвалась: %v", err)
	}
	h.close()
	hostlog.Printf("Chrome закрыл соединение, компаньон завершается")
}

type nmHost struct {
	mu sync.Mutex // apply / start / stop — по очереди

	sb    *singbox.Core  // sing-box (создаётся при первом apply)
	built *singbox.Built // его конфиг (с которым запущен или был запущен)
	sbKey string         // список серверов sing-box, с которым ядро запущено: тот же — без перезапуска

	xr        *singbox.Core // Xray (SPEC-XRAY.md)
	xbuilt    *xray.Built
	xrKey     string // список серверов Xray, для которого собран xbuilt
	xrStarted string // список, с которым Xray запущен
	xrNeed    bool   // среди нужных серверов есть серверы Xray
}

func (h *nmHost) handle(ctx context.Context, req *nm.Request) (any, error) {
	switch req.Cmd {
	case "hello":
		return hello(), nil
	case "parse_links":
		return parseLinks(req)
	case "apply":
		return h.apply(req)
	case "start":
		return h.start()
	case "stop":
		return h.stop(), nil
	case "status":
		return h.status(), nil
	case "ping":
		return h.ping(ctx, req)
	case "fetch_subscription":
		return h.fetchSubscription(ctx, req)
	case "exit_ip":
		return h.exitIP(ctx, req)
	case "sub_info":
		return h.subInfo(ctx, req)
	case "logs":
		return logs(req)
	}
	return nil, &nm.Error{Code: "UNKNOWN_CMD", Message: "компаньон не знает команду «" + req.Cmd + "» — обновите компаньон"}
}

func (h *nmHost) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range []*singbox.Core{h.sb, h.xr} {
		if c != nil {
			c.Close()
		}
	}
}

// helloResult — ответ на hello: версии и пути. Xray нужен только для серверов XHTTP, поэтому
// его отсутствие — не ошибка связи (xrayError — для диагностики).
type helloResult struct {
	HostVersion    string    `json:"hostVersion"`
	SingboxVersion string    `json:"singboxVersion,omitempty"`
	SingboxPath    string    `json:"singboxPath,omitempty"`
	SingboxError   *nm.Error `json:"singboxError,omitempty"` // sing-box не найден или не запускается
	XrayVersion    string    `json:"xrayVersion,omitempty"`
	XrayPath       string    `json:"xrayPath,omitempty"`
	XrayError      *nm.Error `json:"xrayError,omitempty"`
	DataDir        string    `json:"dataDir"`
}

func hello() *helloResult {
	r := &helloResult{HostVersion: version, DataDir: singbox.DataDir()}
	bin, err := singbox.FindBinary()
	if err == nil {
		r.SingboxPath = bin
		r.SingboxVersion, err = singbox.Version(bin)
	}
	r.SingboxError = asNM(err, "SINGBOX_NOT_FOUND")
	xbin, err := xray.FindBinary()
	if err == nil {
		r.XrayPath = xbin
		r.XrayVersion, err = xray.Version(xbin)
	}
	r.XrayError = asNM(err, "XRAY_NOT_FOUND")
	return r
}

// asNM — ошибка ядра в виде для расширения (nil — ошибки нет).
func asNM(err error, code string) *nm.Error {
	if err == nil {
		return nil
	}
	e := &nm.Error{Code: code, Message: err.Error()}
	if se, ok := err.(*singbox.Error); ok {
		e.Code = se.Code
	}
	return e
}

// serverInfo — разобранный сервер для расширения (вместе со ссылкой: её хранит расширение).
type serverInfo struct {
	Key       string   `json:"key"` // для поиска повторов, без секретов
	Name      string   `json:"name"`
	Protocol  string   `json:"protocol"`
	Address   string   `json:"address"`
	Port      int      `json:"port"`
	Transport string   `json:"transport"`
	Security  string   `json:"security"`
	Core      string   `json:"core"` // каким ядром запускается: sing-box | xray
	Link      string   `json:"link"`
	Warnings  []string `json:"warnings,omitempty"`
}

type parseResult struct {
	Servers       []serverInfo      `json:"servers"`
	Errors        []links.LineError `json:"errors"`
	Subscriptions []string          `json:"subscriptions,omitempty"`
}

// parseLinks: текст со ссылками → серверы, которые можно запустить, и пропущенные строки с причиной
// (в том числе то, что не поддерживает sing-box).
func parseLinks(req *nm.Request) (*parseResult, error) {
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil {
		return nil, &nm.Error{Code: "BAD_REQUEST", Message: "parse_links: нужен текст со ссылками"}
	}
	return describe(links.ParseText(p.Text)), nil
}

// describe — разобранные строки → серверы для расширения (с ядром, которым каждый запустится);
// то, что не запустит ни sing-box, ни Xray, — в пропущенные с причиной.
func describe(res *links.TextResult) *parseResult {
	out := &parseResult{Servers: []serverInfo{}, Errors: res.Errors, Subscriptions: res.Subscriptions}
	if out.Errors == nil {
		out.Errors = []links.LineError{}
	}
	for _, s := range res.Servers {
		core, warns, err := xray.Pick(s)
		if err != nil {
			out.Errors = append(out.Errors, links.LineError{Line: s.Line, Text: links.Preview(s.Link), Reason: err.Error()})
			continue
		}
		out.Servers = append(out.Servers, serverInfo{
			Key: s.KeyHash(), Name: s.Name, Protocol: s.Protocol, Address: s.Address, Port: s.Port, Transport: s.Transport,
			Security: s.Security, Core: core, Link: s.Link, Warnings: append(append([]string{}, s.Warnings...), warns...),
		})
	}
	sort.SliceStable(out.Errors, func(i, j int) bool { return out.Errors[i].Line < out.Errors[j].Line })
	return out
}

// ping меряет серверы через их локальные порты (ядро должно работать).
func (h *nmHost) ping(ctx context.Context, req *nm.Request) (any, error) {
	var p struct {
		ServerIDs []string `json:"serverIds"`
		URL       string   `json:"url"`
		TimeoutMs int      `json:"timeoutMs"`
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil {
		return nil, &nm.Error{Code: "BAD_REQUEST", Message: "ping: нужен список serverIds"}
	}
	if p.URL == "" {
		p.URL = singbox.PingURL
	}
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout < time.Second || timeout > 15*time.Second {
		timeout = singbox.PingTimeout
	}
	h.mu.Lock()
	running := h.runningLocked()
	h.mu.Unlock()
	if len(running) == 0 {
		return nil, &nm.Error{Code: "CORE_NOT_RUNNING", Message: "ядро не запущено — включите VPN"}
	}
	results := make([]singbox.PingResult, len(p.ServerIDs))
	var targets []singbox.Target
	var index []int
	for i, id := range p.ServerIDs {
		t, ok := running[id]
		if !ok {
			results[i] = singbox.PingResult{ID: id, Error: "сервер не запущен в ядре"}
			continue
		}
		targets = append(targets, singbox.Target{ID: id, Port: t.port, Protocol: t.proto})
		index = append(index, i)
	}
	for j, r := range singbox.PingMany(ctx, targets, p.URL, timeout) {
		results[index[j]] = r
	}
	return map[string]any{"results": results}, nil
}

// subscriptionResult — ответ fetch_subscription.
type subscriptionResult struct {
	*parseResult
	Info                *links.SubInfo `json:"info,omitempty"`
	Title               string         `json:"title,omitempty"`
	UpdateIntervalHours int            `json:"updateIntervalHours,omitempty"`
	ViaVPN              bool           `json:"viaVpn,omitempty"`     // напрямую не скачалось — скачано через VPN
	DeviceUsed          bool           `json:"deviceUsed,omitempty"` // подписка привязана к компьютеру как устройство
	Announce            string         `json:"announce,omitempty"`   // сообщение провайдера, обычный текст
	Format              string         `json:"format,omitempty"`     // "" — ссылки; xray-json / singbox-json / clash-yaml
}

// fetchSubscription скачивает подписку (SPEC, раздел 5; SPEC-SUBS, шаг 2): по правилам привязки к
// устройству (fetchSub; device — подписка уже привязана), напрямую, а если не вышло по сети и ядро
// работает — ещё раз через порт сервера proxyServerId (обычно текущего).
func (h *nmHost) fetchSubscription(ctx context.Context, req *nm.Request) (*subscriptionResult, error) {
	var p struct {
		URL           string `json:"url"`
		UserAgent     string `json:"userAgent"`
		ProxyServerID string `json:"proxyServerId"`
		Device        bool   `json:"device"`
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil || !links.IsSubscriptionURL(p.URL) {
		return nil, &nm.Error{Code: "BAD_REQUEST", Message: "fetch_subscription: нужен адрес подписки http(s)://…"}
	}
	sub, used, err := fetchSub(ctx, p.URL, p.UserAgent, nil, p.Device)
	via := false
	var known *nm.Error
	if err != nil && !errors.As(err, &known) && p.ProxyServerID != "" {
		if port := h.runningPort(p.ProxyServerID); port > 0 {
			hostlog.Printf("подписка напрямую не скачалась (%v), пробую через VPN", err)
			proxy := &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)}
			if sub2, used2, err2 := fetchSub(ctx, p.URL, p.UserAgent, proxy, p.Device); err2 == nil || errors.As(err2, &known) {
				sub, used, err, via = sub2, used2, err2, true
			}
		}
	}
	if err != nil {
		if errors.As(err, &known) {
			return nil, known // лимит устройств, шифрование для Happ, сообщение панели — со своим кодом
		}
		return nil, &nm.Error{Code: "SUBSCRIPTION_FAILED", Message: err.Error()}
	}
	return &subscriptionResult{parseResult: describe(sub.TextResult), Info: sub.Info, Title: sub.Title,
		UpdateIntervalHours: sub.UpdateIntervalHours, ViaVPN: via, DeviceUsed: used, Announce: sub.Announce, Format: sub.Format}, nil
}

// subInfo — «Проверить подписку» (SPEC-SUBS.md, шаг 1): подписка скачивается с User-Agent разных
// клиентов (и с заголовками устройства, только если device: true — это решает человек), ответ —
// отчёт без секретов. Напрямую ни один способ не получил ответа, а ядро работает — ещё раз через VPN.
func (h *nmHost) subInfo(ctx context.Context, req *nm.Request) (any, error) {
	var p struct {
		URL           string `json:"url"`
		Device        bool   `json:"device"`
		ProxyServerID string `json:"proxyServerId"`
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil || !links.IsSubscriptionURL(p.URL) {
		return nil, &nm.Error{Code: "BAD_REQUEST", Message: "sub_info: нужен адрес подписки http(s)://…"}
	}
	o := subinfo.Options{Timeout: 20 * time.Second}
	if p.Device {
		dev, created, err := device.Load(singbox.DataDir())
		if err != nil {
			return nil, &nm.Error{Code: "DEVICE_ID", Message: err.Error()}
		}
		if created {
			hostlog.Printf("создан идентификатор устройства %s", dev.Short())
		}
		o.Device = dev
	}
	results := subinfo.Run(ctx, p.URL, o)
	if noAnswer(results) && p.ProxyServerID != "" {
		if port := h.runningPort(p.ProxyServerID); port > 0 {
			o.Proxy = &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)}
			results = subinfo.Run(ctx, p.URL, o)
		}
	}
	hostlog.Printf("проверка подписки: способов %d, с устройством: %v, через VPN: %v", len(results), o.Device != nil, o.Proxy != nil)
	return map[string]any{"report": subinfo.Report(results, o), "results": results, "device": o.Device != nil, "viaVpn": o.Proxy != nil}, nil
}

// noAnswer — ни один способ не получил ответа сервера (сеть, DNS, блокировка).
func noAnswer(results []subinfo.Result) bool {
	for _, r := range results {
		if r.Status != 0 {
			return false
		}
	}
	return len(results) > 0
}

// runningPort — локальный порт сервера, если его ядро работает; иначе 0.
func (h *nmHost) runningPort(id string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.runningLocked()[id].port
}

// exitIP — внешний IP, который видят сайты через сервер (диагностика «Мой IP сейчас»).
func (h *nmHost) exitIP(ctx context.Context, req *nm.Request) (any, error) {
	var p struct {
		ServerID string `json:"serverId"`
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil || p.ServerID == "" {
		return nil, &nm.Error{Code: "BAD_REQUEST", Message: "exit_ip: нужен serverId"}
	}
	h.mu.Lock()
	t, ok := h.runningLocked()[p.ServerID]
	h.mu.Unlock()
	if !ok {
		return nil, &nm.Error{Code: "CORE_NOT_RUNNING", Message: "ядро не запущено или в нём нет этого сервера"}
	}
	ip, err := singbox.ExitIP(ctx, singbox.Target{ID: p.ServerID, Port: t.port, Protocol: t.proto}, 10*time.Second)
	if err != nil {
		return nil, &nm.Error{Code: "NO_ANSWER", Message: err.Error()}
	}
	return map[string]string{"ip": ip}, nil
}

// logs — последние строки host.log, sing-box.log и xray.log без секретов (ответ укладывается в 1 МБ).
func logs(req *nm.Request) (any, error) {
	var p struct {
		Lines int `json:"lines"`
	}
	json.Unmarshal(req.Raw, &p)
	if p.Lines <= 0 || p.Lines > 500 {
		p.Lines = 100
	}
	dir := singbox.DataDir()
	return map[string]string{
		"host":    singbox.Tail(filepath.Join(dir, "host.log"), p.Lines),
		"singbox": singbox.Tail(filepath.Join(dir, "sing-box.log"), p.Lines),
		"xray":    singbox.Tail(filepath.Join(dir, xray.Engine.LogFile), p.Lines),
	}, nil
}
