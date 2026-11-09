package device

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	d1, created, err := Load(dir)
	if err != nil || !created || !hwidRe.MatchString(d1.HWID) {
		t.Fatalf("первый раз: %v %v %q", err, created, d1.HWID)
	}
	d2, created, err := Load(dir)
	if err != nil || created || d2.HWID != d1.HWID {
		t.Fatalf("второй раз — тот же идентификатор: %v %v %q", err, created, d2.HWID)
	}
	os.WriteFile(filepath.Join(dir, File), []byte("плохой"), 0o600)
	d3, created, _ := Load(dir)
	if !created || d3.HWID == d1.HWID || !hwidRe.MatchString(d3.HWID) {
		t.Fatalf("испорченный файл — новый идентификатор: %v %q", created, d3.HWID)
	}
	h := d3.Header()
	want := http.Header{"X-Hwid": {d3.HWID}, "X-Device-Os": {"Windows"}, "X-Ver-Os": {d3.OSVersion}, "X-Device-Model": {"Chrome"}}
	for k, v := range want {
		if h.Get(k) != v[0] {
			t.Errorf("%s = %q, нужно %q", k, h.Get(k), v[0])
		}
	}
}
