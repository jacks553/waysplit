// Package subinfo — диагностика подписок (SPEC-SUBS.md, шаг 1): скачать подписку разными
// способами (User-Agent разных клиентов, с заголовками устройства и без) и рассказать, что
// пришло, — без секретов: формат, счётчики серверов, ключи JSON/YAML без значений, заголовки
// ответа с маскировкой.
package subinfo

import (
	"encoding/json"
	"fmt"
	"html"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/xray"
)

// Body — что лежит в ответе сервера подписки.
type Body struct {
	Format     string   `json:"format"`     // empty | html | base64 | links | happ-crypt | xray-json | singbox-json | clash-yaml | json | yaml | text
	FormatText string   `json:"formatText"` // то же по-русски
	HTMLTitle  string   `json:"htmlTitle,omitempty"`
	Keys       []string `json:"keys,omitempty"` // структура JSON / YAML: только ключи
	Servers    int      `json:"servers"`        // серверов (прокси) любого протокола
	Usable     int      `json:"usable"`         // из них Waysplit может запустить (VLESS и Hysteria2, транспорт есть в sing-box)
	Kinds      []Kind   `json:"kinds,omitempty"`
	Skipped    []Kind   `json:"skipped,omitempty"` // строки, которые не стали серверами, — по причинам
	Stubs      []string `json:"stubs,omitempty"`   // «серверы»-заглушки (0.0.0.0, порт 1…): их имена — сообщение панели
	Happ       int      `json:"happ"`              // ссылок happ://
	HappCrypt  int      `json:"happCrypt"`         // из них зашифрованных happ://crypt…
	Lines      int      `json:"lines"`             // непустых строк (для текста и ссылок)

	kinds   map[string]*Kind
	skipped map[string]*Kind
}

// Kind — сколько серверов одного вида («VLESS · tcp · reality») или строк с одной причиной пропуска.
type Kind struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
	Core  string `json:"core,omitempty"` // каким ядром Waysplit его запустит: sing-box | xray
	Note  string `json:"note,omitempty"` // почему Waysplit этот вид не запустит
}

var formatTexts = map[string]string{
	"empty":        "пусто",
	"html":         "веб-страница (HTML)",
	"base64":       "base64 со ссылками",
	"links":        "строки ссылок",
	"happ-crypt":   "ссылки, зашифрованные для Happ (happ://crypt…)",
	"xray-json":    "Xray JSON",
	"singbox-json": "sing-box JSON",
	"clash-yaml":   "Clash / Mihomo YAML",
	"json":         "JSON неизвестного вида",
	"yaml":         "YAML неизвестного вида",
	"text":         "непонятный текст",
}

func (b *Body) set(format string) {
	b.Format = format
	b.FormatText = formatTexts[format]
}

// Транспорты, которых нет в sing-box: XHTTP запускает Xray (SPEC-XRAY.md), mKCP — никто.
var xrayNet = map[string]bool{"xhttp": true, "splithttp": true}
var noNet = map[string]bool{"kcp": true, "mkcp": true}

func (b *Body) addKind(proto, network, security, core, note string) {
	if b.kinds == nil {
		b.kinds = map[string]*Kind{}
	}
	name := protoTitle(proto) + " · " + nonEmpty(network, "tcp") + " · " + nonEmpty(security, "none")
	k := b.kinds[name]
	if k == nil {
		k = &Kind{Name: name, Core: core, Note: note}
		if note != "" {
			k.Core = ""
		}
		b.kinds[name] = k
	}
	k.Count++
	b.Servers++
	if note == "" {
		b.Usable++
	}
}

// isStub — «сервер»-заглушка (links.IsStubAddr).
func isStub(addr string, port int) bool { return links.IsStubAddr(addr, port) }

func (b *Body) addStub(name string) {
	name = strings.Join(strings.Fields(hostlog.Mask(name)), " ")
	if r := []rune(name); len(r) > 100 {
		name = string(r[:100]) + "…"
	}
	b.Stubs = append(b.Stubs, name)
}

var lineNoRe = regexp.MustCompile(`\s*\(строка \d+\)`)

func (b *Body) addSkipped(reason string) {
	if b.skipped == nil {
		b.skipped = map[string]*Kind{}
	}
	reason = lineNoRe.ReplaceAllString(hostlog.Mask(reason), "")
	k := b.skipped[reason]
	if k == nil {
		k = &Kind{Name: reason}
		b.skipped[reason] = k
	}
	k.Count++
}

func (b *Body) finish() {
	b.Kinds = sortedKinds(b.kinds)
	b.Skipped = sortedKinds(b.skipped)
}

func sortedKinds(m map[string]*Kind) []Kind {
	var out []Kind
	for _, k := range m {
		out = append(out, *k)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func protoTitle(p string) string {
	switch strings.ToLower(p) {
	case "vless":
		return "VLESS"
	case "hysteria2", "hy2":
		return "Hysteria2"
	}
	return p
}

func nonEmpty(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// Analyze определяет формат ответа и считает серверы. Значения (адреса, ключи, имена) в
// результат не попадают — только формат, счётчики и названия ключей.
func Analyze(body []byte, contentType string) *Body {
	b := &Body{}
	defer b.finish()
	raw := strings.TrimPrefix(string(body), string(rune(0xFEFF)))
	t := strings.TrimSpace(raw)
	ct := strings.ToLower(contentType)
	switch {
	case t == "":
		b.set("empty")
	case strings.HasPrefix(t, "<") || strings.Contains(ct, "text/html") && !strings.Contains(t, "://"):
		b.set("html")
		b.HTMLTitle = htmlTitle(t)
	case strings.HasPrefix(t, "{") || strings.HasPrefix(t, "["):
		var v any
		if err := json.Unmarshal([]byte(t), &v); err != nil {
			b.set("text")
			b.Lines = countLines(t)
			return b
		}
		analyzeJSON(b, v)
	default:
		text := links.DecodeBody([]byte(raw))
		switch {
		case isClash(t): // раньше ссылок: в YAML бывают адреса с «://» (проверка пинга, наборы правил)
			b.set("clash-yaml")
			analyzeClash(b, t)
		case strings.Contains(text, "://"):
			b.set("links")
			if !strings.Contains(raw, "://") {
				b.set("base64")
			}
			analyzeLinks(b, text)
			if b.Servers == 0 && b.HappCrypt > 0 {
				b.set("happ-crypt")
			}
		case len(yamlTopKeys(t)) >= 2:
			b.set("yaml")
			b.Keys = yamlTopKeys(t)
		default:
			b.set("text")
			b.Lines = countLines(t)
		}
	}
	return b
}

func countLines(t string) int {
	n := 0
	for _, l := range strings.Split(t, "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// htmlTitle — заголовок страницы (только он: остальное может содержать личные данные).
func htmlTitle(t string) string {
	m := titleRe.FindStringSubmatch(t)
	if m == nil {
		return ""
	}
	s := strings.Join(strings.Fields(html.UnescapeString(m[1])), " ")
	if r := []rune(s); len(r) > 120 {
		s = string(r[:120]) + "…"
	}
	return hostlog.Mask(s)
}

// --- ссылки ---

func analyzeLinks(b *Body, text string) {
	for _, line := range strings.Split(text, "\n") {
		l := strings.ToLower(strings.TrimSpace(line))
		if l == "" {
			continue
		}
		b.Lines++
		if strings.HasPrefix(l, "happ://") {
			b.Happ++
			if strings.HasPrefix(l, "happ://crypt") {
				b.HappCrypt++
			}
		}
	}
	res := links.ParseText(text)
	for _, s := range res.Servers {
		if isStub(s.Address, s.Port) {
			b.addStub(s.Name)
			continue
		}
		note := ""
		core, _, err := xray.Pick(s)
		if err != nil {
			note = hostlog.Mask(err.Error())
		}
		b.addKind(s.Protocol, s.Transport, s.Security, core, note)
	}
	for _, e := range res.Errors {
		reason := e.Reason
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(e.Text)), "happ://") {
			reason = "ссылка happ:// — формат приложения Happ"
		}
		b.addSkipped(reason)
	}
	for range res.Subscriptions {
		b.addSkipped("адрес подписки внутри подписки")
	}
}

// --- JSON: Xray и sing-box ---

// Служебные outbound — не серверы.
var serviceOutbounds = map[string]bool{
	"freedom": true, "blackhole": true, "dns": true, "loopback": true, // Xray
	"direct": true, "block": true, "selector": true, "urltest": true, // sing-box
}

func analyzeJSON(b *Body, v any) {
	switch x := v.(type) {
	case map[string]any:
		b.Keys = append(b.Keys, "{"+strings.Join(keysOf(x), ", ")+"}")
		outs, _ := x["outbounds"].([]any)
		switch outboundsKind(outs) {
		case "xray":
			b.set("xray-json")
			b.FormatText += " (один конфиг)"
			countXray(b, outs, str(x["remarks"]))
		case "singbox":
			b.set("singbox-json")
			countSingbox(b, outs)
		default:
			b.set("json")
		}
		if len(outs) > 0 {
			b.Keys = append(b.Keys, "outbounds[]: {"+strings.Join(unionKeys(outs), ", ")+"}")
		}
	case []any:
		b.set("json")
		b.Keys = append(b.Keys, fmt.Sprintf("[массив из %d]", len(x)))
		if len(x) == 0 {
			return
		}
		b.Keys = append(b.Keys, "элементы: {"+strings.Join(unionKeys(x), ", ")+"}")
		var outs []any
		for _, el := range x {
			m, _ := el.(map[string]any)
			o, _ := m["outbounds"].([]any)
			if outboundsKind(o) != "xray" {
				return
			}
			outs = append(outs, o...)
		}
		b.set("xray-json")
		b.FormatText += fmt.Sprintf(" (массив из %d %s)", len(x), plural(len(x), "конфига", "конфигов"))
		for _, el := range x {
			m := el.(map[string]any)
			o, _ := m["outbounds"].([]any)
			countXray(b, o, str(m["remarks"]))
		}
		b.Keys = append(b.Keys, "outbounds[]: {"+strings.Join(unionKeys(outs), ", ")+"}")
	default:
		b.set("json")
	}
}

// outboundsKind: у Xray у outbound есть «protocol», у sing-box — «type».
func outboundsKind(outs []any) string {
	for _, o := range outs {
		m, _ := o.(map[string]any)
		if _, ok := m["protocol"]; ok {
			return "xray"
		}
		if _, ok := m["type"]; ok {
			return "singbox"
		}
	}
	return ""
}

// plural — «из 1 конфига», «из 5 конфигов» (родительный падеж после «из»).
func plural(n int, one, many string) string {
	if n%10 == 1 && n%100 != 11 {
		return one
	}
	return many
}

// countXray — серверы из outbounds одного конфига Xray; remarks — имя конфига (для заглушек).
func countXray(b *Body, outs []any, remarks string) {
	for _, o := range outs {
		m, _ := o.(map[string]any)
		proto := str(m["protocol"])
		if proto == "" || serviceOutbounds[proto] {
			continue
		}
		if addr, port := xrayTarget(m); isStub(addr, port) {
			b.addStub(nonEmpty(remarks, str(m["tag"])))
			continue
		}
		ss, _ := m["streamSettings"].(map[string]any)
		network := strings.ToLower(nonEmpty(str(ss["network"]), "tcp"))
		security := strings.ToLower(nonEmpty(str(ss["security"]), "none"))
		core, note := kindNote(proto, network)
		b.addKind(proto, network, security, core, note)
	}
}

// xrayTarget — адрес и порт сервера в outbound Xray: settings.vnext[0] (VLESS, VMess),
// settings.servers[0] (Trojan, Shadowsocks) или прямо в settings (новый короткий вид).
func xrayTarget(m map[string]any) (string, int) {
	st, _ := m["settings"].(map[string]any)
	for _, key := range []string{"vnext", "servers"} {
		if list, ok := st[key].([]any); ok && len(list) > 0 {
			v, _ := list[0].(map[string]any)
			return str(v["address"]), num(v["port"])
		}
	}
	return str(st["address"]), num(st["port"])
}

func num(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(x))
		return n
	}
	return 0
}

func countSingbox(b *Body, outs []any) {
	for _, o := range outs {
		m, _ := o.(map[string]any)
		typ := str(m["type"])
		if typ == "" || serviceOutbounds[typ] {
			continue
		}
		if isStub(str(m["server"]), num(m["server_port"])) {
			b.addStub(str(m["tag"]))
			continue
		}
		network := "tcp"
		if tr, ok := m["transport"].(map[string]any); ok && str(tr["type"]) != "" {
			network = str(tr["type"])
		}
		if typ == "hysteria2" {
			network = "udp"
		}
		security := "none"
		if tls, ok := m["tls"].(map[string]any); ok && tls["enabled"] == true {
			security = "tls"
			if r, ok := tls["reality"].(map[string]any); ok && r["enabled"] == true {
				security = "reality"
			}
		}
		core, note := kindNote(typ, network)
		b.addKind(typ, network, security, core, note)
	}
}

// kindNote — каким ядром Waysplit запустит такой сервер и почему не запустит (note "" — запустит).
func kindNote(proto, network string) (core, note string) {
	p, n := strings.ToLower(proto), strings.ToLower(network)
	switch {
	case p != "vless" && p != "hysteria2":
		return "", "протокол " + proto + " не поддерживается"
	case noNet[n]:
		return "", "транспорт " + network + " не поддерживается"
	case p == "vless" && xrayNet[n]:
		return "xray", ""
	}
	return "sing-box", ""
}

func str(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// unionKeys — все ключи всех объектов списка (без значений).
func unionKeys(list []any) []string {
	set := map[string]bool{}
	for _, el := range list {
		if m, ok := el.(map[string]any); ok {
			for k := range m {
				set[k] = true
			}
		}
	}
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// --- YAML: Clash / Mihomo ---
// Без библиотеки YAML: для диагностики хватает ключей верхнего уровня и простого разбора
// списка proxies (блочный вид «- name: …» и строчный «- {name: …, type: …}»).

var topKeyRe = regexp.MustCompile(`(?m)^([A-Za-z0-9_.-]+):`)

func yamlTopKeys(t string) []string {
	var keys []string
	seen := map[string]bool{}
	for _, m := range topKeyRe.FindAllStringSubmatch(t, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			keys = append(keys, m[1])
		}
	}
	return keys
}

func isClash(t string) bool {
	for _, k := range yamlTopKeys(t) {
		if k == "proxies" || k == "proxy-providers" {
			return true
		}
	}
	return false
}

func analyzeClash(b *Body, t string) {
	b.Keys = []string{strings.Join(yamlTopKeys(t), ", ")}
	itemKeys := map[string]bool{}
	var cur map[string]string
	flush := func() {
		if cur == nil {
			return
		}
		if isStub(cur["server"], num(cur["port"])) {
			b.addStub(cur["name"])
			cur = nil
			return
		}
		security := "none"
		if _, ok := cur["reality-opts"]; ok {
			security = "reality"
		} else if strings.EqualFold(cur["tls"], "true") {
			security = "tls"
		}
		typ := strings.ToLower(cur["type"])
		network := strings.ToLower(nonEmpty(cur["network"], "tcp"))
		if typ == "hysteria2" {
			network, security = "udp", "tls"
		}
		core, note := kindNote(typ, network)
		b.addKind(typ, network, security, core, note)
		cur = nil
	}
	in := false
	listIndent, keyIndent := -1, -1
	for _, ln := range strings.Split(strings.ReplaceAll(t, "\r", ""), "\n") {
		trimmed := strings.TrimLeft(ln, " ")
		indent := len(ln) - len(trimmed)
		if strings.TrimSpace(ln) == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if indent == 0 && !strings.HasPrefix(trimmed, "- ") {
			flush()
			in = strings.HasPrefix(trimmed, "proxies:")
			continue
		}
		if !in {
			continue
		}
		if strings.HasPrefix(trimmed, "- ") && (listIndent < 0 || indent == listIndent) {
			flush()
			listIndent = indent
			keyIndent = indent + 2
			cur = map[string]string{}
			rest := strings.TrimSpace(trimmed[2:])
			if strings.HasPrefix(rest, "{") {
				for _, pair := range strings.Split(strings.Trim(rest, "{} "), ",") {
					yamlPair(cur, itemKeys, pair)
				}
			} else {
				yamlPair(cur, itemKeys, rest)
			}
			continue
		}
		if cur != nil && indent == keyIndent {
			yamlPair(cur, itemKeys, trimmed)
		}
	}
	flush()
	if len(itemKeys) > 0 {
		keys := make([]string, 0, len(itemKeys))
		for k := range itemKeys {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.Keys = append(b.Keys, "proxies[]: {"+strings.Join(keys, ", ")+"}")
	}
}

func yamlPair(cur map[string]string, keys map[string]bool, s string) {
	k, v, ok := strings.Cut(s, ":")
	if !ok {
		return
	}
	k = strings.TrimSpace(k)
	if k == "" || strings.ContainsAny(k, " {}[]") {
		return
	}
	keys[k] = true
	cur[k] = strings.Trim(strings.TrimSpace(v), `"'`)
}
