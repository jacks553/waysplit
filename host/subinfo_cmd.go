package main

// Команда subinfo (SPEC-SUBS.md, шаг 1): скачать подписку разными способами и показать отчёт
// без секретов. Адрес — в файле (как links.local.txt) или прямо в командной строке.

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"waysplit/host/internal/device"
	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/singbox"
	"waysplit/host/internal/subinfo"
)

func cmdSubinfo(args []string) error {
	fs := flag.NewFlagSet("subinfo", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	withDevice := fs.Bool("device", false, "ещё раз с заголовками устройства (x-hwid)")
	proxyPort := fs.Int("proxy", 0, "через локальный прокси 127.0.0.1:N (порт сервера в работающем ядре)")
	// Параметры можно писать и после файла: «subinfo файл -device».
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			pos = append(pos, a)
			continue
		}
		flags = append(flags, a)
		if (a == "-proxy" || a == "--proxy") && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	if err := fs.Parse(flags); err != nil {
		return errors.New("неверные параметры команды subinfo")
	}
	if len(pos) != 1 {
		return errors.New("укажите файл с адресом подписки или сам адрес: subinfo [-device] [-proxy N] файл|адрес")
	}
	rawURL, err := subscriptionFrom(pos[0])
	if err != nil {
		return err
	}
	subinfo.HideURL(rawURL)

	o := subinfo.Options{Timeout: 20 * time.Second}
	if *proxyPort > 0 {
		o.Proxy = &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(*proxyPort)}
	}
	if *withDevice {
		dev, created, err := device.Load(singbox.DataDir())
		if err != nil {
			return err
		}
		o.Device = dev
		if created {
			fmt.Printf("Создан идентификатор устройства %s (файл %s в папке данных).\n", dev.Short(), device.File)
		}
	}
	n := len(subinfo.Clients)
	if o.Device != nil {
		n *= 2
	}
	fmt.Printf("Скачиваю подписку %d способами, подождите до минуты…\n\n", n)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	results := subinfo.Run(ctx, rawURL, o)
	hostlog.Printf("subinfo: способов %d, с устройством: %v, через прокси: %v", len(results), o.Device != nil, o.Proxy != nil)
	fmt.Print(subinfo.Report(results, o))
	return nil
}

// subscriptionFrom — адрес подписки из аргумента: сам адрес или файл, где он записан
// (первая строка http(s)://…; строки с # — комментарии).
func subscriptionFrom(arg string) (string, error) {
	if links.IsSubscriptionURL(arg) {
		return strings.TrimSpace(arg), nil
	}
	b, err := os.ReadFile(arg)
	if err != nil {
		return "", fmt.Errorf("не удалось открыть файл «%s»", arg)
	}
	for _, line := range strings.Split(decodeText(b), "\n") {
		if l := strings.TrimSpace(line); links.IsSubscriptionURL(l) {
			return l, nil
		}
	}
	return "", fmt.Errorf("в файле «%s» нет адреса подписки http(s)://…", arg)
}
