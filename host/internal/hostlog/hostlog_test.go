package hostlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"

func TestMaskLink(t *testing.T) {
	for in, want := range map[string]string{
		"vless://" + uuid + "@vpn.example.com:443?pbk=KEY&sid=b4#Амстердам": "vless://d47d…@vpn.example.com:443?…#Амстердам",
		"hysteria2://secret-pass@hy.example.com:443/?obfs-password=x#HY":    "hysteria2://***@hy.example.com:443/?…#HY",
		"hy2://a/b@c@hy.example.com:443":                                    "hy2://***@hy.example.com:443",
		"vless://short@h.example.com:443":                                   "vless://***@h.example.com:443",
		"vless://" + uuid + "@h.example.com:443#EU%20%7C%20LTE":             "vless://d47d…@h.example.com:443#EU | LTE",
		"vmess://eyJhZGQiOiJ4IiwiaWQiOiJzZWNyZXQifQ==#VM":                   "vmess://…#VM",
		"не ссылка": "***",
	} {
		if got := MaskLink(in); got != want {
			t.Errorf("MaskLink(%q) = %q, ожидалось %q", in, got, want)
		}
	}
}

func TestMask(t *testing.T) {
	AddSecret("очень-секретный-пароль")
	AddSecret("ab") // слишком короткий — не запоминается, иначе маскировал бы всё подряд
	in := "сервер vless://" + uuid + "@h.example.com:443?pbk=K#A, uuid " + strings.ToUpper(uuid) +
		", пароль очень-секретный-пароль, слово ab"
	got := Mask(in)
	for _, leak := range []string{uuid, strings.ToUpper(uuid), "очень-секретный-пароль", "pbk=K"} {
		if strings.Contains(got, leak) {
			t.Errorf("в тексте осталось %q: %s", leak, got)
		}
	}
	if !strings.Contains(got, "слово ab") {
		t.Errorf("короткие строки не должны маскироваться: %s", got)
	}
}

func TestMaskURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://sub.example.com/api/sub/TOKEN?x=1": "https://sub.example.com/…",
		"https://sub.example.com":                   "https://sub.example.com",
		"ерунда":                                    "***",
	} {
		if got := MaskURL(in); got != want {
			t.Errorf("MaskURL(%q) = %q, ожидалось %q", in, got, want)
		}
	}
}

func TestPrintf(t *testing.T) {
	dir := t.TempDir()
	if err := Open(dir); err != nil {
		t.Fatal(err)
	}
	Printf("ссылка %s", "vless://"+uuid+"@h.example.com:443")
	Close()
	data, err := os.ReadFile(filepath.Join(dir, "host.log"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), uuid) || !strings.Contains(string(data), "vless://d47d…@h.example.com:443") {
		t.Errorf("журнал: %s", data)
	}
}
