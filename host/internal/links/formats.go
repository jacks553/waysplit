package links

// Подписки не списком ссылок (SPEC-SUBS.md, шаг 2, п. 1): панели дают отдельные адреса под
// приложения (у Remnawave — …/json, /singbox, /mihomo, /clash), и такой формат приходит при любом
// User-Agent. Серверы из Xray JSON, sing-box JSON и Clash / Mihomo YAML переводятся в обычные
// ссылки vless:// и hysteria2:// (ShareLink): расширение хранит у сервера ссылку, а компаньон
// собирает из неё конфиг — дальше всё как со ссылками (проверка, выбор ядра, обновление подписки).
// Берутся VLESS и Hysteria2; остальное — в «пропущено» с причиной. Один и тот же сервер из
// нескольких конфигов (группы автовыбора Xray) — один раз.

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Форматы подписки (Subscription.Format; "" — обычный список ссылок).
const (
	FormatXray    = "xray-json"
	FormatSingbox = "singbox-json"
	FormatClash   = "clash-yaml"
)

// FormatName — формат по-русски.
func FormatName(f string) string {
	switch f {
	case FormatXray:
		return "Xray JSON"
	case FormatSingbox:
		return "sing-box JSON"
	case FormatClash:
		return "Clash / Mihomo YAML"
	}
	return "список ссылок"
}

var clashRe = regexp.MustCompile(`(?m)^(proxies|proxy-providers)\s*:`)

// ConvertBody — тело подписки (уже раскодированное из base64, если было) → ссылки по одной на
// строку. format "" — это и так ссылки, text возвращается как есть. skipped — записи, которые
// не стали ссылками (протокол не поддерживается и т. п.). Ошибка — веб-страница или
// непонятный JSON / YAML.
func ConvertBody(text, contentType string) (out string, format string, skipped []LineError, err error) {
	t := strings.TrimSpace(text)
	switch {
	case strings.HasPrefix(t, "<") || strings.Contains(strings.ToLower(contentType), "text/html") && !strings.Contains(t, "://"):
		return "", "", nil, errors.New("вместо списка серверов пришла веб-страница: проверьте адрес подписки или User-Agent в настройках")
	case strings.HasPrefix(t, "{") || strings.HasPrefix(t, "["):
		var v any
		if err := json.Unmarshal([]byte(t), &v); err != nil {
			return "", "", nil, errors.New("подписка пришла в виде JSON, но он испорчен: " + err.Error())
		}
		c := &collector{}
		switch {
		case isXray(v):
			format = FormatXray
			c.xray(v)
		case isSingbox(v):
			format = FormatSingbox
			c.singbox(v.(map[string]any))
		default:
			return "", "", nil, errors.New("подписка пришла в формате JSON, который Waysplit не знает (нужны настройки Xray или sing-box с outbounds)")
		}
		return c.text(), format, c.skipped, nil
	case clashRe.MatchString(t):
		var doc struct {
			Proxies   []map[string]any `yaml:"proxies"`
			Providers map[string]any   `yaml:"proxy-providers"`
		}
		if err := yaml.Unmarshal([]byte(t), &doc); err != nil {
			return "", "", nil, errors.New("подписка пришла в формате Clash / Mihomo, но YAML испорчен: " + err.Error())
		}
		if len(doc.Proxies) == 0 && len(doc.Providers) > 0 {
			return "", "", nil, errors.New("в подписке Clash / Mihomo нет списка серверов (proxies), только ссылки на другие списки (proxy-providers) — попросите у провайдера обычную ссылку на подписку")
		}
		c := &collector{}
		for _, p := range doc.Proxies {
			c.clash(p)
		}
		return c.text(), FormatClash, c.skipped, nil
	}
	return text, "", nil, nil
}

// collector собирает серверы без повторов (по Key) и пропущенные записи.
type collector struct {
	servers []*Server
	single  []bool // имя взято из отдельного конфига (не из группы)
	byKey   map[string]int
	skipped []LineError
}

func (c *collector) add(s *Server, single bool) {
	if c.byKey == nil {
		c.byKey = map[string]int{}
	}
	if i, ok := c.byKey[s.Key()]; ok {
		if single && !c.single[i] { // у сервера есть свой конфиг — его имя лучше имени группы
			c.servers[i].Name, c.single[i] = s.Name, true
		}
		return
	}
	c.byKey[s.Key()] = len(c.servers)
	c.servers = append(c.servers, s)
	c.single = append(c.single, single)
}

func (c *collector) skip(name, reason string) {
	c.skipped = append(c.skipped, LineError{Text: clip(name), Reason: reason})
}

func (c *collector) text() string {
	var lines []string
	for _, s := range c.servers {
		lines = append(lines, s.ShareLink())
	}
	return strings.Join(lines, "\n")
}

func clip(s string) string {
	if r := []rune(s); len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return s
}

// --- Xray JSON: один конфиг или массив конфигов ---

func isXray(v any) bool {
	switch x := v.(type) {
	case map[string]any:
		return outboundsHave(x, "protocol")
	case []any:
		for _, el := range x {
			if m, ok := el.(map[string]any); ok && outboundsHave(m, "protocol") {
				return true
			}
		}
	}
	return false
}

func isSingbox(v any) bool {
	m, ok := v.(map[string]any)
	return ok && outboundsHave(m, "type")
}

func outboundsHave(cfg map[string]any, key string) bool {
	for _, o := range list(cfg["outbounds"]) {
		if _, ok := obj(o)[key]; ok {
			return true
		}
	}
	return false
}

// Служебные outbound — не серверы.
var serviceOutbounds = map[string]bool{
	"freedom": true, "blackhole": true, "dns": true, "loopback": true, // Xray
	"direct": true, "block": true, "selector": true, "urltest": true, // sing-box
}

func (c *collector) xray(v any) {
	cfgs := list(v)
	if m, ok := v.(map[string]any); ok {
		cfgs = []any{m}
	}
	for _, cfg := range cfgs {
		m := obj(cfg)
		remarks := str(m["remarks"])
		var proxies []map[string]any
		for _, o := range list(m["outbounds"]) {
			if p := str(obj(o)["protocol"]); p != "" && !serviceOutbounds[p] {
				proxies = append(proxies, obj(o))
			}
		}
		single := len(proxies) == 1
		for _, o := range proxies {
			name := remarks
			if !single || name == "" {
				name = strings.TrimSpace(strings.Join(nonEmptyList(remarks, str(o["tag"])), " · "))
			}
			s, err := xrayOutbound(o)
			if err != nil {
				c.skip(name, err.Error())
				continue
			}
			s.Name = name
			c.add(s, single)
		}
	}
}

func xrayOutbound(o map[string]any) (*Server, error) {
	proto := strings.ToLower(str(o["protocol"]))
	st := obj(o["settings"])
	ss := obj(o["streamSettings"])
	switch proto {
	case "vless":
		s := &Server{Protocol: "vless"}
		if vn := list(st["vnext"]); len(vn) > 0 {
			v := obj(vn[0])
			s.Address, s.Port = str(v["address"]), num(v["port"])
			if us := list(v["users"]); len(us) > 0 {
				u := obj(us[0])
				s.UUID, s.Flow, s.Encryption = str(u["id"]), str(u["flow"]), str(u["encryption"])
			}
		} else {
			s.Address, s.Port = str(st["address"]), num(st["port"])
			s.UUID, s.Flow, s.Encryption = str(st["id"]), str(st["flow"]), str(st["encryption"])
		}
		xrayStream(s, ss)
		return s, nil
	case "hysteria":
		if v := num(st["version"]); v != 0 && v != 2 {
			return nil, fmt.Errorf("Hysteria версии %d не поддерживается (нужна 2)", v)
		}
		s := &Server{Protocol: "hysteria2", Address: str(st["address"]), Port: num(st["port"]), Transport: "udp", Security: "tls"}
		s.Password = str(obj(ss["hysteriaSettings"])["auth"])
		t := obj(ss["tlsSettings"])
		s.SNI, s.Insecure, s.PinSHA256 = str(t["serverName"]), truthy(t["allowInsecure"]), str(t["pinnedPeerCertSha256"])
		for _, mk := range list(obj(ss["finalmask"])["udp"]) {
			if str(obj(mk)["type"]) == "salamander" {
				s.Obfs, s.ObfsPassword = "salamander", str(obj(obj(mk)["settings"])["password"])
			}
		}
		return s, nil
	}
	return nil, fmt.Errorf("протокол %s пока не поддерживается", proto)
}

// xrayStream — streamSettings Xray → транспорт и защита сервера.
func xrayStream(s *Server, ss map[string]any) {
	s.Transport = strings.ToLower(nonEmpty(str(ss["network"]), "tcp"))
	switch s.Transport {
	case "raw":
		s.Transport = "tcp"
	case "splithttp":
		s.Transport = "xhttp"
	case "websocket":
		s.Transport = "ws"
	case "h2", "h3":
		s.Transport = "http"
	}
	switch s.Transport {
	case "tcp":
		raw := obj(ss["rawSettings"])
		if len(raw) == 0 {
			raw = obj(ss["tcpSettings"])
		}
		s.HeaderType = str(obj(raw["header"])["type"])
	case "ws", "httpupgrade":
		w := obj(ss[s.Transport+"Settings"])
		if s.Transport == "ws" {
			w = obj(ss["wsSettings"])
		}
		s.Path = str(w["path"])
		s.Host = nonEmpty(str(w["host"]), str(obj(w["headers"])["Host"]))
	case "grpc":
		s.ServiceName = str(obj(ss["grpcSettings"])["serviceName"])
	case "http":
		h := obj(ss["httpSettings"])
		s.Path = str(h["path"])
		s.Host = strings.Join(strList(h["host"]), ",")
	case "xhttp":
		x := obj(ss["xhttpSettings"])
		if len(x) == 0 {
			x = obj(ss["splithttpSettings"])
		}
		s.Path, s.Host, s.Mode = str(x["path"]), str(x["host"]), strings.ToLower(str(x["mode"]))
		// Остальные настройки XHTTP (xPaddingBytes, xmux…) — в extra, как их и понимает Xray.
		extra := map[string]any{}
		for k, v := range obj(x["extra"]) {
			extra[k] = v
		}
		for k, v := range x {
			if k != "path" && k != "host" && k != "mode" && k != "extra" {
				extra[k] = v
			}
		}
		if len(extra) > 0 {
			if b, err := json.Marshal(extra); err == nil {
				s.Extra = string(b)
			}
		}
	}
	s.Security = strings.ToLower(nonEmpty(str(ss["security"]), "none"))
	switch s.Security {
	case "tls":
		t := obj(ss["tlsSettings"])
		s.SNI, s.ALPN, s.Fingerprint = str(t["serverName"]), strList(t["alpn"]), str(t["fingerprint"])
		s.Insecure = truthy(t["allowInsecure"])
		s.PinnedCert, s.VerifyName = str(t["pinnedPeerCertSha256"]), str(t["verifyPeerCertByName"])
	case "reality":
		r := obj(ss["realitySettings"])
		s.SNI, s.Fingerprint = str(r["serverName"]), str(r["fingerprint"])
		s.PublicKey = nonEmpty(str(r["password"]), str(r["publicKey"]))
		s.ShortID, s.SpiderX, s.PQV = str(r["shortId"]), str(r["spiderX"]), str(r["mldsa65Verify"])
	}
}

// --- sing-box JSON ---

func (c *collector) singbox(cfg map[string]any) {
	for _, raw := range list(cfg["outbounds"]) {
		o := obj(raw)
		typ := strings.ToLower(str(o["type"]))
		if typ == "" || serviceOutbounds[typ] {
			continue
		}
		name := str(o["tag"])
		s := &Server{Name: name, Address: str(o["server"]), Port: num(o["server_port"])}
		tls := obj(o["tls"])
		switch typ {
		case "vless":
			s.Protocol, s.UUID, s.Flow, s.Security = "vless", str(o["uuid"]), str(o["flow"]), "none"
			if truthy(tls["enabled"]) {
				s.Security = "tls"
				s.SNI, s.Insecure, s.ALPN = str(tls["server_name"]), truthy(tls["insecure"]), strList(tls["alpn"])
				s.Fingerprint = str(obj(tls["utls"])["fingerprint"])
				if r := obj(tls["reality"]); truthy(r["enabled"]) {
					s.Security, s.PublicKey, s.ShortID = "reality", str(r["public_key"]), str(r["short_id"])
				}
			}
			tr := obj(o["transport"])
			s.Transport = strings.ToLower(nonEmpty(str(tr["type"]), "tcp"))
			switch s.Transport {
			case "ws":
				s.Path, s.Host = str(tr["path"]), str(obj(tr["headers"])["Host"])
				if strings.EqualFold(str(tr["early_data_header_name"]), "Sec-WebSocket-Protocol") {
					s.EarlyData = num(tr["max_early_data"])
				}
			case "httpupgrade":
				s.Path, s.Host = str(tr["path"]), str(tr["host"])
			case "grpc":
				s.ServiceName = str(tr["service_name"])
			case "http":
				s.Path, s.Host = str(tr["path"]), strings.Join(strList(tr["host"]), ",")
			}
		case "hysteria2":
			s.Protocol, s.Transport, s.Security = "hysteria2", "udp", "tls"
			s.Password = str(o["password"])
			s.SNI, s.Insecure = str(tls["server_name"]), truthy(tls["insecure"])
			if ob := obj(o["obfs"]); str(ob["type"]) != "" {
				s.Obfs, s.ObfsPassword = strings.ToLower(str(ob["type"])), str(ob["password"])
			}
			s.Ports = portRanges(strList(o["server_ports"]))
			if s.Port == 0 && len(s.Ports) > 0 {
				s.Port = s.Ports[0].From
			}
			if s.Port != 0 && len(s.Ports) > 0 && !inRanges(s.Port, s.Ports) {
				s.Ports = append([]PortRange{{s.Port, s.Port}}, s.Ports...)
			}
		default:
			c.skip(name, fmt.Sprintf("протокол %s пока не поддерживается", typ))
			continue
		}
		c.add(s, true)
	}
}

// --- Clash / Mihomo YAML ---

func (c *collector) clash(p map[string]any) {
	typ := strings.ToLower(str(p["type"]))
	name := str(p["name"])
	s := &Server{Name: name, Address: str(p["server"]), Port: num(p["port"])}
	switch typ {
	case "vless":
		s.Protocol, s.UUID, s.Flow, s.Encryption = "vless", str(p["uuid"]), str(p["flow"]), str(p["encryption"])
		s.Security = "none"
		if truthy(p["tls"]) {
			s.Security = "tls"
		}
		s.SNI = nonEmpty(str(p["servername"]), str(p["sni"]))
		s.Insecure, s.ALPN = truthy(p["skip-cert-verify"]), strList(p["alpn"])
		s.Fingerprint = str(p["client-fingerprint"])
		s.PinnedCert = str(p["fingerprint"]) // в Mihomo fingerprint — отпечаток сертификата, uTLS — client-fingerprint
		if r := obj(p["reality-opts"]); len(r) > 0 {
			s.Security, s.PublicKey, s.ShortID = "reality", str(r["public-key"]), str(r["short-id"])
		}
		s.Transport = strings.ToLower(nonEmpty(str(p["network"]), "tcp"))
		switch s.Transport {
		case "ws":
			w := obj(p["ws-opts"])
			s.Path, s.Host = str(w["path"]), str(obj(w["headers"])["Host"])
			if strings.EqualFold(str(w["early-data-header-name"]), "Sec-WebSocket-Protocol") {
				s.EarlyData = num(w["max-early-data"])
			}
		case "grpc":
			s.ServiceName = str(obj(p["grpc-opts"])["grpc-service-name"])
		case "h2":
			h := obj(p["h2-opts"])
			s.Transport, s.Path, s.Host = "http", str(h["path"]), strings.Join(strList(h["host"]), ",")
		case "http":
			h := obj(p["http-opts"])
			s.Path = strings.Join(strList(h["path"]), ",")
			s.Host = strings.Join(strList(obj(h["headers"])["Host"]), ",")
		case "xhttp":
			x := obj(p["xhttp-opts"])
			s.Path, s.Host, s.Mode = str(x["path"]), str(x["host"]), strings.ToLower(str(x["mode"]))
		}
	case "hysteria2":
		s.Protocol, s.Transport, s.Security = "hysteria2", "udp", "tls"
		s.Password = nonEmpty(str(p["password"]), str(p["auth"]))
		s.SNI, s.Insecure = str(p["sni"]), truthy(p["skip-cert-verify"])
		s.Obfs, s.ObfsPassword = strings.ToLower(str(p["obfs"])), str(p["obfs-password"])
		s.PinSHA256 = str(p["fingerprint"])
		if ports := str(p["ports"]); ports != "" {
			if pr, err := parsePortList(strings.ReplaceAll(ports, "/", ",")); err == nil {
				s.Ports = pr
				if s.Port == 0 {
					s.Port = pr[0].From
				} else if !inRanges(s.Port, pr) {
					s.Ports = append([]PortRange{{s.Port, s.Port}}, pr...)
				}
			}
		}
	default:
		c.skip(name, fmt.Sprintf("протокол %s пока не поддерживается", typ))
		return
	}
	c.add(s, true)
}

// --- ссылка из сервера ---

// ShareLink — ссылка vless:// или hysteria2:// со всеми параметрами сервера (обратное к Parse).
func (s *Server) ShareLink() string {
	var q []string
	add := func(k, v string) {
		if v != "" {
			q = append(q, k+"="+escapeValue(v))
		}
	}
	host := s.Address
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	name := ""
	if s.Name != "" {
		name = "#" + escapeValue(s.Name)
	}
	switch s.Protocol {
	case "vless":
		add("encryption", s.Encryption) // пусто и «none» — одно и то же
		add("flow", s.Flow)
		add("security", nonEmpty(s.Security, "none"))
		add("sni", s.SNI)
		add("alpn", strings.Join(s.ALPN, ","))
		add("fp", s.Fingerprint)
		if s.Insecure {
			add("allowInsecure", "1")
		}
		add("pbk", s.PublicKey)
		add("sid", s.ShortID)
		add("spx", s.SpiderX)
		add("pqv", s.PQV)
		add("pcs", s.PinnedCert)
		add("vcn", s.VerifyName)
		add("type", nonEmpty(s.Transport, "tcp"))
		add("headerType", s.HeaderType)
		path := s.Path
		if s.EarlyData > 0 {
			sep := "?"
			if strings.Contains(path, "?") {
				sep = "&"
			}
			path += sep + "ed=" + strconv.Itoa(s.EarlyData)
		}
		add("path", path)
		add("host", s.Host)
		add("serviceName", s.ServiceName)
		add("mode", s.Mode)
		add("extra", s.Extra)
		return "vless://" + escapeValue(s.UUID) + "@" + host + ":" + strconv.Itoa(s.Port) + "?" + strings.Join(q, "&") + name
	case "hysteria2":
		ports := strconv.Itoa(s.Port)
		if len(s.Ports) > 0 {
			var parts []string
			for _, p := range s.Ports {
				if p.From == p.To {
					parts = append(parts, strconv.Itoa(p.From))
				} else {
					parts = append(parts, strconv.Itoa(p.From)+"-"+strconv.Itoa(p.To))
				}
			}
			ports = strings.Join(parts, ",")
		}
		add("sni", s.SNI)
		if s.Insecure {
			add("insecure", "1")
		}
		add("obfs", s.Obfs)
		add("obfs-password", s.ObfsPassword)
		add("pinSHA256", s.PinSHA256)
		return "hysteria2://" + escapeValue(s.Password) + "@" + host + ":" + ports + "/?" + strings.Join(q, "&") + name
	}
	return ""
}

// escapeValue — %XX для всего, кроме букв, цифр и «-._~»: разбор ссылок раскодирует обратно
// («+» в ссылках остаётся плюсом, поэтому пробел — %20).
func escapeValue(v string) string {
	var b strings.Builder
	for _, c := range []byte(v) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// --- мелочи для разбора JSON / YAML ---

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}

func num(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(x))
		return n
	}
	return 0
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return isTrue(x)
	case float64:
		return x != 0
	case int:
		return x != 0
	}
	return false
}

// strList — список строк: ["h2","http/1.1"] или "h2,http/1.1".
func strList(v any) []string {
	var out []string
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if s := str(e); s != "" {
				out = append(out, s)
			}
		}
	case string:
		out = SplitList(x)
	}
	return out
}

func nonEmpty(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func nonEmptyList(items ...string) []string {
	var out []string
	for _, s := range items {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// portRanges — порты sing-box «20000:50000» (и «20000-50000») → диапазоны.
func portRanges(items []string) []PortRange {
	var out []PortRange
	for _, it := range items {
		if pr, err := parsePortList(strings.ReplaceAll(it, ":", "-")); err == nil {
			out = append(out, pr...)
		}
	}
	return out
}

func inRanges(port int, ranges []PortRange) bool {
	for _, r := range ranges {
		if port >= r.From && port <= r.To {
			return true
		}
	}
	return false
}
