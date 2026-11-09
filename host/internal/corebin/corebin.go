// Package corebin — то, что одинаково у программ ядер (sing-box, Xray): поиск файла, запуск
// без окна, версия с запоминанием, очистка вывода, поиск серверов, которые ядро не принимает.
// Раньше это жило копиями в пакетах singbox и xray.
package corebin

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"waysplit/host/internal/hostlog"
)

// Find ищет программу ядра: путь из переменной окружения envVar (для отладки) или файл name
// рядом с компаньоном. Возвращает полный путь; "" — не нашлось.
func Find(envVar, name string) string {
	var tried []string
	if p := os.Getenv(envVar); p != "" {
		tried = append(tried, p)
	}
	if exe, err := os.Executable(); err == nil {
		tried = append(tried, filepath.Join(filepath.Dir(exe), name))
	}
	for _, p := range tried {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			if abs, err := filepath.Abs(p); err == nil {
				return abs
			}
		}
	}
	return ""
}

// ErrUnclear — программа ответила на «version» не так, как ждали.
var ErrUnclear = errors.New("непонятный ответ на «version»")

type versionInfo struct {
	size    int64
	mod     time.Time
	version string
}

var (
	versionMu    sync.Mutex
	versionCache = map[string]versionInfo{}
)

// Version — версия из «bin version» (parse достаёт номер из вывода). Ответ запоминается: пока
// у файла те же размер и время изменения, программа второй раз не запускается (замер: запуск
// sing-box только ради версии — ~65 мс, Xray — ~40 мс). Файл заменили (обновили ядро) —
// версия узнаётся заново.
func Version(bin string, parse func(out string) (string, bool)) (string, error) {
	fi, err := os.Stat(bin)
	if err != nil {
		return "", err
	}
	versionMu.Lock()
	v, ok := versionCache[bin]
	versionMu.Unlock()
	if ok && v.size == fi.Size() && v.mod.Equal(fi.ModTime()) {
		return v.version, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "version")
	HideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New(hostlog.Mask(err.Error()))
	}
	version, ok := parse(string(out))
	if !ok {
		return "", ErrUnclear
	}
	versionMu.Lock()
	versionCache[bin] = versionInfo{fi.Size(), fi.ModTime(), version}
	versionMu.Unlock()
	return version, nil
}

var (
	ansiRe   = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	newlines = strings.NewReplacer("\r\n", "\n", "\r", "\n")
)

// Clean — вывод ядра без цветов, с одним видом переводов строк и без секретов.
func Clean(s string) string {
	return strings.TrimSpace(hostlog.Mask(ansiRe.ReplaceAllString(newlines.Replace(s), "")))
}

// FindBad — какие элементы не проходят проверку check (она запускает ядро, поэтому проверок
// должно быть мало). Вызывается, когда все вместе проверку уже не прошли. Делит пополам:
// прошедшая половина целиком хорошая, в непрошедшей ищем дальше; если в левой половине плохих
// не нашлось, правая точно плохая — её целиком не проверяем, сразу делим. Каждый плохой
// проверяется и поодиночке: у него своя, понятная ошибка. Хорошие — в исходном порядке.
// Для 199 серверов с одним плохим — около 15 проверок вместо 199 по одному.
func FindBad[T any](items []T, check func([]T) error) (good, bad []T, errs []error) {
	var walk func(part []T, knownBad bool)
	walk = func(part []T, knownBad bool) {
		if len(part) == 0 {
			return
		}
		if len(part) == 1 {
			if err := check(part); err != nil {
				bad = append(bad, part[0])
				errs = append(errs, err)
			} else {
				good = append(good, part[0])
			}
			return
		}
		if !knownBad && check(part) == nil {
			good = append(good, part...)
			return
		}
		mid := len(part) / 2
		before := len(bad)
		walk(part[:mid], false)
		walk(part[mid:], len(bad) == before)
	}
	walk(items, true)
	return good, bad, errs
}
