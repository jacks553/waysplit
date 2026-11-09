package singbox

import (
	"errors"
	"fmt"
	"strconv"

	"waysplit/host/internal/links"
)

// OutboundFor переводит разобранную ссылку в outbound sing-box (SPEC, раздел 6).
// Ошибка — sing-box такой сервер не поддерживает; предупреждения — работает, но с оговорками.
func OutboundFor(s *links.Server, tag string) (Outbound, []string, error) {
	switch s.Protocol {
	case "vless":
		return vlessOutbound(s, tag)
	case "hysteria2":
		return hysteria2Outbound(s, tag)
	}
	return Outbound{}, nil, fmt.Errorf("протокол %s не поддерживается sing-box", s.Protocol)
}

func vlessOutbound(s *links.Server, tag string) (Outbound, []string, error) {
	var warns []string
	o := Outbound{Type: "vless", Tag: tag, Server: s.Address, ServerPort: s.Port, UUID: s.UUID}

	if s.Encryption != "" && s.Encryption != "none" {
		// Значение не показываем: в новом VLESS Encryption там ключ.
		return o, nil, errors.New("шифрование VLESS Encryption не поддерживается sing-box")
	}
	switch s.Flow {
	case "":
	case "xtls-rprx-vision":
		o.Flow = s.Flow
	case "xtls-rprx-vision-udp443":
		o.Flow = "xtls-rprx-vision" // sing-box такой flow не принимает (проверено: unsupported flow)
	default:
		return o, nil, fmt.Errorf("flow=%s не поддерживается sing-box", s.Flow)
	}

	switch s.Security {
	case "none":
	case "tls":
		t := &TLS{Enabled: true, ServerName: s.SNI, Insecure: s.Insecure, ALPN: s.ALPN}
		if t.ServerName == "" && links.IsDomain(s.Address) {
			t.ServerName = s.Address
		}
		if s.Fingerprint != "" {
			fp, w := fingerprint(s.Fingerprint)
			t.UTLS = &UTLS{Enabled: true, Fingerprint: fp}
			warns = appendNonEmpty(warns, w)
		}
		o.TLS = t
	case "reality":
		// Без uTLS sing-box не пускает Reality (проверено: uTLS is required by reality client).
		fp, w := fingerprint(s.Fingerprint)
		warns = appendNonEmpty(warns, w)
		o.TLS = &TLS{
			Enabled:    true,
			ServerName: s.SNI,
			UTLS:       &UTLS{Enabled: true, Fingerprint: fp},
			Reality:    &Reality{Enabled: true, PublicKey: s.PublicKey, ShortID: s.ShortID},
		}
		if s.PQV != "" {
			warns = append(warns, "Параметр pqv (дополнительная постквантовая проверка Reality) sing-box не поддерживает: сервер проверяется только по ключу pbk")
		}
	default:
		return o, nil, fmt.Errorf("security=%s не поддерживается sing-box", s.Security)
	}

	switch s.Transport {
	case "tcp":
		if s.HeaderType != "" && s.HeaderType != "none" {
			return o, nil, fmt.Errorf("TCP с маскировкой headerType=%s не поддерживается sing-box", s.HeaderType)
		}
	case "ws":
		t := &Transport{Type: "ws", Path: s.Path}
		if s.Host != "" {
			t.Headers = map[string]string{"Host": s.Host}
		}
		if s.EarlyData > 0 {
			t.MaxEarlyData = s.EarlyData
			t.EarlyDataHeaderName = "Sec-WebSocket-Protocol"
		}
		o.Transport = t
	case "grpc":
		o.Transport = &Transport{Type: "grpc", ServiceName: s.ServiceName}
	case "httpupgrade":
		t := &Transport{Type: "httpupgrade", Path: s.Path}
		if s.Host != "" {
			t.Host = s.Host
		}
		o.Transport = t
	case "http":
		t := &Transport{Type: "http", Path: s.Path}
		if hosts := links.SplitList(s.Host); len(hosts) > 0 {
			t.Host = hosts
		}
		o.Transport = t
	default:
		// xhttp не подменяем на httpupgrade: вышло бы «тихо» неработающее подключение.
		return o, nil, fmt.Errorf("транспорт %s не поддерживается sing-box", s.Transport)
	}
	return o, warns, nil
}

func hysteria2Outbound(s *links.Server, tag string) (Outbound, []string, error) {
	var warns []string
	o := Outbound{Type: "hysteria2", Tag: tag, Server: s.Address, Password: s.Password}
	if len(s.Ports) > 0 {
		// Каждый порт и диапазон — строкой «от:до»: «443» и «20000-50000» sing-box
		// не принимает (проверено: bad port range).
		for _, p := range s.Ports {
			o.ServerPorts = append(o.ServerPorts, strconv.Itoa(p.From)+":"+strconv.Itoa(p.To))
		}
		o.HopInterval = "30s"
	} else {
		o.ServerPort = s.Port
	}
	switch s.Obfs {
	case "":
	case "salamander":
		o.Obfs = &Obfs{Type: "salamander", Password: s.ObfsPassword}
	default:
		return o, nil, fmt.Errorf("obfs=%s не поддерживается", s.Obfs)
	}
	sni := s.SNI
	if sni == "" {
		sni = s.Address
	}
	o.TLS = &TLS{Enabled: true, ServerName: sni, Insecure: s.Insecure}
	if s.PinSHA256 != "" {
		// pinSHA256 — отпечаток всего сертификата. certificate_public_key_sha256 в sing-box —
		// хеш открытого ключа, это другое, туда подставлять нельзя.
		if s.Insecure {
			warns = append(warns, "Закрепление сертификата (pinSHA256) sing-box не поддерживает, а проверка сертификата в ссылке отключена (insecure=1): соединение не защищено от подмены сервера")
		} else {
			warns = append(warns, "Закрепление сертификата (pinSHA256) sing-box не поддерживает: сертификат проверяется обычным способом")
		}
	}
	return o, warns, nil
}

// Отпечатки uTLS, которые принимает sing-box 1.14 (из `sing-box schema`).
var utlsFingerprints = map[string]bool{
	"chrome": true, "chrome_psk": true, "chrome_psk_shuffle": true, "chrome_padding_psk_shuffle": true,
	"chrome_pq": true, "chrome_pq_psk": true, "firefox": true, "edge": true, "safari": true,
	"360": true, "qq": true, "ios": true, "android": true, "random": true, "randomized": true,
}

// fingerprint: fp из ссылки → отпечаток sing-box (пусто — chrome) и предупреждение, если пришлось заменить.
func fingerprint(fp string) (string, string) {
	switch {
	case fp == "":
		return "chrome", ""
	case utlsFingerprints[fp]:
		return fp, ""
	case fp == "randomizednoalpn":
		return "randomized", ""
	}
	return "chrome", fmt.Sprintf("Отпечаток fp=%s sing-box не знает, взят chrome", fp)
}

func appendNonEmpty(list []string, s string) []string {
	if s != "" {
		list = append(list, s)
	}
	return list
}
