package singbox

import (
	"bytes"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"waysplit/host/internal/links"
)

var update = flag.Bool("update", false, "переписать эталонные конфиги в testdata")

// Вымышленные данные: адреса example.com и документационных сетей, ключи сгенерированы для тестов.
const (
	uuid     = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	pbk      = "eG9ft1Ut-iZk-V87OwAE_APpKV_H8OYoS1KBvjlJwlg"
	realityL = "vless://" + uuid + "@nl1.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.org&fp=chrome&pbk=" + pbk + "&sid=b43351f6&spx=%2F&type=tcp&headerType=none#NL"
)

// Эталонные конфиги: testdata/<имя>.json. Каждый ещё и прогоняется через `sing-box check`.
var goldens = []struct {
	name    string
	entries []Entry
}{
	{"reality_vision", []Entry{{ID: "s_ab12", Link: realityL, LocalPort: 27101}}},
	{"vless_transports", []Entry{
		{ID: "ws", Link: "vless://" + uuid + "@cdn.example.com:443?security=tls&sni=cdn.example.com&alpn=h2%2Chttp%2F1.1&fp=firefox&type=ws&host=cdn.example.com&path=%2Fws%3Fed%3D2048#WS", LocalPort: 27102},
		{ID: "grpc", Link: "vless://" + uuid + "@203.0.113.5:443?security=tls&sni=g.example.com&allowInsecure=1&type=grpc&serviceName=grpc-svc#gRPC", LocalPort: 27103},
		{ID: "hu", Link: "vless://" + uuid + "@[2001:db8::1]:8443?security=tls&type=httpupgrade&host=cdn.example.com&path=%2Fup#HU", LocalPort: 27104},
		{ID: "h2", Link: "vless://" + uuid + "@h2.example.com:443?security=tls&type=h2&host=a.example.com,b.example.com&path=/h2#H2", LocalPort: 27105},
		{ID: "plain", Link: "vless://" + uuid + "@198.51.100.7:80?type=tcp#plain", LocalPort: 27106},
		{ID: "udp443", Link: "vless://" + uuid + "@r.example.com:443?security=reality&sni=www.example.org&pbk=" + pbk + "&flow=xtls-rprx-vision-udp443&fp=randomizednoalpn#udp443", LocalPort: 27107},
	}},
	{"hysteria2", []Entry{
		{ID: "hy", Link: "hysteria2://p%40ss%3Aword@hy.example.com:443/?sni=hy.example.com#HY", LocalPort: 27110},
		{ID: "multi", Link: "hysteria2://pw@hy.example.com:443,20000-50000/?obfs=salamander&obfs-password=ob#Multi", LocalPort: 27111},
		{ID: "mport", Link: "hy2://pw@192.0.2.10:8443?mport=30000-31000&insecure=1&pinSHA256=AA:BB#mport", LocalPort: 27112},
	}},
}

func TestGolden(t *testing.T) {
	bin := testBinary(t)
	for _, g := range goldens {
		t.Run(g.name, func(t *testing.T) {
			b, err := Build(g.entries, "warn")
			if err != nil || len(b.Errors) > 0 {
				t.Fatalf("сборка: %v %+v", err, b.Errors)
			}
			got, err := b.Config.JSON()
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("testdata", g.name+".json")
			if *update {
				os.MkdirAll("testdata", 0o755)
				if err := os.WriteFile(path, got, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("нет эталона (go test -run TestGolden -update): %v", err)
			}
			if !bytes.Equal(got, bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n"))) {
				t.Errorf("конфиг отличается от %s.\nПолучилось:\n%s", path, got)
			}
			if bin == "" {
				return
			}
			out, err := Check(bin, path)
			if err != nil {
				t.Fatalf("sing-box check: %v\n%s", err, out)
			}
			if out != "" {
				t.Errorf("sing-box check выдал предупреждения (нужно без них):\n%s", out)
			}
		})
	}
}

func TestUnsupported(t *testing.T) {
	tests := []struct{ link, err string }{
		{"vless://" + uuid + "@eu.example.com:443?security=tls&type=xhttp&path=%2Fx#EU", "транспорт xhttp не поддерживается sing-box"},
		{"vless://" + uuid + "@eu.example.com:443?security=tls&type=splithttp", "транспорт xhttp не поддерживается sing-box"},
		{"vless://" + uuid + "@k.example.com:443?type=kcp", "транспорт kcp не поддерживается"},
		{"vless://" + uuid + "@q.example.com:443?type=quic&security=tls", "транспорт quic не поддерживается"},
		{"vless://" + uuid + "@t.example.com:80?type=tcp&headerType=http", "headerType=http не поддерживается"},
		{"vless://" + uuid + "@e.example.com:443?encryption=mlkem768x25519plus.native.0rtt.SECRETKEY&security=tls", "VLESS Encryption не поддерживается"},
		{"vless://" + uuid + "@f.example.com:443?flow=xtls-rprx-direct&security=tls", "flow=xtls-rprx-direct не поддерживается"},
		{"vless://" + uuid + "@x.example.com:443?security=xtls", "security=xtls не поддерживается"},
		{"hy2://pw@hy.example.com:443?obfs=gecko&obfs-password=x", "obfs=gecko не поддерживается"},
	}
	for _, tt := range tests {
		s, err := links.Parse(tt.link)
		if err != nil {
			t.Fatalf("%s: разбор: %v", tt.link, err)
		}
		_, _, err = OutboundFor(s, "out")
		if err == nil || !strings.Contains(err.Error(), tt.err) {
			t.Errorf("%s:\n  ошибка %v, ожидалась «%s»", tt.link, err, tt.err)
		}
		if err != nil && strings.Contains(err.Error(), "SECRETKEY") {
			t.Errorf("в тексте ошибки виден ключ VLESS Encryption: %v", err)
		}
	}
}

func TestWarnings(t *testing.T) {
	tests := []struct{ link, warn string }{
		{strings.Replace(realityL, "#NL", "&pqv=abc#NL", 1), "pqv"},
		{"vless://" + uuid + "@h.example.com:443?security=tls&fp=netscape", "fp=netscape sing-box не знает"},
		{"hy2://pw@hy.example.com:443?pinSHA256=AA:BB", "сертификат проверяется обычным способом"},
		{"hy2://pw@hy.example.com:443?pinSHA256=AA:BB&insecure=1", "не защищено от подмены"},
	}
	for _, tt := range tests {
		s, err := links.Parse(tt.link)
		if err != nil {
			t.Fatalf("%s: разбор: %v", tt.link, err)
		}
		_, warns, err := OutboundFor(s, "out")
		if err != nil {
			t.Fatalf("%s: %v", tt.link, err)
		}
		if !strings.Contains(strings.Join(warns, "\n"), tt.warn) {
			t.Errorf("%s:\n  предупреждения %v, ожидалось «%s»", tt.link, warns, tt.warn)
		}
	}
}

func TestBuildErrors(t *testing.T) {
	good := "vless://" + uuid + "@a.example.com:443?security=tls#A"
	b, err := Build([]Entry{
		{ID: "a", Link: good, LocalPort: 27101},
		{ID: "a", Link: good, LocalPort: 27102},                                                  // повтор id
		{ID: "b", Link: "vless://" + uuid + "@b.example.com:443?security=tls", LocalPort: 27101}, // занятый порт
		{ID: "c d", Link: good, LocalPort: 27103},                                                // плохой id
		{ID: "e", Link: good, LocalPort: 80},                                                     // порт < 1024
		{ID: "f", Link: "ерунда", LocalPort: 27104},
		{ID: "g", Link: "vless://" + uuid + "@g.example.com:443?type=xhttp", LocalPort: 27105},
	}, "verbose")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Config.Outbounds) != 1 || b.Ports["a"] != 27101 {
		t.Errorf("в конфиг должен войти только a: %+v", b.Ports)
	}
	if b.Config.Log.Level != "warn" {
		t.Errorf("неизвестный уровень журнала должен стать warn, а не %q", b.Config.Log.Level)
	}
	want := []string{"уже есть", "порт 27101 уже назначен серверу a", "неверный id", "неверный локальный порт 80", "ссылка не распознана", "xhttp"}
	if len(b.Errors) != len(want) {
		t.Fatalf("ошибки %+v", b.Errors)
	}
	for i, w := range want {
		if !strings.Contains(b.Errors[i].Message, w) {
			t.Errorf("ошибка %d: «%s», ожидалось «%s»", i, b.Errors[i].Message, w)
		}
	}
	_, err = Build([]Entry{{ID: "x", Link: "ерунда", LocalPort: 27101}}, "warn")
	var se *Error
	if !errors.As(err, &se) || se.Code != "NO_SERVERS" {
		t.Errorf("ожидалась ошибка NO_SERVERS, получено %v", err)
	}
}

// Validate: если ядро не приняло общий конфиг, плохой сервер вычисляется
// проверкой по одному и выкидывается, остальные работают.
func TestValidateDropsBadServer(t *testing.T) {
	calls := 0
	runCheck = func(bin, path string) (string, error) {
		calls++
		data, _ := os.ReadFile(path)
		if bytes.Contains(data, []byte("bad.example.com")) {
			return "FATAL[0000] initialize outbound[1]: что-то не так", &Error{Code: "CONFIG_INVALID", Message: "sing-box не принял конфиг: что-то не так"}
		}
		return "", nil
	}
	defer func() { runCheck = Check }()
	entries := []Entry{
		{ID: "a", Link: "vless://" + uuid + "@a.example.com:443?security=tls", LocalPort: 27101},
		{ID: "bad", Link: "vless://" + uuid + "@bad.example.com:443?security=tls", LocalPort: 27102},
		{ID: "c", Link: "vless://" + uuid + "@c.example.com:443?security=tls", LocalPort: 27103},
	}
	b, err := Validate("sing-box.exe", t.TempDir(), entries, "warn")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Ports) != 2 || b.Ports["a"] == 0 || b.Ports["c"] == 0 {
		t.Errorf("должны остаться a и c: %v", b.Ports)
	}
	if len(b.Errors) != 1 || b.Errors[0].ID != "bad" {
		t.Errorf("ошибки %+v", b.Errors)
	}
	if calls != 5 { // общий + три по одному + итоговый
		t.Errorf("проверок %d, ожидалось 5", calls)
	}

	// Ядро вообще не запускается — по одному не проверяем, сразу ошибка.
	runCheck = func(bin, path string) (string, error) {
		return "", &Error{Code: "SINGBOX_FAILED", Message: "не удалось запустить sing-box"}
	}
	if _, err := Validate("sing-box.exe", t.TempDir(), entries, "warn"); err == nil || !strings.Contains(err.Error(), "не удалось запустить") {
		t.Errorf("ожидалась ошибка запуска ядра, получено %v", err)
	}
}

// testBinary — sing-box.exe из host\bin (или WAYSPLIT_SINGBOX). Нет — проверки ядром пропускаются.
func testBinary(t *testing.T) string {
	t.Helper()
	for _, p := range []string{os.Getenv("WAYSPLIT_SINGBOX"), filepath.Join("..", "..", "bin", "sing-box.exe")} {
		if p == "" {
			continue
		}
		if abs, err := filepath.Abs(p); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs
			}
		}
	}
	t.Log("sing-box.exe не найден (host\\bin) — проверка ядром пропущена")
	return ""
}

func needBinary(t *testing.T) string {
	t.Helper()
	bin := testBinary(t)
	if bin == "" {
		t.Skip("нужен sing-box.exe в host\\bin")
	}
	return bin
}
