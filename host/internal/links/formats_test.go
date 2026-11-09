package links

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Все данные вымышленные (uuid и pbk — из links_test.go).

func convert(t *testing.T, body string) (*TextResult, string, []LineError) {
	t.Helper()
	out, format, skipped, err := ConvertBody(body, "")
	if err != nil {
		t.Fatalf("ConvertBody: %v", err)
	}
	res := ParseText(out)
	if len(res.Errors) != 0 {
		t.Fatalf("ссылки после перевода не разобрались: %+v\n%s", res.Errors, out)
	}
	return res, format, skipped
}

func byName(res *TextResult) map[string]*Server {
	m := map[string]*Server{}
	for _, s := range res.Servers {
		m[s.Name] = s
	}
	return m
}

func TestConvertXray(t *testing.T) {
	nl := `{"tag": "proxy", "protocol": "vless", "settings": {"vnext": [{"address": "nl.example.com", "port": 443,
	  "users": [{"id": "` + uuid + `", "flow": "xtls-rprx-vision", "encryption": "none"}]}]},
	  "streamSettings": {"network": "raw", "security": "reality",
	   "realitySettings": {"serverName": "www.example.org", "fingerprint": "chrome", "password": "` + pbk + `", "shortId": "b43351f6", "spiderX": "/"}}}`
	body := `[
	{"remarks": "Авто", "observatory": {}, "outbounds": [
	  ` + strings.Replace(nl, `"tag": "proxy"`, `"tag": "proxy-1"`, 1) + `,
	  {"tag": "proxy-2", "protocol": "vless", "settings": {"address": "ws.example.com", "port": 443, "id": "` + uuid + `", "encryption": "none"},
	   "streamSettings": {"network": "ws", "security": "tls", "tlsSettings": {"serverName": "ws.example.com", "alpn": ["http/1.1"]},
	    "wsSettings": {"path": "/ws?ed=2048", "headers": {"Host": "cdn2.example.com"}}}},
	  {"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}]},
	{"remarks": "🇳🇱 NL #1 50%", "outbounds": [` + nl + `, {"protocol": "freedom"}]},
	{"remarks": "EU XHTTP", "outbounds": [{"tag": "proxy", "protocol": "vless",
	  "settings": {"vnext": [{"address": "eu.example.com", "port": 8443, "users": [{"id": "` + uuid + `", "encryption": "none"}]}]},
	  "streamSettings": {"network": "xhttp", "security": "tls",
	   "tlsSettings": {"serverName": "eu.example.com", "fingerprint": "firefox", "pinnedPeerCertSha256": "ab:cd", "verifyPeerCertByName": "real.example.com"},
	   "xhttpSettings": {"path": "/xh", "host": "cdn.example.com", "mode": "packet-up", "xPaddingBytes": "100-1000", "extra": {"xmux": {"maxConcurrency": "16-32"}}}}}]},
	{"remarks": "HY", "outbounds": [{"protocol": "hysteria", "settings": {"version": 2, "address": "hy.example.com", "port": 443},
	  "streamSettings": {"network": "hysteria", "security": "tls", "hysteriaSettings": {"version": 2, "auth": "p@ss word"},
	   "tlsSettings": {"serverName": "hy.example.com"}, "finalmask": {"udp": [{"type": "salamander", "settings": {"password": "ob"}}]}}}]},
	{"remarks": "VM", "outbounds": [{"protocol": "vmess", "settings": {}}]}
	]`
	res, format, skipped := convert(t, body)
	if format != FormatXray {
		t.Fatalf("формат %q", format)
	}
	names := []string{}
	for _, s := range res.Servers {
		names = append(names, s.Name)
	}
	if !reflect.DeepEqual(names, []string{"🇳🇱 NL #1 50%", "Авто · proxy-2", "EU XHTTP", "HY"}) {
		t.Fatalf("серверы без повторов, имя — из отдельного конфига: %q", names)
	}
	if len(skipped) != 1 || skipped[0].Text != "VM" || !strings.Contains(skipped[0].Reason, "vmess") {
		t.Errorf("пропущено: %+v", skipped)
	}
	m := byName(res)
	if s := m["🇳🇱 NL #1 50%"]; s.Security != "reality" || s.Flow != "xtls-rprx-vision" || s.PublicKey != pbk || s.ShortID != "b43351f6" || s.SNI != "www.example.org" || s.Transport != "tcp" || s.SpiderX != "/" {
		t.Errorf("Reality: %+v", s)
	}
	if s := m["Авто · proxy-2"]; s.Transport != "ws" || s.Path != "/ws" || s.EarlyData != 2048 || s.Host != "cdn2.example.com" || !reflect.DeepEqual(s.ALPN, []string{"http/1.1"}) {
		t.Errorf("WebSocket: %+v", s)
	}
	s := m["EU XHTTP"]
	if s.Transport != "xhttp" || s.Port != 8443 || s.Path != "/xh" || s.Host != "cdn.example.com" || s.Mode != "packet-up" || s.PinnedCert != "ab:cd" || s.VerifyName != "real.example.com" || s.Fingerprint != "firefox" {
		t.Errorf("XHTTP: %+v", s)
	}
	var extra map[string]any
	if json.Unmarshal([]byte(s.Extra), &extra) != nil || extra["xPaddingBytes"] != "100-1000" || extra["xmux"] == nil {
		t.Errorf("extra XHTTP: %s", s.Extra)
	}
	if s := m["HY"]; s.Protocol != "hysteria2" || s.Password != "p@ss word" || s.Obfs != "salamander" || s.ObfsPassword != "ob" || s.SNI != "hy.example.com" {
		t.Errorf("Hysteria2 из Xray: %+v", s)
	}
}

func TestConvertSingbox(t *testing.T) {
	body := `{"log": {}, "outbounds": [
	 {"type": "selector", "tag": "proxy", "outbounds": ["NL", "WS"]},
	 {"type": "vless", "tag": "NL", "server": "nl.example.com", "server_port": 443, "uuid": "` + uuid + `", "flow": "xtls-rprx-vision",
	  "tls": {"enabled": true, "server_name": "www.example.org", "utls": {"enabled": true, "fingerprint": "chrome"},
	   "reality": {"enabled": true, "public_key": "` + pbk + `", "short_id": "b43351f6"}}},
	 {"type": "vless", "tag": "WS", "server": "ws.example.com", "server_port": 443, "uuid": "` + uuid + `",
	  "tls": {"enabled": true, "server_name": "ws.example.com"},
	  "transport": {"type": "ws", "path": "/ws", "headers": {"Host": "cdn.example.com"}, "max_early_data": 2048, "early_data_header_name": "Sec-WebSocket-Protocol"}},
	 {"type": "vless", "tag": "GRPC", "server": "g.example.com", "server_port": 443, "uuid": "` + uuid + `", "tls": {"enabled": true}, "transport": {"type": "grpc", "service_name": "svc"}},
	 {"type": "hysteria2", "tag": "HY", "server": "hy.example.com", "server_ports": ["20000:30000"], "password": "secret",
	  "obfs": {"type": "salamander", "password": "ob"}, "tls": {"enabled": true, "server_name": "hy.example.com", "insecure": true}},
	 {"type": "vmess", "tag": "VM", "server": "v.example.com", "server_port": 443},
	 {"type": "direct", "tag": "direct"}]}`
	res, format, skipped := convert(t, body)
	m := byName(res)
	if format != FormatSingbox || len(res.Servers) != 4 || len(skipped) != 1 || skipped[0].Text != "VM" {
		t.Fatalf("sing-box: %s, серверов %d, пропущено %+v", format, len(res.Servers), skipped)
	}
	if s := m["NL"]; s.Security != "reality" || s.PublicKey != pbk || s.Fingerprint != "chrome" || s.Flow != "xtls-rprx-vision" {
		t.Errorf("Reality: %+v", s)
	}
	if s := m["WS"]; s.Path != "/ws" || s.EarlyData != 2048 || s.Host != "cdn.example.com" {
		t.Errorf("WebSocket: %+v", s)
	}
	if s := m["GRPC"]; s.Transport != "grpc" || s.ServiceName != "svc" {
		t.Errorf("gRPC: %+v", s)
	}
	if s := m["HY"]; s.Port != 20000 || !reflect.DeepEqual(s.Ports, []PortRange{{20000, 30000}}) || s.Obfs != "salamander" || !s.Insecure {
		t.Errorf("Hysteria2: порт %d, порты %v, %+v", s.Port, s.Ports, s)
	}
}

func TestConvertClash(t *testing.T) {
	body := `mixed-port: 7890
proxies:
  - name: "🇳🇱 NL"
    type: vless
    server: nl.example.com
    port: 443
    uuid: ` + uuid + `
    flow: xtls-rprx-vision
    tls: true
    servername: www.example.org
    client-fingerprint: chrome
    reality-opts:
      public-key: ` + pbk + `
      short-id: b43351f6
    network: tcp
  - name: WS
    type: vless
    server: ws.example.com
    port: 443
    uuid: ` + uuid + `
    tls: true
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: XH
    type: vless
    server: xh.example.com
    port: 443
    uuid: ` + uuid + `
    tls: true
    servername: xh.example.com
    network: xhttp
    xhttp-opts: {path: /xh, host: cdn.example.com, mode: stream-one}
  - {name: G, type: vless, server: g.example.com, port: 443, uuid: ` + uuid + `, tls: true, network: grpc, grpc-opts: {grpc-service-name: svc}}
  - name: HY
    type: hysteria2
    server: hy.example.com
    port: 443
    ports: 20000-30000
    password: secret
    obfs: salamander
    obfs-password: ob
    sni: hy.example.com
  - {name: VM, type: vmess, server: v.example.com, port: 443}
proxy-groups:
  - name: PROXY
    type: select
    proxies: [🇳🇱 NL, WS]
rules:
  - MATCH,PROXY
`
	res, format, skipped := convert(t, body)
	m := byName(res)
	if format != FormatClash || len(res.Servers) != 5 || len(skipped) != 1 || skipped[0].Text != "VM" {
		t.Fatalf("Clash: %s, серверов %d, пропущено %+v", format, len(res.Servers), skipped)
	}
	if s := m["🇳🇱 NL"]; s.Security != "reality" || s.PublicKey != pbk || s.ShortID != "b43351f6" || s.SNI != "www.example.org" || s.Fingerprint != "chrome" {
		t.Errorf("Reality: %+v", s)
	}
	if s := m["WS"]; s.Transport != "ws" || s.Path != "/ws" || s.Host != "cdn.example.com" {
		t.Errorf("WebSocket: %+v", s)
	}
	if s := m["XH"]; s.Transport != "xhttp" || s.Path != "/xh" || s.Mode != "stream-one" {
		t.Errorf("XHTTP: %+v", s)
	}
	if s := m["G"]; s.ServiceName != "svc" {
		t.Errorf("gRPC (строчный вид YAML): %+v", s)
	}
	if s := m["HY"]; !reflect.DeepEqual(s.Ports, []PortRange{{443, 443}, {20000, 30000}}) || s.ObfsPassword != "ob" {
		t.Errorf("Hysteria2: %+v", s)
	}
}

func TestConvertErrors(t *testing.T) {
	for body, want := range map[string]string{
		"proxy-providers:\n  p1:\n    type: http\n    url: https://x.example.com/p\n": "proxy-providers",
		`{"error": "not found"}`:                "не знает",
		`{"outbounds": [`:                       "испорчен",
		"<!doctype html><title>Кабинет</title>": "веб-страница",
		"proxies:\n  - name: [не закрыта\n":     "YAML испорчен",
	} {
		if _, _, _, err := ConvertBody(body, ""); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%.30q: ошибка %v, нужно «%s»", body, err, want)
		}
	}
	// Обычные ссылки — как есть.
	if out, f, _, err := ConvertBody("vless://x@a.example.com:443#A", ""); err != nil || f != "" || out != "vless://x@a.example.com:443#A" {
		t.Errorf("ссылки: %q %q %v", out, f, err)
	}
}

// Ссылка → сервер → ссылка → сервер: ничего не теряется.
func TestShareLinkRoundTrip(t *testing.T) {
	for _, link := range []string{
		"vless://" + uuid + "@nl1.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.org&fp=chrome&pbk=" + pbk + "&sid=b43351f6&spx=%2F&type=tcp#%F0%9F%87%B3%F0%9F%87%B1%20NL%20%231",
		"vless://" + uuid + "@[2001:db8::1]:8443?security=tls&sni=v6.example.com&alpn=h2%2Chttp%2F1.1&allowInsecure=1&pcs=AB%3ACD&vcn=a.example.com%2Cb.example.com&type=xhttp&path=%2Fxh&host=cdn.example.com&mode=packet-up&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#V6",
		"vless://" + uuid + "@ws.example.com:443?security=tls&type=ws&path=%2Fws%3Fed%3D2048&host=cdn.example.com#WS",
		"vless://" + uuid + "@g.example.com:443?security=tls&type=grpc&serviceName=svc&encryption=mlkem768x25519plus.native.0rtt." + pbk + "#G",
		"hysteria2://p%40ss%3Aword%20x@hy.example.com:443,20000-30000/?sni=hy.example.com&insecure=1&obfs=salamander&obfs-password=ob&pinSHA256=AA%3ABB#HY",
	} {
		a, err := Parse(link)
		if err != nil {
			t.Fatalf("%s: %v", link, err)
		}
		b, err := Parse(a.ShareLink())
		if err != nil {
			t.Fatalf("обратно не разобралась %s: %v", a.ShareLink(), err)
		}
		a.Link, b.Link, a.Warnings, b.Warnings = "", "", nil, nil
		if !reflect.DeepEqual(a, b) {
			t.Errorf("потеряно при переводе:\n было %+v\nстало %+v\nссылка %s", a, b, a.ShareLink())
		}
	}
}
