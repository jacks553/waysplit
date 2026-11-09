package singbox

// Сквозные тесты: второй sing-box на этом же компьютере изображает VPN-сервер
// (VLESS + Reality + Vision, VLESS по WebSocket, Hysteria2 с salamander), а наш конфиг
// к нему подключается. Сайт — маленький HTTP-сервер теста по имени target.test:
// это имя знает только «VPN-сервер» (DNS типа hosts), так что тест заодно
// доказывает, что адрес сайта узнаёт сервер, а не компьютер (нет утечки DNS).

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"waysplit/host/internal/corebin"
)

const (
	realityPrivate = "ICCHrnITtBOikPyufCQXkJW5wdTV35I36lnW83CS_3M" // пара к pbk, только для тестов
	targetHost     = "target.test"
	targetReply    = "привет от сайта"
)

func TestEndToEnd(t *testing.T) {
	bin := needBinary(t)
	dir := t.TempDir()

	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/generate_204" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fmt.Fprint(w, targetReply)
	}))
	defer site.Close()
	sitePort := site.Listener.Addr().(*net.TCPAddr).Port
	siteURL := fmt.Sprintf("http://%s:%d/", targetHost, sitePort)

	// Настоящий TLS-сайт, под который маскируется Reality.
	mask := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	mask.Config.ErrorLog = log.New(io.Discard, "", 0) // Reality проверяет сайт обрывками рукопожатий — это не ошибки
	mask.StartTLS()
	defer mask.Close()
	maskPort := mask.Listener.Addr().(*net.TCPAddr).Port

	cert, key := selfSigned(t, dir, "hy.example.com")
	pReality, pWS, pHy := freePort(t), freePort(t), freeUDPPort(t)

	startServer(t, bin, dir, []map[string]any{
		{
			"type": "vless", "tag": "reality", "listen": "127.0.0.1", "listen_port": pReality,
			"users": []any{map[string]any{"uuid": uuid, "flow": "xtls-rprx-vision"}},
			"tls": map[string]any{"enabled": true, "server_name": "www.example.org", "reality": map[string]any{
				"enabled": true, "private_key": realityPrivate, "short_id": []string{"b43351f6"},
				"handshake": map[string]any{"server": "127.0.0.1", "server_port": maskPort},
			}},
		},
		{
			"type": "vless", "tag": "ws", "listen": "127.0.0.1", "listen_port": pWS,
			"users":     []any{map[string]any{"uuid": uuid}},
			"transport": map[string]any{"type": "ws", "path": "/ws", "max_early_data": 2048, "early_data_header_name": "Sec-WebSocket-Protocol"},
		},
		{
			"type": "hysteria2", "tag": "hy2", "listen": "127.0.0.1", "listen_port": pHy,
			"users": []any{map[string]any{"password": "p@ss:word"}},
			"obfs":  map[string]any{"type": "salamander", "password": "ob-secret"},
			"tls":   map[string]any{"enabled": true, "certificate_path": cert, "key_path": key},
		},
	}, sitePort)

	servers := []struct{ id, proto, link string }{
		{"reality", "vless", fmt.Sprintf("vless://%s@127.0.0.1:%d?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.org&fp=chrome&pbk=%s&sid=b43351f6&type=tcp#R", uuid, pReality, pbk)},
		{"ws", "vless", fmt.Sprintf("vless://%s@127.0.0.1:%d?type=ws&host=cdn.example.com&path=%%2Fws%%3Fed%%3D2048#WS", uuid, pWS)},
		{"hy2", "hysteria2", fmt.Sprintf("hysteria2://p%%40ss%%3Aword@127.0.0.1:%d/?sni=hy.example.com&insecure=1&obfs=salamander&obfs-password=ob-secret#HY", pHy)},
	}
	var entries []Entry
	for _, s := range servers {
		entries = append(entries, Entry{ID: s.id, Link: s.link, LocalPort: freePort(t)})
	}
	built, err := Validate(bin, dir, entries, "warn")
	if err != nil || len(built.Errors) > 0 {
		t.Fatalf("конфиг: %v %+v", err, built.Errors)
	}
	core := &Core{Bin: bin, DataDir: filepath.Join(dir, "client")}
	defer core.Close()
	if err := core.Start(built.Config); err != nil {
		t.Fatalf("%v\n%s", err, detail(err))
	}

	for _, s := range servers {
		port := built.Ports[s.id]
		t.Run(s.id, func(t *testing.T) {
			// Как Chrome: SOCKS5 с именем сайта, адрес узнаёт сервер.
			body, err := socks5Get(port, targetHost, sitePort)
			if err != nil || !strings.HasSuffix(body, targetReply) {
				t.Errorf("SOCKS5: %v, ответ %q\nsing-box.log:\n%s", err, body, Tail(core.LogPath(), 10))
			}
			// Как пинг компаньона: HTTP-прокси на том же порту.
			ms, err := Ping(context.Background(), Target{ID: s.id, Port: port, Protocol: s.proto}, siteURL+"generate_204", 5*time.Second)
			if err != nil {
				t.Errorf("пинг через HTTP-прокси: %v", err)
			} else {
				t.Logf("%s: пинг %d мс", s.id, ms)
			}
		})
	}
}

// Hysteria2-сервер не отвечает — подсказка про UDP.
func TestHysteria2NoAnswer(t *testing.T) {
	bin := needBinary(t)
	link := fmt.Sprintf("hysteria2://pw@127.0.0.1:%d/?sni=hy.example.com&insecure=1", freeUDPPort(t))
	c := &Core{Bin: bin, DataDir: t.TempDir()}
	defer c.Close()
	port := freePort(t)
	if err := c.Start(mustBuild(t, Entry{ID: "hy", Link: link, LocalPort: port})); err != nil {
		t.Fatal(err)
	}
	_, err := Ping(context.Background(), Target{ID: "hy", Port: port, Protocol: "hysteria2"}, "http://192.0.2.1/", 3*time.Second)
	if err == nil || err.Error() != "Сервер не отвечает (возможно, заблокирован UDP)" {
		t.Errorf("ошибка %v", err)
	}
}

// startServer запускает sing-box в роли VPN-сервера и ждёт, пока он поднимется.
func startServer(t *testing.T, bin, dir string, inbounds []map[string]any, sitePort int) {
	t.Helper()
	cfg := map[string]any{
		"log":       map[string]any{"level": "info", "timestamp": false},
		"dns":       map[string]any{"servers": []any{map[string]any{"type": "hosts", "tag": "hosts", "predefined": map[string]any{targetHost: "127.0.0.1"}}}},
		"inbounds":  inbounds,
		"outbounds": []any{map[string]any{"type": "direct", "tag": "direct"}},
		"route":     map[string]any{"default_domain_resolver": "hosts"},
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	path := filepath.Join(dir, "server.json")
	os.WriteFile(path, data, 0o600)
	if out, err := Check(bin, path); err != nil || out != "" {
		t.Fatalf("конфиг тестового сервера: %v\n%s", err, out)
	}
	logPath := filepath.Join(dir, "server.log")
	logf, _ := os.Create(logPath)
	cmd := exec.Command(bin, "run", "--disable-color", "-c", path, "-D", dir)
	cmd.Stdout, cmd.Stderr = logf, logf
	corebin.HideWindow(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	logf.Close()
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, _ := os.ReadFile(logPath); strings.Contains(string(data), "sing-box started") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	data, _ = os.ReadFile(logPath)
	t.Fatalf("тестовый сервер не запустился:\n%s", data)
}

// socks5Get — GET через SOCKS5 с именем сайта (как socks5h у curl и как Chrome).
func socks5Get(proxyPort int, host string, port int) (string, error) {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(proxyPort), 3*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil { // SOCKS5, один способ входа: без пароля
		return "", err
	}
	hello := make([]byte, 2)
	if _, err := io.ReadFull(conn, hello); err != nil || hello[1] != 0 {
		return "", fmt.Errorf("приветствие SOCKS5: %v %v", hello, err)
	}
	req := append([]byte{5, 1, 0, 3, byte(len(host))}, host...) // CONNECT по имени
	req = append(req, byte(port>>8), byte(port))
	if _, err := conn.Write(req); err != nil {
		return "", err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil || head[1] != 0 {
		return "", fmt.Errorf("SOCKS5 CONNECT: %v %v", head, err)
	}
	skip := map[byte]int{1: 4 + 2, 4: 16 + 2}[head[3]]
	if head[3] == 3 {
		l := make([]byte, 1)
		io.ReadFull(conn, l)
		skip = int(l[0]) + 2
	}
	io.ReadFull(conn, make([]byte, skip))
	fmt.Fprintf(conn, "GET / HTTP/1.0\r\nHost: %s\r\n\r\n", host)
	body, err := io.ReadAll(conn)
	return string(body), err
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

// selfSigned — самоподписанный сертификат для тестового Hysteria2-сервера.
func selfSigned(t *testing.T, dir, name string) (certPath, keyPath string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	certPath, keyPath = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600)
	return certPath, keyPath
}
