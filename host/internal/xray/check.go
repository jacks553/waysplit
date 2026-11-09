package xray

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"waysplit/host/internal/corebin"
	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/singbox"
)

// Engine — как запускать Xray (процессом управляет singbox.Core, как и sing-box). Конфиг до
// запуска проверяет Validate.
var Engine = &singbox.Engine{
	Name: "Xray", ConfigFile: "xray.json", LogFile: "xray.log", PIDFile: "xray.pid",
	RunArgs: func(config, _ string) []string { return []string{"run", "-c", config} },
}

// FindBinary ищет xray.exe рядом с компаньоном; для отладки путь можно задать переменной
// окружения WAYSPLIT_XRAY.
func FindBinary() (string, error) {
	if p := corebin.Find("WAYSPLIT_XRAY", "xray.exe"); p != "" {
		return p, nil
	}
	return "", &singbox.Error{Code: "XRAY_NOT_FOUND", Message: "Xray не найден рядом с waysplit-host.exe (он нужен для серверов XHTTP): установите компаньон заново («Установить.cmd»)"}
}

// «2026/11/07 19:30:00.123456 [Warning] » в начале строки журнала Xray.
var stampRe = regexp.MustCompile(`(?m)^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? (?:\[\w+\] )?`)

// clean — вывод Xray без цветов, времени, строк с версией и без секретов.
func clean(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return corebin.Clean(trimBanner(stampRe.ReplaceAllString(s, "")))
}

// Check проверяет файл конфига командой `xray run -test`. Вывод без секретов: пустой — всё
// хорошо; непустой при успехе — предупреждения (например, об устаревшем транспорте).
func Check(bin, path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "run", "-test", "-c", path)
	corebin.HideWindow(cmd)
	out, err := cmd.CombinedOutput()
	text := clean(string(out))
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return "", &singbox.Error{Code: "XRAY_FAILED", Message: "не удалось запустить Xray: " + hostlog.Mask(err.Error())}
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return text, &singbox.Error{Code: "CONFIG_INVALID", Message: "проверка конфига Xray не ответила за 30 секунд"}
		}
		if text == "" {
			text = err.Error()
		}
		return text, &singbox.Error{Code: "CONFIG_INVALID", Message: "Xray не принял конфиг: " + reason(text), Detail: text}
	}
	return text, nil
}

// reason — самое понятное место ошибки Xray: последняя часть цепочки «… > … > причина».
func reason(text string) string {
	line := ""
	for _, l := range strings.Split(text, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			line = l
			if strings.Contains(strings.ToLower(l), "failed") {
				break
			}
		}
	}
	if i := strings.LastIndex(line, " > "); i >= 0 {
		line = strings.TrimSpace(line[i+3:])
	}
	return line
}

// Version — версия из `xray version` (например, «26.10.31»). Запоминается, пока файл ядра не
// изменился (corebin.Version).
func Version(bin string) (string, error) {
	v, err := corebin.Version(bin, func(out string) (string, bool) {
		f := strings.Fields(out)
		if len(f) >= 2 && f[0] == "Xray" {
			return f[1], true
		}
		return "", false
	})
	switch {
	case errors.Is(err, corebin.ErrUnclear):
		return "", &singbox.Error{Code: "XRAY_FAILED", Message: "Xray ответил непонятно на «version»"}
	case err != nil:
		return "", &singbox.Error{Code: "XRAY_FAILED", Message: "не удалось запустить Xray: " + err.Error()}
	}
	return v, nil
}

// Validate собирает конфиг и проверяет его Xray. Не прошёл общий — серверы, которые Xray не
// принимает, ищутся делением пополам (corebin.FindBad) и исключаются (одна ссылка не должна
// ломать остальные), как у sing-box.
func Validate(bin, dir string, entries []singbox.Entry, level string) (*Built, error) {
	b, err := Build(entries, level)
	if err != nil {
		return b, err
	}
	if err = checkConfig(bin, dir, b.Config); err == nil {
		return b, nil
	}
	if e, ok := err.(*singbox.Error); !ok || e.Code != "CONFIG_INVALID" {
		return b, err
	}
	hostlog.Printf("общий конфиг Xray не прошёл проверку (%v), ищу серверы, которые Xray не принимает", err)
	var built []singbox.Entry
	for _, e := range entries {
		if _, ok := b.Ports[e.ID]; ok {
			built = append(built, e)
		}
	}
	good, bad, badErrs := corebin.FindBad(built, func(part []singbox.Entry) error {
		pb, err := Build(part, level)
		if err != nil {
			return err
		}
		return checkConfig(bin, dir, pb.Config)
	})
	errs := b.Errors
	for i, e := range bad {
		errs = append(errs, singbox.EntryError{ID: e.ID, Message: badErrs[i].Error()})
	}
	nb, err := Build(good, level)
	nb.Errors = append(errs, nb.Errors...)
	if err != nil {
		return nb, err
	}
	return nb, checkConfig(bin, dir, nb.Config)
}

// checkConfig пишет конфиг во временный файл (в нём секреты — сразу удаляем) и проверяет.
func checkConfig(bin, dir string, c *Config) error {
	data, err := c.JSON()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "xray-check-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	_, err = runCheck(bin, f.Name())
	return err
}

// runCheck — проверка ядром; тесты подменяют её, чтобы проверить Validate без Xray.
var runCheck = Check
