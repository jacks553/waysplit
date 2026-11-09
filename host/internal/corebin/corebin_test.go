package corebin

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Тестовая программа умеет притворяться ядром: на «version» печатает версию и отмечает запуск.
func TestMain(m *testing.M) {
	if v := os.Getenv("COREBIN_FAKE_VERSION"); v != "" && len(os.Args) > 1 && os.Args[1] == "version" {
		if f, err := os.OpenFile(os.Getenv("COREBIN_COUNT"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			f.WriteString("x")
			f.Close()
		}
		fmt.Println("fake version " + v)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestFindBad(t *testing.T) {
	items := make([]int, 199)
	for i := range items {
		items[i] = i
	}
	for _, badSet := range [][]int{{57}, {0}, {198}, {3, 150}, {10, 11, 12}} {
		isBad := map[int]bool{}
		for _, b := range badSet {
			isBad[b] = true
		}
		checks := 0
		check := func(part []int) error {
			checks++
			for _, x := range part {
				if isBad[x] {
					return fmt.Errorf("плохой %d", x)
				}
			}
			return nil
		}
		good, bad, errs := FindBad(items, check)
		if fmt.Sprint(bad) != fmt.Sprint(badSet) || len(errs) != len(badSet) {
			t.Errorf("плохие %v (ошибки %v), нужно %v", bad, errs, badSet)
		}
		for i, e := range errs {
			if e.Error() != fmt.Sprintf("плохой %d", badSet[i]) {
				t.Errorf("у плохого %d ошибка %q — не его собственная", badSet[i], e)
			}
		}
		if len(good)+len(bad) != len(items) {
			t.Errorf("потерялись элементы: хороших %d, плохих %d", len(good), len(bad))
		}
		for i := 1; i < len(good); i++ {
			if good[i] <= good[i-1] {
				t.Fatalf("хорошие не по порядку: %v", good)
			}
		}
		if limit := 18 * len(badSet); checks > limit {
			t.Errorf("плохие %v: проверок %d, должно быть не больше %d (по одному было бы %d)", badSet, checks, limit, len(items))
		}
	}
	// Три элемента, средний плохой — столько же проверок, сколько было по одному (без общих).
	checks := 0
	_, bad, _ := FindBad([]string{"a", "bad", "c"}, func(p []string) error {
		checks++
		if strings.Contains(strings.Join(p, ","), "bad") {
			return errors.New("нет")
		}
		return nil
	})
	if fmt.Sprint(bad) != "[bad]" || checks != 3 {
		t.Errorf("плохие %v, проверок %d (нужно 3)", bad, checks)
	}
	// Все вместе не проходят, а по отдельности — все хорошие (дело в сочетании): плохих нет.
	good, none, _ := FindBad([]int{1, 2, 3, 4}, func(p []int) error {
		if len(p) == 4 {
			return errors.New("вместе нельзя")
		}
		return nil
	})
	if len(none) != 0 || len(good) != 4 {
		t.Errorf("хорошие %v, плохие %v", good, none)
	}
}

func TestVersionCache(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-core.exe")
	src, err := os.Open(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	dst, err := os.Create(bin)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(dst, src)
	src.Close()
	dst.Close()
	if err != nil {
		t.Fatal(err)
	}
	count := filepath.Join(dir, "count")
	t.Setenv("COREBIN_FAKE_VERSION", "1.2.3")
	t.Setenv("COREBIN_COUNT", count)
	parse := func(out string) (string, bool) {
		f := strings.Fields(out)
		return f[len(f)-1], len(f) == 3 && f[0] == "fake"
	}
	runs := func() int { b, _ := os.ReadFile(count); return len(b) }

	for i := 0; i < 3; i++ {
		v, err := Version(bin, parse)
		if err != nil || v != "1.2.3" {
			t.Fatalf("версия %q, %v", v, err)
		}
	}
	if runs() != 1 {
		t.Fatalf("программа запускалась %d раз, нужно 1 (дальше — из памяти)", runs())
	}
	// Файл «обновили»: другое время изменения — версия узнаётся заново.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(bin, later, later); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COREBIN_FAKE_VERSION", "1.2.4")
	if v, _ := Version(bin, parse); v != "1.2.4" || runs() != 2 {
		t.Errorf("после смены даты: версия %q, запусков %d", v, runs())
	}
	// Другой размер (та же дата) — тоже заново.
	f, _ := os.OpenFile(bin, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("хвост")
	f.Close()
	os.Chtimes(bin, later, later)
	t.Setenv("COREBIN_FAKE_VERSION", "1.2.5")
	if v, _ := Version(bin, parse); v != "1.2.5" || runs() != 3 {
		t.Errorf("после смены размера: версия %q, запусков %d", v, runs())
	}
	if _, err := Version(filepath.Join(dir, "нет.exe"), parse); err == nil {
		t.Error("нет файла — ошибка")
	}
}

func TestFindAndClean(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "core.exe")
	os.WriteFile(p, []byte("x"), 0o644)
	t.Setenv("COREBIN_TEST_PATH", p)
	if got := Find("COREBIN_TEST_PATH", "nope.exe"); got != p {
		t.Errorf("Find по переменной: %q", got)
	}
	t.Setenv("COREBIN_TEST_PATH", "")
	if got := Find("COREBIN_TEST_PATH", "точно-нет-такого.exe"); got != "" {
		t.Errorf("Find без файла: %q", got)
	}
	if got := Clean("\x1b[31mFATAL\x1b[0m что-то\r\nещё\r\n"); got != "FATAL что-то\nещё" {
		t.Errorf("Clean: %q", got)
	}
}
