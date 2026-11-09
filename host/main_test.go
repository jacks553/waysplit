package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"

	"waysplit/host/internal/nm"
)

// Тестовая программа умеет притворяться компаньоном, которого запустил Chrome.
func TestMain(m *testing.M) {
	if os.Getenv("WAYSPLIT_TEST_NM") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// ID в компаньоне должен совпадать с ключом в manifest.json, иначе Chrome не пустит расширение к компаньону.
func TestExtensionIDMatchesManifest(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "extension", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct{ Key string }
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	der, err := base64.StdEncoding.DecodeString(m.Key)
	if err != nil || len(der) == 0 {
		t.Fatalf("поле key в manifest.json: %v", err)
	}
	sum := sha256.Sum256(der)
	id := []byte(hex.EncodeToString(sum[:16]))
	for i, c := range id {
		if c <= '9' {
			id[i] = 'a' + c - '0'
		} else {
			id[i] = 'a' + 10 + c - 'a'
		}
	}
	if string(id) != extensionID {
		t.Fatalf("ID по ключу из manifest.json %s, а в host/extid.go %s — выполните go run ./genkey в tools", id, extensionID)
	}
}

func TestInstallUninstall(t *testing.T) {
	base := fmt.Sprintf(`Software\Waysplit-test-%d`, os.Getpid())
	key := base + `\NativeMessagingHosts\` + hostName
	t.Cleanup(func() {
		registry.DeleteKey(registry.CURRENT_USER, key)
		registry.DeleteKey(registry.CURRENT_USER, base+`\NativeMessagingHosts`)
		registry.DeleteKey(registry.CURRENT_USER, base)
	})
	dir := t.TempDir()
	exe := `C:\Путь с пробелами\waysplit-host.exe`
	for _, bad := range [][]string{nil, {"abc"}, {strings.Repeat("z", 32)}} {
		if _, err := install(exe, bad, dir, key); err == nil {
			t.Errorf("с ID %q install должен отказать", bad)
		}
	}
	id := strings.Repeat("abcdefghijklmnop", 2)
	id2 := strings.Repeat("ponmlkjihgfedcba", 2)
	path, err := install(exe, []string{id, id2}, dir, key)
	if err != nil {
		t.Fatal(err)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, key, registry.QUERY_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	val, _, err := k.GetStringValue("")
	k.Close()
	if err != nil || val != path {
		t.Errorf("значение по умолчанию в реестре %q, ожидалось %q (%v)", val, path, err)
	}
	data, _ := os.ReadFile(path)
	var m hostManifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("манифест не JSON: %v\n%s", err, data)
	}
	want := hostManifest{Name: "com.waysplit.host", Description: m.Description, Path: exe, Type: "stdio", AllowedOrigins: []string{"chrome-extension://" + id + "/", "chrome-extension://" + id2 + "/"}}
	if fmt.Sprint(m) != fmt.Sprint(want) {
		t.Errorf("манифест %+v", m)
	}
	// Имя по правилам Chrome: строчные латинские буквы, цифры, «_» и точки, не в начале и не в конце, без «..».
	if !regexp.MustCompile(`^[a-z0-9_]+(\.[a-z0-9_]+)*$`).MatchString(m.Name) {
		t.Errorf("недопустимое имя %q", m.Name)
	}

	if removed, err := uninstall(dir, key, hostName); err != nil || !removed {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	if _, err := registry.OpenKey(registry.CURRENT_USER, key, registry.QUERY_VALUE); err == nil {
		t.Error("ключ реестра остался")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("манифест остался")
	}
	if removed, err := uninstall(dir, key, hostName); err != nil || removed {
		t.Errorf("повторный uninstall: %v %v", removed, err)
	}
}

// Компаньон в режиме Chrome: отвечает на hello, в stdout — только сообщения,
// закрыли stdin — выходит сам.
func TestNativeMessagingMode(t *testing.T) {
	cmd := exec.Command(os.Args[0], "chrome-extension://"+extensionID+"/", "--parent-window=0")
	cmd.Env = append(os.Environ(), "WAYSPLIT_TEST_NM=1", "LOCALAPPDATA="+t.TempDir())
	if bin, err := filepath.Abs(filepath.Join("bin", "sing-box.exe")); err == nil {
		if _, err := os.Stat(bin); err == nil {
			cmd.Env = append(cmd.Env, "WAYSPLIT_SINGBOX="+bin)
		}
	}
	stdin, _ := cmd.StdinPipe()
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	nm.Write(stdin, []byte(`{"id":1,"cmd":"hello"}`))
	nm.Write(stdin, []byte(`{"id":2,"cmd":"нет такой"}`))
	time.Sleep(1500 * time.Millisecond) // hello запускает sing-box version
	stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("компаньон завершился с ошибкой: %v", err)
		}
	case <-time.After(5 * time.Second):
		cmd.Process.Kill()
		t.Fatal("компаньон не завершился после закрытия stdin")
	}

	byID := map[int64]map[string]any{}
	for {
		data, err := nm.Read(&stdout)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("в stdout не только сообщения: %v (остаток %q)", err, stdout.String())
		}
		var r map[string]any
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatalf("сообщение не JSON: %s", data)
		}
		byID[int64(r["id"].(float64))] = r
	}
	hello := byID[1]
	if hello == nil || hello["ok"] != true {
		t.Fatalf("ответ на hello: %v", hello)
	}
	res := hello["result"].(map[string]any)
	if res["hostVersion"] != version {
		t.Errorf("hostVersion %v", res["hostVersion"])
	}
	if os.Getenv("WAYSPLIT_SINGBOX") == "" && !strings.Contains(fmt.Sprint(cmd.Env), "WAYSPLIT_SINGBOX=") {
		t.Log("sing-box.exe нет в host\\bin — версию ядра не проверяю")
	} else if !regexp.MustCompile(`^\d+\.\d+\.\d+`).MatchString(fmt.Sprint(res["singboxVersion"])) {
		t.Errorf("singboxVersion %v (%v)", res["singboxVersion"], res["singboxError"])
	}
	if e, _ := byID[2]["error"].(map[string]any); e == nil || e["code"] != "UNKNOWN_CMD" {
		t.Errorf("неизвестная команда: %v", byID[2])
	}
}

// nmClient — тест в роли Chrome: запускает компаньон в режиме native messaging
// и шлёт команды по одной.
type nmClient struct {
	t      *testing.T
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    io.Reader
	nextID int64
}

func startNM(t *testing.T) *nmClient {
	t.Helper()
	bin, _ := filepath.Abs(filepath.Join("bin", "sing-box.exe"))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("нужен sing-box.exe в host\bin")
	}
	cmd := exec.Command(os.Args[0], "chrome-extension://"+extensionID+"/", "--parent-window=0")
	xbin, _ := filepath.Abs(filepath.Join("bin", "xray.exe"))
	cmd.Env = append(os.Environ(), "WAYSPLIT_TEST_NM=1", "LOCALAPPDATA="+t.TempDir(), "WAYSPLIT_SINGBOX="+bin, "WAYSPLIT_XRAY="+xbin)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	c := &nmClient{t: t, cmd: cmd, in: in, out: out}
	t.Cleanup(func() { in.Close(); cmd.Process.Kill(); cmd.Wait() })
	return c
}

// call отправляет команду и ждёт ответ на неё: (result, код ошибки, текст ошибки).
func (c *nmClient) call(cmd string, params map[string]any) (map[string]any, string, string) {
	c.t.Helper()
	c.nextID++
	req := map[string]any{"id": c.nextID, "cmd": cmd}
	for k, v := range params {
		req[k] = v
	}
	data, _ := json.Marshal(req)
	if err := nm.Write(c.in, data); err != nil {
		c.t.Fatalf("%s: запись: %v", cmd, err)
	}
	for {
		data, err := nm.Read(c.out)
		if err != nil {
			c.t.Fatalf("%s: чтение ответа: %v", cmd, err)
		}
		var r struct {
			ID     int64          `json:"id"`
			OK     bool           `json:"ok"`
			Result map[string]any `json:"result"`
			Error  *nm.Error      `json:"error"`
		}
		if err := json.Unmarshal(data, &r); err != nil {
			c.t.Fatalf("%s: ответ не JSON: %s", cmd, data)
		}
		if r.ID != c.nextID {
			continue
		}
		if !r.OK {
			return nil, r.Error.Code, r.Error.Message
		}
		return r.Result, "", ""
	}
}

// Сценарий этапа 3 глазами расширения: разобрать ссылку, поднять ядро, тот же список —
// без перезапуска, пинг, остановка. Закрыли связь — ядра не осталось.
func TestNativeMessagingVPN(t *testing.T) {
	c := startNM(t)
	const uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	dead := "vless://" + uuid + "@127.0.0.1:9?type=tcp#Мёртвый"

	res, code, msg := c.call("parse_links", map[string]any{"text": dead + "\nvless://" + uuid + "@x.example.com:443?type=xhttp&security=tls#X\n" +
		"vless://" + uuid + "@y.example.com:443?type=xhttp&security=tls&mode=turbo#BAD\nhttps://sub.example.com/s/TOKEN"})
	if code != "" {
		t.Fatalf("parse_links: %s %s", code, msg)
	}
	servers := res["servers"].([]any)
	errs := res["errors"].([]any)
	if len(servers) != 2 || len(errs) != 1 || !strings.Contains(fmt.Sprint(errs[0]), "mode=turbo") || fmt.Sprint(res["subscriptions"]) != "[https://sub.example.com/s/TOKEN]" {
		t.Fatalf("parse_links: %v", res)
	}
	s0 := servers[0].(map[string]any)
	if s0["name"] != "Мёртвый" || s0["link"] != dead || len(fmt.Sprint(s0["key"])) != 16 || strings.Contains(fmt.Sprint(s0["key"]), uuid) || s0["core"] != "sing-box" {
		t.Errorf("сервер: %v", s0)
	}
	if s1 := servers[1].(map[string]any); s1["core"] != "xray" {
		t.Errorf("xhttp — через Xray: %v", s1)
	}

	port := freePort(t)
	list := []map[string]any{{"id": "s_a1", "link": dead, "localPort": port}}
	res, code, msg = c.call("apply", map[string]any{"servers": list, "logLevel": "warn"})
	if code != "" || res["running"] != true || res["restarted"] != true || res["servers"].(map[string]any)["s_a1"] != float64(port) {
		t.Fatalf("apply: %v %s %s", res, code, msg)
	}
	pid := int(res["pid"].(float64))
	res, _, _ = c.call("apply", map[string]any{"servers": list, "logLevel": "warn"})
	if res["restarted"] != false || int(res["pid"].(float64)) != pid {
		t.Errorf("тот же список не должен перезапускать ядро: %v", res)
	}
	res, _, _ = c.call("status", nil)
	if res["running"] != true {
		t.Errorf("status: %v", res)
	}
	res, code, _ = c.call("ping", map[string]any{"serverIds": []string{"s_a1", "нет"}, "url": "http://192.0.2.1/", "timeoutMs": 2000})
	if code != "" || fmt.Sprint(res["results"]) != "[map[error:Сервер не отвечает id:s_a1] map[error:сервер не запущен в ядре id:нет]]" {
		t.Errorf("ping: %v %s", res, code)
	}
	if _, code, msg = c.call("apply", map[string]any{"servers": []map[string]any{{"id": "bad", "link": "vless://" + uuid + "@x.example.com:443?type=xhttp&mode=turbo", "localPort": port}}}); code != "SERVER_INVALID" || !strings.Contains(msg, "mode=turbo") {
		t.Errorf("apply с неподдерживаемым сервером: %s %s", code, msg)
	}
	res, _, _ = c.call("stop", nil)
	if res["running"] != false {
		t.Errorf("stop: %v", res)
	}
	if _, code, _ = c.call("ping", map[string]any{"serverIds": []string{"s_a1"}}); code != "CORE_NOT_RUNNING" {
		t.Errorf("ping без ядра: %s", code)
	}
	res, code, _ = c.call("start", nil)
	if code != "" || res["running"] != true {
		t.Fatalf("start: %v %s", res, code)
	}
	pid = int(res["pid"].(float64))

	// Два ядра (SPEC-XRAY.md): сервер XHTTP — в Xray, а Xray запускается, только когда его
	// сервер нужен; sing-box при этом не перезапускается.
	xbin, _ := filepath.Abs(filepath.Join("bin", "xray.exe"))
	var xpid int
	if _, err := os.Stat(xbin); err == nil {
		xport := freePort(t)
		mixed := append(list, map[string]any{"id": "s_x1", "link": "vless://" + uuid + "@127.0.0.1:9?type=xhttp&path=%2Fx#XH", "localPort": xport})
		res, code, msg = c.call("apply", map[string]any{"servers": mixed, "logLevel": "warn", "need": []string{"s_a1"}})
		cores := func() map[string]any { return res["cores"].(map[string]any) }
		if code != "" || res["running"] != true || cores()["xray"].(map[string]any)["running"] == true || res["servers"].(map[string]any)["s_x1"] != nil {
			t.Fatalf("Xray не нужен — не запущен: %v %s %s", res, code, msg)
		}
		if int(res["pid"].(float64)) != pid {
			t.Errorf("sing-box перезапустился из-за сервера Xray: %v", res)
		}
		res, code, msg = c.call("apply", map[string]any{"servers": mixed, "logLevel": "warn", "need": []string{"s_a1", "s_x1"}})
		xr := cores()["xray"].(map[string]any)
		if code != "" || res["running"] != true || res["restarted"] != true || xr["running"] != true || res["servers"].(map[string]any)["s_x1"] != float64(xport) {
			t.Fatalf("Xray нужен — запущен: %v %s %s", res, code, msg)
		}
		if int(cores()["sing-box"].(map[string]any)["pid"].(float64)) != pid {
			t.Errorf("sing-box перезапустился: %v", res)
		}
		xpid = int(xr["pid"].(float64))
		res, code, _ = c.call("ping", map[string]any{"serverIds": []string{"s_x1"}, "url": "http://192.0.2.1/", "timeoutMs": 2000})
		if code != "" || !strings.Contains(fmt.Sprint(res["results"]), "id:s_x1") || strings.Contains(fmt.Sprint(res["results"]), "не запущен") {
			t.Errorf("пинг сервера Xray: %v %s", res, code)
		}
		res, _, _ = c.call("status", nil)
		if res["running"] != true || cores()["xray"].(map[string]any)["running"] != true {
			t.Errorf("status с двумя ядрами: %v", res)
		}
		res, _, _ = c.call("logs", map[string]any{"lines": 20})
		if !strings.Contains(fmt.Sprint(res["xray"]), "started") {
			t.Errorf("журнал Xray: %v", res["xray"])
		}
	} else {
		t.Log("нет xray.exe — часть с двумя ядрами пропущена")
	}

	c.in.Close() // Chrome закрыл порт
	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("компаньон не завершился после закрытия stdin")
	}
	time.Sleep(300 * time.Millisecond)
	for name, p := range map[string]int{"sing-box": pid, "Xray": xpid} {
		if p == 0 {
			continue
		}
		if proc, err := os.FindProcess(p); err == nil {
			if err := proc.Signal(os.Kill); err == nil {
				t.Errorf("%s (PID %d) остался работать после выхода компаньона", name, p)
			}
		}
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// fetch_subscription, logs, exit_ip глазами расширения.
func TestNativeMessagingSubscription(t *testing.T) {
	const uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	body := "vless://" + uuid + "@nl.example.com:443?security=tls&type=ws#NL\n" +
		"vless://" + uuid + "@eu.example.com:443?security=tls&type=xhttp#EU%20%7C%20LTE\n" +
		"hy2://secret@hy.example.com:443#HY\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.UserAgent() != "v2rayN/7.0" {
			w.Write([]byte("<html>Панель</html>"))
			return
		}
		w.Header().Set("Subscription-Userinfo", "upload=1; download=2; total=1073741824; expire=1798675200")
		w.Header().Set("Profile-Title", "base64:"+base64.StdEncoding.EncodeToString([]byte("Моя подписка")))
		w.Header().Set("Profile-Update-Interval", "6")
		w.Write([]byte(base64.StdEncoding.EncodeToString([]byte(body))))
	}))
	defer srv.Close()

	c := startNM(t)
	res, code, msg := c.call("fetch_subscription", map[string]any{"url": srv.URL + "/sub/TOKEN", "userAgent": "v2rayN/7.0"})
	if code != "" {
		t.Fatalf("fetch_subscription: %s %s", code, msg)
	}
	if n := len(res["servers"].([]any)); n != 3 || res["servers"].([]any)[1].(map[string]any)["core"] != "xray" {
		t.Errorf("серверов %d, ожидалось 3 (xhttp — через Xray): %v", n, res)
	}
	if errs := res["errors"].([]any); len(errs) != 0 {
		t.Errorf("пропущенные: %v", errs)
	}
	if res["title"] != "Моя подписка" || res["updateIntervalHours"] != float64(6) || res["info"].(map[string]any)["total"] != float64(1073741824) {
		t.Errorf("название, интервал, трафик: %v %v %v", res["title"], res["updateIntervalHours"], res["info"])
	}
	if _, code, msg = c.call("fetch_subscription", map[string]any{"url": srv.URL + "/sub/TOKEN", "userAgent": "Mozilla/5.0"}); code != "SUBSCRIPTION_FAILED" || !strings.Contains(msg, "веб-страница") {
		t.Errorf("браузерный User-Agent: %s %s", code, msg)
	}
	if _, code, _ = c.call("fetch_subscription", map[string]any{"url": "ftp://x"}); code != "BAD_REQUEST" {
		t.Errorf("не http(s): %s", code)
	}
	// «Проверить подписку»: отчёт без секретов, идентификатор устройства не отправляется без device.
	res, code, msg = c.call("sub_info", map[string]any{"url": srv.URL + "/sub/TOKEN"})
	if code != "" {
		t.Fatalf("sub_info: %s %s", code, msg)
	}
	rep := fmt.Sprint(res["report"])
	if !strings.Contains(rep, "Waysplit сейчас — 3 (base64 со ссылками; запустим 3)") || !strings.Contains(rep, "v2rayN 7.25.6 — 200, веб-страница") ||
		strings.Contains(rep, "TOKEN") || strings.Contains(rep, uuid) || res["device"] != false {
		t.Errorf("sub_info: device=%v\n%s", res["device"], rep)
	}
	if _, code, _ = c.call("sub_info", map[string]any{"url": "ftp://x"}); code != "BAD_REQUEST" {
		t.Errorf("sub_info не http(s): %s", code)
	}
	if _, code, _ = c.call("exit_ip", map[string]any{"serverId": "s_1"}); code != "CORE_NOT_RUNNING" {
		t.Errorf("exit_ip без ядра: %s", code)
	}
	res, code, _ = c.call("logs", map[string]any{"lines": 20})
	if code != "" || !strings.Contains(fmt.Sprint(res["host"]), "запуск из Chrome") {
		t.Errorf("logs: %s %v", code, res)
	}
	if strings.Contains(fmt.Sprint(res), "TOKEN") || strings.Contains(fmt.Sprint(res), uuid) {
		t.Errorf("в журнале секреты: %v", res)
	}
}

// SPEC-SUBS, шаг 2: подписка с привязкой к устройству глазами расширения. Панель (вымышленная,
// как Remnawave) без x-hwid отдаёт заглушку «App not supported», с x-hwid — серверы.
func TestNativeMessagingDeviceSubscription(t *testing.T) {
	const uuid = "d47d7dee-9073-46b1-a078-dc5be5c1524b"
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	stub := "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?type=tcp#App%20not%20supported"
	servers := "vless://" + uuid + "@nl.example.com:443?security=tls&type=ws#NL\nvless://" + uuid + "@eu.example.com:443?security=tls&type=xhttp#EU"
	var mu sync.Mutex
	var seen []string // по запросу: «без» или модель устройства
	mode := "normal"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hwid := r.Header.Get("x-hwid")
		mu.Lock()
		if hwid == "" {
			seen = append(seen, "без")
		} else {
			seen = append(seen, r.Header.Get("x-device-os")+"/"+r.Header.Get("x-device-model"))
		}
		m := mode
		mu.Unlock()
		w.Header().Set("X-Hwid-Active", "true")
		w.Header().Set("Announce", "base64:"+b64("Пишите в поддержку"))
		switch {
		case m == "404" && hwid == "":
			w.WriteHeader(http.StatusNotFound) // как в документации Remnawave: без x-hwid — 404
		case m == "limit":
			w.Header().Set("X-Hwid-Max-Devices-Reached", "true")
			w.Write([]byte(b64(stub)))
		case m == "happ":
			w.Write([]byte("happ://crypt3/QUJDREVGR0g="))
		case m == "clash-empty": // ссылка для классического Clash: VLESS он не умеет — список пуст
			w.Write([]byte("mixed-port: 7890\nproxies: []\nproxy-groups: []\n"))
		case m == "mihomo":
			w.Write([]byte("proxies:\n  - {name: NL, type: vless, server: nl.example.com, port: 443, uuid: " + uuid + ", tls: true, network: ws}\n"))
		case hwid == "":
			w.Header().Set("X-Hwid-Not-Supported", "true")
			w.Write([]byte(b64(stub)))
		default:
			w.Write([]byte(b64(servers)))
		}
	}))
	defer srv.Close()
	reset := func(m string) {
		mu.Lock()
		mode, seen = m, nil
		mu.Unlock()
	}
	requests := func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.Join(seen, ", ")
	}
	c := startNM(t)
	url := srv.URL + "/api/sub/TOKEN"

	// Не привязана: сначала без идентификатора, получили заглушку — повтор с ним.
	res, code, msg := c.call("fetch_subscription", map[string]any{"url": url, "userAgent": "v2rayN/7.0"})
	if code != "" || res["deviceUsed"] != true || len(res["servers"].([]any)) != 2 || res["announce"] != "Пишите в поддержку" {
		t.Fatalf("не привязана: %s %s %v", code, msg, res)
	}
	if r := requests(); r != "без, Windows/Chrome" {
		t.Errorf("запросы: %s", r)
	}
	// Привязана: сразу с идентификатором, без лишнего запроса.
	reset("normal")
	res, code, _ = c.call("fetch_subscription", map[string]any{"url": url, "device": true})
	if code != "" || res["deviceUsed"] != true || requests() != "Windows/Chrome" {
		t.Errorf("привязана: %s %v; запросы: %s", code, res, requests())
	}
	// Без x-hwid — 404 (так пишет документация Remnawave): тоже повтор с идентификатором.
	reset("404")
	if res, code, _ = c.call("fetch_subscription", map[string]any{"url": url}); code != "" || res["deviceUsed"] != true || requests() != "без, Windows/Chrome" {
		t.Errorf("404 без x-hwid: %s %v; запросы: %s", code, res, requests())
	}
	// Лимит устройств и подписка для Happ — понятные ошибки со своим кодом.
	reset("limit")
	if _, code, msg = c.call("fetch_subscription", map[string]any{"url": url, "device": true}); code != "DEVICE_LIMIT" || !strings.Contains(msg, "Лимит устройств исчерпан") {
		t.Errorf("лимит: %s %s", code, msg)
	}
	reset("happ")
	if _, code, msg = c.call("fetch_subscription", map[string]any{"url": url}); code != "HAPP_CRYPT" || !strings.Contains(msg, "зашифрована для приложения Happ") {
		t.Errorf("happ://crypt: %s %s", code, msg)
	}
	// Форматы панелей под приложения (SPEC-SUBS, п. 1): Mihomo — серверы и формат; пустой Clash — объяснение.
	reset("mihomo")
	if res, code, _ = c.call("fetch_subscription", map[string]any{"url": url}); code != "" || res["format"] != "clash-yaml" || len(res["servers"].([]any)) != 1 || res["deviceUsed"] == true {
		t.Errorf("Mihomo YAML: %s %v", code, res)
	}
	reset("clash-empty")
	if _, code, msg = c.call("fetch_subscription", map[string]any{"url": url}); code != "SUBSCRIPTION_EMPTY" || !strings.Contains(msg, "Mihomo") {
		t.Errorf("пустой Clash: %s %s", code, msg)
	}
	// Журнал без адреса подписки и идентификатора устройства.
	res, _, _ = c.call("logs", map[string]any{"lines": 100})
	if log := fmt.Sprint(res["host"]); strings.Contains(log, "TOKEN") || !strings.Contains(log, "повтор с ним") {
		t.Errorf("журнал: %s", log)
	}
}

// ID из магазина (SPEC-STORE.md, 1.1): пока не известен — пусто; известен — верный и не тот же,
// что для разработки. Компаньон пускает оба.
func TestExtensionIDs(t *testing.T) {
	ids := extensionIDs()
	if ids[0] != extensionID {
		t.Fatalf("первый ID %q, нужен ID для разработки", ids[0])
	}
	if storeExtensionID == "" {
		if len(ids) != 1 {
			t.Errorf("ID магазина не задан, а разрешены %v", ids)
		}
		return
	}
	if !validExtID(storeExtensionID) || storeExtensionID == extensionID || len(ids) != 2 {
		t.Errorf("ID магазина %q, разрешены %v", storeExtensionID, ids)
	}
}
