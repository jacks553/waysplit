package links

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// rawLink — ссылка, разрезанная на части. Части уже раскодированы из %XX.
//
// Ссылки режем вручную, а не через net/url: в настоящих ссылках встречаются пароли
// с «/» и «@», имена с пробелами и «%», параметры с «+» (url.ParseQuery превратил бы его в пробел).
type rawLink struct {
	scheme   string // в нижнем регистре
	userinfo string // uuid или пароль
	host     string // без квадратных скобок у IPv6, в нижнем регистре
	ports    string // как в ссылке: "443", "443,20000-50000"; пусто, если порта нет
	path     string
	query    []param // параметры по порядку
	name     string  // #фрагмент
}

type param struct{ key, value string }

func splitLink(s string) (*rawLink, error) {
	i := strings.Index(s, "://")
	if i <= 0 {
		return nil, errors.New("не похоже на ссылку сервера")
	}
	r := &rawLink{scheme: strings.ToLower(s[:i])}
	rest := s[i+3:]
	if j := strings.IndexByte(rest, '#'); j >= 0 {
		r.name = strings.TrimSpace(unescape(rest[j+1:]))
		rest = rest[:j]
	}
	if j := strings.IndexByte(rest, '?'); j >= 0 {
		r.query = parseQuery(rest[j+1:])
		rest = rest[:j]
	}
	// Пароль может содержать «@», поэтому берём последний «@».
	if at := strings.LastIndexByte(rest, '@'); at >= 0 {
		r.userinfo = unescape(rest[:at])
		rest = rest[at+1:]
	}
	if j := strings.IndexByte(rest, '/'); j >= 0 {
		r.path = unescape(rest[j:])
		rest = rest[:j]
	}
	if strings.HasPrefix(rest, "[") {
		end := strings.IndexByte(rest, ']')
		if end < 0 {
			return nil, errors.New("IPv6-адрес без закрывающей скобки «]»")
		}
		r.host, rest = rest[1:end], rest[end+1:]
		if rest != "" {
			if rest[0] != ':' {
				return nil, fmt.Errorf("после адреса [%s] ожидается «:порт»", r.host)
			}
			r.ports = rest[1:]
		}
	} else {
		if strings.Count(rest, ":") > 1 && !strings.Contains(rest, ",") {
			return nil, errors.New("IPv6-адрес нужно писать в квадратных скобках: [2001:db8::1]:443")
		}
		if c := strings.IndexByte(rest, ':'); c >= 0 {
			r.host, r.ports = rest[:c], rest[c+1:]
		} else {
			r.host = rest
		}
	}
	r.host = strings.ToLower(strings.TrimSpace(r.host))
	if r.host == "" {
		return nil, errors.New("нет адреса сервера")
	}
	if strings.ContainsAny(r.host, " \t/\\?#@%") {
		return nil, fmt.Errorf("неверный адрес сервера «%s»", r.host)
	}
	return r, nil
}

// get возвращает первое непустое значение параметра (имена без учёта регистра)
// и отмечает параметр как прочитанный.
func (r *rawLink) get(seen map[string]bool, keys ...string) string {
	for _, k := range keys {
		seen[k] = true
		for _, p := range r.query {
			if p.key == k && p.value != "" {
				return p.value
			}
		}
	}
	return ""
}

// unknown — параметры, которые разбор не прочитал (их пишем в журнал).
func (r *rawLink) unknown(seen map[string]bool) []string {
	var out []string
	for _, p := range r.query {
		if !seen[p.key] {
			out = append(out, p.key)
			seen[p.key] = true
		}
	}
	return out
}

func parseQuery(q string) []param {
	var out []param
	for _, part := range strings.Split(q, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		out = append(out, param{key: strings.ToLower(strings.TrimSpace(unescape(k))), value: strings.TrimSpace(unescape(v))})
	}
	return out
}

// unescape раскодирует %XX; «+» остаётся плюсом. Битую последовательность оставляет как есть.
func unescape(s string) string {
	if d, err := url.PathUnescape(s); err == nil {
		return d
	}
	return s
}

func parsePort(s string) (int, error) {
	s = strings.TrimSpace(s)
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > 65535 || strings.HasPrefix(s, "+") {
		return 0, fmt.Errorf("неверный порт «%s»", s)
	}
	return n, nil
}

// parsePortList разбирает «443,20000-50000» (диапазон можно писать и через «:»).
func parsePortList(s string) ([]PortRange, error) {
	var out []PortRange
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		from, to, isRange := strings.Cut(part, "-")
		if !isRange {
			from, to, isRange = strings.Cut(part, ":")
		}
		a, err := parsePort(from)
		if err != nil {
			return nil, err
		}
		b := a
		if isRange {
			if b, err = parsePort(to); err != nil {
				return nil, err
			}
			if b < a {
				return nil, fmt.Errorf("неверный диапазон портов «%s»", part)
			}
		}
		out = append(out, PortRange{From: a, To: b})
	}
	if len(out) == 0 {
		return nil, errors.New("не указан порт")
	}
	return out, nil
}

func isTrue(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// IsDomain — адрес не IP (для IP имя сервера в TLS не подставляем).
func IsDomain(host string) bool {
	if strings.Contains(host, ":") {
		return false
	}
	for _, c := range host {
		if (c < '0' || c > '9') && c != '.' {
			return true
		}
	}
	return false
}

func SplitList(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}
