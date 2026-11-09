// Package device — идентификатор этого компьютера для подписок с привязкой к устройствам
// (HWID, SPEC-SUBS.md). Один на компьютер: его берут и расширение (обновление подписок),
// и отладочные команды компаньона — у провайдера устройство одно, а не несколько.
package device

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Device — заголовки устройства, как у панели Remnawave (docs.rw, «HWID device limit»):
// обязателен только x-hwid, остальные уточняют устройство в списке у провайдера. Никаких
// настоящих данных компьютера: идентификатор — случайный UUID этой установки, ОС — Windows и
// её версия, модель — «Chrome» (решение автора: так устройство понятно в списке у провайдера).
type Device struct {
	HWID      string `json:"-"`
	OS        string `json:"os"`
	OSVersion string `json:"osVersion"`
	Model     string `json:"model"`
}

// Apply добавляет заголовки устройства к запросу.
func (d *Device) Apply(h http.Header) {
	h.Set("x-hwid", d.HWID)
	h.Set("x-device-os", d.OS)
	h.Set("x-ver-os", d.OSVersion)
	h.Set("x-device-model", d.Model)
}

// Header — заголовки устройства отдельно (для запроса подписки).
func (d *Device) Header() http.Header {
	h := http.Header{}
	d.Apply(h)
	return h
}

// Short — идентификатор для показа: первые 4 символа.
func (d *Device) Short() string {
	if len(d.HWID) < 4 {
		return "…"
	}
	return d.HWID[:4] + "…"
}

// File — файл с идентификатором в папке данных компаньона.
const File = "device-id"

// Remnawave принимает x-hwid только такого вида (иначе заголовок не учитывается).
var hwidRe = regexp.MustCompile(`^[a-zA-Z0-9=-]{10,64}$`)

// Load читает идентификатор из папки данных; если его нет — создаёт (случайный UUID)
// и запоминает. created — создан сейчас.
func Load(dir string) (d *Device, created bool, err error) {
	path := filepath.Join(dir, File)
	id := ""
	if b, err := os.ReadFile(path); err == nil {
		id = strings.TrimSpace(string(b))
	}
	if !hwidRe.MatchString(id) {
		id, err = newUUID()
		if err != nil {
			return nil, false, err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, false, err
		}
		if err := os.WriteFile(path, []byte(id+"\n"), 0o600); err != nil {
			return nil, false, errors.New("не удалось сохранить идентификатор устройства: " + err.Error())
		}
		created = true
	}
	return &Device{HWID: id, OS: "Windows", OSVersion: windowsVersion(), Model: "Chrome"}, created, nil
}

// newUUID — случайный UUID версии 4.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
