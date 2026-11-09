package subinfo

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
)

// Все данные вымышленные.
const (
	uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	pbk  = "eG9ft1Ut-iZk-V87OwAE_APpKV_H8OYoS1KBvjlJwlg"
)

var (
	linkReality = "vless://" + uuid + "@nl1.example.com:443?security=reality&sni=www.example.org&fp=chrome&pbk=" + pbk + "&sid=b43351f6&type=tcp&flow=xtls-rprx-vision#NL"
	linkXHTTP   = "vless://" + uuid + "@eu.example.com:443?security=tls&sni=eu.example.com&type=xhttp&path=%2Fx#EU%20LTE"
	linkHy2     = "hysteria2://secret-pass@hy.example.com:443/?sni=hy.example.com#HY"
	linkStub    = "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?security=none&type=tcp#App%20not%20supported"
)

func kinds(b *Body) map[string]int {
	m := map[string]int{}
	for _, k := range b.Kinds {
		m[k.Name] = k.Count
	}
	return m
}

func TestAnalyzeLinks(t *testing.T) {
	text := strings.Join([]string{linkReality, linkXHTTP, linkHy2, "vmess://eyJhZGQiOiJ4In0=", "happ://crypt3/AbCdEf0123456789", "happ://routing/xyz"}, "\n")
	for _, tc := range []struct {
		name, body, format string
	}{
		{"строки", text, "links"},
		{"base64", base64.StdEncoding.EncodeToString([]byte(text)), "base64"},
		{"base64 URL-safe без =", base64.RawURLEncoding.EncodeToString([]byte(text)), "base64"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := Analyze([]byte(tc.body), "text/plain")
			if b.Format != tc.format {
				t.Fatalf("формат %q, нужен %q", b.Format, tc.format)
			}
			want := map[string]int{"VLESS · tcp · reality": 1, "VLESS · xhttp · tls": 1, "Hysteria2 · udp · tls": 1}
			if got := kinds(b); !reflect.DeepEqual(got, want) {
				t.Fatalf("виды %v, нужны %v", got, want)
			}
			if b.Servers != 3 || b.Usable != 3 {
				t.Fatalf("серверов %d, запустим %d; нужно 3 и 3 (xhttp — через Xray)", b.Servers, b.Usable)
			}
			if b.Happ != 2 || b.HappCrypt != 1 {
				t.Fatalf("happ:// %d, crypt %d; нужно 2 и 1", b.Happ, b.HappCrypt)
			}
			if len(b.Skipped) == 0 {
				t.Fatal("vmess и happ:// должны попасть в «не стали серверами»")
			}
		})
	}
}

func TestAnalyzeStubAndHappCrypt(t *testing.T) {
	b := Analyze([]byte(base64.StdEncoding.EncodeToString([]byte(linkStub))), "text/plain")
	if b.Servers != 0 || !reflect.DeepEqual(b.Stubs, []string{"App not supported"}) {
		t.Fatalf("заглушка: серверов %d, заглушки %v", b.Servers, b.Stubs)
	}
	b = Analyze([]byte("happ://crypt3/QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo="), "text/plain")
	if b.Format != "happ-crypt" || b.HappCrypt != 1 {
		t.Fatalf("happ://crypt: формат %q, crypt %d", b.Format, b.HappCrypt)
	}
}

const xrayOne = `{"remarks": "NL", "dns": {}, "routing": {"rules": []},
 "inbounds": [{"protocol": "socks", "port": 10808}],
 "outbounds": [
  {"tag": "proxy", "protocol": "vless", "settings": {"vnext": [{"address": "nl1.example.com", "port": 443, "users": [{"id": "` + uuid + `"}]}]},
   "streamSettings": {"network": "tcp", "security": "reality"}},
  {"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}]}`

func TestAnalyzeXrayJSON(t *testing.T) {
	b := Analyze([]byte(xrayOne), "application/json")
	if b.Format != "xray-json" || b.Servers != 1 || kinds(b)["VLESS · tcp · reality"] != 1 {
		t.Fatalf("Xray JSON (объект): %+v", b)
	}
	if strings.Contains(strings.Join(b.Keys, " "), "nl1.example.com") || strings.Contains(strings.Join(b.Keys, " "), uuid) {
		t.Fatalf("в структуре оказались значения: %v", b.Keys)
	}
	stub := `{"remarks": "Device limit reached", "outbounds": [{"protocol": "vless", "settings": {"vnext": [{"address": "0.0.0.0", "port": 1}]}}]}`
	arr := "[" + xrayOne + "," + strings.Replace(xrayOne, `"network": "tcp"`, `"network": "xhttp"`, 1) + "," + stub + "]"
	b = Analyze([]byte(arr), "application/json")
	if b.Format != "xray-json" || b.Servers != 2 || b.Usable != 2 || !strings.Contains(b.FormatText, "из 3 конфигов") {
		t.Fatalf("Xray JSON (массив): %s, серверов %d, запустим %d", b.FormatText, b.Servers, b.Usable)
	}
	if !reflect.DeepEqual(b.Stubs, []string{"Device limit reached"}) {
		t.Fatalf("заглушка в массиве: %v", b.Stubs)
	}
	if b = Analyze([]byte("["+xrayOne+"]"), ""); !strings.Contains(b.FormatText, "из 1 конфига") {
		t.Fatalf("«из 1 конфига»: %s", b.FormatText)
	}
}

func TestAnalyzeSingboxJSON(t *testing.T) {
	cfg := `{"log": {}, "dns": {}, "route": {}, "outbounds": [
	 {"type": "selector", "tag": "proxy", "outbounds": ["NL", "HY"]},
	 {"type": "vless", "tag": "NL", "server": "nl1.example.com", "server_port": 443, "uuid": "` + uuid + `",
	  "tls": {"enabled": true, "reality": {"enabled": true}}},
	 {"type": "vless", "tag": "WS", "server": "ws.example.com", "server_port": 443, "transport": {"type": "ws"}, "tls": {"enabled": true}},
	 {"type": "hysteria2", "tag": "HY", "server": "hy.example.com", "server_port": 443, "tls": {"enabled": true}},
	 {"type": "direct", "tag": "direct"}]}`
	b := Analyze([]byte(cfg), "application/json")
	want := map[string]int{"VLESS · tcp · reality": 1, "VLESS · ws · tls": 1, "Hysteria2 · udp · tls": 1}
	if b.Format != "singbox-json" || !reflect.DeepEqual(kinds(b), want) || b.Usable != 3 {
		t.Fatalf("sing-box JSON: %s %v", b.Format, kinds(b))
	}
}

func TestAnalyzeClashYAML(t *testing.T) {
	block := `mixed-port: 7890
proxy-groups:
  - name: PROXY
    type: select
proxies:
  - name: "NL"
    type: vless
    server: nl1.example.com
    port: 443
    uuid: ` + uuid + `
    network: tcp
    tls: true
    reality-opts:
      public-key: ` + pbk + `
    alpn:
      - h2
  - {name: EU, type: vless, server: eu.example.com, port: 443, network: xhttp, tls: true}
  - {name: HY, type: hysteria2, server: hy.example.com, port: 443, password: secret}
  - {name: "App not supported", type: vless, server: 0.0.0.0, port: 1}
rules:
  - MATCH,PROXY
proxy-providers: {}
health-check-url: http://www.gstatic.com/generate_204
`
	b := Analyze([]byte(block), "text/yaml")
	want := map[string]int{"VLESS · tcp · reality": 1, "VLESS · xhttp · tls": 1, "Hysteria2 · udp · tls": 1}
	if b.Format != "clash-yaml" || !reflect.DeepEqual(kinds(b), want) || b.Usable != 3 {
		t.Fatalf("Clash YAML: %s %v, запустим %d", b.Format, kinds(b), b.Usable)
	}
	if !reflect.DeepEqual(b.Stubs, []string{"App not supported"}) {
		t.Fatalf("заглушка в YAML: %v", b.Stubs)
	}
	keys := strings.Join(b.Keys, " | ")
	if !strings.Contains(keys, "mixed-port, proxy-groups, proxies, rules, proxy-providers") || strings.Contains(keys, "example.com") || strings.Contains(keys, uuid) {
		t.Fatalf("структура YAML: %s", keys)
	}
}

func TestAnalyzeOther(t *testing.T) {
	for _, tc := range []struct {
		body, ct, format string
	}{
		{"", "text/plain", "empty"},
		{"  \n ", "", "empty"},
		{"<!doctype html><html><head><title> Подписка &amp; оплата </title></head><body>x</body></html>", "text/html", "html"},
		{`{"error": "not found"}`, "application/json", "json"},
		{"[1, 2]", "application/json", "json"},
		{"{не json", "", "text"},
		{"просто текст\nещё строка", "text/plain", "text"},
		{"key: 1\nother: 2\n", "text/yaml", "yaml"},
	} {
		b := Analyze([]byte(tc.body), tc.ct)
		if b.Format != tc.format {
			t.Errorf("%q: формат %q, нужен %q", tc.body, b.Format, tc.format)
		}
		if tc.format == "html" && b.HTMLTitle != "Подписка & оплата" {
			t.Errorf("заголовок страницы %q", b.HTMLTitle)
		}
	}
}
