// Command release собирает то, что получают пользователи (SPEC-STORE.md, этап 9):
//
//	go run ./release store [-draft]      — store/waysplit-<версия>.zip для Chrome Web Store:
//	                                       копия extension/ без поля key и лишних файлов;
//	go run ./release companion [-draft] [-cores папка]
//	                                     — dist/Waysplit-companion.zip (имя без версии) и .sha256
//	                                       рядом: waysplit-host.exe, ядра sing-box и Xray (из папки
//	                                       -cores, по умолчанию dist/cores; SHA-256 — tools/cores.json),
//	                                       установщик, инструкция, лицензии;
//	go run ./release extension [-draft]  — dist/Waysplit-extension.zip (имя без версии) и .sha256:
//	                                       расширение для ручной установки — extension/ с полем key
//	                                       (ID версии для разработки), без ключей и служебных файлов;
//	go run ./release public [-author …] [-message …]
//	                                     — публичный репозиторий в dist/public: последний коммит без
//	                                       внутренних заметок, проверка на секреты (public.go).
//
// Сборки сначала всё проверяют и при ошибке ничего не пишут. -draft — собрать, даже если
// в ссылках ещё заглушка имени на GitHub (GITHUB_USER): только для первой загрузки в магазин,
// которая нужна, чтобы узнать ID (SPEC-STORE.md, 4.2), — не для публикации.
//
// Запуск из папки tools (или tools\build-store.ps1, tools\build-companion.ps1).
package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// placeholder — заглушка имени на GitHub в ссылках (extension/lib/companion.js).
const placeholder = "GITHUB_USER"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	draft := fs.Bool("draft", false, "собрать с заглушкой имени на GitHub (не для публикации)")
	rootDir := fs.String("root", "..", "папка проекта")
	out := fs.String("out", "", "public: куда выгрузить (по умолчанию dist/public)")
	author := fs.String("author", "", "public: автор единственного коммита — служебный адрес GitHub")
	message := fs.String("message", "", "public: сообщение коммита (по умолчанию «Waysplit <версия>»)")
	cores := fs.String("cores", "", "companion: папка с файлами ядер (по умолчанию dist/cores)")
	fs.Parse(os.Args[2:])
	root, err := filepath.Abs(*rootDir)
	if err == nil {
		_, err = os.Stat(filepath.Join(root, "extension", "manifest.json"))
	}
	if err != nil {
		fail(fmt.Errorf("не нашёл папку проекта (%s): запускайте из папки tools", *rootDir))
	}
	switch os.Args[1] {
	case "store":
		err = buildStore(root, *draft)
	case "extension":
		err = buildExtension(root, *draft)
	case "companion":
		dir := *cores
		if dir == "" {
			dir = filepath.Join(root, "dist", "cores")
		}
		err = buildCompanion(root, dir, *draft)
	case "public":
		dir := *out
		if dir == "" {
			dir = filepath.Join(root, "dist", "public")
		}
		err = buildPublic(root, dir, *author, *message)
	default:
		usage()
	}
	if err != nil {
		fail(err)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "использование: go run ./release store [-draft] | extension [-draft] | companion [-draft] [-cores папка] | public [-out папка] [-author \"Имя <ID+имя@users.noreply.github.com>\"] [-message текст]")
	os.Exit(2)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "ОШИБКА:", err)
	os.Exit(1)
}

// --- общее ---

// entry — файл в архиве: имя (через «/») и содержимое.
type entry struct {
	name string
	data []byte
}

// writeZip пишет архив: файлы по алфавиту, у всех одно время — одинаковый код даёт
// одинаковый архив. Имена с русскими буквами — с флагом UTF-8 (archive/zip ставит его сам).
// Сжатие — сильнейшее: архив компаньона с ядрами меньше примерно на 1,2 МБ (сборка — на секунды
// дольше), а распаковывает его любая программа, и «Извлечь всё» в Windows тоже.
func writeZip(path string, files []entry, stamp time.Time) error {
	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, flate.BestCompression)
	})
	for _, f := range files {
		if strings.Contains(f.name, `\`) || strings.HasPrefix(f.name, "/") {
			return fmt.Errorf("плохое имя в архиве: %s", f.name)
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: f.name, Method: zip.Deflate, Modified: stamp})
		if err != nil {
			return err
		}
		if _, err := w.Write(f.data); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func sha256File(path string) (string, int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	return sha256Hex(data), int64(len(data)), nil
}

// commitTime — время последнего коммита (время файлов в архивах); без git — сейчас.
// dirty — есть незакоммиченные изменения: архив тогда не совпадёт с кодом в репозитории.
func commitTime(root string) (t time.Time, dirty bool) {
	out, err := exec.Command("git", "-C", root, "log", "-1", "--format=%ct").Output()
	if err != nil {
		return time.Now().UTC().Truncate(time.Second), false
	}
	sec, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return time.Now().UTC().Truncate(time.Second), false
	}
	st, _ := exec.Command("git", "-C", root, "status", "--porcelain").Output()
	return time.Unix(sec, 0).UTC(), len(bytes.TrimSpace(st)) > 0
}

var repoRe = regexp.MustCompile(`REPO_URL = '(https://github\.com/[^']+)'`)

// repoURL — адрес репозитория из extension/lib/companion.js (одно место для всех ссылок).
func repoURL(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "extension", "lib", "companion.js"))
	if err != nil {
		return "", err
	}
	m := repoRe.FindSubmatch(data)
	if m == nil {
		return "", errors.New("в extension/lib/companion.js нет REPO_URL")
	}
	return string(m[1]), nil
}

// checkPlaceholder — заглушка имени на GitHub допустима только с -draft.
func checkPlaceholder(url string, draft bool) error {
	if !strings.Contains(url, placeholder) {
		return nil
	}
	if draft {
		fmt.Println("Внимание: в ссылках заглушка", placeholder, "— архив только для первой загрузки (узнать ID), не для публикации.")
		return nil
	}
	return fmt.Errorf("в ссылках ещё заглушка %s (extension/lib/companion.js, REPO_URL): впишите имя на GitHub или соберите с -draft", placeholder)
}

func printDirty(dirty bool) {
	if dirty {
		fmt.Println("Внимание: есть незакоммиченные изменения — перед выпуском закоммитьте и соберите заново.")
	}
}
