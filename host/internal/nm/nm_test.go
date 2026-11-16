package nm

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"testing"
	"time"

	"waysplit/host/internal/msg"
)

func TestReadWrite(t *testing.T) {
	var buf bytes.Buffer
	msg := []byte(`{"id":1,"cmd":"hello","text":"Привет"}`)
	if err := Write(&buf, msg); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	if n := binary.LittleEndian.Uint32(raw[:4]); int(n) != len(msg) {
		t.Fatalf("длина %d, ожидалось %d байт (байты, а не символы)", n, len(msg))
	}
	if raw[0] != byte(len(msg)) || raw[3] != 0 {
		t.Errorf("длина должна идти младшим байтом вперёд: % x", raw[:4])
	}
	got, err := Read(&buf)
	if err != nil || !bytes.Equal(got, msg) {
		t.Fatalf("прочитано %q, %v", got, err)
	}
	if _, err := Read(&buf); !errors.Is(err, io.EOF) {
		t.Errorf("в конце потока ожидался io.EOF, получено %v", err)
	}
}

func TestLimits(t *testing.T) {
	if err := Write(io.Discard, make([]byte, MaxOut+1)); err == nil {
		t.Error("сообщение больше 1 МБ не должно уходить в Chrome")
	}
	if err := Write(io.Discard, make([]byte, MaxOut)); err != nil {
		t.Errorf("ровно 1 МБ можно: %v", err)
	}
	var head [4]byte
	binary.LittleEndian.PutUint32(head[:], MaxIn+1)
	if _, err := Read(bytes.NewReader(head[:])); err == nil {
		t.Error("слишком большое входящее сообщение должно давать ошибку")
	}
	if _, err := Read(bytes.NewReader([]byte{5, 0})); err == nil || errors.Is(err, io.EOF) {
		t.Errorf("оборванная длина: %v", err)
	}
	if _, err := Read(bytes.NewReader([]byte{5, 0, 0, 0, 'a'})); err == nil {
		t.Error("оборванное сообщение должно давать ошибку")
	}
}

type testErr struct{}

func (testErr) Error() string     { return "Порт 27105 занят другой программой" }
func (testErr) ErrorCode() string { return "PORT_BUSY" }

func TestServe(t *testing.T) {
	var in bytes.Buffer
	for _, m := range []string{
		`{"id":1,"cmd":"hello"}`,
		`{"id":2,"cmd":"slow"}`,
		`{"id":3,"cmd":"busy"}`,
		`{"id":4,"cmd":"oops"}`,
		`{"id":5,"cmd":"panic"}`,
		`{"id":6,"cmd":"big"}`,
		`не JSON`,
		`{"id":8,"cmd":"echo","text":"секрет d47d7dee-9073-46b1-a078-dc5be5c1524b"}`,
	} {
		Write(&in, []byte(m))
	}
	h := func(ctx context.Context, req *Request) (any, error) {
		switch req.Cmd {
		case "hello":
			return map[string]string{"hostVersion": "test"}, nil
		case "slow":
			time.Sleep(200 * time.Millisecond) // остальные не ждут
			return "медленно", nil
		case "busy":
			return nil, testErr{}
		case "oops":
			return nil, errors.New("что-то сломалось")
		case "panic":
			panic("ой")
		case "big":
			return strings.Repeat("x", MaxOut), nil
		case "echo":
			var p struct{ Text string }
			json.Unmarshal(req.Raw, &p)
			return nil, errors.New(p.Text)
		}
		return nil, &Error{Code: "UNKNOWN_CMD", Message: "?"}
	}
	var out bytes.Buffer // Serve пишет ответы по одному, под замком
	if err := Serve(context.Background(), &in, &out, h); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond) // дождаться медленной команды
	var got []response
	for {
		data, err := Read(&out)
		if err != nil {
			break
		}
		var r response
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatalf("ответ не JSON: %s", data)
		}
		got = append(got, r)
	}
	if len(got) != 8 {
		t.Fatalf("ответов %d, ожидалось 8: %+v", len(got), got)
	}
	if got[len(got)-1].ID != 2 {
		t.Errorf("медленная команда должна ответить последней, а последним пришёл ответ %d", got[len(got)-1].ID)
	}
	sort.Slice(got, func(i, j int) bool { return got[i].ID < got[j].ID })
	want := map[int64]string{1: "ok", 2: "ok", 3: "PORT_BUSY", 4: "INTERNAL", 5: "INTERNAL", 6: "RESULT_TOO_BIG", 0: "BAD_REQUEST", 8: "INTERNAL"}
	for _, r := range got {
		code := "ok"
		if !r.OK {
			code = r.Error.Code
		}
		if code != want[r.ID] {
			t.Errorf("ответ %d: %s, ожидалось %s (%+v)", r.ID, code, want[r.ID], r.Error)
		}
		if r.ID == 3 && r.Error.Message != "Порт 27105 занят другой программой" {
			t.Errorf("текст ошибки: %q", r.Error.Message)
		}
		if r.ID == 8 && strings.Contains(r.Error.Message, "d47d7dee-9073") {
			t.Errorf("uuid в тексте ошибки не замаскирован: %q", r.Error.Message)
		}
	}
}

type codedErr struct{ error }

func (codedErr) ErrorCode() string { return "PORT_BUSY" }
func (e codedErr) Unwrap() error   { return e.error }

// Ошибка для расширения: прежний текст (его видят расширения до 1.2.0) и фраза — только если
// фраза и есть весь текст; секреты прячутся и в тексте, и во вставках.
func TestToError(t *testing.T) {
	busy := msg.E("port_busy", "port", 27105)
	e := toError(codedErr{busy})
	if e.Code != "PORT_BUSY" || e.Message != "Порт 27105 занят другой программой" || e.Msg != "port_busy" || e.Params["port"] != 27105 {
		t.Errorf("с фразой: %#v", *e)
	}
	e = toError(fmt.Errorf("перед фразой: %w", busy))
	if e.Code != "INTERNAL" || e.Message != "перед фразой: Порт 27105 занят другой программой" || e.Msg != "" || e.Params != nil {
		t.Errorf("фраза — не весь текст: %#v", *e)
	}
	e = toError(errors.New("просто текст"))
	if e.Message != "просто текст" || e.Msg != "" {
		t.Errorf("без фразы: %#v", *e)
	}
	uuid := "123e4567-e89b-12d3-a456-426614174000"
	e = toError(msg.E("sub_net", "reason", msg.New("raw", "error", "сбой "+uuid)))
	inner, _ := e.Params["reason"].(msg.Text)
	if strings.Contains(e.Message, uuid) || e.Msg != "sub_net" || inner.Params["error"] != "сбой 123e…" {
		t.Errorf("секрет во вставке: %#v", *e)
	}
	data, _ := json.Marshal(e)
	if want := `{"code":"INTERNAL","message":"подписка не скачалась: сбой 123e…","msg":"sub_net","params":{"reason":{"msg":"raw","params":{"error":"сбой 123e…"}}}}`; string(data) != want {
		t.Errorf("JSON %s, нужно %s", data, want)
	}
}

func TestWrapPhrased(t *testing.T) {
	e := Wrap("NO_ANSWER", msg.E("exit_ip_not_ip"))
	if e.Code != "NO_ANSWER" || e.Msg != "exit_ip_not_ip" || e.Message != "api.ipify.org вернул не IP-адрес" {
		t.Errorf("Wrap: %#v", *e)
	}
	if e := Wrap("NO_ANSWER", errors.New("timeout")); e.Msg != "" || e.Message != "timeout" {
		t.Errorf("Wrap без фразы: %#v", *e)
	}
	e = Phrased("BAD_REQUEST", msg.New("unknown_cmd", "cmd", "x"))
	if e.Message != "компаньон не знает команду «x» — обновите компаньон" || e.Msg != "unknown_cmd" || e.Params["cmd"] != "x" {
		t.Errorf("Phrased: %#v", *e)
	}
	if p := e.Phrase(); p.ID != "unknown_cmd" {
		t.Errorf("Phrase: %+v", p)
	}
	// Ошибка без фразы в JSON — прежняя: только code и message.
	data, _ := json.Marshal(&Error{Code: "X", Message: "y"})
	if string(data) != `{"code":"X","message":"y"}` {
		t.Errorf("JSON без фразы: %s", data)
	}
}
