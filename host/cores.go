package main

// Два ядра (SPEC-XRAY.md): sing-box — для всего, что он умеет, Xray — для XHTTP и VLESS
// Encryption. apply делит серверы между ними: у каждого ядра свой конфиг, свой процесс и свой
// журнал; ядро, чей список серверов не изменился, не перезапускается. Xray запускается, только
// если среди нужных серверов (need: текущий, серверы правил, те, что сейчас пингуются) есть его
// серверы; в его конфиге — все серверы Xray, поэтому переключение между ними его не перезапускает.

import (
	"encoding/json"

	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/links"
	"waysplit/host/internal/nm"
	"waysplit/host/internal/singbox"
	"waysplit/host/internal/xray"
)

// hostStatus — состояние для расширения. Общее: running — работают все нужные ядра (по нему
// расширение замечает, что ядро упало), pid — sing-box, если он работает, иначе Xray.
// cores — каждое ядро отдельно (для диагностики).
type hostStatus struct {
	singbox.Status
	Cores map[string]singbox.Status `json:"cores"`
}

// applyResult — что получилось после apply / start.
type applyResult struct {
	hostStatus
	HostVersion string               `json:"hostVersion"` // расширение сверяет: старый компаньон — «Обновите компаньон»
	Restarted   bool                 `json:"restarted"`   // какое-то ядро перезапускалось (его конфиг поменялся)
	Servers     map[string]int       `json:"servers"`     // id → порт, только запущенные
	Errors      []singbox.EntryError `json:"errors"`      // серверы, которые не запустятся, и почему
	Warnings    map[string][]string  `json:"warnings,omitempty"`
}

// splitEntries — серверы sing-box и серверы Xray (по ссылке; нераспознанную ссылку разберёт
// и объяснит sing-box).
func splitEntries(list []singbox.Entry) (sb, xr []singbox.Entry) {
	for _, e := range list {
		if s, err := links.Parse(e.Link); err == nil && xray.Needed(s) {
			xr = append(xr, e)
		} else {
			sb = append(sb, e)
		}
	}
	return sb, xr
}

func entriesKey(list []singbox.Entry, level string) string {
	if len(list) == 0 {
		return ""
	}
	b, _ := json.Marshal(struct {
		S []singbox.Entry
		L string
	}{list, level})
	return string(b)
}

// apply: собрать конфиги → проверить каждым ядром → (пере)запустить то, что изменилось.
// Тот же список, что уже работает, — ничего не перезапускается (смена сервера и правила сайтов
// меняют только PAC в расширении, а для Xray — только need).
func (h *nmHost) apply(req *nm.Request) (*applyResult, error) {
	var p struct {
		Servers  []singbox.Entry `json:"servers"`
		LogLevel string          `json:"logLevel"`
		Need     *[]string       `json:"need"` // нет поля (старое расширение) — нужны все
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil {
		return nil, &nm.Error{Code: "BAD_REQUEST", Message: "apply: неверный список серверов"}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(p.Servers) == 0 {
		h.stopLocked()
		return h.resultLocked(false), nil
	}
	sbList, xrList := splitEntries(p.Servers)
	need := map[string]bool{}
	for _, e := range p.Servers {
		need[e.ID] = p.Need == nil
	}
	if p.Need != nil {
		for _, id := range *p.Need {
			need[id] = true
		}
	}
	xrNeed := false
	for _, e := range xrList {
		xrNeed = xrNeed || need[e.ID]
	}

	// Шаг 1 — собрать и проверить конфиги, ничего не трогая: если не запустится ни один сервер,
	// работающие ядра остаются как были (как и раньше было с одним sing-box).
	sbKey, xrKey := entriesKey(sbList, p.LogLevel), entriesKey(xrList, p.LogLevel)
	sbKeep := sbKey != "" && h.sb != nil && h.sb.Status().Running && sbKey == h.sbKey
	newBuilt := h.built
	if sbKey == "" {
		newBuilt = nil
	} else if !sbKeep {
		core, err := h.sbCoreLocked()
		if err != nil {
			return nil, err
		}
		b, err := singbox.Validate(core.Bin, core.DataDir, sbList, p.LogLevel)
		if err != nil && !isNoServers(err) {
			return nil, err
		}
		newBuilt = b
	}
	xrSame := xrKey != "" && xrKey == h.xrKey && h.xbuilt != nil
	newXBuilt := h.xbuilt
	if xrKey == "" {
		newXBuilt = nil
	} else if !xrSame {
		xb, err := h.validateXrayLocked(xrList, p.LogLevel)
		if err != nil {
			return nil, err
		}
		newXBuilt = xb
	}
	sbOK := newBuilt != nil && len(newBuilt.Ports) > 0
	xrOK := newXBuilt != nil && len(newXBuilt.Ports) > 0
	if !sbOK && !xrOK {
		var errs []singbox.EntryError
		if newBuilt != nil {
			errs = append(errs, newBuilt.Errors...)
		}
		if newXBuilt != nil {
			errs = append(errs, newXBuilt.Errors...)
		}
		if len(p.Servers) == 1 && len(errs) == 1 {
			return nil, &nm.Error{Code: "SERVER_INVALID", Message: errs[0].Message}
		}
		return nil, &singbox.Error{Code: "NO_SERVERS", Message: "нет ни одного сервера, который можно запустить"}
	}

	// Шаг 2 — запустить, перезапустить или остановить то, что изменилось.
	restarted := false
	if !sbKeep {
		h.built, h.sbKey = newBuilt, ""
		if sbOK {
			if err := h.sb.Start(newBuilt.Config); err != nil {
				return nil, err
			}
			h.sbKey, restarted = sbKey, true
		} else {
			h.stopCore(h.sb) // серверов sing-box нет или ни один не годится
		}
	}
	h.xrNeed = xrNeed
	if !xrSame {
		h.stopCore(h.xr) // конфиг Xray поменялся — запустится заново, если нужен
		h.xbuilt, h.xrKey, h.xrStarted = newXBuilt, xrKey, ""
	}
	switch {
	case !xrNeed || !xrOK:
		h.stopCore(h.xr)
		h.xrStarted = ""
	case !(h.xr.Status().Running && h.xrStarted == xrKey):
		data, err := h.xbuilt.Config.JSON()
		if err != nil {
			return nil, &singbox.Error{Code: "START_FAILED", Message: "не удалось собрать конфиг Xray: " + err.Error()}
		}
		if err := h.xr.StartData(data, h.xbuilt.Config.PortsOf()); err != nil {
			h.xrStarted = ""
			return nil, err
		}
		h.xrStarted, restarted = xrKey, true
	}
	return h.resultLocked(restarted), nil
}

func isNoServers(err error) bool {
	se, ok := err.(*singbox.Error)
	return ok && se.Code == "NO_SERVERS"
}

// validateXrayLocked — конфиг Xray и проверка самим Xray. Нет xray.exe — серверы Xray не
// запустятся (с понятной причиной), а серверы sing-box работают.
func (h *nmHost) validateXrayLocked(list []singbox.Entry, level string) (*xray.Built, error) {
	bin, err := xray.FindBinary()
	if err != nil {
		xb := &xray.Built{Ports: map[string]int{}, Servers: map[string]*links.Server{}, Warnings: map[string][]string{}}
		for _, e := range list {
			xb.Errors = append(xb.Errors, singbox.EntryError{ID: e.ID, Message: err.Error()})
		}
		hostlog.Printf("%v", err)
		return xb, nil
	}
	if h.xr == nil {
		h.xr = &singbox.Core{Bin: bin, DataDir: singbox.DataDir(), Engine: xray.Engine}
	}
	xb, err := xray.Validate(bin, h.xr.DataDir, list, level)
	if err != nil && !isNoServers(err) {
		return nil, err
	}
	return xb, nil
}

// start — запустить ядра с последними конфигами из apply.
func (h *nmHost) start() (*applyResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.built == nil && h.xbuilt == nil {
		return nil, &nm.Error{Code: "NO_CONFIG", Message: "нет конфига: сначала нужен apply со списком серверов"}
	}
	restarted := false
	if h.sbRunnable() && !h.sb.Status().Running {
		if err := h.sb.Start(h.built.Config); err != nil {
			return nil, err
		}
		restarted = true
	}
	if h.xrNeed && h.xbuilt != nil && len(h.xbuilt.Ports) > 0 && h.xr != nil && !h.xr.Status().Running {
		data, _ := h.xbuilt.Config.JSON()
		if err := h.xr.StartData(data, h.xbuilt.Config.PortsOf()); err != nil {
			return nil, err
		}
		h.xrStarted, restarted = h.xrKey, true
	}
	return h.resultLocked(restarted), nil
}

func (h *nmHost) stop() hostStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopLocked()
	return h.statusLocked()
}

func (h *nmHost) status() hostStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.statusLocked()
}

// stopLocked останавливает оба ядра; конфиги и их списки остаются (для start: после него тот же
// список в apply ядро не перезапускает — sbKeep смотрит ещё и на то, работает ли ядро).
func (h *nmHost) stopLocked() {
	h.stopCore(h.sb)
	h.stopCore(h.xr)
}

func (h *nmHost) stopCore(c *singbox.Core) {
	if c != nil {
		c.Stop()
	}
}

func (h *nmHost) sbRunnable() bool { return h.built != nil && len(h.built.Ports) > 0 }

func coreStatus(c *singbox.Core) singbox.Status {
	if c == nil {
		return singbox.Status{}
	}
	return c.Status()
}

func (h *nmHost) statusLocked() hostStatus {
	sb, xr := coreStatus(h.sb), coreStatus(h.xr)
	st := hostStatus{Cores: map[string]singbox.Status{"sing-box": sb, "xray": xr}}
	sbOn := h.sbRunnable()
	xrOn := h.xrNeed && h.xbuilt != nil && len(h.xbuilt.Ports) > 0
	st.Running = (sbOn || xrOn) && (!sbOn || sb.Running) && (!xrOn || xr.Running)
	switch {
	case sb.Running:
		st.PID, st.Uptime, st.Ports = sb.PID, sb.Uptime, sb.Ports
	case xr.Running:
		st.PID, st.Uptime, st.Ports = xr.PID, xr.Uptime, xr.Ports
	}
	st.LastError = sb.LastError
	if st.LastError == "" {
		st.LastError = xr.LastError
	}
	return st
}

// errorsLocked — серверы обоих ядер, которые не запустятся.
func (h *nmHost) errorsLocked() []singbox.EntryError {
	errs := []singbox.EntryError{}
	if h.built != nil {
		errs = append(errs, h.built.Errors...)
	}
	if h.xbuilt != nil {
		errs = append(errs, h.xbuilt.Errors...)
	}
	return errs
}

// target — сервер в работающем ядре: порт и протокол.
type target struct {
	port  int
	proto string
}

// runningLocked — серверы работающих ядер.
func (h *nmHost) runningLocked() map[string]target {
	out := map[string]target{}
	if h.built != nil && h.sb != nil && h.sb.Status().Running {
		for id, port := range h.built.Ports {
			out[id] = target{port, h.built.Servers[id].Protocol}
		}
	}
	if h.xbuilt != nil && h.xr != nil && h.xr.Status().Running {
		for id, port := range h.xbuilt.Ports {
			out[id] = target{port, h.xbuilt.Servers[id].Protocol}
		}
	}
	return out
}

func (h *nmHost) resultLocked(restarted bool) *applyResult {
	r := &applyResult{hostStatus: h.statusLocked(), HostVersion: version, Restarted: restarted, Servers: map[string]int{},
		Errors: h.errorsLocked(), Warnings: map[string][]string{}}
	for id, t := range h.runningLocked() {
		r.Servers[id] = t.port
	}
	for _, w := range []map[string][]string{builtWarnings(h.built), xbuiltWarnings(h.xbuilt)} {
		for id, list := range w {
			r.Warnings[id] = list
		}
	}
	return r
}

func builtWarnings(b *singbox.Built) map[string][]string {
	if b == nil {
		return nil
	}
	return b.Warnings
}

func xbuiltWarnings(b *xray.Built) map[string][]string {
	if b == nil {
		return nil
	}
	return b.Warnings
}

// sbCoreLocked — ядро sing-box создаётся при первом apply: hello и parse_links работают и без него.
func (h *nmHost) sbCoreLocked() (*singbox.Core, error) {
	if h.sb == nil {
		bin, err := singbox.FindBinary()
		if err != nil {
			return nil, err
		}
		h.sb = &singbox.Core{Bin: bin, DataDir: singbox.DataDir()}
	}
	return h.sb, nil
}
