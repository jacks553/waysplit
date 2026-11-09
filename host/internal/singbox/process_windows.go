package singbox

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"waysplit/host/internal/corebin"
	"waysplit/host/internal/hostlog"
)

// Engine — чем отличаются ядра при запуске (sing-box, Xray): имя, файлы, команда запуска.
// Конфиг проверяет вызывающий (Validate) до запуска.
type Engine struct {
	Name       string // «sing-box», «Xray» — для журнала и сообщений
	ConfigFile string // имя файла конфига в папке данных
	LogFile    string // журнал ядра (прошлый — *.prev.log)
	PIDFile    string
	RunArgs    func(config, dataDir string) []string
}

// SingBox — ядро по умолчанию.
var SingBox = &Engine{
	Name: "sing-box", ConfigFile: "config.json", LogFile: "sing-box.log", PIDFile: "sing-box.pid",
	RunArgs: func(config, dataDir string) []string {
		return []string{"run", "--disable-color", "-c", config, "-D", dataDir}
	},
}

// Core управляет процессом ядра (sing-box или другого — см. Engine).
//
// Ядро запускается без окна, его вывод идёт в свой журнал (не в stdout компаньона),
// а сам процесс привязан к Job Object с KILL_ON_JOB_CLOSE: когда компаньон завершается
// (даже аварийно), Windows закрывает job и ядро завершается вместе с ним.
type Core struct {
	Bin     string  // полный путь к sing-box.exe (или xray.exe)
	DataDir string  // %LOCALAPPDATA%\Waysplit
	Engine  *Engine // nil — sing-box

	mu      sync.Mutex
	job     windows.Handle
	cmd     *exec.Cmd
	done    chan struct{}
	started time.Time
	ports   []int
	lastErr string
}

// Status — состояние ядра для расширения.
type Status struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	Uptime    int64  `json:"uptime"` // секунды
	Ports     []int  `json:"ports,omitempty"`
	LastError string `json:"lastError,omitempty"`
}

// StartTimeout — сколько ждать, пока ядро откроет все порты.
const StartTimeout = 5 * time.Second

func (c *Core) eng() *Engine {
	if c.Engine != nil {
		return c.Engine
	}
	return SingBox
}

func (c *Core) ConfigPath() string { return filepath.Join(c.DataDir, c.eng().ConfigFile) }
func (c *Core) LogPath() string    { return filepath.Join(c.DataDir, c.eng().LogFile) }
func (c *Core) pidPath() string    { return filepath.Join(c.DataDir, c.eng().PIDFile) }

// Start записывает конфиг sing-box и (пере)запускает ядро. Возвращается, когда все порты
// принимают подключения, или с ошибкой. Конфиг уже проверен ядром (Validate) — второй раз
// перед запуском его не проверяем: это ещё один запуск sing-box (~64 мс) при каждом включении.
func (c *Core) Start(cfg *Config) error {
	data, err := cfg.JSON()
	if err != nil {
		return &Error{Code: "START_FAILED", Message: "не удалось собрать конфиг: " + err.Error()}
	}
	var ports []int
	for _, in := range cfg.Inbounds {
		ports = append(ports, in.ListenPort)
	}
	return c.StartData(data, ports)
}

// StartData — то же для готового конфига любого ядра: data — конфиг (уже проверенный этим
// ядром), ports — порты, которые ядро должно открыть.
func (c *Core) StartData(data []byte, ports []int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopLocked()
	err := c.startLocked(data, ports)
	c.lastErr = ""
	if err != nil {
		c.lastErr = err.Error()
		hostlog.Printf("запуск %s: %v", c.eng().Name, err)
	}
	return err
}

// Stop останавливает ядро (если оно запущено).
func (c *Core) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopLocked()
}

// Close останавливает ядро и закрывает job. После Close объект не использовать.
func (c *Core) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopLocked()
	if c.job != 0 {
		windows.CloseHandle(c.job)
		c.job = 0
	}
}

// Status — запущено ли ядро, PID, сколько работает, последняя ошибка.
func (c *Core) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := Status{Running: c.cmd != nil, LastError: c.lastErr}
	if c.cmd != nil {
		st.PID = c.cmd.Process.Pid
		st.Uptime = int64(time.Since(c.started).Seconds())
		st.Ports = append([]int(nil), c.ports...)
	}
	return st
}

func (c *Core) startLocked(data []byte, ports []int) error {
	e := c.eng()
	if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
		return &Error{Code: "START_FAILED", Message: "не удалось создать папку " + c.DataDir}
	}
	KillOrphan(c.Bin, c.pidPath())

	if err := waitPortsFree(ports, 2*time.Second); err != nil {
		return err
	}
	if err := writeAtomic(c.ConfigPath(), data); err != nil {
		return &Error{Code: "START_FAILED", Message: "не удалось записать конфиг: " + err.Error()}
	}

	logf, err := openLog(c.LogPath())
	if err != nil {
		return &Error{Code: "START_FAILED", Message: "не удалось открыть " + e.LogFile + ": " + err.Error()}
	}
	cmd := exec.Command(c.Bin, e.RunArgs(c.ConfigPath(), c.DataDir)...)
	cmd.Dir = c.DataDir
	cmd.Stdout, cmd.Stderr = logf, logf // не наследуем stdout компаньона: там сообщения для Chrome
	corebin.HideWindow(cmd)
	err = cmd.Start()
	logf.Close() // у ядра своя копия дескриптора
	if err != nil {
		return &Error{Code: "START_FAILED", Message: e.Name + " не запустился: " + hostlog.Mask(err.Error())}
	}
	pid := cmd.Process.Pid
	if err := c.attachJob(pid); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return &Error{Code: "START_FAILED", Message: "не удалось привязать " + e.Name + " к компаньону (Job Object): " + err.Error()}
	}
	os.WriteFile(c.pidPath(), []byte(strconv.Itoa(pid)), 0o644)
	hostlog.Printf("%s запущен, PID %d, порты %v", e.Name, pid, ports)

	done := make(chan struct{})
	c.cmd, c.done, c.started, c.ports = cmd, done, time.Now(), ports
	go c.watch(cmd, done)

	deadline := time.Now().Add(StartTimeout)
	for _, p := range ports {
		addr := "127.0.0.1:" + strconv.Itoa(p)
		for {
			select {
			case <-done:
				c.cmd = nil
				os.Remove(c.pidPath())
				return &Error{Code: "START_FAILED", Message: e.Name + " сразу завершился: " + lastLogLine(c.LogPath()), Detail: Tail(c.LogPath(), 20)}
			default:
			}
			conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
			if err == nil {
				conn.Close()
				break
			}
			if time.Now().After(deadline) {
				c.stopLocked()
				return &Error{Code: "START_TIMEOUT", Message: fmt.Sprintf("%s не открыл порт %d за %d секунд", e.Name, p, int(StartTimeout.Seconds())), Detail: Tail(c.LogPath(), 20)}
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	return nil
}

// watch ждёт завершения ядра. Если его никто не останавливал — запоминает ошибку.
func (c *Core) watch(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	close(done)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != cmd {
		return // остановили мы сами
	}
	c.cmd = nil
	os.Remove(c.pidPath())
	c.lastErr = c.eng().Name + " неожиданно завершился: " + lastLogLine(c.LogPath())
	hostlog.Printf("%s (%v)", c.lastErr, err)
}

func (c *Core) stopLocked() {
	if c.cmd == nil {
		return
	}
	cmd, done := c.cmd, c.done
	c.cmd = nil
	cmd.Process.Kill()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	os.Remove(c.pidPath())
	hostlog.Printf("%s остановлен (PID %d)", c.eng().Name, cmd.Process.Pid)
}

func (c *Core) attachJob(pid int) error {
	if c.job == 0 {
		job, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			return err
		}
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
			windows.CloseHandle(job)
			return err
		}
		c.job = job
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.AssignProcessToJobObject(c.job, h)
}

// KillOrphan завершает ядро, оставшееся от прошлого запуска (PID — из файла),
// но только если по этому PID работает именно наш exe (bin).
func KillOrphan(bin, pidPath string) {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return
	}
	defer os.Remove(pidPath)
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return // процесса уже нет
	}
	defer windows.CloseHandle(h)
	var code uint32
	if windows.GetExitCodeProcess(h, &code) == nil && code != 259 { // 259 = STILL_ACTIVE
		return
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return
	}
	image := windows.UTF16ToString(buf[:n])
	if !strings.EqualFold(filepath.Clean(image), filepath.Clean(bin)) {
		hostlog.Printf("PID %d из %s — не наше ядро (%s), не трогаю", pid, filepath.Base(pidPath), image)
		return
	}
	windows.TerminateProcess(h, 1)
	windows.WaitForSingleObject(h, 3000)
	hostlog.Printf("завершено ядро %s, оставшееся от прошлого запуска (PID %d)", filepath.Base(bin), pid)
}

// waitPortsFree проверяет, что порты свободны (после завершения старого ядра
// Windows может отпустить порт не сразу — ждём до wait).
func waitPortsFree(ports []int, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for _, p := range ports {
		for {
			l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
			if err == nil {
				l.Close()
				break
			}
			if time.Now().After(deadline) {
				if errors.Is(err, windows.WSAEACCES) {
					return &Error{Code: "PORT_BUSY", Message: fmt.Sprintf("Порт %d зарезервирован Windows — выберите другой диапазон портов", p)}
				}
				return &Error{Code: "PORT_BUSY", Message: fmt.Sprintf("Порт %d занят другой программой", p)}
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return nil
}

// openLog открывает свежий журнал ядра; прошлый переезжает в *.prev.log.
func openLog(path string) (*os.File, error) {
	if _, err := os.Stat(path); err == nil {
		prev := strings.TrimSuffix(path, ".log") + ".prev.log"
		os.Remove(prev)
		os.Rename(path, prev)
	}
	return os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
}

// Tail — последние n строк журнала без цветов и секретов.
func Tail(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	const max = 64 << 10
	if fi, err := f.Stat(); err == nil && fi.Size() > max {
		f.Seek(-max, io.SeekEnd)
	}
	data, _ := io.ReadAll(f)
	lines := strings.Split(corebin.Clean(string(data)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func lastLogLine(path string) string {
	lines := strings.Split(Tail(path, 5), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := firstLine(lines[i]); l != "" {
			return l
		}
	}
	return "причина неизвестна, см. " + filepath.Base(path)
}
