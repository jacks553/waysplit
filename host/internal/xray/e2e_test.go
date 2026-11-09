package xray

// Сквозной тест (SPEC-XRAY.md): второй Xray на этом же компьютере изображает VPN-сервер —
// VLESS + XHTTP с TLS на самоподписанном сертификате (клиент закрепляет его отпечаток, pcs),
// VLESS + XHTTP с Reality и VLESS Encryption + XHTTP. Наш конфиг к нему подключается.
// Сайт target.test знает только «сервер» (DNS hosts) — значит, адрес сайта узнаёт сервер,
// а не компьютер.

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
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
	"waysplit/host/internal/singbox"
)

const (
	realityPrivate = "ICCHrnITtBOikPyufCQXkJW5wdTV35I36lnW83CS_3M" // пара к pbk, только для тестов
	targetHost     = "target.test"
	targetReply    = "привет от сайта"
)

func TestEndToEnd(t *testing.T) {
	bin := xrayBin(t)
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

	// Настоящий TLS-сайт, под который маскируется Reality.
	mask := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	mask.Config.ErrorLog = log.New(io.Discard, "", 0)
	mask.StartTLS()
	defer mask.Close()
	maskPort := mask.Listener.Addr().(*net.TCPAddr).Port

	certPath, keyPath, pin := selfSigned(t, dir, "xh.example.com")
	// Сертификат от своего CA (в цепочке — и сам CA): клиент закрепляет CA (pcs), а имя
	// сервера проверяет по vcn — sni при этом другое.
	chainPath, chainKey, caPin := caSigned(t, dir, "xh.example.com")
	encPriv, encPub := x25519Pair(t) // VLESS Encryption (проверка по X25519)
	pTLS, pReality, pEnc, pVCN := freePort(t), freePort(t), freePort(t), freePort(t)

	vlessIn := func(tag string, port int, decryption string, stream map[string]any) map[string]any {
		return map[string]any{"tag": tag, "listen": "127.0.0.1", "port": port, "protocol": "vless",
			"settings":       map[string]any{"clients": []any{map[string]any{"id": uuid}}, "decryption": decryption},
			"streamSettings": stream}
	}
	startServer(t, bin, dir, []map[string]any{
		vlessIn("tls", pTLS, "none", map[string]any{"network": "xhttp", "security": "tls",
			"xhttpSettings": map[string]any{"path": "/xh"},
			"tlsSettings":   map[string]any{"certificates": []any{map[string]any{"certificateFile": certPath, "keyFile": keyPath}}}}),
		vlessIn("reality", pReality, "none", map[string]any{"network": "xhttp", "security": "reality",
			"xhttpSettings": map[string]any{"path": "/xr"},
			"realitySettings": map[string]any{"target": "127.0.0.1:" + strconv.Itoa(maskPort), "serverNames": []string{"www.example.org"},
				"privateKey": realityPrivate, "shortIds": []string{"b43351f6"}}}),
		vlessIn("enc", pEnc, "mlkem768x25519plus.native.600s."+encPriv, map[string]any{"network": "xhttp", "security": "none",
			"xhttpSettings": map[string]any{"path": "/xe"}}),
		vlessIn("vcn", pVCN, "none", map[string]any{"network": "xhttp", "security": "tls",
			"xhttpSettings": map[string]any{"path": "/xv"},
			"tlsSettings":   map[string]any{"certificates": []any{map[string]any{"certificateFile": chainPath, "keyFile": chainKey}}}}),
	})
	vcnLink := func(name string) string {
		return fmt.Sprintf("vless://%s@127.0.0.1:%d?security=tls&sni=cdn.example.com&pcs=%s&vcn=%s&type=xhttp&path=%%2Fxv#V", uuid, pVCN, caPin, name)
	}

	servers := []struct{ id, link string }{
		{"tls", fmt.Sprintf("vless://%s@127.0.0.1:%d?security=tls&sni=xh.example.com&pcs=%s&type=xhttp&path=%%2Fxh&mode=auto#TLS", uuid, pTLS, pin)},
		{"reality", fmt.Sprintf("vless://%s@127.0.0.1:%d?security=reality&sni=www.example.org&fp=chrome&pbk=%s&sid=b43351f6&spx=%%2F&type=xhttp&path=%%2Fxr"+
			"&extra=%%7B%%22xPaddingBytes%%22%%3A%%22100-1000%%22%%7D#R", uuid, pReality, pbk)},
		{"enc", fmt.Sprintf("vless://%s@127.0.0.1:%d?encryption=mlkem768x25519plus.native.0rtt.%s&type=xhttp&path=%%2Fxe#E", uuid, pEnc, encPub)},
		{"vcn", vcnLink("other.example.com%2Cxh.example.com")}, // подходит второе имя из списка
	}
	var list []singbox.Entry
	for _, s := range servers {
		list = append(list, singbox.Entry{ID: s.id, Link: s.link, LocalPort: freePort(t)})
	}
	built, err := Validate(bin, dir, list, "warn")
	if err != nil || len(built.Errors) > 0 {
		t.Fatalf("конфиг: %v %+v", err, built.Errors)
	}
	data, _ := built.Config.JSON()
	core := &singbox.Core{Bin: bin, DataDir: filepath.Join(dir, "client"), Engine: Engine}
	defer core.Close()
	if err := core.StartData(data, built.Config.PortsOf()); err != nil {
		t.Fatalf("%v\n%s", err, singbox.Tail(core.LogPath(), 20))
	}
	if st := core.Status(); !st.Running || st.PID == 0 {
		t.Fatalf("Xray не работает: %+v", st)
	}

	for _, s := range servers {
		port := built.Ports[s.id]
		t.Run(s.id, func(t *testing.T) {
			body, err := socks5Get(port, targetHost, sitePort)
			if err != nil || !strings.HasSuffix(body, targetReply) {
				t.Errorf("SOCKS5: %v, ответ %q\nxray.log:\n%s\nserver.log:\n%s", err, body,
					singbox.Tail(core.LogPath(), 10), singbox.Tail(filepath.Join(dir, "server.log"), 25))
			}
			// Как пинг компаньона: HTTP-прокси на том же порту (socks-вход Xray понимает и HTTP).
			ms, err := singbox.Ping(context.Background(), singbox.Target{ID: s.id, Port: port, Protocol: "vless"},
				fmt.Sprintf("http://%s:%d/generate_204", targetHost, sitePort), 5*time.Second)
			if err != nil {
				t.Errorf("пинг через HTTP-прокси: %v", err)
			} else {
				t.Logf("%s: пинг %d мс", s.id, ms)
			}
		})
	}

	// Чужой отпечаток сертификата или чужое имя в vcn — подключения нет (проверка работает,
	// а не «пропускает всё»).
	for _, bad := range []struct{ name, link string }{
		{"чужой pcs", strings.Replace(servers[0].link, pin, strings.Repeat("ab", 32), 1)},
		{"чужой vcn", vcnLink("wrong.example.com")},
	} {
		t.Run(bad.name, func(t *testing.T) {
			e := singbox.Entry{ID: "wrong", Link: bad.link, LocalPort: freePort(t)}
			b, err := Build([]singbox.Entry{e}, "warn")
			if err != nil {
				t.Fatal(err)
			}
			d, _ := b.Config.JSON()
			c2 := &singbox.Core{Bin: bin, DataDir: filepath.Join(dir, "client-"+strconv.Itoa(e.LocalPort)), Engine: Engine}
			defer c2.Close()
			if err := c2.StartData(d, b.Config.PortsOf()); err != nil {
				t.Fatal(err)
			}
			if body, err := socks5Get(e.LocalPort, targetHost, sitePort); err == nil && strings.HasSuffix(body, targetReply) {
				t.Fatalf("%s: сайт открылся, а не должен", bad.name)
			}
		})
	}

	// Ядро завершается вместе с Close (Job Object): порт закрыт.
	port := built.Ports["tls"]
	core.Close()
	for i := 0; i < 50; i++ {
		c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 200*time.Millisecond)
		if err != nil {
			return
		}
		c.Close()
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("после Close ядро Xray всё ещё слушает порт")
}

// startServer запускает Xray в роли VPN-сервера и ждёт «started» в журнале.
func startServer(t *testing.T, bin, dir string, inbounds []map[string]any) {
	t.Helper()
	cfg := map[string]any{
		"log":      map[string]any{"loglevel": "warning"},
		"dns":      map[string]any{"hosts": map[string]any{targetHost: "127.0.0.1"}},
		"inbounds": inbounds,
		// Xray 26 по умолчанию не выпускает сервер к локальным адресам — сайт теста на 127.0.0.1, разрешаем.
		"outbounds": []any{map[string]any{"protocol": "freedom", "settings": map[string]any{"targetStrategy": "UseIP",
			"finalRules": []any{map[string]any{"action": "allow", "ip": []string{"127.0.0.0/8"}}}}}},
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	path := filepath.Join(dir, "server.json")
	os.WriteFile(path, data, 0o600)
	if out, err := Check(bin, path); err != nil {
		t.Fatalf("конфиг тестового сервера: %v\n%s", err, out)
	}
	logPath := filepath.Join(dir, "server.log")
	logf, _ := os.Create(logPath)
	cmd := exec.Command(bin, "run", "-c", path)
	cmd.Stdout, cmd.Stderr = logf, logf
	corebin.HideWindow(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	logf.Close()
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, _ := os.ReadFile(logPath); strings.Contains(string(data), " started") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	data, _ = os.ReadFile(logPath)
	t.Fatalf("тестовый сервер не запустился:\n%s", data)
}

// socks5Get — GET через SOCKS5 с именем сайта (как Chrome).
func socks5Get(proxyPort int, host string, port int) (string, error) {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(proxyPort), 3*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return "", err
	}
	hello := make([]byte, 2)
	if _, err := io.ReadFull(conn, hello); err != nil || hello[1] != 0 {
		return "", fmt.Errorf("приветствие SOCKS5: %v %v", hello, err)
	}
	req := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
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

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// selfSigned — самоподписанный сертификат и его отпечаток SHA-256 (hex) для pcs.
func selfSigned(t *testing.T, dir, name string) (certPath, keyPath, pin string) {
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
	sum := sha256.Sum256(der)
	return certPath, keyPath, hex.EncodeToString(sum[:])
}

// caSigned — свой CA и выпущенный им сертификат сервера. Файл сертификата — цепочка «сервер + CA»
// (CA должен прийти клиенту, чтобы его можно было узнать по отпечатку); caPin — SHA-256 CA (hex).
func caSigned(t *testing.T, dir, name string) (chainPath, keyPath, caPin string) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(10), Subject: pkix.Name{CommonName: "Test CA"}, IsCA: true, BasicConstraintsValid: true,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(11), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	chainPath, keyPath = filepath.Join(dir, "chain.pem"), filepath.Join(dir, "chain-key.pem")
	chain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	os.WriteFile(chainPath, chain, 0o600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600)
	sum := sha256.Sum256(caDER)
	return chainPath, keyPath, hex.EncodeToString(sum[:])
}

// x25519Pair — закрытый и открытый ключ X25519 в base64url без «=».
func x25519Pair(t *testing.T) (priv, pub string) {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(k.Bytes()), base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes())
}
