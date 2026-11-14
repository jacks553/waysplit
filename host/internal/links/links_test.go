package links

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// Все ссылки в тестах вымышленные: адреса из example.com и документационных сетей
// (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), ключи сгенерированы для тестов.
const (
	uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	pbk  = "eG9ft1Ut-iZk-V87OwAE_APpKV_H8OYoS1KBvjlJwlg"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name  string
		link  string
		err   string                        // ожидаемая ошибка (часть текста); пусто — ссылка верная
		check func(t *testing.T, s *Server) // проверки разобранного сервера
	}{
		{
			name: "VLESS Reality Vision с флагом в имени",
			link: "vless://" + uuid + "@nl1.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.org&fp=chrome&pbk=" + pbk + "&sid=b43351f6&spx=%2F&type=tcp&headerType=none#%F0%9F%87%B3%F0%9F%87%B1%20%D0%90%D0%BC%D1%81%D1%82%D0%B5%D1%80%D0%B4%D0%B0%D0%BC",
			check: func(t *testing.T, s *Server) {
				want := Server{Protocol: "vless", Name: "🇳🇱 Амстердам", Address: "nl1.example.com", Port: 443, Transport: "tcp", Security: "reality",
					UUID: uuid, Flow: "xtls-rprx-vision", Encryption: "none", SNI: "www.example.org", Fingerprint: "chrome", PublicKey: pbk, ShortID: "b43351f6", HeaderType: "none"}
				same(t, s, &want, "Protocol", "Name", "Address", "Port", "Transport", "Security", "UUID", "Flow", "Encryption", "SNI", "Fingerprint", "PublicKey", "ShortID", "HeaderType")
				if len(s.Warnings) != 0 || len(s.Ignored) != 0 {
					t.Errorf("лишние предупреждения %v или параметры %v", s.Warnings, s.Ignored)
				}
			},
		},
		{
			name: "VLESS WS TLS: ed из path, alpn списком",
			link: "vless://" + uuid + "@cdn.example.com:443?security=tls&sni=cdn.example.com&alpn=h2%2Chttp%2F1.1&fp=firefox&type=ws&host=cdn.example.com&path=%2Fws%3Fed%3D2048#WS",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Transport: "ws", Path: "/ws", EarlyData: 2048, Host: "cdn.example.com", ALPN: []string{"h2", "http/1.1"}, Fingerprint: "firefox"},
					"Transport", "Path", "EarlyData", "Host", "ALPN", "Fingerprint")
			},
		},
		{
			name: "ed в path вместе с другим параметром",
			link: "vless://" + uuid + "@cdn.example.com:443?security=tls&type=ws&path=%2Fws%3Fx%3D1%26ed%3D4096",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Path: "/ws?x=1", EarlyData: 4096}, "Path", "EarlyData")
			},
		},
		{
			name: "VLESS gRPC, allowInsecure — предупреждение",
			link: "vless://" + uuid + "@203.0.113.5:443?security=tls&sni=g.example.com&allowInsecure=1&type=grpc&serviceName=grpc-svc&mode=gun#gRPC",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Transport: "grpc", ServiceName: "grpc-svc", Insecure: true}, "Transport", "ServiceName", "Insecure")
				wantWarn(t, s, "Проверка сертификата")
			},
		},
		{
			name: "VLESS httpupgrade на IPv6, имя по умолчанию",
			link: "vless://" + uuid + "@[2001:db8::1]:8443?security=tls&sni=cdn.example.com&type=httpupgrade&host=cdn.example.com&path=%2Fup",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Address: "2001:db8::1", Port: 8443, Transport: "httpupgrade", Path: "/up", Name: "VLESS [2001:db8::1]:8443"}, "Address", "Port", "Transport", "Path", "Name")
			},
		},
		{
			name: "type=h2 — это транспорт http",
			link: "vless://" + uuid + "@h2.example.com:443?security=tls&type=h2&host=a.example.com,b.example.com&path=/h2#H2",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Transport: "http", Host: "a.example.com,b.example.com", Path: "/h2"}, "Transport", "Host", "Path")
			},
		},
		{
			name: "без TLS — предупреждение",
			link: "vless://" + uuid + "@198.51.100.7:80?type=tcp#plain",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Security: "none", Transport: "tcp"}, "Security", "Transport")
				wantWarn(t, s, "Без TLS")
			},
		},
		{
			name: "xhttp разбирается (отказ — уже в пакете singbox)",
			link: "vless://" + uuid + "@eu.example.com:443?security=tls&sni=eu.example.com&type=xhttp&path=%2Fx&mode=auto#EU%20%7C%20LTE",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Transport: "xhttp", Name: "EU | LTE"}, "Transport", "Name")
			},
		},
		{
			name:  "splithttp — старое имя xhttp",
			link:  "vless://" + uuid + "@eu.example.com:443?security=tls&type=splithttp",
			check: func(t *testing.T, s *Server) { same(t, s, &Server{Transport: "xhttp"}, "Transport") },
		},
		{
			name: "заглавные буквы в схеме и параметрах",
			link: "VLESS://" + uuid + "@Up.Example.COM:443?Security=TLS&SNI=up.example.com&Type=WS",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Address: "up.example.com", Security: "tls", Transport: "ws", SNI: "up.example.com"}, "Address", "Security", "Transport", "SNI")
			},
		},
		{
			name:  "pbk в обычном base64 с «=» приводится к base64url",
			link:  "vless://" + uuid + "@r.example.com:443?security=reality&sni=www.example.org&pbk=" + strings.NewReplacer("-", "+", "_", "/").Replace(pbk) + "%3D",
			check: func(t *testing.T, s *Server) { same(t, s, &Server{PublicKey: pbk}, "PublicKey") },
		},
		{
			name: "Reality без sni: берём домен сервера и предупреждаем",
			link: "vless://" + uuid + "@r.example.com:443?security=reality&pbk=" + pbk,
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{SNI: "r.example.com"}, "SNI")
				wantWarn(t, s, "нет sni")
			},
		},
		{
			name: "неизвестные параметры собираются для журнала",
			link: "vless://" + uuid + "@h.example.com:443?security=tls&foo=1&bar=&foo=2",
			check: func(t *testing.T, s *Server) {
				if !reflect.DeepEqual(s.Ignored, []string{"foo", "bar"}) {
					t.Errorf("Ignored = %v", s.Ignored)
				}
			},
		},
		{
			name:  "имя с «%» без кодирования не ломает разбор",
			link:  "vless://" + uuid + "@h.example.com:443?security=tls#Скидка 100%",
			check: func(t *testing.T, s *Server) { same(t, s, &Server{Name: "Скидка 100%"}, "Name") },
		},
		{
			name:  "«+» в параметре остаётся плюсом",
			link:  "vless://" + uuid + "@h.example.com:443?security=tls&type=ws&path=/a+b",
			check: func(t *testing.T, s *Server) { same(t, s, &Server{Path: "/a+b"}, "Path") },
		},
		{
			name: "Hysteria2: пароль с %-кодированием",
			link: "hysteria2://p%40ss%3Aword@hy.example.com:443/?sni=hy.example.com#HY",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Protocol: "hysteria2", Password: "p@ss:word", Port: 443, SNI: "hy.example.com", Name: "HY", Security: "tls", Transport: "udp"},
					"Protocol", "Password", "Port", "SNI", "Name", "Security", "Transport")
				if s.Ports != nil {
					t.Errorf("Ports = %v, ожидался один порт", s.Ports)
				}
			},
		},
		{
			name: "hy2:// без порта — 443, insecure — предупреждение",
			link: "hy2://secret@hy.example.com/?insecure=1",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Port: 443, Insecure: true, Name: "Hysteria2 hy.example.com:443"}, "Port", "Insecure", "Name")
				wantWarn(t, s, "Проверка сертификата")
			},
		},
		{
			name: "Hysteria2: несколько портов в адресе, salamander",
			link: "hysteria2://pw@hy.example.com:443,20000-50000/?obfs=salamander&obfs-password=ob#Multi",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Port: 443, Ports: []PortRange{{443, 443}, {20000, 50000}}, Obfs: "salamander", ObfsPassword: "ob"}, "Port", "Ports", "Obfs", "ObfsPassword")
			},
		},
		{
			name: "Hysteria2: параметр mport",
			link: "hysteria2://pw@hy.example.com:443?mport=20000-30000,443",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Port: 443, Ports: []PortRange{{443, 443}, {20000, 30000}}}, "Port", "Ports")
			},
		},
		{
			name: "Hysteria2: user:pass — пароль целиком",
			link: "hysteria2://user:pass@hy.example.com:8443",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Password: "user:pass", Port: 8443}, "Password", "Port")
			},
		},
		{
			name: "Hysteria2: «/» и «@» в пароле без кодирования",
			link: "hysteria2://a/b@c@hy.example.com:443#X",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{Password: "a/b@c", Address: "hy.example.com"}, "Password", "Address")
			},
		},
		{
			name: "Hysteria2: pinSHA256 сохраняется",
			link: "hysteria2://pw@192.0.2.10:443?insecure=1&pinSHA256=AA:BB:CC",
			check: func(t *testing.T, s *Server) {
				same(t, s, &Server{PinSHA256: "AA:BB:CC", Insecure: true}, "PinSHA256", "Insecure")
			},
		},
		{
			name:  "невидимые символы по краям строки",
			link:  "\ufeff  vless://" + uuid + "@h.example.com:443?security=tls#A\u200b ",
			check: func(t *testing.T, s *Server) { same(t, s, &Server{Name: "A"}, "Name") },
		},

		// Битые и неподдерживаемые ссылки
		{name: "Reality без pbk", link: "vless://" + uuid + "@r.example.com:443?security=reality&sni=www.example.org", err: "нет ключа pbk"},
		{name: "Reality с неверным pbk", link: "vless://" + uuid + "@r.example.com:443?security=reality&sni=x.org&pbk=abc", err: "неверный ключ pbk"},
		{name: "Reality: sid длиннее 16 (sing-box падал бы целиком)", link: "vless://" + uuid + "@r.example.com:443?security=reality&sni=x.org&pbk=" + pbk + "&sid=0123456789abcdef01", err: "неверный sid"},
		{name: "Reality: нечётный sid", link: "vless://" + uuid + "@r.example.com:443?security=reality&sni=x.org&pbk=" + pbk + "&sid=abc", err: "неверный sid"},
		{name: "Reality: sid не hex", link: "vless://" + uuid + "@r.example.com:443?security=reality&sni=x.org&pbk=" + pbk + "&sid=zz", err: "неверный sid"},
		{name: "Reality без sni на IP", link: "vless://" + uuid + "@203.0.113.9:443?security=reality&pbk=" + pbk, err: "нет sni"},
		{name: "VLESS без порта", link: "vless://" + uuid + "@h.example.com?security=tls", err: "нет порта"},
		{name: "VLESS с портом 70000", link: "vless://" + uuid + "@h.example.com:70000", err: "неверный порт"},
		{name: "VLESS без uuid", link: "vless://@h.example.com:443", err: "нет uuid"},
		{name: "IPv6 без скобок", link: "vless://" + uuid + "@2001:db8::1:443", err: "квадратных скобках"},
		{name: "IPv6 без закрывающей скобки", link: "vless://" + uuid + "@[2001:db8::1:443", err: "закрывающей"},
		{name: "пустой адрес", link: "vless://" + uuid + "@:443", err: "нет адреса"},
		{name: "Hysteria2 без пароля", link: "hysteria2://@hy.example.com:443", err: "нет пароля"},
		{name: "Hysteria2: salamander без пароля", link: "hy2://pw@hy.example.com:443?obfs=salamander", err: "без obfs-password"},
		{name: "Hysteria2: диапазон наоборот", link: "hy2://pw@hy.example.com:50000-20000", err: "неверный диапазон"},
		{name: "Hysteria2: неверный mport", link: "hy2://pw@hy.example.com:443?mport=abc", err: "mport"},
		{name: "VMess пока не поддерживается", link: "vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9", err: "VMess пока не поддерживается"},
		{name: "Trojan пока не поддерживается", link: "trojan://pw@t.example.com:443#T", err: "Trojan пока не поддерживается"},
		{name: "просто текст", link: "привет", err: "не похоже на ссылку"},
		{name: "неизвестная схема", link: "foo://bar@baz:1", err: "не распознана"},
		{name: "пустая строка", link: "   ", err: "пустая строка"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, err := Parse(tt.link)
			if tt.err != "" {
				if err == nil {
					t.Fatalf("ожидалась ошибка «%s», а ссылка разобралась: %+v", tt.err, s)
				}
				if !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("ошибка «%v», ожидалась «%s»", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("неожиданная ошибка: %v", err)
			}
			if s.Link != cleanLine(tt.link) {
				t.Errorf("Link = %q", s.Link)
			}
			tt.check(t, s)
		})
	}
}

func TestParseSubscriptionURL(t *testing.T) {
	if _, err := Parse("https://sub.example.com/api/sub/abc"); !errors.Is(err, ErrSubscription) {
		t.Fatalf("ожидалась ErrSubscription, получено %v", err)
	}
}

// TestHapp — ссылки приложения Happ: зашифрованные (любая версия crypt, любой регистр) и прочие
// happ:// — в пропущенные с понятной причиной; happ://add/https://… — подписка по этому адресу.
// В тексте ошибки нет ни шифровки, ни адреса.
func TestHapp(t *testing.T) {
	const payload = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy"
	skipped := map[string]string{ // строка → как она видна в ошибке
		"happ://crypt/" + payload:                          "happ://crypt/…",
		"happ://crypt2/" + payload:                         "happ://crypt2/…",
		"happ://crypt3/" + payload + "?x=1#Имя":            "happ://crypt3/…",
		"happ://crypt4/" + payload:                         "happ://crypt4/…",
		"HAPP://CRYPT5/" + payload:                         "HAPP://CRYPT5/…",
		"Happ://Crypt4/" + payload:                         "Happ://Crypt4/…",
		"happ://add/http://sub.example.com/sub/" + payload: "happ://add/…", // не https
		"happ://add/https://":                              "happ://add/…", // нет адреса
		"happ://add/":                                      "happ://add/…",
		"happ://add/" + payload:                            "happ://add/…",
		"happ://route/" + payload:                          "happ://route/…",
		"happ://" + payload + "@x.example.com":             "happ://…",
	}
	for line, preview := range skipped {
		if _, err := Parse(line); !errors.Is(err, ErrHapp) {
			t.Errorf("Parse(%q): %v, ожидалась ErrHapp", line, err)
		}
		r := ParseText(" " + string(rune(0xFEFF)) + line + "\r\n") // BOM и пробел прилипают при копировании
		if len(r.Servers) != 0 || len(r.Subscriptions) != 0 || len(r.Errors) != 1 {
			t.Errorf("%q: серверы %d, подписки %v, ошибки %+v", line, len(r.Servers), r.Subscriptions, r.Errors)
			continue
		}
		e := r.Errors[0]
		if e.Reason != ErrHapp.Error() || !strings.Contains(e.Reason, "открыть её может только Happ") || !strings.Contains(e.Reason, "(https://…)") {
			t.Errorf("%q: причина %q", line, e.Reason)
		}
		if e.Text != preview {
			t.Errorf("%q: в ошибке %q, ожидалось %q", line, e.Text, preview)
		}
		if strings.Contains(e.Text, payload) || strings.Contains(e.Text, "sub.example.com") {
			t.Errorf("%q: в ошибке видна ссылка: %q", line, e.Text)
		}
	}

	// happ://add/https://… — подписка, как будто вставили сам адрес.
	for line, want := range map[string]string{
		"happ://add/https://sub.example.com/api/sub/" + payload:          "https://sub.example.com/api/sub/" + payload,
		"HAPP://ADD/https://sub.example.com/s?token=" + payload + "#Мой": "https://sub.example.com/s?token=" + payload + "#Мой",
		"happ://add/HTTPS://Sub.Example.com/x":                           "HTTPS://Sub.Example.com/x",
	} {
		if _, err := Parse(line); !errors.Is(err, ErrSubscription) {
			t.Errorf("Parse(%q): %v, ожидалась ErrSubscription", line, err)
		}
		r := ParseText("vless://" + uuid + "@a.example.com:443?security=tls#A\n" + line + "\n")
		if len(r.Errors) != 0 || len(r.Servers) != 1 || !reflect.DeepEqual(r.Subscriptions, []string{want}) {
			t.Errorf("%q: подписки %v, серверы %d, ошибки %+v", line, r.Subscriptions, len(r.Servers), r.Errors)
		}
	}
}

func TestParseText(t *testing.T) {
	text := "# мои серверы\r\n" +
		"vless://" + uuid + "@a.example.com:443?security=tls#A\r\n" +
		"\r\n" +
		"// ещё комментарий\n" +
		"hy2://pw@b.example.com:443#B\n" +
		"vless://" + uuid + "@A.example.com:443?security=tls&type=ws#A-копия\n" +
		"https://sub.example.com/sub/secret-token\n" +
		"vless://" + uuid + "@c.example.com:443?type=xhttp&security=tls#C\n" +
		"мусор\n"
	r := ParseText(text)
	var names []string
	for _, s := range r.Servers {
		names = append(names, s.Name)
	}
	if !reflect.DeepEqual(names, []string{"A", "B", "C"}) {
		t.Errorf("серверы %v", names)
	}
	if r.Servers[1].Line != 5 {
		t.Errorf("строка сервера B = %d, ожидалась 5", r.Servers[1].Line)
	}
	if len(r.Errors) != 2 || r.Errors[0].Line != 6 || !strings.Contains(r.Errors[0].Reason, "уже есть (строка 2)") || r.Errors[1].Line != 9 {
		t.Errorf("ошибки %+v", r.Errors)
	}
	if !reflect.DeepEqual(r.Subscriptions, []string{"https://sub.example.com/sub/secret-token"}) {
		t.Errorf("подписки %v", r.Subscriptions)
	}
	if strings.Contains(r.Errors[0].Text, uuid) {
		t.Errorf("в тексте ошибки виден uuid: %s", r.Errors[0].Text)
	}
}

func TestKey(t *testing.T) {
	a, _ := Parse("vless://" + uuid + "@A.example.com:443?security=tls#A")
	b, _ := Parse("vless://" + uuid + "@a.example.com:443?security=reality&sni=x.org&pbk=" + pbk + "#B")
	c, _ := Parse("vless://" + uuid + "@a.example.com:8443#C")
	if a.Key() != b.Key() {
		t.Errorf("один сервер с разными параметрами должен совпадать: %s / %s", a.Key(), b.Key())
	}
	if a.Key() == c.Key() {
		t.Error("разные порты — разные серверы")
	}
}

// same сравнивает только перечисленные поля.
func same(t *testing.T, got, want *Server, fields ...string) {
	t.Helper()
	g, w := reflect.ValueOf(got).Elem(), reflect.ValueOf(want).Elem()
	for _, f := range fields {
		if a, b := g.FieldByName(f).Interface(), w.FieldByName(f).Interface(); !reflect.DeepEqual(a, b) {
			t.Errorf("%s = %#v, ожидалось %#v", f, a, b)
		}
	}
}

func wantWarn(t *testing.T, s *Server, part string) {
	t.Helper()
	for _, w := range s.Warnings {
		if strings.Contains(w, part) {
			return
		}
	}
	t.Errorf("нет предупреждения «%s», есть %v", part, s.Warnings)
}

// XHTTP и параметры для Xray (SPEC-XRAY.md): path, host, mode, extra (JSON, раскодированный из %XX),
// spx, pcs, vcn; encryption — как есть.
func TestXHTTPParams(t *testing.T) {
	enc := "mlkem768x25519plus.native.0rtt." + pbk
	link := "vless://" + uuid + "@eu.example.com:443?encryption=" + enc + "&security=reality&sni=www.example.org&pbk=" + pbk +
		"&sid=ab&spx=%2Fstart&type=xhttp&path=%2Fxh%3Fa%3D1&host=cdn.example.com&mode=Stream-One" +
		"&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%2C%22xmux%22%3A%7B%22maxConcurrency%22%3A%2216-32%22%7D%7D#EU"
	s, err := Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"Transport": s.Transport, "Path": s.Path, "Host": s.Host, "Mode": s.Mode, "SpiderX": s.SpiderX, "Encryption": s.Encryption,
	}
	for k, v := range map[string]string{"Transport": "xhttp", "Path": "/xh?a=1", "Host": "cdn.example.com", "Mode": "stream-one",
		"SpiderX": "/start", "Encryption": enc} {
		if want[k] != v {
			t.Errorf("%s = %q, нужно %q", k, want[k], v)
		}
	}
	if s.Extra != `{"xPaddingBytes":"100-1000","xmux":{"maxConcurrency":"16-32"}}` {
		t.Errorf("extra = %q", s.Extra)
	}
	if len(s.Ignored) != 0 {
		t.Errorf("непрочитанные параметры: %v", s.Ignored)
	}

	s, err = Parse("vless://" + uuid + "@tls.example.com:443?security=tls&type=splithttp&pcs=AB%3ACD&vcn=real.example.com#S")
	if err != nil || s.Transport != "xhttp" || s.PinnedCert != "AB:CD" || s.VerifyName != "real.example.com" {
		t.Errorf("splithttp, pcs, vcn: %+v %v", s, err)
	}
	for _, bad := range []string{"%7Bнет", "%5B1%2C2%5D", "null"} {
		if _, err := Parse("vless://" + uuid + "@x.example.com:443?type=xhttp&extra=" + bad + "#X"); err == nil || !strings.Contains(err.Error(), "extra") {
			t.Errorf("extra=%s: нужна ошибка про extra, есть %v", bad, err)
		}
	}
}
