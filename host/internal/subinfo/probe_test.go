package subinfo

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"waysplit/host/internal/device"
)

// fakePanel ведёт себя как панель с привязкой к устройствам (как Remnawave): без x-hwid —
// заглушка «App not supported» и заголовки x-hwid-*; с x-hwid — настоящие серверы
// (Happ получает Xray JSON). Всё вымышленное.
func fakePanel(t *testing.T) (*httptest.Server, *sync.Map, *atomic.Bool) {
	seen := &sync.Map{} // User-Agent → заголовки устройства, которые пришли
	var devReqs atomic.Int32
	var firstDone, overlap atomic.Bool // overlap — пришёл второй запрос с x-hwid, пока первый не закончен
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hwid := r.Header.Get("x-hwid")
		if hwid != "" {
			if devReqs.Add(1) == 1 {
				time.Sleep(150 * time.Millisecond) // «панель заводит устройство»
				firstDone.Store(true)
			} else if !firstDone.Load() {
				overlap.Store(true)
			}
		}
		seen.Store(r.Header.Get("User-Agent")+"|"+hwid, r.Header.Get("x-device-os")+"/"+r.Header.Get("x-ver-os")+"/"+r.Header.Get("x-device-model"))
		h := w.Header()
		h.Set("Profile-Title", "base64:"+b64("Тестовый VPN"))
		h.Set("Announce", "base64:"+b64("Пишите в поддержку"))
		h.Set("Subscription-Userinfo", "upload=1073741824; download=100170000000; total=0; expire=1795790440")
		h.Set("Profile-Web-Page-Url", "https://"+r.Host+"/api/sub/SECRET-TOKEN-123456")
		h.Set("Content-Disposition", `attachment; filename="user42"`)
		h.Set("Etag", `W/"9c-Q0FCREVGR0hJSktMTU5PUFFS"`)
		h.Add("Set-Cookie", "session=very-secret-cookie")
		h.Set("X-Hwid-Active", "true")
		if hwid == "" {
			h.Set("X-Hwid-Not-Supported", "true")
			h.Set("X-Hwid-Limit", "true")
			w.Write([]byte(b64(linkStub)))
			return
		}
		if strings.HasPrefix(r.Header.Get("User-Agent"), "Happ/") {
			h.Set("Content-Type", "application/json")
			w.Write([]byte("[" + xrayOne + "]"))
			return
		}
		w.Write([]byte(b64(linkReality + "\n" + linkXHTTP)))
	}))
	t.Cleanup(srv.Close)
	return srv, seen, &overlap
}

func TestRunAndReport(t *testing.T) {
	srv, seen, overlap := fakePanel(t)
	subURL := srv.URL + "/api/sub/SECRET-TOKEN-123456"
	dev, created, err := device.Load(t.TempDir())
	if err != nil || !created {
		t.Fatalf("device.Load: %v, created %v", err, created)
	}
	o := Options{Device: dev, Timeout: 5 * time.Second}
	results := Run(context.Background(), subURL, o)
	if len(results) != 2*len(Clients) {
		t.Fatalf("способов %d, нужно %d", len(results), 2*len(Clients))
	}
	for i, r := range results {
		withDevice := i >= len(Clients)
		if r.Device != withDevice || r.Status != 200 || r.Body == nil {
			t.Fatalf("способ %d (%s): device %v, статус %d", i+1, r.Client, r.Device, r.Status)
		}
		if !withDevice && (r.Body.Servers != 0 || len(r.Body.Stubs) != 1) {
			t.Fatalf("без устройства %s: серверов %d, заглушек %d", r.Client, r.Body.Servers, len(r.Body.Stubs))
		}
		if withDevice && r.Body.Servers == 0 {
			t.Fatalf("с устройством %s: серверов нет", r.Client)
		}
	}
	// Устройство: тот же идентификатор у всех способов, ОС и модель — как задумано.
	got, ok := seen.Load("v2rayN/7.25.6|" + dev.HWID)
	if !ok || !strings.HasPrefix(got.(string), "Windows/") || !strings.HasSuffix(got.(string), "/Chrome") {
		t.Fatalf("заголовки устройства: %v", got)
	}
	if overlap.Load() {
		t.Fatal("первый запрос с идентификатором должен закончиться раньше остальных: панель заводит устройство")
	}
	if _, ok := seen.Load("v2rayN/7.25.6|"); !ok {
		t.Fatal("без устройства запрос не отправлялся")
	}

	rep := Report(results, o)
	for _, leak := range []string{"SECRET-TOKEN", "user42", "very-secret-cookie", "set-cookie", uuid, dev.HWID, "nl1.example.com", "127.0.0.1", "Q0FCREVGR0hJSktMTU5PUFFS"} {
		if strings.Contains(rep, leak) {
			t.Errorf("в отчёте есть %q", leak)
		}
	}
	for _, want := range []string{
		"x-hwid-not-supported: true  — клиент не прислал идентификатор устройства",
		"profile-title: Тестовый VPN  [было в base64]",
		"announce: Пишите в поддержку",
		"download=100170000000",
		"трафик 94,3 ГБ, без лимита",
		"profile-web-page-url: https://***/…",
		"заглушка «App not supported»",
		"Xray JSON (массив из 1 конфига)",
		"Заголовки: те же, что в способе 1",
		"x-hwid " + dev.Short(),
	} {
		if !strings.Contains(rep, want) {
			t.Errorf("в отчёте нет %q", want)
		}
	}
	if t.Failed() {
		t.Log(rep)
	}
}

func TestNoAnswer(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.URL
	srv.Close() // никто не слушает
	results := Run(context.Background(), addr+"/sub", Options{Timeout: 2 * time.Second, Clients: Clients[:2]})
	if len(results) != 2 || results[0].Status != 0 || results[0].Error == "" {
		t.Fatalf("нет ответа: %+v", results)
	}
	if rep := Report(results, Options{}); !strings.Contains(rep, "Ответа нет") || !strings.Contains(rep, "Серверы не пришли ни одним способом") {
		t.Fatal(rep)
	}
}
