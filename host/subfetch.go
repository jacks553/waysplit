package main

// Скачивание подписки с привязкой к устройству (SPEC-SUBS.md, шаг 2, пункты 3–4):
//   - подписка ещё не привязана — сначала запрос без идентификатора устройства; если серверов
//     нет (пусто, только заглушка «App not supported», happ://crypt) или панель прямо говорит,
//     что нужно устройство (x-hwid-not-supported, ответ не 200 при x-hwid-active), — ещё раз
//     с идентификатором; расширение запоминает, что подписка привязана (deviceUsed);
//   - подписка уже привязана — сразу с идентификатором;
//   - серверов так и нет — понятная причина: лимит устройств, шифрование для Happ, сообщение панели.

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"waysplit/host/internal/device"
	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/nm"
	"waysplit/host/internal/singbox"
)

// fetchSub — подписка по правилам выше. withDevice — подписка уже привязана к устройству.
// usedDevice — идентификатор отправлялся (и с ним пришли серверы).
func fetchSub(ctx context.Context, rawURL, ua string, proxy *url.URL, withDevice bool) (sub *links.Subscription, usedDevice bool, err error) {
	var hdr http.Header
	loadDevice := func() error {
		// Идентификатор — только по защищённому соединению (правила Chrome Web Store).
		if u, err := url.Parse(strings.TrimSpace(rawURL)); err != nil || !links.SecureForDevice(u) {
			return deviceNeedsHTTPS()
		}
		dev, created, err := device.Load(singbox.DataDir())
		if err != nil {
			return err
		}
		if created {
			hostlog.Printf("создан идентификатор устройства %s", dev.Short())
		}
		hdr = dev.Header()
		return nil
	}
	if withDevice {
		if err := loadDevice(); err != nil {
			return nil, false, err
		}
	}
	bound := withDevice
	sub, err = links.FetchWith(ctx, rawURL, ua, proxy, hdr)
	if why := needsDevice(sub, err); !withDevice && why != "" {
		hostlog.Printf("подписка без идентификатора устройства: %s — повтор с ним", why)
		if err := loadDevice(); err != nil {
			return nil, false, err
		}
		withDevice = true
		sub, err = links.FetchWith(ctx, rawURL, ua, proxy, hdr)
	}
	if errors.Is(err, links.ErrDeviceInsecure) {
		return nil, bound, deviceNeedsHTTPS() // перенаправили на http://
	}
	if err != nil {
		var he *links.HTTPError
		if errors.As(err, &he) && he.Device.MaxReached {
			return nil, bound, deviceLimit()
		}
		return nil, bound, err
	}
	if len(sub.Servers) == 0 {
		switch {
		case sub.Device.MaxReached:
			return nil, bound, deviceLimit()
		case sub.HappCrypt > 0:
			return nil, bound, &nm.Error{Code: "HAPP_CRYPT", Message: "Подписка зашифрована для приложения Happ. Попросите у провайдера обычную ссылку на подписку"}
		case len(sub.Stubs) > 0:
			return nil, bound, &nm.Error{Code: "SUBSCRIPTION_STUB", Message: "Вместо серверов провайдер прислал сообщение: «" + strings.Join(sub.Stubs, "», «") + "»"}
		case sub.Format == links.FormatClash && len(sub.Errors) == 0:
			// Ссылка для классического Clash: он не умеет VLESS и Hysteria2, и панель кладёт туда пустой список.
			return nil, bound, &nm.Error{Code: "SUBSCRIPTION_EMPTY", Message: "В подписке для Clash нет ни одного сервера: классический Clash не умеет VLESS и Hysteria2, поэтому провайдер их туда не кладёт. Возьмите у провайдера ссылку для Mihomo (Clash Meta) или обычную ссылку на подписку"}
		}
		return sub, bound, nil // пустая и с идентификатором — привязкой это не считаем
	}
	// Привязана: уже была или серверы пришли только с идентификатором.
	return sub, withDevice, nil
}

// needsDevice — почему стоит повторить с идентификатором устройства ("" — не нужно).
func needsDevice(sub *links.Subscription, err error) string {
	var he *links.HTTPError
	switch {
	case errors.As(err, &he):
		if he.Device.Active || he.Device.NotSupported {
			return "панель с привязкой к устройствам ответила «" + he.Status + "»"
		}
	case err != nil:
	case sub.Device.NotSupported && len(sub.Servers) == 0:
		return "панель сообщила, что нужен идентификатор устройства"
	case len(sub.Servers) == 0:
		return "серверов нет"
	}
	return ""
}

func deviceNeedsHTTPS() error {
	return &nm.Error{Code: "DEVICE_NEEDS_HTTPS", Message: "Провайдер требует идентификатор устройства, а адрес подписки без шифрования (http://): по такому адресу идентификатор не отправляется. Возьмите у провайдера адрес, который начинается с https://"}
}

func deviceLimit() error {
	return &nm.Error{Code: "DEVICE_LIMIT", Message: "Лимит устройств исчерпан: провайдер не отдаёт серверы этому компьютеру. Удалите старое устройство в личном кабинете провайдера или попросите увеличить лимит"}
}
