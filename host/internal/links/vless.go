package links

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// parseVLESS: vless://uuid@host:port?параметры#имя
func parseVLESS(r *rawLink, link string) (*Server, error) {
	s := &Server{Protocol: "vless", Link: link, Address: r.host, Name: r.name}
	s.UUID = strings.TrimSpace(r.userinfo)
	if s.UUID == "" {
		return nil, errors.New("в ссылке нет uuid")
	}
	if r.ports == "" {
		return nil, errors.New("в ссылке нет порта")
	}
	port, err := parsePort(r.ports)
	if err != nil {
		return nil, err
	}
	s.Port = port

	seen := map[string]bool{}
	s.Encryption = r.get(seen, "encryption")
	s.Flow = strings.ToLower(r.get(seen, "flow"))
	s.Security = strings.ToLower(r.get(seen, "security"))
	if s.Security == "" {
		s.Security = "none"
	}
	switch t := strings.ToLower(r.get(seen, "type")); t {
	case "", "tcp", "raw":
		s.Transport = "tcp"
	case "h2":
		s.Transport = "http"
	case "splithttp":
		s.Transport = "xhttp"
	default:
		s.Transport = t
	}
	s.HeaderType = strings.ToLower(r.get(seen, "headertype"))
	s.Path = r.get(seen, "path")
	s.Host = r.get(seen, "host")
	s.ServiceName = r.get(seen, "servicename")
	if s.Transport == "ws" || s.Transport == "httpupgrade" {
		s.Path, s.EarlyData = splitEarlyData(s.Path)
	}

	s.SNI = r.get(seen, "sni")
	s.ALPN = SplitList(r.get(seen, "alpn"))
	s.Fingerprint = strings.ToLower(r.get(seen, "fp"))
	s.Insecure = isTrue(r.get(seen, "allowinsecure", "insecure"))
	s.PublicKey = r.get(seen, "pbk")
	s.ShortID = strings.ToLower(r.get(seen, "sid"))
	s.PQV = r.get(seen, "pqv")
	s.SpiderX = r.get(seen, "spx")
	s.PinnedCert = r.get(seen, "pcs")
	s.VerifyName = r.get(seen, "vcn")
	if s.Transport == "xhttp" {
		s.Mode = strings.ToLower(r.get(seen, "mode"))
		s.Extra = strings.TrimSpace(r.get(seen, "extra"))
		if s.Extra != "" && !isJSONObject(s.Extra) {
			return nil, errors.New("xhttp: параметр extra — не JSON-объект")
		}
	}
	r.get(seen, "mode", "authority", "packetencoding") // знаем, но не используем
	s.Ignored = r.unknown(seen)

	switch s.Security {
	case "none":
		s.Warnings = append(s.Warnings, "Без TLS: трафик до сервера не зашифрован (security=none)")
	case "tls":
		if s.Insecure {
			s.Warnings = append(s.Warnings, "Проверка сертификата сервера отключена (allowInsecure=1): соединение можно подменить")
		}
	case "reality":
		if s.PublicKey == "" {
			return nil, errors.New("Reality: в ссылке нет ключа pbk")
		}
		pbk, ok := normalizePBK(s.PublicKey)
		if !ok {
			return nil, errors.New("Reality: неверный ключ pbk")
		}
		s.PublicKey = pbk
		if !validShortID(s.ShortID) {
			return nil, errors.New("Reality: неверный sid (нужно до 16 символов 0–9, a–f, чётное количество)")
		}
		if s.SNI == "" {
			if !IsDomain(s.Address) {
				return nil, errors.New("Reality: в ссылке нет sni")
			}
			s.SNI = s.Address
			s.Warnings = append(s.Warnings, "Reality: в ссылке нет sni, взят адрес сервера")
		}
	}
	if s.Name == "" {
		s.Name = defaultName("VLESS", s)
	}
	return s, nil
}

// isJSONObject — строка целиком корректный JSON-объект ({…}).
func isJSONObject(s string) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal([]byte(s), &m) == nil && m != nil
}

// splitEarlyData вынимает ?ed=2048 из path веб-сокета: "/ws?ed=2048" → "/ws", 2048.
func splitEarlyData(path string) (string, int) {
	base, q, ok := strings.Cut(path, "?")
	if !ok {
		return path, 0
	}
	ed := 0
	var keep []string
	for _, part := range strings.Split(q, "&") {
		k, v, _ := strings.Cut(part, "=")
		if strings.EqualFold(k, "ed") {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				ed = n
			}
			continue
		}
		if part != "" {
			keep = append(keep, part)
		}
	}
	if len(keep) > 0 {
		base += "?" + strings.Join(keep, "&")
	}
	return base, ed
}

// normalizePBK приводит ключ Reality к виду, который ждёт sing-box (base64url без «=»),
// и проверяет, что это 32 байта.
func normalizePBK(s string) (string, bool) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	b, err := base64.RawURLEncoding.DecodeString(s)
	return s, err == nil && len(b) == 32
}

// validShortID: пусто или до 16 hex-символов, чётное количество. Иначе sing-box
// не примет конфиг (проверено: на 18 символах sing-box 1.14.4 падает целиком).
func validShortID(s string) bool {
	if len(s) > 16 || len(s)%2 != 0 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
