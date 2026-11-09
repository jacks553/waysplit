package singbox

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"waysplit/host/internal/corebin"
)

// deadServer — сервер, которого нет: ядро запускается, но до сервера не достучаться.
const deadServer = "vless://" + uuid + "@127.0.0.1:9?type=tcp#dead"

func TestCoreStartStop(t *testing.T) {
	bin := needBinary(t)
	c := &Core{Bin: bin, DataDir: t.TempDir()}
	defer c.Close()
	port := freePort(t)
	cfg := mustBuild(t, Entry{ID: "t1", Link: deadServer, LocalPort: port})

	if err := c.Start(cfg); err != nil {
		t.Fatalf("%v\n%s", err, detail(err))
	}
	st := c.Status()
	if !st.Running || st.PID == 0 || len(st.Ports) != 1 || st.Ports[0] != port {
		t.Fatalf("состояние после запуска: %+v", st)
	}
	if data, _ := os.ReadFile(c.pidPath()); strings.TrimSpace(string(data)) != strconv.Itoa(st.PID) {
		t.Errorf("в sing-box.pid «%s», ожидался PID %d", data, st.PID)
	}
	if _, err := os.Stat(c.ConfigPath()); err != nil {
		t.Errorf("нет config.json: %v", err)
	}

	// Сервер не отвечает — понятная ошибка, а не зависание.
	start := time.Now()
	_, err := Ping(context.Background(), Target{ID: "t1", Port: port, Protocol: "vless"}, "http://192.0.2.1/", 3*time.Second)
	if err == nil || err.Error() != "Сервер не отвечает" {
		t.Errorf("пинг мёртвого сервера: %v", err)
	}
	if time.Since(start) > 4*time.Second {
		t.Errorf("пинг шёл %v — дольше таймаута", time.Since(start))
	}

	// Повторный Start перезапускает ядро.
	old := st.PID
	if err := c.Start(cfg); err != nil {
		t.Fatalf("перезапуск: %v", err)
	}
	if st = c.Status(); !st.Running || st.PID == old {
		t.Errorf("после перезапуска: %+v (старый PID %d)", st, old)
	}
	if alive(old) {
		t.Errorf("старое ядро (PID %d) осталось работать", old)
	}

	pid := st.PID
	c.Stop()
	if st = c.Status(); st.Running {
		t.Errorf("после Stop ядро работает: %+v", st)
	}
	if alive(pid) {
		t.Errorf("процесс %d жив после Stop", pid)
	}
	if _, err := os.Stat(c.pidPath()); !os.IsNotExist(err) {
		t.Error("sing-box.pid не удалён после Stop")
	}
	if _, err := Ping(context.Background(), Target{Port: port}, "http://192.0.2.1/", time.Second); err == nil || !strings.Contains(err.Error(), "не слушает порт") {
		t.Errorf("пинг при остановленном ядре: %v", err)
	}
}

// Компаньон закрылся (даже аварийно) — Windows закрывает job, и ядро завершается само.
func TestJobKillsCore(t *testing.T) {
	bin := needBinary(t)
	c := &Core{Bin: bin, DataDir: t.TempDir()}
	defer c.Close()
	if err := c.Start(mustBuild(t, Entry{ID: "t1", Link: deadServer, LocalPort: freePort(t)})); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	done, job := c.done, c.job
	c.job = 0
	c.mu.Unlock()
	windows.CloseHandle(job) // то же, что происходит при завершении процесса компаньона
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ядро не завершилось после закрытия job")
	}
	if st := c.Status(); st.Running || !strings.Contains(st.LastError, "неожиданно завершился") {
		t.Errorf("состояние: %+v", st)
	}
}

func TestCorePortBusy(t *testing.T) {
	bin := needBinary(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	c := &Core{Bin: bin, DataDir: t.TempDir()}
	defer c.Close()
	err = c.Start(mustBuild(t, Entry{ID: "t1", Link: deadServer, LocalPort: port}))
	var se *Error
	if !errors.As(err, &se) || se.Code != "PORT_BUSY" || se.Message != "Порт "+strconv.Itoa(port)+" занят другой программой" {
		t.Fatalf("ожидалась ошибка PORT_BUSY, получено %v", err)
	}
	if st := c.Status(); st.Running || st.LastError != se.Message {
		t.Errorf("состояние: %+v", st)
	}
}

func TestKillOrphan(t *testing.T) {
	bin := needBinary(t)
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "sing-box.pid")

	// По PID из файла работает чужая программа — не трогаем.
	other := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "PING.EXE"), "-n", "30", "127.0.0.1")
	corebin.HideWindow(other)
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer other.Process.Kill()
	os.WriteFile(pidFile, []byte(strconv.Itoa(other.Process.Pid)), 0o644)
	KillOrphan(bin, pidFile)
	if !alive(other.Process.Pid) {
		t.Error("KillOrphan завершил чужую программу")
	}
	if _, err := os.Stat(pidFile); !os.IsNotExist(err) {
		t.Error("файл PID не удалён")
	}

	// Осиротевший sing-box от прошлого раза — завершаем.
	port := freePort(t)
	cfgPath := filepath.Join(dir, "orphan.json")
	data, _ := mustBuild(t, Entry{ID: "t1", Link: deadServer, LocalPort: port}).JSON()
	os.WriteFile(cfgPath, data, 0o600)
	orphan := exec.Command(bin, "run", "-c", cfgPath, "-D", dir)
	corebin.HideWindow(orphan)
	if err := orphan.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { orphan.Wait(); close(exited) }()
	defer orphan.Process.Kill()
	waitPort(t, port)
	os.WriteFile(pidFile, []byte(strconv.Itoa(orphan.Process.Pid)), 0o644)
	KillOrphan(bin, pidFile)
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("осиротевший sing-box не завершён")
	}
}

func mustBuild(t *testing.T, entries ...Entry) *Config {
	t.Helper()
	b, err := Build(entries, "warn")
	if err != nil || len(b.Errors) > 0 {
		t.Fatalf("сборка: %v %+v", err, b.Errors)
	}
	return b.Config
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

func waitPort(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 200*time.Millisecond); err == nil {
			conn.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("порт %d не открылся", port)
}

func alive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	return windows.GetExitCodeProcess(h, &code) == nil && code == 259
}

func detail(err error) string {
	var se *Error
	if errors.As(err, &se) {
		return se.Detail
	}
	return ""
}
