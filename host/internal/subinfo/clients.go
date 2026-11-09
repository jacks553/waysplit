package subinfo

import "waysplit/host/internal/links"

// Client — как представиться серверу подписки.
type Client struct {
	Name      string `json:"name"`
	UserAgent string `json:"userAgent"`
}

// Clients — User-Agent разных клиентов. Строки взяты из исходников клиентов (ноябрь 2026),
// не выдуманы:
//   - v2rayN 7.25.6: ServiceLib/Common/Utils.cs GetVersion → "v2rayN/<версия>";
//   - Happ (код закрыт): панель Remnawave узнаёт Happ по началу "Happ/"
//     (remnawave/backend, subscription-template/constants/extended-clients.ts, /^Happ\//);
//     версия 3.24.1 — последний выпуск Happ для Android на ноябрь 2026;
//   - v2rayNG 2.3.15: util/HttpUtil.kt → "v2rayNG/<версия>";
//   - Hiddify 5.5.5: lib/core/model/app_info_entity.dart →
//     "HiddifyNext/<версия> (<ОС>) like ClashMeta v2ray sing-box";
//   - sing-box для Android (SFA): utils/HTTPClient.kt → "SFA (sing-box <версия>; language <язык>)";
//   - Clash Verge Rev 2.5.10: src-tauri/src/utils/network.rs → "clash-verge/v<версия>";
//   - mihomo 1.19.33: config/config.go GlobalUA → "clash.meta/" + версия (в выпусках — с «v»).
var Clients = []Client{
	{"Waysplit сейчас", links.DefaultUserAgent},
	{"v2rayN 7.25.6", "v2rayN/7.25.6"},
	{"Happ 3.24.1", "Happ/3.24.1"},
	{"v2rayNG 2.3.15", "v2rayNG/2.3.15"},
	{"Hiddify 5.5.5", "HiddifyNext/5.5.5 (windows) like ClashMeta v2ray sing-box"},
	{"sing-box (SFA)", "SFA (sing-box 1.14.4; language ru_RU)"},
	{"Clash Verge Rev 2.5.10", "clash-verge/v2.5.10"},
	{"mihomo 1.19.33", "clash.meta/v1.19.33"},
}
