package xray

import (
	"bytes"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"waysplit/host/internal/links"
	"waysplit/host/internal/singbox"
)

var update = flag.Bool("update", false, "переписать эталоны testdata/*.json")

// Всё вымышленное: uuid, ключи, адреса.
const (
	uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	pbk  = "eG9ft1Ut-iZk-V87OwAE_APpKV_H8OYoS1KBvjlJwlg"
	enc  = "mlkem768x25519plus.native.0rtt." + pbk // открытый ключ X25519 — 32 байта, как у настоящего
	pcs  = "6f0dbd0c8b8a5f2d7a3b9a1c0e4f5d6c7b8a9f0e1d2c3b4a59687766554433ff"
)

var goldenLinks = []string{
	"vless://" + uuid + "@eu.example.com:443?security=reality&sni=www.example.org&fp=chrome&pbk=" + pbk +
		"&sid=b43351f6&spx=%2F&type=xhttp&path=%2Fxh&host=cdn.example.com&mode=packet-up" +
		"&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#EU%20%7C%20LTE",
	"vless://" + uuid + "@tls.example.com:443?security=tls&sni=tls.example.com&alpn=h2%2Chttp%2F1.1&fp=firefox&pcs=" + pcs +
		"&vcn=real.example.com%2Calt.example.com&type=splithttp&path=%2Fp#TLS",
	"vless://" + uuid + "@enc.example.com:443?encryption=" + enc + "&flow=xtls-rprx-vision&security=reality&sni=www.example.org&pbk=" + pbk +
		"&sid=ab&type=tcp#ENC",
	"vless://" + uuid + "@ws.example.com:443?encryption=" + enc + "&security=tls&type=ws&path=%2Fws&host=ws.example.com#WS",
}

func entries(list []string) []singbox.Entry {
	var out []singbox.Entry
	for i, l := range list {
		out = append(out, singbox.Entry{ID: "s_" + string(rune('a'+i)), Link: l, LocalPort: 27101 + i})
	}
	return out
}

// xrayBin — xray.exe из host\bin (или WAYSPLIT_XRAY); нет — проверка самим Xray пропускается.
func xrayBin(t *testing.T) string {
	t.Helper()
	p := os.Getenv("WAYSPLIT_XRAY")
	if p == "" {
		p, _ = filepath.Abs(filepath.Join("..", "..", "bin", "xray.exe"))
	}
	if _, err := os.Stat(p); err != nil {
		t.Skip("нет xray.exe (tools\\setup.ps1 его скачает) — проверка самим Xray пропущена")
	}
	return p
}

func TestNeededAndPick(t *testing.T) {
	for _, tc := range []struct {
		link, core string
	}{
		{goldenLinks[0], "xray"},
		{goldenLinks[1], "xray"}, // splithttp — то же, что xhttp
		{goldenLinks[2], "xray"}, // VLESS Encryption
		{"vless://" + uuid + "@nl.example.com:443?security=reality&sni=www.example.org&pbk=" + pbk + "&type=tcp#NL", "sing-box"},
		{"vless://" + uuid + "@nl.example.com:443?encryption=none&security=tls&type=ws#WS", "sing-box"},
		{"hysteria2://secret@hy.example.com:443#HY", "sing-box"},
	} {
		s, err := links.Parse(tc.link)
		if err != nil {
			t.Fatalf("%s: %v", tc.link, err)
		}
		core, _, err := Pick(s)
		if err != nil || core != tc.core {
			t.Errorf("%s: ядро %s, ошибка %v; нужно %s", s.Name, core, err, tc.core)
		}
	}
}

func TestOutboundErrorsAndWarnings(t *testing.T) {
	bad := map[string]string{
		"vless://" + uuid + "@x.example.com:443?security=tls&type=xhttp&mode=turbo#M":              "неизвестный режим mode=turbo",
		"vless://" + uuid + "@x.example.com:443?security=tls&type=xhttp&flow=xtls-rprx-direct#F":   "flow=xtls-rprx-direct",
		"vless://" + uuid + "@x.example.com:443?encryption=" + enc + "&type=tcp&headerType=http#H": "headerType=http",
		"vless://" + uuid + "@x.example.com:443?encryption=" + enc + "&security=tls&type=kcp#K":    "транспорт kcp",
	}
	for link, want := range bad {
		s, err := links.Parse(link)
		if err != nil {
			t.Fatalf("%s: %v", link, err)
		}
		if _, _, err := OutboundFor(s, "x"); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: ошибка %v, нужно «%s»", s.Name, err, want)
		}
	}
	s, _ := links.Parse("vless://" + uuid + "@x.example.com:443?security=tls&allowInsecure=1&type=xhttp#I")
	o, warns, err := OutboundFor(s, "x")
	if err != nil || len(warns) != 1 || !strings.Contains(warns[0], "allowInsecure") {
		t.Errorf("allowInsecure без pcs: %v %v", warns, err)
	}
	if o.StreamSettings.TLSSettings.ServerName != "x.example.com" {
		t.Errorf("serverName по адресу: %+v", o.StreamSettings.TLSSettings)
	}
}

func TestBuildGolden(t *testing.T) {
	b, err := Build(append(entries(goldenLinks), singbox.Entry{ID: "s_bad", Link: "vless://нет", LocalPort: 27199}), "warn")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Errors) != 1 || b.Errors[0].ID != "s_bad" {
		t.Fatalf("плохая ссылка — в Errors: %+v", b.Errors)
	}
	got, err := b.Config.JSON()
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "xray.json")
	if *update {
		os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("нет эталона (go test ./internal/xray -run TestBuildGolden -update): %v", err)
	}
	if !bytes.Equal(bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n")), got) {
		t.Fatalf("конфиг не совпал с эталоном %s:\n%s", golden, got)
	}
	for _, must := range []string{`"password": "` + pbk, `"xPaddingBytes": "100-1000"`, `"pinnedPeerCertSha256": "` + pcs,
		`"verifyPeerCertByName": "real.example.com,alt.example.com"`,
		`"encryption": "` + enc, `"access": "none"`, `"protocol": "blackhole"`, `"network": "raw"`, `"mode": "packet-up"`} {
		if !strings.Contains(string(got), must) {
			t.Errorf("в конфиге нет %s", must)
		}
	}

	// Проверка самим Xray: конфиг принят.
	bin := xrayBin(t)
	if out, err := Check(bin, golden); err != nil {
		t.Fatalf("xray run -test не принял эталон: %v\n%s", err, out)
	} else {
		t.Logf("предупреждения Xray: %q", out)
	}
}

func TestCheckRejectsAndBisect(t *testing.T) {
	bin := xrayBin(t)
	dir := t.TempDir()
	// sid «zz» разбор ссылки не пропустит, поэтому плохой сервер — с неверным отпечатком fp:
	// его отвергает только сам Xray.
	badLink := "vless://" + uuid + "@bad.example.com:443?security=tls&fp=nosuchbrowser&type=xhttp#BAD"
	b, err := Validate(bin, dir, entries([]string{goldenLinks[0], badLink, goldenLinks[1]}), "warn")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if len(b.Ports) != 2 || len(b.Errors) != 1 || b.Errors[0].ID != "s_b" || !strings.Contains(b.Errors[0].Message, "fingerprint") {
		t.Fatalf("плохой сервер исключён с причиной: порты %v, ошибки %+v", b.Ports, b.Errors)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "xray-check-*.json")); len(left) != 0 {
		t.Fatalf("временные конфиги с секретами не удалены: %v", left)
	}
	if strings.Contains(b.Errors[0].Message, uuid) {
		t.Fatalf("в ошибке uuid: %s", b.Errors[0].Message)
	}
}

func TestValidateSingleBad(t *testing.T) {
	old := runCheck
	defer func() { runCheck = old }()
	runCheck = func(bin, path string) (string, error) {
		return "", &singbox.Error{Code: "CONFIG_INVALID", Message: "Xray не принял конфиг: тест"}
	}
	_, err := Validate("xray.exe", t.TempDir(), entries(goldenLinks[:1]), "warn")
	var se *singbox.Error
	if !errors.As(err, &se) || se.Code != "NO_SERVERS" {
		t.Fatalf("единственный сервер не прошёл — NO_SERVERS: %v", err)
	}
}
