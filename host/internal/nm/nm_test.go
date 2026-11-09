package nm

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
	"testing"
	"time"
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
