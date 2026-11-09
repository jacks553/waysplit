package main

// Отладочные команды этапа 1: parse, config, try. Ссылки — из links.local.txt
// (файл в .gitignore), чтобы не воевать в терминале с кавычками и «&».

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/singbox"
	"waysplit/host/internal/subinfo"
	"waysplit/host/internal/xray"
)

const linksFile = "links.local.txt"

type opts struct {
	file    string
	ua      string
	port    int
	show    bool
	seconds int
	device  bool // подписки — с заголовками устройства (x-hwid…)
}

func parseFlags(name string, args []string) (*opts, error) {
	o := &opts{}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&o.file, "f", "", "файл со ссылками")
	fs.StringVar(&o.ua, "ua", links.DefaultUserAgent, "User-Agent для подписок")
	fs.IntVar(&o.port, "port", 27101, "первый локальный порт")
	fs.BoolVar(&o.show, "show", false, "показать конфиг")
	fs.IntVar(&o.seconds, "seconds", 0, "остановить через N секунд")
	fs.BoolVar(&o.device, "device", false, "подписки — с идентификатором устройства")
	if err := fs.Parse(args); err != nil {
		return nil, errors.New("неверные параметры команды " + name)
	}
	if o.port < 1024 || o.port > 65000 {
		return nil, fmt.Errorf("неверный порт %d: нужен от 1024 до 65000", o.port)
	}
	return o, nil
}

// item — сервер и откуда он взят («строка 3», «подписка «Имя», строка 12»).
type item struct {
	srv   *links.Server
	where string
	warns []string
	core  string // sing-box | xray
}

type skip struct {
	where, text, reason string
	line                int // для порядка внутри одного источника
}

type loaded struct {
	items   []item
	skipped []skip
}

// loadLinks читает файл ссылок, скачивает подписки из него и отбрасывает то,
// что sing-box не поддерживает (с причиной).
func loadLinks(o *opts) (*loaded, error) {
	path, err := findLinksFile(o.file)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	fmt.Printf("Ссылки из файла: %s\n", path)
	ld := &loaded{}
	seen := map[string]string{}
	add := func(r *links.TextResult, label string) {
		var skipped []skip
		for _, e := range r.Errors {
			skipped = append(skipped, skip{fmt.Sprintf("%sстрока %d", label, e.Line), e.Text, e.Reason, e.Line})
		}
		for _, s := range r.Servers {
			where := fmt.Sprintf("%sстрока %d", label, s.Line)
			if first, dup := seen[s.Key()]; dup {
				skipped = append(skipped, skip{where, links.Preview(s.Link), "такой сервер уже есть (" + first + ")", s.Line})
				continue
			}
			core, warns, err := xray.Pick(s)
			if err != nil {
				skipped = append(skipped, skip{where, links.Preview(s.Link), err.Error(), s.Line})
				continue
			}
			seen[s.Key()] = where
			ld.items = append(ld.items, item{srv: s, where: where, warns: append(append([]string{}, s.Warnings...), warns...), core: core})
		}
		sort.SliceStable(skipped, func(i, j int) bool { return skipped[i].line < skipped[j].line })
		ld.skipped = append(ld.skipped, skipped...)
	}
	res := links.ParseText(decodeText(raw))
	add(res, "")
	for i, u := range res.Subscriptions {
		subinfo.HideURL(u)
		fmt.Println("Скачиваю подписку (адрес скрыт)")
		// Как в расширении: без идентификатора устройства, а если без него серверов нет —
		// с ним (fetchSub); -device — сразу с ним.
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		sub, used, err := fetchSub(ctx, u, o.ua, nil, o.device)
		cancel()
		if err != nil {
			ld.skipped = append(ld.skipped, skip{"подписка", "(адрес скрыт)", err.Error(), 0})
			continue
		}
		title := sub.Title
		if title == "" {
			title = fmt.Sprintf("№%d", i+1)
		}
		if used {
			fmt.Println("  подписка привязана к этому компьютеру как устройство (идентификатор отправлялся)")
		}
		if sub.Announce != "" {
			fmt.Printf("  сообщение провайдера: %s\n", sub.Announce)
		}
		if sub.Format != "" {
			fmt.Printf("  формат: %s (серверы переведены в ссылки)\n", links.FormatName(sub.Format))
		}
		fmt.Printf("  «%s»: серверов %d, нераспознанных строк %d", title, len(sub.Servers), len(sub.Errors))
		if inf := sub.Info; inf != nil {
			if inf.Total > 0 {
				fmt.Printf("; трафик %s из %s", fmtBytes(inf.Upload+inf.Download), fmtBytes(inf.Total))
			}
			if inf.Expire > 0 {
				fmt.Printf("; действует до %s", time.Unix(inf.Expire, 0).Format("02.01.2006"))
			}
		}
		if sub.UpdateIntervalHours > 0 {
			fmt.Printf("; обновлять раз в %d ч", sub.UpdateIntervalHours)
		}
		fmt.Println()
		add(sub.TextResult, "подписка «"+title+"», ")
	}
	return ld, nil
}

func cmdParse(args []string) error {
	o, err := parseFlags("parse", args)
	if err != nil {
		return err
	}
	ld, err := loadLinks(o)
	if err != nil {
		return err
	}
	fmt.Printf("\nСерверы, которые можно запустить (%d):\n", len(ld.items))
	for i, it := range ld.items {
		s := it.srv
		fmt.Printf("%4d. %s · %s · %s · %s · %s%s\n", i+1, protoName(s.Protocol), s.Security, s.Transport, s.HostPort(), s.Name, coreMark(it.core))
		for _, w := range it.warns {
			fmt.Printf("      ! %s\n", w)
		}
	}
	printSkipped(ld.skipped)
	fmt.Printf("\nИтог: можно добавить %d, пропущено %d.\n", len(ld.items), len(ld.skipped))
	if len(ld.items) == 0 {
		return errors.New("нет ни одного сервера, который можно запустить")
	}
	return nil
}

func coreMark(core string) string {
	if core == "xray" {
		return " [Xray]"
	}
	return ""
}

func cmdConfig(args []string) error {
	o, err := parseFlags("config", args)
	if err != nil {
		return err
	}
	pr, err := prepare(o)
	if err != nil {
		return err
	}
	var shown []string
	for _, c := range pr.configs() {
		path := filepath.Join(singbox.DataDir(), c.engine.ConfigFile)
		if err := os.WriteFile(path, c.data, 0o600); err != nil {
			return err
		}
		fmt.Printf("Конфиг %s записан и проверен ядром (%s): %s\n", c.engine.Name, c.bin, path)
		shown = append(shown, c.engine.Name+":\n"+hostlog.Mask(string(c.data)))
	}
	pr.printPorts()
	if o.show {
		fmt.Println("\nКонфиги (uuid и пароли скрыты):")
		fmt.Println(strings.Join(shown, "\n"))
	}
	return nil
}

func cmdTry(args []string) error {
	o, err := parseFlags("try", args)
	if err != nil {
		return err
	}
	pr, err := prepare(o)
	if err != nil {
		return err
	}
	var cores []*singbox.Core
	defer func() {
		for _, c := range cores {
			c.Close()
		}
	}()
	for _, c := range pr.configs() {
		core := &singbox.Core{Bin: c.bin, DataDir: singbox.DataDir(), Engine: c.engine}
		fmt.Printf("\nЗапускаю %s…\n", c.engine.Name)
		if err := core.StartData(c.data, c.ports); err != nil {
			var se *singbox.Error
			if errors.As(err, &se) && se.Detail != "" {
				fmt.Printf("Последние строки %s:\n%s\n", c.engine.LogFile, se.Detail)
			}
			return err
		}
		cores = append(cores, core)
		fmt.Printf("%s работает (PID %d).\n", c.engine.Name, core.Status().PID)
	}
	fmt.Println("Проверяю серверы через их порты…")

	type row struct {
		it        item
		id        string
		port      int
		ms        int
		ip, error string
	}
	var rows []row
	for i, it := range pr.ld.items {
		id := entryID(i)
		if p, ok := pr.port(id); ok {
			rows = append(rows, row{it: it, id: id, port: p})
		}
	}
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i := range rows {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			r := &rows[i]
			t := singbox.Target{ID: r.id, Port: r.port, Protocol: r.it.srv.Protocol}
			ms, err := singbox.Ping(context.Background(), t, singbox.PingURL, singbox.PingTimeout)
			if err != nil {
				r.error = err.Error()
				return
			}
			r.ms = ms
			if r.ip, err = singbox.ExitIP(context.Background(), t, 10*time.Second); err != nil {
				r.error = err.Error()
			}
		}()
	}
	wg.Wait()

	fmt.Printf("\n%-6s  %-8s  %-16s  %s\n", "Порт", "Пинг", "IP через сервер", "Сервер")
	firstOK := 0
	for _, r := range rows {
		ping, ip := "—", "—"
		if r.ms > 0 {
			ping = fmt.Sprintf("%d мс", r.ms)
		}
		if r.ip != "" {
			ip = r.ip
			if firstOK == 0 {
				firstOK = r.port
			}
		}
		line := fmt.Sprintf("%-6d  %-8s  %-16s  %s%s", r.port, ping, ip, r.it.srv.Name, coreMark(r.it.core))
		if r.error != "" {
			line += " — " + r.error
		}
		fmt.Println(line)
	}
	if firstOK == 0 {
		fmt.Println("\nНи один сервер не ответил. Прокси всё равно запущены — можно проверить вручную.")
		firstOK = rows[0].port
	}
	fmt.Printf("\nПроверьте в другом окне PowerShell:\n  curl.exe -x socks5h://127.0.0.1:%d https://api.ipify.org\n", firstOK)
	fmt.Println("Должен показаться IP сервера из таблицы, а не ваш обычный.")

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	enter := make(chan struct{})
	go func() {
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err == nil {
			close(enter)
		}
	}()
	var timeout <-chan time.Time
	if o.seconds > 0 {
		timeout = time.After(time.Duration(o.seconds) * time.Second)
		fmt.Printf("Остановлюсь сам через %d с.\n", o.seconds)
	} else {
		fmt.Println("Чтобы остановить, нажмите Enter (или Ctrl+C).")
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-stop:
		case <-enter:
		case <-timeout:
		case <-tick.C:
			for _, c := range cores {
				if st := c.Status(); !st.Running {
					return errors.New(st.LastError)
				}
			}
			continue
		}
		break
	}
	for _, c := range cores {
		c.Close()
	}
	cores = nil
	fmt.Println("Ядра остановлены.")
	return nil
}

func entryID(i int) string { return fmt.Sprintf("s_%02d", i+1) }

// prepared — серверы, разделённые между ядрами, и проверенные конфиги.
type prepared struct {
	ld          *loaded
	sb          *singbox.Built // nil — серверов sing-box нет
	xb          *xray.Built    // nil — серверов Xray нет (или нет xray.exe)
	sbBin, xBin string
}

type coreConfig struct {
	engine *singbox.Engine
	bin    string
	data   []byte
	ports  []int
}

// configs — конфиги ядер, которые надо запустить.
func (p *prepared) configs() []coreConfig {
	var out []coreConfig
	if p.sb != nil && len(p.sb.Ports) > 0 {
		data, _ := p.sb.Config.JSON()
		var ports []int
		for _, in := range p.sb.Config.Inbounds {
			ports = append(ports, in.ListenPort)
		}
		out = append(out, coreConfig{singbox.SingBox, p.sbBin, data, ports})
	}
	if p.xb != nil && len(p.xb.Ports) > 0 {
		data, _ := p.xb.Config.JSON()
		out = append(out, coreConfig{xray.Engine, p.xBin, data, p.xb.Config.PortsOf()})
	}
	return out
}

func (p *prepared) port(id string) (int, bool) {
	if p.sb != nil {
		if port, ok := p.sb.Ports[id]; ok {
			return port, true
		}
	}
	if p.xb != nil {
		if port, ok := p.xb.Ports[id]; ok {
			return port, true
		}
	}
	return 0, false
}

// prepare: ссылки → серверы sing-box и Xray → конфиги → проверка каждым ядром. Общая часть config и try.
func prepare(o *opts) (*prepared, error) {
	ld, err := loadLinks(o)
	if err != nil {
		return nil, err
	}
	if len(ld.skipped) > 0 {
		printSkipped(ld.skipped)
	}
	if len(ld.items) == 0 {
		return nil, errors.New("нет ни одного сервера, который можно запустить")
	}
	pr := &prepared{ld: ld}
	var sbList, xrList []singbox.Entry
	for i, it := range ld.items {
		if o.port+i > 65535 {
			break
		}
		e := singbox.Entry{ID: entryID(i), Link: it.srv.Link, LocalPort: o.port + i}
		if it.core == "xray" {
			xrList = append(xrList, e)
		} else {
			sbList = append(sbList, e)
		}
	}
	report := func(errs []singbox.EntryError) {
		for _, e := range errs {
			fmt.Printf("Сервер %s не вошёл в конфиг: %s\n", e.ID, e.Message)
		}
	}
	if len(sbList) > 0 {
		if pr.sbBin, err = singbox.FindBinary(); err != nil {
			return nil, err
		}
		ver, err := singbox.Version(pr.sbBin)
		if err != nil {
			return nil, err
		}
		fmt.Printf("sing-box %s: %s\n", ver, pr.sbBin)
		pr.sb, err = singbox.Validate(pr.sbBin, singbox.DataDir(), sbList, "warn")
		report(pr.sb.Errors)
		if err != nil && !isNoServers(err) {
			return nil, err
		}
	}
	if len(xrList) > 0 {
		if pr.xBin, err = xray.FindBinary(); err != nil {
			fmt.Printf("Серверы Xray (%d) пропущены: %v\n", len(xrList), err)
		} else {
			ver, err := xray.Version(pr.xBin)
			if err != nil {
				return nil, err
			}
			fmt.Printf("Xray %s: %s\n", ver, pr.xBin)
			pr.xb, err = xray.Validate(pr.xBin, singbox.DataDir(), xrList, "warn")
			report(pr.xb.Errors)
			if err != nil && !isNoServers(err) {
				return nil, err
			}
		}
	}
	if len(pr.configs()) == 0 {
		return nil, errors.New("нет ни одного сервера, который можно запустить")
	}
	return pr, nil
}

func (p *prepared) printPorts() {
	fmt.Printf("\n%-6s  %-8s  %s\n", "Порт", "Протокол", "Сервер")
	for i, it := range p.ld.items {
		if port, ok := p.port(entryID(i)); ok {
			fmt.Printf("%-6d  %-8s  %s (%s)%s\n", port, protoName(it.srv.Protocol), it.srv.Name, it.srv.HostPort(), coreMark(it.core))
		}
	}
}

func printSkipped(list []skip) {
	if len(list) == 0 {
		return
	}
	fmt.Printf("\nПропущено (%d):\n", len(list))
	for _, s := range list {
		where := s.where
		if where != "" {
			where += ": "
		}
		fmt.Printf("  • %s%s\n      %s\n", where, s.text, s.reason)
	}
}

func protoName(p string) string {
	if p == "hysteria2" {
		return "HY2"
	}
	return strings.ToUpper(p)
}

func fmtBytes(n int64) string {
	const gb = 1 << 30
	if n >= gb {
		return strings.Replace(fmt.Sprintf("%.1f ГБ", float64(n)/gb), ".", ",", 1)
	}
	return fmt.Sprintf("%d МБ", n>>20)
}

// findLinksFile: links.local.txt в текущей папке, рядом с программой или в папке проекта
// (программа лежит в host\bin, проект — двумя уровнями выше).
func findLinksFile(explicit string) (string, error) {
	if explicit != "" {
		if _, err := os.Stat(explicit); err != nil {
			return "", fmt.Errorf("файл %s не найден", explicit)
		}
		return filepath.Abs(explicit)
	}
	var cands []string
	if wd, err := os.Getwd(); err == nil {
		cands = append(cands, filepath.Join(wd, linksFile))
	}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		cands = append(cands, filepath.Join(d, linksFile), filepath.Join(d, "..", linksFile), filepath.Join(d, "..", "..", linksFile))
	}
	for _, c := range cands {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return filepath.Clean(c), nil
		}
	}
	return "", fmt.Errorf("не найден файл %s. Создайте его в папке проекта и вставьте ссылку vless://… или адрес подписки — по одной на строку.\nГде искал:\n  %s",
		linksFile, strings.Join(cands, "\n  "))
}

// decodeText понимает UTF-8 (с BOM и без) и UTF-16 — так сохраняет Блокнот.
func decodeText(b []byte) string {
	if len(b) >= 2 && (b[0] == 0xFF && b[1] == 0xFE || b[0] == 0xFE && b[1] == 0xFF) {
		le := b[0] == 0xFF
		u := make([]uint16, 0, len(b)/2)
		for i := 2; i+1 < len(b); i += 2 {
			if le {
				u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
			} else {
				u = append(u, uint16(b[i])<<8|uint16(b[i+1]))
			}
		}
		return string(utf16.Decode(u))
	}
	return strings.TrimPrefix(string(b), "\ufeff")
}
