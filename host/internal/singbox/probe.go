package singbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"waysplit/host/internal/hostlog"
)

const (
	PingURL     = "https://www.gstatic.com/generate_204"
	ExitIPURL   = "https://api.ipify.org"
	PingTimeout = 5 * time.Second
	maxParallel = 8
)

// Target — сервер для проверки: id, локальный порт и протокол (для понятной ошибки).
type Target struct {
	ID       string
	Port     int
	Protocol string
}

// PingResult — время ответа в миллисекундах или ошибка.
type PingResult struct {
	ID    string `json:"id"`
	MS    int    `json:"ms,omitempty"`
	Error string `json:"error,omitempty"`
}

// Ping делает HTTP-запрос через локальный порт сервера (inbound mixed понимает и
// HTTP-прокси) и возвращает время до ответа в миллисекундах.
func Ping(ctx context.Context, t Target, target string, timeout time.Duration) (int, error) {
	start := time.Now()
	if _, err := get(ctx, t.Port, target, timeout); err != nil {
		return 0, errors.New(netError(err, t))
	}
	return int(time.Since(start).Milliseconds()), nil
}

// ExitIP — внешний IP, который видят сайты, когда идёшь через этот сервер.
func ExitIP(ctx context.Context, t Target, timeout time.Duration) (string, error) {
	body, err := get(ctx, t.Port, ExitIPURL, timeout)
	if err != nil {
		return "", errors.New(netError(err, t))
	}
	ip := strings.TrimSpace(body)
	if net.ParseIP(ip) == nil {
		return "", errors.New("api.ipify.org вернул не IP-адрес")
	}
	return ip, nil
}

// PingMany меряет серверы, не больше 8 одновременно. Порядок результатов — как у targets.
func PingMany(ctx context.Context, targets []Target, target string, timeout time.Duration) []PingResult {
	res := make([]PingResult, len(targets))
	sem := make(chan struct{}, maxParallel)
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			res[i].ID = t.ID
			if ms, err := Ping(ctx, t, target, timeout); err != nil {
				res[i].Error = err.Error()
			} else {
				res[i].MS = ms
			}
		}()
	}
	wg.Wait()
	return res
}

// get — GET через локальный порт; новое соединение на каждый запрос, без кэша.
func get(ctx context.Context, port int, target string, timeout time.Duration) (string, error) {
	proxy := &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)}
	tr := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("ответ %s", resp.Status)
	}
	return string(body), nil
}

// netError — понятная причина, почему сервер не ответил. Подробности — в журнал.
func netError(err error, t Target) string {
	hostlog.Printf("проверка сервера %s (порт %d): %v", t.ID, t.Port, err)
	if strings.Contains(err.Error(), "dial tcp 127.0.0.1:") {
		return fmt.Sprintf("ядро не слушает порт %d", t.Port) // не достучались до самого sing-box
	}
	if t.Protocol == "hysteria2" {
		return "Сервер не отвечает (возможно, заблокирован UDP)"
	}
	return "Сервер не отвечает"
}
