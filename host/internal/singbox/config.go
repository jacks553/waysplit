// Package singbox собирает конфиг sing-box, проверяет его ядром и запускает ядро.
//
// Устройство конфига (SPEC, раздел 2): у каждого сервера свой inbound mixed на
// 127.0.0.1:<порт> и свой outbound; маршрут жёсткий in-<id> → out-<id>, outbound direct нет.
// Поля сверены со схемой `sing-box schema` версии 1.14.4.
package singbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"

	"waysplit/host/internal/links"
)

type Config struct {
	Log       Log        `json:"log"`
	DNS       DNS        `json:"dns"`
	Inbounds  []Inbound  `json:"inbounds"`
	Outbounds []Outbound `json:"outbounds"`
	Route     Route      `json:"route"`
}

type Log struct {
	Level     string `json:"level"`
	Timestamp bool   `json:"timestamp"`
}

// DNS — только для адресов самих VPN-серверов. Адреса сайтов через SOCKS5
// уходят на сервер как имена и там же разрешаются.
type DNS struct {
	Servers []DNSServer `json:"servers"`
}

type DNSServer struct {
	Type string `json:"type"`
	Tag  string `json:"tag"`
}

type Inbound struct {
	Type       string `json:"type"`
	Tag        string `json:"tag"`
	Listen     string `json:"listen"`
	ListenPort int    `json:"listen_port"`
}

type Outbound struct {
	Type        string     `json:"type"`
	Tag         string     `json:"tag"`
	Server      string     `json:"server"`
	ServerPort  int        `json:"server_port,omitempty"`
	ServerPorts []string   `json:"server_ports,omitempty"`
	HopInterval string     `json:"hop_interval,omitempty"`
	UUID        string     `json:"uuid,omitempty"`
	Flow        string     `json:"flow,omitempty"`
	Password    string     `json:"password,omitempty"`
	Obfs        *Obfs      `json:"obfs,omitempty"`
	TLS         *TLS       `json:"tls,omitempty"`
	Transport   *Transport `json:"transport,omitempty"`
}

type Obfs struct {
	Type     string `json:"type"`
	Password string `json:"password"`
}

type TLS struct {
	Enabled    bool     `json:"enabled"`
	ServerName string   `json:"server_name,omitempty"`
	Insecure   bool     `json:"insecure,omitempty"`
	ALPN       []string `json:"alpn,omitempty"`
	UTLS       *UTLS    `json:"utls,omitempty"`
	Reality    *Reality `json:"reality,omitempty"`
}

type UTLS struct {
	Enabled     bool   `json:"enabled"`
	Fingerprint string `json:"fingerprint"`
}

type Reality struct {
	Enabled   bool   `json:"enabled"`
	PublicKey string `json:"public_key"`
	ShortID   string `json:"short_id,omitempty"`
}

// Transport — ws, grpc, httpupgrade или http. Host у httpupgrade строка, у http — список.
type Transport struct {
	Type                string            `json:"type"`
	Host                any               `json:"host,omitempty"`
	Path                string            `json:"path,omitempty"`
	Headers             map[string]string `json:"headers,omitempty"`
	MaxEarlyData        int               `json:"max_early_data,omitempty"`
	EarlyDataHeaderName string            `json:"early_data_header_name,omitempty"`
	ServiceName         string            `json:"service_name,omitempty"`
}

type Route struct {
	DefaultDomainResolver string `json:"default_domain_resolver"`
	Rules                 []Rule `json:"rules"`
}

type Rule struct {
	Inbound  []string `json:"inbound"`
	Outbound string   `json:"outbound"`
}

// Entry — сервер для конфига: id, ссылка и постоянный локальный порт.
type Entry struct {
	ID        string `json:"id"`
	Link      string `json:"link"`
	LocalPort int    `json:"localPort"`
}

// EntryError — сервер не вошёл в конфиг.
type EntryError struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

// Built — собранный конфиг и что с каждым сервером.
type Built struct {
	Config   *Config
	Ports    map[string]int // id → порт, только вошедшие в конфиг
	Servers  map[string]*links.Server
	Errors   []EntryError        // не вошедшие и почему
	Warnings map[string][]string // id → предупреждения
}

var (
	idRe      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	logLevels = map[string]bool{"trace": true, "debug": true, "info": true, "warn": true, "error": true, "fatal": true, "panic": true}
)

// ValidID — id сервера годится для тегов конфига (латиница, цифры, «_», «-»).
func ValidID(id string) bool { return idRe.MatchString(id) }

// Build собирает конфиг. Серверы с ошибками в конфиг не входят и перечислены в Errors.
// Если не вошёл ни один, возвращается ошибка NO_SERVERS.
func Build(entries []Entry, logLevel string) (*Built, error) {
	if !logLevels[logLevel] {
		logLevel = "warn"
	}
	b := &Built{
		Config: &Config{
			Log:   Log{Level: logLevel, Timestamp: true},
			DNS:   DNS{Servers: []DNSServer{{Type: "local", Tag: "local"}}},
			Route: Route{DefaultDomainResolver: "local"},
		},
		Ports:    map[string]int{},
		Servers:  map[string]*links.Server{},
		Warnings: map[string][]string{},
	}
	usedPort := map[int]string{}
	for _, e := range entries {
		fail := func(msg string) { b.Errors = append(b.Errors, EntryError{ID: e.ID, Message: msg}) }
		switch {
		case !idRe.MatchString(e.ID):
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
		out, warns, err := OutboundFor(s, "out-"+e.ID)
		if err != nil {
			fail(err.Error())
			continue
		}
		in := "in-" + e.ID
		c := b.Config
		c.Inbounds = append(c.Inbounds, Inbound{Type: "mixed", Tag: in, Listen: "127.0.0.1", ListenPort: e.LocalPort})
		c.Outbounds = append(c.Outbounds, out)
		c.Route.Rules = append(c.Route.Rules, Rule{Inbound: []string{in}, Outbound: out.Tag})
		b.Ports[e.ID] = e.LocalPort
		b.Servers[e.ID] = s
		usedPort[e.LocalPort] = e.ID
		if w := append(append([]string{}, s.Warnings...), warns...); len(w) > 0 {
			b.Warnings[e.ID] = w
		}
	}
	if len(b.Config.Outbounds) == 0 {
		return b, &Error{Code: "NO_SERVERS", Message: "нет ни одного сервера, который можно запустить"}
	}
	return b, nil
}

// JSON — конфиг для записи в файл (с отступами, без замены «&» и «<» на &).
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

// Error — ошибка с кодом для расширения (PORT_BUSY, SINGBOX_NOT_FOUND…) и текстом по-русски.
type Error struct {
	Code    string
	Message string
	Detail  string // хвост журнала sing-box и т. п., уже без секретов
}

func (e *Error) Error() string { return e.Message }

// ErrorCode — код для расширения (так ошибку понимает пакет nm).
func (e *Error) ErrorCode() string { return e.Code }
