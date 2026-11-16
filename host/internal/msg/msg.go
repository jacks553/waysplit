// Package msg — фразы компаньона для расширения: код фразы и значения вставок.
//
// У каждой фразы есть код и русский шаблон со вставками {имя}. Те же шаблоны лежат в словаре
// расширения (extension/lib/i18n/ru.js, ключи host.<код>), а в en.js — их перевод: тест пакета
// сверяет таблицу со словарями. Расширение 1.2.0 и новее показывает фразу по коду на языке окна;
// расширения до 1.2.0 видят готовую русскую фразу (Ru) — она буква в букву прежняя.
//
// Значение вставки — строка, число или другая фраза (Text): так причина внутри фразы
// («подписка не скачалась: сервер подписки не ответил вовремя») тоже переводится.
package msg

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
)

// ru — коды фраз и русские шаблоны.
var ru = map[string]string{
	// Запросы к компаньону. Ошибки запроса возможны, только если в расширении ошибка.
	"unknown_cmd":         "компаньон не знает команду «{cmd}» — обновите компаньон",
	"bad_message":         "непонятный запрос к компаньону",
	"bad_request_links":   "parse_links: нужен текст со ссылками",
	"bad_request_ping":    "ping: нужен список serverIds",
	"bad_request_sub":     "{cmd}: нужен адрес подписки http(s)://…",
	"bad_request_exit_ip": "exit_ip: нужен serverId",
	"bad_request_apply":   "apply: неверный список серверов",
	"result_too_big":      "ответ компаньона слишком большой",
	"internal":            "внутренняя ошибка компаньона (подробности — в host.log)",
	"no_config":           "нет конфига: сначала нужен apply со списком серверов",
	"core_not_running":    "ядро не запущено — включите VPN",
	"core_no_server":      "ядро не запущено или в нём нет этого сервера",
	"no_servers":          "нет ни одного сервера, который можно запустить",

	// Ядра: проверка, запуск, порты.
	"singbox_not_found":     "sing-box не найден рядом с waysplit-host.exe: установите компаньон заново («Установить.cmd»)",
	"singbox_failed":        "не удалось запустить sing-box: {error}",
	"singbox_check_timeout": "sing-box check не ответил за 30 секунд",
	"singbox_rejected":      "sing-box не принял конфиг: {line}",
	"xray_not_found":        "Xray не найден рядом с waysplit-host.exe (он нужен для серверов XHTTP): установите компаньон заново («Установить.cmd»)",
	"xray_failed":           "не удалось запустить Xray: {error}",
	"xray_check_timeout":    "проверка конфига Xray не ответила за 30 секунд",
	"xray_rejected":         "Xray не принял конфиг: {line}",
	"xray_version_unclear":  "Xray ответил непонятно на «version»",
	"version_unclear":       "непонятный ответ на «version»",
	"config_build":          "не удалось собрать конфиг: {error}",
	"config_build_xray":     "не удалось собрать конфиг Xray: {error}",
	"dir_create":            "не удалось создать папку {dir}",
	"config_write":          "не удалось записать конфиг: {error}",
	"log_open":              "не удалось открыть {file}: {error}",
	"core_start":            "{core} не запустился: {error}",
	"core_job":              "не удалось привязать {core} к компаньону (Job Object): {error}",
	"core_exited":           "{core} сразу завершился: {line}",
	"core_died":             "{core} неожиданно завершился: {line}",
	"unknown_reason":        "причина неизвестна, см. {file}",
	"start_timeout":         "{core} не открыл порт {port} за {sec} секунд",
	"port_reserved":         "Порт {port} зарезервирован Windows — выберите другой диапазон портов",
	"port_busy":             "Порт {port} занят другой программой",

	// Сервер в списке для ядра.
	"bad_server_id":  "неверный id сервера «{id}»",
	"dup_server_id":  "сервер с таким id уже есть",
	"bad_local_port": "неверный локальный порт {port}",
	"port_taken":     "порт {port} уже назначен серверу {server}",
	"link_bad":       "ссылка не распознана: {error}",

	// Что не умеют ядра.
	"sb_protocol":         "протокол {proto} не поддерживается sing-box",
	"sb_vless_encryption": "шифрование VLESS Encryption не поддерживается sing-box",
	"sb_flow":             "flow={flow} не поддерживается sing-box",
	"sb_security":         "security={security} не поддерживается sing-box",
	"sb_tcp_header":       "TCP с маскировкой headerType={header} не поддерживается sing-box",
	"sb_transport":        "транспорт {transport} не поддерживается sing-box",
	"obfs_unsupported":    "obfs={obfs} не поддерживается",
	"xr_protocol":         "протокол {proto} через Xray не запускается",
	"xr_flow":             "flow={flow} не поддерживается Xray",
	"xr_security":         "security={security} не поддерживается",
	"xr_tcp_header":       "TCP с маскировкой headerType={header} не поддерживается",
	"xr_xhttp_mode":       "xhttp: неизвестный режим mode={mode}",
	"xr_transport":        "транспорт {transport} не поддерживается",

	// Ссылка сервера: почему строка не стала сервером.
	"empty_line":         "пустая строка",
	"not_a_link":         "не похоже на ссылку сервера",
	"link_unknown":       "ссылка не распознана",
	"link_subscription":  "это ссылка на подписку, а не на сервер",
	"happ_link":          "Ссылка зашифрована для приложения Happ — открыть её может только Happ. Попросите у провайдера обычную ссылку на подписку (https://…)",
	"proto_unsupported":  "протокол {proto} пока не поддерживается",
	"proto_hysteria1":    "Hysteria (первая версия)",
	"hysteria_version":   "Hysteria версии {version} не поддерживается (нужна 2)",
	"duplicate_line":     "такой сервер уже есть (строка {line})",
	"ipv6_no_bracket":    "IPv6-адрес без закрывающей скобки «]»",
	"ipv6_port_expected": "после адреса [{host}] ожидается «:порт»",
	"ipv6_brackets":      "IPv6-адрес нужно писать в квадратных скобках: [2001:db8::1]:443",
	"no_address":         "нет адреса сервера",
	"bad_address":        "неверный адрес сервера «{host}»",
	"bad_port":           "неверный порт «{port}»",
	"bad_port_range":     "неверный диапазон портов «{range}»",
	"no_port_given":      "не указан порт",
	"mport":              "mport: {error}",
	"no_uuid":            "в ссылке нет uuid",
	"no_port":            "в ссылке нет порта",
	"no_password":        "в ссылке нет пароля",
	"obfs_no_password":   "obfs=salamander без obfs-password",
	"xhttp_extra":        "xhttp: параметр extra — не JSON-объект",
	"reality_no_pbk":     "Reality: в ссылке нет ключа pbk",
	"reality_bad_pbk":    "Reality: неверный ключ pbk",
	"reality_bad_sid":    "Reality: неверный sid (нужно до 16 символов 0–9, a–f, чётное количество)",
	"reality_no_sni":     "Reality: в ссылке нет sni",

	// Подписка.
	"bad_sub_url":         "неверный адрес подписки",
	"sub_http_status":     "подписка не скачалась: сервер ответил «{status}»",
	"sub_net":             "подписка не скачалась: {reason}",
	"net_dns":             "адрес сервера подписки не найден ({host})",
	"net_timeout":         "сервер подписки не ответил вовремя",
	"net_refused":         "сервер подписки не принимает подключения",
	"net_cert":            "у сервера подписки неверный сертификат",
	"sub_too_big":         "подписка слишком большая (больше 10 МБ)",
	"sub_html":            "вместо списка серверов пришла веб-страница: проверьте адрес подписки или User-Agent в настройках",
	"sub_json_broken":     "подписка пришла в виде JSON, но он испорчен: {error}",
	"sub_json_unknown":    "подписка пришла в формате JSON, который Waysplit не знает (нужны настройки Xray или sing-box с outbounds)",
	"sub_yaml_broken":     "подписка пришла в формате Clash / Mihomo, но YAML испорчен: {error}",
	"sub_clash_providers": "в подписке Clash / Mihomo нет списка серверов (proxies), только ссылки на другие списки (proxy-providers) — попросите у провайдера обычную ссылку на подписку",
	"sub_clash_empty":     "В подписке для Clash нет ни одного сервера: классический Clash не умеет VLESS и Hysteria2, поэтому провайдер их туда не кладёт. Возьмите у провайдера ссылку для Mihomo (Clash Meta) или обычную ссылку на подписку",
	"sub_stub":            "Вместо серверов провайдер прислал сообщение: «{text}»",
	"happ_sub":            "Подписка зашифрована для приложения Happ. Попросите у провайдера обычную ссылку на подписку",
	"device_insecure":     "идентификатор устройства по адресу без шифрования (http://) не отправляется",
	"device_needs_https":  "Провайдер требует идентификатор устройства, а адрес подписки без шифрования (http://): по такому адресу идентификатор не отправляется. Возьмите у провайдера адрес, который начинается с https://",
	"device_limit":        "Лимит устройств исчерпан: провайдер не отдаёт серверы этому компьютеру. Удалите старое устройство в личном кабинете провайдера или попросите увеличить лимит",
	"device_save":         "не удалось сохранить идентификатор устройства: {error}",

	// Проверка сервера: пинг и «Мой IP сейчас».
	"ping_no_response":     "Сервер не отвечает",
	"ping_no_response_udp": "Сервер не отвечает (возможно, заблокирован UDP)",
	"ping_core_port":       "ядро не слушает порт {port}",
	"ping_not_in_core":     "сервер не запущен в ядре",
	"exit_ip_not_ip":       "api.ipify.org вернул не IP-адрес",

	// Текст как есть (ошибка Windows, сети и т. п. без своей фразы): его не переводим.
	"raw": "{error}",
}

// Text — фраза: код и значения вставок (строка, число или Text).
type Text struct {
	ID     string
	Params map[string]any
}

// New — фраза по коду: New("port_busy", "port", 27105). Кода нет в таблице — паника: это
// ошибка в самом компаньоне, её ловят тесты.
func New(id string, kv ...any) Text {
	if _, ok := ru[id]; !ok {
		panic("msg: нет фразы " + id)
	}
	t := Text{ID: id}
	if len(kv) > 0 {
		t.Params = make(map[string]any, len(kv)/2)
		for i := 0; i+1 < len(kv); i += 2 {
			t.Params[kv[i].(string)] = kv[i+1]
		}
	}
	return t
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// Ru — фраза по-русски: шаблон со вставками.
func (t Text) Ru() string {
	return placeholder.ReplaceAllStringFunc(ru[t.ID], func(m string) string {
		v, ok := t.Params[m[1:len(m)-1]]
		if !ok {
			return m
		}
		if inner, ok := v.(Text); ok {
			return inner.Ru()
		}
		return fmt.Sprint(v)
	})
}

// MarshalJSON — фраза внутри значений: {"msg": код, "params": {...}}.
func (t Text) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Msg    string         `json:"msg"`
		Params map[string]any `json:"params,omitempty"`
	}{t.ID, t.Params})
}

// Map — значения вставок с изменённым текстом: fn — для каждой строки, и во вложенных фразах
// (компаньон прячет в них секреты так же, как в русской фразе).
func (t Text) Map(fn func(string) string) Text {
	if len(t.Params) == 0 {
		return t
	}
	out := Text{ID: t.ID, Params: make(map[string]any, len(t.Params))}
	for k, v := range t.Params {
		switch x := v.(type) {
		case string:
			out.Params[k] = fn(x)
		case Text:
			out.Params[k] = x.Map(fn)
		default:
			out.Params[k] = v
		}
	}
	return out
}

// Error — ошибка-фраза. Код ошибки для расширения (PORT_BUSY…) ставит тот, кто отдаёт её
// расширению; Of достаёт фразу из любой цепочки ошибок.
type Error struct{ Text Text }

func (e *Error) Error() string { return e.Text.Ru() }

// Phrase — фраза ошибки (так её находит Of).
func (e *Error) Phrase() Text { return e.Text }

// E — ошибка с фразой: E("no_uuid"), E("bad_port", "port", s).
func E(id string, kv ...any) error { return &Error{Text: New(id, kv...)} }

// Of — фраза ошибки, если она есть в её цепочке (у самой ошибки или у обёрнутой).
func Of(err error) (Text, bool) {
	var p interface{ Phrase() Text }
	if err != nil && errors.As(err, &p) {
		if t := p.Phrase(); t.ID != "" {
			return t, true
		}
	}
	return Text{}, false
}

// From — фраза для ошибки: своя, если есть, иначе текст ошибки как есть (raw).
func From(err error) Text {
	if t, ok := Of(err); ok {
		return t
	}
	return New("raw", "error", err.Error())
}

// IDs — все коды фраз по алфавиту (для тестов и проверки словарей).
func IDs() []string {
	out := make([]string, 0, len(ru))
	for id := range ru {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Template — русский шаблон фразы ("" — такой нет).
func Template(id string) string { return ru[id] }
