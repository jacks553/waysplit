package singbox

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"waysplit/host/internal/corebin"
	"waysplit/host/internal/hostlog"
)

// DataDir — папка данных компаньона: %LOCALAPPDATA%\Waysplit.
func DataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserCacheDir()
	}
	return filepath.Join(base, "Waysplit")
}

// FindBinary ищет sing-box.exe рядом с компаньоном; для отладки путь можно задать
// переменной окружения WAYSPLIT_SINGBOX.
func FindBinary() (string, error) {
	if p := corebin.Find("WAYSPLIT_SINGBOX", "sing-box.exe"); p != "" {
		return p, nil
	}
	return "", &Error{Code: "SINGBOX_NOT_FOUND", Message: "sing-box не найден рядом с waysplit-host.exe: установите компаньон заново («Установить.cmd»)"}
}

// Check проверяет файл конфига командой `sing-box check`. Возвращает вывод ядра
// без цветов и секретов: пустой — всё хорошо; непустой при успехе — предупреждения.
func Check(bin, path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "check", "--disable-color", "-c", path)
	corebin.HideWindow(cmd)
	out, err := cmd.CombinedOutput()
	text := corebin.Clean(string(out))
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			// Ядро даже не запустилось: нет файла или его заблокировал антивирус.
			return "", &Error{Code: "SINGBOX_FAILED", Message: "не удалось запустить sing-box: " + hostlog.Mask(err.Error())}
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return text, &Error{Code: "CONFIG_INVALID", Message: "sing-box check не ответил за 30 секунд"}
		}
		if text == "" {
			text = err.Error()
		}
		return text, &Error{Code: "CONFIG_INVALID", Message: "sing-box не принял конфиг: " + firstLine(text), Detail: text}
	}
	return text, nil
}

// Validate собирает конфиг и проверяет его ядром. Все серверы живут в одном конфиге,
// поэтому если ядро не приняло общий конфиг, не прошедшие серверы ищутся делением пополам
// (corebin.FindBad) и выкидываются: одна плохая ссылка не должна ломать остальные.
func Validate(bin, dir string, entries []Entry, logLevel string) (*Built, error) {
	b, err := Build(entries, logLevel)
	if err != nil {
		return b, err
	}
	_, err = checkConfig(bin, dir, b.Config)
	if err == nil {
		return b, nil
	}
	if e, ok := err.(*Error); !ok || e.Code != "CONFIG_INVALID" {
		return b, err // дело не в серверах: ядро не запускается или не пишется файл
	}
	hostlog.Printf("общий конфиг не прошёл check (%v), ищу серверы, которые ядро не принимает", err)
	var built []Entry
	for _, e := range entries {
		if _, ok := b.Ports[e.ID]; ok {
			built = append(built, e)
		}
	}
	good, bad, badErrs := corebin.FindBad(built, func(part []Entry) error {
		pb, err := Build(part, logLevel)
		if err != nil {
			return err
		}
		_, err = checkConfig(bin, dir, pb.Config)
		return err
	})
	errs := b.Errors
	for i, e := range bad {
		errs = append(errs, EntryError{ID: e.ID, Message: badErrs[i].Error()})
	}
	nb, err := Build(good, logLevel)
	nb.Errors = append(errs, nb.Errors...)
	if err != nil {
		return nb, err
	}
	_, err = checkConfig(bin, dir, nb.Config)
	return nb, err
}

// checkConfig пишет конфиг во временный файл (в нём секреты — сразу удаляем) и проверяет.
func checkConfig(bin, dir string, c *Config) (string, error) {
	data, err := c.JSON()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, "check-*.json")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	return runCheck(bin, f.Name())
}

// runCheck — проверка ядром; тесты подменяют её, чтобы проверить Validate без sing-box.
var runCheck = Check

// writeAtomic записывает файл через временный и переименование: ядро никогда
// не увидит наполовину записанный конфиг.
func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

var levelRe = regexp.MustCompile(`^(?:[-+:.\d ]+)?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)\[\d+\]\s*`)

// firstLine — первая непустая строка без «FATAL[0000]» в начале.
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(levelRe.ReplaceAllString(strings.TrimSpace(l), "")); l != "" {
			return l
		}
	}
	return ""
}

// Version — версия ядра из `sing-box version` (например, «1.14.4»). Запоминается, пока файл
// ядра не изменился (corebin.Version).
func Version(bin string) (string, error) {
	v, err := corebin.Version(bin, func(out string) (string, bool) {
		first, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
		v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(first), "sing-box version"))
		return v, v != "" && v != strings.TrimSpace(first)
	})
	if err != nil {
		return "", &Error{Code: "SINGBOX_FAILED", Message: "не удалось запустить sing-box: " + err.Error()}
	}
	return v, nil
}
