package links

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

// Тело подписки: две верные ссылки и одна xhttp (разбирается, отказ — в пакете singbox).
// Имена подобраны так, чтобы в base64 попались «+» и «/» (обычный алфавит) и «-» и «_» (URL-safe).
var subLinks = "vless://" + uuid + "@a.example.com:443?security=reality&sni=www.example.org&pbk=" + pbk + "&sid=b4#A>>>?\n" +
	"hysteria2://pw@b.example.com:443?sni=b.example.com#B~~~\n" +
	"vless://" + uuid + "@c.example.com:443?security=tls&type=xhttp#C\n"

func TestDecodeBody(t *testing.T) {
	std := base64.StdEncoding.EncodeToString([]byte(subLinks))
	if !strings.ContainsAny(std, "+/") {
		t.Fatal("тестовые данные: в base64 нет «+» или «/», вариант URL-safe не проверится")
	}
	wrapped := ""
	for i := 0; i < len(std); i += 76 {
		wrapped += std[i:min(i+76, len(std))] + "\r\n"
	}
	cases := map[string]string{
		"просто текст":             subLinks,
		"текст с BOM":              "\ufeff" + subLinks,
		"base64 с «=»":             std,
		"base64 без «=»":           base64.RawStdEncoding.EncodeToString([]byte(subLinks)),
		"base64 URL-safe с «=»":    base64.URLEncoding.EncodeToString([]byte(subLinks)),
		"base64 URL-safe без «=»":  base64.RawURLEncoding.EncodeToString([]byte(subLinks)),
		"base64 с переносом строк": wrapped,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			got := strings.TrimPrefix(DecodeBody([]byte(body)), "\ufeff")
			if got != subLinks {
				t.Fatalf("получилось:\n%q", got)
			}
			if r := ParseText(got); len(r.Servers) != 3 {
				t.Fatalf("серверов %d, ошибки %+v", len(r.Servers), r.Errors)
			}
		})
	}
	if got := DecodeBody([]byte("не base64 и не ссылки")); got != "не base64 и не ссылки" {
		t.Errorf("непонятное тело должно вернуться как есть, получено %q", got)
	}
}

func TestParseUserInfo(t *testing.T) {
	tests := []struct {
		in   string
		want *SubInfo
	}{
		{"upload=1024; download=2048; total=107374182400; expire=1798675200", &SubInfo{1024, 2048, 107374182400, 1798675200}},
		{" Upload=1 ;DOWNLOAD=2;total=3 ", &SubInfo{Upload: 1, Download: 2, Total: 3}},
		{"upload=0; download=1.5e+09; total=0; expire=0", &SubInfo{Download: 1500000000}},
		{"", nil},
		{"ерунда", nil},
	}
	for _, tt := range tests {
		if got := ParseUserInfo(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("ParseUserInfo(%q) = %+v, ожидалось %+v", tt.in, got, tt.want)
		}
	}
}

func TestDecodeTitle(t *testing.T) {
	enc := base64.StdEncoding.EncodeToString([]byte("Мой VPN 🇳🇱"))
	for in, want := range map[string]string{
		"base64:" + enc: "Мой VPN 🇳🇱",
		"base64:" + base64.RawURLEncoding.EncodeToString([]byte("Мой VPN 🇳🇱")): "Мой VPN 🇳🇱",
		"  Просто название ":                                                   "Просто название",
		"base64:!!!":                                                           "",
		"":                                                                     "",
	} {
		if got := DecodeTitle(in); got != want {
			t.Errorf("DecodeTitle(%q) = %q, ожидалось %q", in, got, want)
		}
	}
}

// Сервер-подделка ведёт себя как панели: на чужой User-Agent отдаёт веб-страницу.
func subServer(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/missing":
			http.NotFound(w, r)
		case !strings.HasPrefix(r.UserAgent(), "v2rayN/"):
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte("<!doctype html><html><body>Панель</body></html>"))
		default:
			w.Header().Set("Subscription-Userinfo", "upload=10; download=20; total=1000; expire=1798675200")
			w.Header().Set("Profile-Title", "base64:"+base64.StdEncoding.EncodeToString([]byte("Тестовая подписка")))
			w.Header().Set("Profile-Update-Interval", "12")
			w.Write([]byte(base64.StdEncoding.EncodeToString([]byte(subLinks + "vmess://abc\n"))))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetch(t *testing.T) {
	srv := subServer(t)
	sub, err := FetchWith(context.Background(), srv.URL+"/sub/token", "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sub.Servers) != 3 || len(sub.Errors) != 1 || !strings.Contains(sub.Errors[0].Reason, "VMess") {
		t.Errorf("серверов %d, ошибки %+v", len(sub.Servers), sub.Errors)
	}
	if sub.Title != "Тестовая подписка" || sub.UpdateIntervalHours != 12 {
		t.Errorf("название %q, интервал %d", sub.Title, sub.UpdateIntervalHours)
	}
	if !reflect.DeepEqual(sub.Info, &SubInfo{10, 20, 1000, 1798675200}) {
		t.Errorf("трафик %+v", sub.Info)
	}

	if _, err := FetchWith(context.Background(), srv.URL+"/sub/token", "Mozilla/5.0", nil, nil); err == nil || !strings.Contains(err.Error(), "веб-страница") {
		t.Errorf("браузерный User-Agent: ожидалась ошибка про веб-страницу, получено %v", err)
	}
	if _, err := FetchWith(context.Background(), srv.URL+"/missing", "", nil, nil); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("ожидалась ошибка 404, получено %v", err)
	}
	if _, err := FetchWith(context.Background(), "http://127.0.0.1:1/", "", nil, nil); err == nil || !strings.Contains(err.Error(), "не принимает подключения") {
		t.Errorf("закрытый порт: получено %v", err)
	}
}

func TestShortNetError(t *testing.T) {
	dns := &url.Error{Op: "Get", URL: "https://sub.invalid/x", Err: &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "sub.invalid", IsNotFound: true}}}
	if got := shortNetError(dns); got != "адрес сервера подписки не найден (sub.invalid)" {
		t.Errorf("DNS: %q", got)
	}
	if got := shortNetError(context.DeadlineExceeded); got != "сервер подписки не ответил вовремя" {
		t.Errorf("таймаут: %q", got)
	}
}

// SPEC-SUBS, шаг 2: заглушки, сообщение провайдера, happ://crypt, другие форматы, ответ не 200.
func TestFetchPanelSignals(t *testing.T) {
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	stub := "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?type=tcp#App%20not%20supported"
	real := "vless://" + uuid + "@nl.example.com:443?security=tls&type=ws#NL"
	var reply func(w http.ResponseWriter)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reply(w) }))
	defer srv.Close()
	fetch := func() (*Subscription, error) {
		return FetchWith(context.Background(), srv.URL+"/s/TOKEN", "", nil, nil)
	}

	// Заглушка — не сервер; сообщение провайдера — обычным текстом.
	reply = func(w http.ResponseWriter) {
		w.Header().Set("X-Hwid-Active", "true")
		w.Header().Set("X-Hwid-Not-Supported", "true")
		w.Header().Set("Announce", "base64:"+b64("#ff0000Внимание: оплата до\r\n1 декабря\x07 https://pay.example.com"))
		w.Write([]byte(b64(stub + "\n" + real)))
	}
	sub, err := fetch()
	if err != nil {
		t.Fatal(err)
	}
	if len(sub.Servers) != 1 || sub.Servers[0].Name != "NL" || !reflect.DeepEqual(sub.Stubs, []string{"App not supported"}) {
		t.Errorf("заглушка отдельно от серверов: %d %v", len(sub.Servers), sub.Stubs)
	}
	if sub.Announce != "Внимание: оплата до\n1 декабря  https://pay.example.com" {
		t.Errorf("announce = %q", sub.Announce)
	}
	if !sub.Device.Active || !sub.Device.NotSupported || sub.Device.MaxReached {
		t.Errorf("сигналы панели: %+v", sub.Device)
	}

	// happ://crypt — считаются, серверов нет.
	reply = func(w http.ResponseWriter) { w.Write([]byte("happ://crypt3/QUJDREVGR0g=\nhappp://x")) }
	if sub, err = fetch(); err != nil || sub.HappCrypt != 1 || len(sub.Servers) != 0 {
		t.Errorf("happ://crypt: %v %+v", err, sub)
	}

	// Непонятный JSON, Clash без proxies, веб-страница — честная причина, а не «0 серверов».
	for body, want := range map[string]string{
		`{"error": "not found"}`: "не знает",
		"proxy-providers:\n  p:\n    url: https://x.example.com/p\n": "proxy-providers",
		"<html><title>Кабинет</title></html>":                        "веб-страница",
	} {
		reply = func(w http.ResponseWriter) { w.Write([]byte(body)) }
		if _, err := fetch(); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%.20q: ошибка %v, нужно «%s»", body, err, want)
		}
	}
	// Xray JSON — серверы и формат (подробно — formats_test.go).
	reply = func(w http.ResponseWriter) {
		w.Write([]byte(`[{"remarks": "NL", "outbounds": [{"protocol": "vless", "settings": {"address": "nl.example.com", "port": 443, "id": "` + uuid + `"},
		  "streamSettings": {"network": "ws", "security": "tls"}}]},
		 {"remarks": "App not supported", "outbounds": [{"protocol": "vless", "settings": {"address": "0.0.0.0", "port": 1, "id": "` + uuid + `"}}]}]`))
	}
	if sub, err := fetch(); err != nil || sub.Format != FormatXray || len(sub.Servers) != 1 || sub.Servers[0].Name != "NL" || len(sub.Stubs) != 1 {
		t.Errorf("Xray JSON через Fetch: %v %+v", err, sub)
	}

	// Ответ не 200 — HTTPError с сигналами панели.
	reply = func(w http.ResponseWriter) {
		w.Header().Set("X-Hwid-Active", "true")
		w.Header().Set("X-Hwid-Max-Devices-Reached", "true")
		w.WriteHeader(http.StatusNotFound)
	}
	_, err = fetch()
	he, ok := err.(*HTTPError)
	if !ok || !he.Device.Active || !he.Device.MaxReached || !strings.Contains(err.Error(), "404") {
		t.Errorf("ответ 404: %#v", err)
	}
}

// Идентификатор устройства — только по https или на этот же компьютер (правила Chrome Web Store).
func TestSecureForDevice(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://sub.example.com/x":    true,
		"HTTPS://sub.example.com/x":    true,
		"http://sub.example.com/x":     false,
		"http://127.0.0.1:8080/x":      true,
		"http://localhost/x":           true,
		"http://[::1]:9/x":             true,
		"http://10.0.0.1/x":            false,
		"http://127.0.0.1.example.com": false,
	} {
		u, _ := url.Parse(raw)
		if got := SecureForDevice(u); got != want {
			t.Errorf("%s: %v, нужно %v", raw, got, want)
		}
	}
	if SecureForDevice(nil) {
		t.Error("nil — нельзя")
	}
}

func TestFetchDeviceOnlyOverHTTPS(t *testing.T) {
	dev := http.Header{}
	dev.Set("x-hwid", "abcdefghij123")
	// Сразу http:// — запрос даже не уходит.
	if _, err := FetchWith(context.Background(), "http://sub.example.invalid/x", "", nil, dev); err != ErrDeviceInsecure {
		t.Errorf("http:// с идентификатором: %v", err)
	}
	// Перенаправление на http:// — дальше не идём (Go перенёс бы заголовки на новый адрес).
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Header.Get("X-Hwid"))
		http.Redirect(w, r, "http://sub.example.invalid/next", http.StatusFound)
	}))
	defer srv.Close()
	if _, err := FetchWith(context.Background(), srv.URL, "", nil, dev); err != ErrDeviceInsecure {
		t.Errorf("перенаправление на http://: %v", err)
	}
	if len(asked) != 1 {
		t.Errorf("запросов к серверу %d", len(asked))
	}
}
