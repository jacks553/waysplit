package links

import (
	"errors"
	"strings"
)

// parseHysteria2: hysteria2://пароль@host:port/?параметры#имя (hy2:// — то же самое).
// Порт по умолчанию 443; несколько портов — «host:443,20000-50000» или параметр mport.
func parseHysteria2(r *rawLink, link string) (*Server, error) {
	s := &Server{Protocol: "hysteria2", Link: link, Address: r.host, Name: r.name, Transport: "udp", Security: "tls"}
	s.Password = r.userinfo // при user:pass — вся строка целиком
	if s.Password == "" {
		return nil, errors.New("в ссылке нет пароля")
	}
	ports := []PortRange{{443, 443}}
	if r.ports != "" {
		var err error
		if ports, err = parsePortList(r.ports); err != nil {
			return nil, err
		}
	}
	s.Port = ports[0].From

	seen := map[string]bool{}
	if m := r.get(seen, "mport"); m != "" {
		more, err := parsePortList(m)
		if err != nil {
			return nil, errors.New("mport: " + err.Error())
		}
		for _, p := range more {
			dup := false
			for _, q := range ports {
				dup = dup || p == q
			}
			if !dup {
				ports = append(ports, p)
			}
		}
	}
	if len(ports) > 1 || ports[0].From != ports[0].To {
		s.Ports = ports
	}

	s.SNI = r.get(seen, "sni")
	s.Insecure = isTrue(r.get(seen, "insecure"))
	s.Obfs = strings.ToLower(r.get(seen, "obfs"))
	if s.Obfs == "none" || s.Obfs == "plain" {
		s.Obfs = ""
	}
	s.ObfsPassword = r.get(seen, "obfs-password", "obfs_password")
	s.PinSHA256 = r.get(seen, "pinsha256")
	s.Ignored = r.unknown(seen)

	if s.Obfs == "salamander" && s.ObfsPassword == "" {
		return nil, errors.New("obfs=salamander без obfs-password")
	}
	if s.Insecure {
		s.Warnings = append(s.Warnings, "Проверка сертификата сервера отключена (insecure=1): соединение можно подменить")
	}
	if s.Name == "" {
		s.Name = defaultName("Hysteria2", s)
	}
	return s, nil
}
