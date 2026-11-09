package subinfo

import (
	"fmt"
	"strings"
)

// Report — отчёт по-русски для человека: по каждому способу ответ, формат, серверы и заголовки,
// в начале — итог. Секретов в нём нет: адрес подписки не печатается вовсе.
func Report(results []Result, o Options) string {
	var sb strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&sb, format, args...) }
	w("Проверка подписки (адрес скрыт)\n")
	w("Способов: %d; ", len(results))
	if o.Proxy != nil {
		w("через VPN (локальный порт сервера).\n")
	} else {
		w("напрямую.\n")
	}
	if o.Device != nil {
		w("Заголовки устройства: во второй половине способов — x-hwid %s, x-device-os %s, x-ver-os %s, x-device-model %s.\n",
			o.Device.Short(), o.Device.OS, o.Device.OSVersion, o.Device.Model)
	} else {
		w("Заголовки устройства (x-hwid и др.) не отправлялись.\n")
	}

	summary(w, results)
	w("\n== Подробно по способам\n")

	var seen []headerSet
	for i, r := range results {
		w("\n== %d. %s", i+1, r.Client)
		if r.Device {
			w(" + устройство")
		}
		w("\nUser-Agent: %s\n", r.UserAgent)
		if r.Status == 0 {
			w("Ответа нет: %s (%s с)\n", r.Error, comma(float64(r.Ms)/1000))
			continue
		}
		w("Ответ: %d %s · %s · %s · %s с", r.Status, r.StatusText, nonEmpty(r.ContentType, "Content-Type нет"), fmtSize(r.Size), comma(float64(r.Ms)/1000))
		if r.Redirects > 0 {
			w(" · перенаправлений: %d", r.Redirects)
		}
		w("\n")
		if r.Error != "" {
			w("Внимание: %s\n", r.Error)
		}
		writeBody(w, r.Body)
		same := 0
		hs := headerSet(r.Headers)
		for j, prev := range seen {
			if prev.equal(hs) {
				same = j + 1
				break
			}
		}
		seen = append(seen, hs)
		if same > 0 {
			w("Заголовки: те же, что в способе %d\n", same)
			continue
		}
		w("Заголовки (без cookie):\n")
		for _, h := range r.Headers {
			w("  %s: %s", h.Name, h.Value)
			if h.Note != "" {
				w("  — %s", h.Note)
			}
			w("\n")
		}
	}
	return sb.String()
}

// summary — итог: какими способами серверы пришли, какими нет и почему.
func summary(w func(string, ...any), results []Result) {
	w("\n== Итог\n")
	var good, bad []string
	for _, r := range results {
		label := r.Client
		if r.Device {
			label += " + устройство"
		}
		switch {
		case r.Status == 0:
			bad = append(bad, label+" — нет ответа")
		case r.Body != nil && r.Body.Servers > 0:
			good = append(good, fmt.Sprintf("%s — %d (%s; запустим %d)", label, r.Body.Servers, r.Body.FormatText, r.Body.Usable))
		default:
			why := fmt.Sprintf("%d", r.Status)
			if r.Body != nil {
				why += ", " + r.Body.FormatText
				if len(r.Body.Stubs) > 0 {
					why += ", только заглушка «" + strings.Join(r.Body.Stubs, "», «") + "»"
				}
				if r.Body.HappCrypt > 0 {
					why += fmt.Sprintf(", happ://crypt: %d", r.Body.HappCrypt)
				}
			}
			bad = append(bad, label+" — "+why)
		}
	}
	if len(good) > 0 {
		w("Серверы пришли:\n")
		for _, s := range good {
			w("  %s\n", s)
		}
	} else {
		w("Серверы не пришли ни одним способом.\n")
	}
	if len(bad) > 0 {
		w("Без серверов:\n")
		for _, s := range bad {
			w("  %s\n", s)
		}
	}
}

func writeBody(w func(string, ...any), b *Body) {
	if b == nil {
		return
	}
	w("Формат: %s", b.FormatText)
	if b.Format == "text" || b.Format == "links" || b.Format == "base64" || b.Format == "happ-crypt" {
		w(" (непустых строк: %d)", b.Lines)
	}
	w("\n")
	if b.HTMLTitle != "" {
		w("Заголовок страницы: «%s»\n", b.HTMLTitle)
	}
	for _, k := range b.Keys {
		w("Структура: %s\n", k)
	}
	if b.Servers > 0 {
		w("Серверов: %d, из них Waysplit запустит: %d\n", b.Servers, b.Usable)
		for _, k := range b.Kinds {
			w("  %s — %d", k.Name, k.Count)
			switch {
			case k.Note != "":
				w(" (%s)", k.Note)
			case k.Core == "xray":
				w(" (через Xray)")
			}
			w("\n")
		}
	} else if b.Format != "empty" && b.Format != "html" {
		w("Серверов: 0\n")
	}
	if len(b.Stubs) > 0 {
		w("Заглушка вместо серверов (адрес 0.0.0.0 или порт 1 — никуда не ведёт), имя: «%s»\n", strings.Join(b.Stubs, "», «"))
	}
	if len(b.Skipped) > 0 {
		w("Не стали серверами:\n")
		for _, k := range b.Skipped {
			w("  %s — %d\n", k.Name, k.Count)
		}
	}
	if b.Happ > 0 {
		w("Ссылок happ://: %d, из них зашифрованных happ://crypt…: %d\n", b.Happ, b.HappCrypt)
	}
}

// headerSet — заголовки для сравнения способов между собой (без date: он всегда разный).
type headerSet []Header

func (a headerSet) equal(b headerSet) bool {
	strip := func(x headerSet) []Header {
		var out []Header
		for _, h := range x {
			if h.Name != "date" {
				out = append(out, h)
			}
		}
		return out
	}
	x, y := strip(a), strip(b)
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

func fmtSize(n int) string {
	switch {
	case n >= 1<<20:
		return comma(float64(n)/(1<<20)) + " МБ"
	case n >= 1024:
		return comma(float64(n)/1024) + " КБ"
	}
	return fmt.Sprintf("%d байт", n)
}
