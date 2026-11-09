// Package xray — второе ядро, Xray-core (SPEC-XRAY.md): для того, чего нет в sing-box,
// — транспорта XHTTP и шифрования VLESS Encryption. Устройство как у sing-box: у каждого
// сервера свой inbound на 127.0.0.1:<порт> и свой outbound, маршрут жёстко по тегу inbound,
// выхода «напрямую» нет (первый outbound — blackhole: туда уходит всё, что не попало в правила).
//
// Поля конфига сверены с исходниками Xray-core v26.10.31 (infra/conf: xray.go, socks.go,
// vless.go, transport_internet.go, transport_method.go, transport_security.go, router.go, log.go)
// и проверяются самим Xray: `xray run -test -c config.json`.
package xray

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/singbox"
)

type Config struct {
	Log       Log        `json:"log"`
	Inbounds  []Inbound  `json:"inbounds"`
	Outbounds []Outbound `json:"outbounds"`
	Routing   Routing    `json:"routing"`
}

type Log struct {
	LogLevel string `json:"loglevel"`
	Access   string `json:"access"` // "none" — не писать, какие сайты открывались
}

// Inbound — socks: Xray понимает на нём и SOCKS5 (для Chrome), и HTTP-прокси (пинг, «Мой IP»).
type Inbound struct {
	Tag      string          `json:"tag"`
	Listen   string          `json:"listen"`
	Port     int             `json:"port"`
	Protocol string          `json:"protocol"`
	Settings InboundSettings `json:"settings"`
}

type InboundSettings struct {
	Auth string `json:"auth"`
	UDP  bool   `json:"udp"`
}

type Outbound struct {
	Tag            string          `json:"tag"`
	Protocol       string          `json:"protocol"`
	Settings       *VLESS          `json:"settings,omitempty"`
	StreamSettings *StreamSettings `json:"streamSettings,omitempty"`
}

// VLESS — короткий вид настроек исходящего VLESS (без vnext).
type VLESS struct {
	Address    string `json:"address"`
	Port       int    `json:"port"`
	ID         string `json:"id"`
	Flow       string `json:"flow,omitempty"`
	Encryption string `json:"encryption"`
}

type StreamSettings struct {
	Network             string        `json:"network"`
	Security            string        `json:"security"`
	TLSSettings         *TLS          `json:"tlsSettings,omitempty"`
	RealitySettings     *Reality      `json:"realitySettings,omitempty"`
	XHTTPSettings       *XHTTP        `json:"xhttpSettings,omitempty"`
	WSSettings          *HostPath     `json:"wsSettings,omitempty"`
	HTTPUpgradeSettings *HostPath     `json:"httpupgradeSettings,omitempty"`
	GRPCSettings        *GRPCSettings `json:"grpcSettings,omitempty"`
}

// TLS — allowInsecure в Xray 26 удалён (конфиг с ним не проходит проверку); вместо него —
// закреплённый сертификат pinnedPeerCertSha256 (в ссылке pcs) и verifyPeerCertByName (vcn).
type TLS struct {
	ServerName           string   `json:"serverName,omitempty"`
	ALPN                 []string `json:"alpn,omitempty"`
	Fingerprint          string   `json:"fingerprint,omitempty"`
	PinnedPeerCertSha256 string   `json:"pinnedPeerCertSha256,omitempty"`
	VerifyPeerCertByName string   `json:"verifyPeerCertByName,omitempty"`
}

// Reality — ключ сервера в Xray 26 называется password (старое имя publicKey тоже принимается).
type Reality struct {
	ServerName    string `json:"serverName"`
	Fingerprint   string `json:"fingerprint"`
	Password      string `json:"password"`
	ShortID       string `json:"shortId,omitempty"`
	SpiderX       string `json:"spiderX,omitempty"`
	Mldsa65Verify string `json:"mldsa65Verify,omitempty"`
}

// XHTTP — extra переносится из ссылки как есть (Xray сам раскладывает его по настройкам XHTTP;
// host, path и mode из ссылки важнее того, что в extra).
type XHTTP struct {
	Host  string          `json:"host,omitempty"`
	Path  string          `json:"path,omitempty"`
	Mode  string          `json:"mode,omitempty"`
	Extra json.RawMessage `json:"extra,omitempty"`
}

type HostPath struct {
	Host string `json:"host,omitempty"`
	Path string `json:"path,omitempty"`
}

type GRPCSettings struct {
	ServiceName string `json:"serviceName,omitempty"`
}

type Routing struct {
	Rules []Rule `json:"rules"`
}

type Rule struct {
	InboundTag  []string `json:"inboundTag"`
	OutboundTag string   `json:"outboundTag"`
}

// Needed — сервер запускается в Xray, а не в sing-box: транспорт XHTTP (в ссылке xhttp или
// splithttp) или VLESS Encryption (encryption не none). Остальное — sing-box (SPEC-XRAY.md).
func Needed(s *links.Server) bool {
	return s.Protocol == "vless" && (s.Transport == "xhttp" || s.Encryption != "" && s.Encryption != "none")
}

// Pick — каким ядром запускать сервер: «xray» или «sing-box». err — сервер не запустит
// ни одно ядро (причина по-русски), warns — работает, но с оговорками.
func Pick(s *links.Server) (core string, warns []string, err error) {
	if Needed(s) {
		_, warns, err = OutboundFor(s, "x")
		return "xray", warns, err
	}
	_, warns, err = singbox.OutboundFor(s, "x")
	return "sing-box", warns, err
}

var xhttpModes = map[string]bool{"": true, "auto": true, "packet-up": true, "stream-up": true, "stream-one": true}

// OutboundFor — разобранная ссылка VLESS → outbound Xray.
func OutboundFor(s *links.Server, tag string) (Outbound, []string, error) {
	var warns []string
	o := Outbound{Tag: tag, Protocol: "vless"}
	if s.Protocol != "vless" {
		return o, nil, fmt.Errorf("протокол %s через Xray не запускается", s.Protocol)
	}
	set := &VLESS{Address: s.Address, Port: s.Port, ID: s.UUID, Encryption: s.Encryption}
	if set.Encryption == "" {
		set.Encryption = "none"
	}
	switch s.Flow {
	case "", "xtls-rprx-vision", "xtls-rprx-vision-udp443":
		set.Flow = s.Flow
	default:
		return o, nil, fmt.Errorf("flow=%s не поддерживается Xray", s.Flow)
	}
	o.Settings = set

	st := &StreamSettings{Security: s.Security}
	switch s.Security {
	case "none":
	case "tls":
		t := &TLS{ServerName: s.SNI, ALPN: s.ALPN, Fingerprint: s.Fingerprint,
			PinnedPeerCertSha256: s.PinnedCert, VerifyPeerCertByName: s.VerifyName}
		if t.ServerName == "" && links.IsDomain(s.Address) {
			t.ServerName = s.Address
		}
		if s.Insecure && s.PinnedCert == "" {
			warns = append(warns, "Xray не умеет отключать проверку сертификата (allowInsecure): сертификат сервера будет проверяться; если он самоподписанный, подключиться не выйдет — нужен его отпечаток (pcs)")
		}
		st.TLSSettings = t
	case "reality":
		fp := s.Fingerprint
		if fp == "" {
			fp = "chrome"
		}
		st.RealitySettings = &Reality{ServerName: s.SNI, Fingerprint: fp, Password: s.PublicKey,
			ShortID: s.ShortID, SpiderX: s.SpiderX, Mldsa65Verify: s.PQV}
	default:
		return o, nil, fmt.Errorf("security=%s не поддерживается", s.Security)
	}

	switch s.Transport {
	case "tcp":
		if s.HeaderType != "" && s.HeaderType != "none" {
			return o, nil, fmt.Errorf("TCP с маскировкой headerType=%s не поддерживается", s.HeaderType)
		}
		st.Network = "raw"
	case "xhttp":
		if !xhttpModes[s.Mode] {
			return o, nil, fmt.Errorf("xhttp: неизвестный режим mode=%s", s.Mode)
		}
		x := &XHTTP{Host: s.Host, Path: s.Path, Mode: s.Mode}
		if s.Extra != "" {
			x.Extra = json.RawMessage(s.Extra)
		}
		st.Network, st.XHTTPSettings = "xhttp", x
	case "ws":
		st.Network, st.WSSettings = "ws", &HostPath{Host: s.Host, Path: s.Path}
	case "httpupgrade":
		st.Network, st.HTTPUpgradeSettings = "httpupgrade", &HostPath{Host: s.Host, Path: s.Path}
	case "grpc":
		st.Network, st.GRPCSettings = "grpc", &GRPCSettings{ServiceName: s.ServiceName}
	default:
		return o, nil, fmt.Errorf("транспорт %s не поддерживается", s.Transport)
	}
	o.StreamSettings = st
	return o, warns, nil
}

// Built — собранный конфиг Xray и что с каждым сервером (как singbox.Built).
type Built struct {
	Config   *Config
	Ports    map[string]int
	Servers  map[string]*links.Server
	Errors   []singbox.EntryError
	Warnings map[string][]string
}

// logLevel: уровни sing-box (их шлёт расширение) → уровни Xray.
func logLevel(l string) string {
	switch l {
	case "trace", "debug":
		return "debug"
	case "info":
		return "info"
	case "error", "fatal", "panic":
		return "error"
	}
	return "warning"
}

// Build собирает конфиг из серверов для Xray. Ошибочные — в Errors; ни одного — NO_SERVERS.
func Build(entries []singbox.Entry, level string) (*Built, error) {
	b := &Built{
		Config: &Config{
			Log:       Log{LogLevel: logLevel(level), Access: "none"},
			Outbounds: []Outbound{{Tag: "block", Protocol: "blackhole"}},
			Routing:   Routing{Rules: []Rule{}},
		},
		Ports:    map[string]int{},
		Servers:  map[string]*links.Server{},
		Warnings: map[string][]string{},
	}
	usedPort := map[int]string{}
	for _, e := range entries {
		fail := func(msg string) { b.Errors = append(b.Errors, singbox.EntryError{ID: e.ID, Message: msg}) }
		switch {
		case !singbox.ValidID(e.ID):
			fail(fmt.Sprintf("неверный id сервера «%s»", e.ID))
			continue
		case b.Ports[e.ID] != 0:
			fail("сервер с таким id уже есть")
			continue
		case e.LocalPort < 1024 || e.LocalPort > 65535:
			fail(fmt.Sprintf("неверный локальный порт %d", e.LocalPort))
			continue
		case usedPort[e.LocalPort] != "":
			fail(fmt.Sprintf("порт %d уже назначен серверу %s", e.LocalPort, usedPort[e.LocalPort]))
			continue
		}
		s, err := links.Parse(e.Link)
		if err != nil {
			fail("ссылка не распознана: " + err.Error())
			continue
		}
		hostlog.AddSecret(s.UUID) // uuid бывает и не в виде UUID — маска uuid его не узнает
		if s.Encryption != "none" {
			hostlog.AddSecret(s.Encryption) // ключ VLESS Encryption
		}
		out, warns, err := OutboundFor(s, "out-"+e.ID)
		if err != nil {
			fail(err.Error())
			continue
		}
		in := "in-" + e.ID
		c := b.Config
		c.Inbounds = append(c.Inbounds, Inbound{Tag: in, Listen: "127.0.0.1", Port: e.LocalPort, Protocol: "socks",
			Settings: InboundSettings{Auth: "noauth"}})
		c.Outbounds = append(c.Outbounds, out)
		c.Routing.Rules = append(c.Routing.Rules, Rule{InboundTag: []string{in}, OutboundTag: out.Tag})
		b.Ports[e.ID] = e.LocalPort
		b.Servers[e.ID] = s
		usedPort[e.LocalPort] = e.ID
		if w := append(append([]string{}, s.Warnings...), warns...); len(w) > 0 {
			b.Warnings[e.ID] = w
		}
	}
	if len(b.Config.Inbounds) == 0 {
		return b, &singbox.Error{Code: "NO_SERVERS", Message: "нет ни одного сервера, который можно запустить"}
	}
	return b, nil
}

// JSON — конфиг для записи в файл.
func (c *Config) JSON() ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(c); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// PortsOf — порты inbound (их должно открыть ядро).
func (c *Config) PortsOf() []int {
	var ports []int
	for _, in := range c.Inbounds {
		ports = append(ports, in.Port)
	}
	return ports
}

// trimBanner убирает из вывода Xray служебное: версию, «Reading config…», «Configuration OK.».
func trimBanner(s string) string {
	var keep []string
	for _, l := range strings.Split(s, "\n") {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "Xray ") || strings.HasPrefix(t, "A unified platform") || t == "Configuration OK." ||
			strings.Contains(t, "Reading config:") {
			continue
		}
		keep = append(keep, t)
	}
	return strings.Join(keep, "\n")
}
