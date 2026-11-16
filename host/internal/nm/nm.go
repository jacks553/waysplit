// Package nm — протокол native messaging между Chrome и компаньоном.
//
// Каждое сообщение — 4 байта длины (little-endian, «родной» порядок байтов Windows x64)
// и JSON в UTF-8. Сообщение от компаньона — не больше 1 МБ (1024*1024 байт), к компаньону —
// не больше 64 МиБ (developer.chrome.com, Native messaging).
//
// Запрос {"id": 7, "cmd": "hello", …} → ответ {"id": 7, "ok": true, "result": …}
// или {"id": 7, "ok": false, "error": {"code": "PORT_BUSY", "message": "Порт 27105 занят"}}.
package nm

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime/debug"
	"sync"

	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/msg"
)

const (
	MaxOut = 1024 * 1024 // больше Chrome не примет и оборвёт соединение
	MaxIn  = 64 << 20
)

// Read читает одно сообщение. Соединение закрыто между сообщениями — io.EOF.
func Read(r io.Reader) ([]byte, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("сообщение оборвано на длине")
		}
		return nil, err
	}
	n := binary.LittleEndian.Uint32(head[:])
	if n > MaxIn {
		return nil, fmt.Errorf("сообщение слишком большое: %d байт", n)
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, fmt.Errorf("сообщение оборвано: %w", err)
	}
	return data, nil
}

// Write пишет одно сообщение длиной и данными за один вызов.
func Write(w io.Writer, data []byte) error {
	if len(data) > MaxOut {
		return fmt.Errorf("сообщение больше 1 МБ (%d байт)", len(data))
	}
	buf := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(buf, uint32(len(data)))
	copy(buf[4:], data)
	_, err := w.Write(buf)
	return err
}

// Error — ошибка для расширения: код и понятный текст по-русски. Msg и Params — код фразы и
// значения вставок (пакет msg): по ним расширение 1.2.0 показывает текст на языке окна;
// расширения до 1.2.0 этих полей не знают и показывают Message.
type Error struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Msg     string         `json:"msg,omitempty"`
	Params  map[string]any `json:"params,omitempty"`
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) ErrorCode() string { return e.Code }

// Phrase — фраза ошибки (пустая, если её нет).
func (e *Error) Phrase() msg.Text { return msg.Text{ID: e.Msg, Params: e.Params} }

// Phrased — ошибка с кодом для расширения и фразой.
func Phrased(code string, t msg.Text) *Error {
	return &Error{Code: code, Message: t.Ru(), Msg: t.ID, Params: t.Params}
}

// Wrap — ошибка с кодом для расширения из любой ошибки: текст — её текст, фраза — её фраза, если
// она и есть весь текст ошибки.
func Wrap(code string, err error) *Error {
	e := &Error{Code: code, Message: err.Error()}
	if t, ok := msg.Of(err); ok && t.Ru() == e.Message {
		e.Msg, e.Params = t.ID, t.Params
	}
	return e
}

// Request — запрос расширения. Raw — весь JSON запроса: из него команда берёт свои поля.
type Request struct {
	ID  int64           `json:"id"`
	Cmd string          `json:"cmd"`
	Raw json.RawMessage `json:"-"`
}

// Handler выполняет команду. Ошибка с методом ErrorCode() уходит со своим кодом,
// любая другая — с кодом INTERNAL.
type Handler func(ctx context.Context, req *Request) (any, error)

type response struct {
	ID     int64  `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

// Serve читает запросы из in, пока Chrome не закроет соединение (тогда возвращает nil),
// и отвечает в out. Каждый запрос выполняется отдельно: долгая команда (пинг, подписка)
// не задерживает остальные. Ответы не перемешиваются.
func Serve(ctx context.Context, in io.Reader, out io.Writer, h Handler) error {
	var mu sync.Mutex
	send := func(r response) {
		data, err := json.Marshal(r)
		if err == nil && len(data) > MaxOut {
			hostlog.Printf("ответ на запрос %d больше 1 МБ (%d байт), отправляю ошибку", r.ID, len(data))
			data, err = json.Marshal(response{ID: r.ID, Error: Phrased("RESULT_TOO_BIG", msg.New("result_too_big"))})
		}
		if err != nil {
			hostlog.Printf("ответ на запрос %d не собрался: %v", r.ID, err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if err := Write(out, data); err != nil {
			hostlog.Printf("ответ на запрос %d не отправлен: %v", r.ID, err)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	for {
		data, err := Read(in)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		req := &Request{Raw: data}
		if err := json.Unmarshal(data, req); err != nil || req.Cmd == "" {
			hostlog.Printf("непонятный запрос: %.200s", hostlog.Mask(string(data)))
			send(response{ID: req.ID, Error: Phrased("BAD_REQUEST", msg.New("bad_message"))})
			continue
		}
		go func() {
			defer func() {
				if p := recover(); p != nil {
					hostlog.Printf("сбой в команде %s: %v\n%s", req.Cmd, p, debug.Stack())
					send(response{ID: req.ID, Error: Phrased("INTERNAL", msg.New("internal"))})
				}
			}()
			result, err := h(ctx, req)
			if err != nil {
				send(response{ID: req.ID, Error: toError(err)})
				return
			}
			send(response{ID: req.ID, OK: true, Result: result})
		}()
	}
}

func toError(err error) *Error {
	e := &Error{Code: "INTERNAL", Message: hostlog.Mask(err.Error())}
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		e.Code = coded.ErrorCode()
	}
	// Фраза — только если она и есть весь текст ошибки (секреты в значениях прячутся так же).
	if t, ok := msg.Of(err); ok && t.Ru() == err.Error() {
		t = t.Map(hostlog.Mask)
		e.Msg, e.Params = t.ID, t.Params
	}
	return e
}
