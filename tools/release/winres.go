package main

// Значок и сведения о версии waysplit-host.exe: их показывают Проводник («Свойства» →
// «Подробно»), диспетчер задач и окна Windows с предупреждениями. Ресурсы Windows собираются
// в объектный файл COFF (.syso), который go build сам берёт из папки пакета, — без сторонних
// программ (rc.exe, windres) и библиотек. Устройство — как у akavel/rsrc и go-winres: одна секция
// .rsrc, дерево каталогов «тип → номер → язык», а адреса данных — через перемещения
// IMAGE_REL_AMD64_ADDR32NB: в поле лежит смещение от начала секции, компоновщик Go прибавляет
// к нему адрес секции в exe.

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	// sysoName — объектный файл в папке host на время сборки; по имени файла — только для windows/amd64.
	sysoName = "rsrc_windows_amd64.syso"
	// iconFile — значок компаньона (рисует go run ./icons).
	iconFile = "tools/companion/waysplit.ico"

	rtIcon      = 3
	rtGroupIcon = 14
	rtVersion   = 16

	langNeutral = 0x0000 // значок — без языка
	langRussian = 0x0419 // сведения о версии — по-русски
	cpUnicode   = 0x04B0 // кодовая страница строк: UTF-16
)

var le = binary.LittleEndian

// resItem — ресурс: тип, номер, язык, данные.
type resItem struct {
	typ, id, lang uint32
	data          []byte
}

// winresObject — .syso со значком (файл .ico) и сведениями о версии.
func winresObject(ico []byte, version string) ([]byte, error) {
	items, err := iconResources(ico)
	if err != nil {
		return nil, err
	}
	ver, err := versionInfo(version)
	if err != nil {
		return nil, err
	}
	items = append(items, resItem{rtVersion, 1, langRussian, ver})
	return coffObject(rsrcSection(items)), nil
}

// --- значок ---

// iconResources — .ico в ресурсы: каждая картинка — RT_ICON (номера 1…n), их список — RT_GROUP_ICON
// номер 1 (по нему Проводник и берёт значок файла).
func iconResources(ico []byte) ([]resItem, error) {
	if len(ico) < 6 || le.Uint16(ico[0:]) != 0 || le.Uint16(ico[2:]) != 1 {
		return nil, errors.New("значок: это не файл .ico")
	}
	n := int(le.Uint16(ico[4:]))
	if n == 0 || len(ico) < 6+16*n {
		return nil, errors.New("значок: испорчен заголовок .ico")
	}
	group := slices.Clone(ico[:6])
	var items []resItem
	for i := 0; i < n; i++ {
		e := ico[6+16*i : 6+16*(i+1)]
		size, off := le.Uint32(e[8:]), le.Uint32(e[12:])
		if size == 0 || uint64(off)+uint64(size) > uint64(len(ico)) {
			return nil, fmt.Errorf("значок: картинка %d за пределами файла", i+1)
		}
		id := uint32(i + 1)
		items = append(items, resItem{rtIcon, id, langNeutral, ico[off : off+size]})
		group = append(group, e[:12]...) // ширина, высота, цвета, резерв, плоскости, бит на точку, размер
		group = le.AppendUint16(group, uint16(id))
	}
	return append(items, resItem{rtGroupIcon, 1, langNeutral, group}), nil
}

// --- сведения о версии ---

// versionStrings — строки сведений о версии.
func versionStrings(version string) [][2]string {
	return [][2]string{
		{"CompanyName", "The Waysplit Authors"},
		{"FileDescription", "Компаньон Waysplit"}, // это имя видно в диспетчере задач
		{"FileVersion", version},
		{"InternalName", "waysplit-host"},
		{"LegalCopyright", "Copyright 2026 The Waysplit Authors. Apache License 2.0"},
		{"OriginalFilename", hostExe},
		{"ProductName", "Waysplit"},
		{"ProductVersion", version},
	}
}

// versionNumbers — «1.2.3» → 1, 2, 3, 0.
func versionNumbers(version string) ([4]uint32, error) {
	var nums [4]uint32
	parts := strings.Split(version, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return nums, fmt.Errorf("версия %q: нужно от одного до четырёх чисел", version)
	}
	for i, p := range parts {
		v, err := strconv.ParseUint(p, 10, 16)
		if err != nil {
			return nums, fmt.Errorf("версия %q: %q — не число до 65535", version, p)
		}
		nums[i] = uint32(v)
	}
	return nums, nil
}

// vblock — узел VS_VERSIONINFO: заголовок (длина, длина значения, тип), имя в UTF-16, значение
// и дети, каждый — с границы 4 байт.
type vblock struct {
	key      string
	text     bool   // значение — строка (тип 1)
	value    []byte // у строки — UTF-16 с нулём на конце
	valueLen uint16 // у строки — в символах UTF-16 вместе с нулём, у двоичного — в байтах
	children []vblock
}

func utf16z(s string) []byte {
	var b []byte
	for _, c := range utf16.Encode([]rune(s)) {
		b = le.AppendUint16(b, c)
	}
	return append(b, 0, 0)
}

func pad4(b []byte) []byte {
	for len(b)%4 != 0 {
		b = append(b, 0)
	}
	return b
}

func (v vblock) encode() []byte {
	b := make([]byte, 6, 128)
	b = pad4(append(b, utf16z(v.key)...))
	b = append(b, v.value...)
	for _, c := range v.children {
		b = append(pad4(b), c.encode()...)
	}
	le.PutUint16(b[0:], uint16(len(b)))
	le.PutUint16(b[2:], v.valueLen)
	if v.text {
		le.PutUint16(b[4:], 1)
	}
	return b
}

// versionInfo — ресурс VS_VERSIONINFO: номера версий и строки (язык — русский, строки — UTF-16).
func versionInfo(version string) ([]byte, error) {
	n, err := versionNumbers(version)
	if err != nil {
		return nil, err
	}
	var fixed []byte // VS_FIXEDFILEINFO
	for _, v := range []uint32{
		0xFEEF04BD, 0x00010000, // подпись, версия структуры
		n[0]<<16 | n[1], n[2]<<16 | n[3], // версия файла
		n[0]<<16 | n[1], n[2]<<16 | n[3], // версия продукта
		0x3F, 0, // какие флаги заданы; флаги
		0x00040004, // VOS_NT_WINDOWS32
		1, 0,       // VFT_APP — программа
		0, 0, // дата
	} {
		fixed = le.AppendUint32(fixed, v)
	}
	var strs []vblock
	for _, kv := range versionStrings(version) {
		u := utf16z(kv[1])
		strs = append(strs, vblock{key: kv[0], text: true, value: u, valueLen: uint16(len(u) / 2)})
	}
	table := fmt.Sprintf("%04X%04X", langRussian, cpUnicode)
	root := vblock{key: "VS_VERSION_INFO", value: fixed, valueLen: uint16(len(fixed)), children: []vblock{
		{key: "StringFileInfo", text: true, children: []vblock{{key: table, text: true, children: strs}}},
		{key: "VarFileInfo", text: true, children: []vblock{
			{key: "Translation", value: le.AppendUint32(nil, cpUnicode<<16|langRussian), valueLen: 4},
		}},
	}}
	return root.encode(), nil
}

var errBadVersion = errors.New("сведения о версии испорчены")

// readVersionStrings — строки из VS_VERSIONINFO (проверка собранного exe).
func readVersionStrings(data []byte) (map[string]string, error) {
	out := map[string]string{}
	var walk func(b []byte, depth int) error
	walk = func(b []byte, depth int) error {
		if len(b) < 6 {
			return errBadVersion
		}
		n, vlen, typ := int(le.Uint16(b[0:])), int(le.Uint16(b[2:])), le.Uint16(b[4:])
		if n < 6 || n > len(b) {
			return errBadVersion
		}
		b = b[:n]
		end := 6
		for end+1 < n && (b[end] != 0 || b[end+1] != 0) {
			end += 2
		}
		if end+1 >= n {
			return errBadVersion
		}
		key := decodeUTF16(b[6:end])
		off := (end + 2 + 3) &^ 3
		size := vlen
		if typ == 1 {
			size = 2 * vlen
		}
		if off+size > n {
			return errBadVersion
		}
		if depth == 3 && typ == 1 { // VS_VERSIONINFO → StringFileInfo → таблица → строка
			out[key] = strings.TrimRight(decodeUTF16(b[off:off+size]), "\x00")
		}
		for off = (off + size + 3) &^ 3; off < n; {
			if off+6 > n {
				return errBadVersion
			}
			cl := int(le.Uint16(b[off:]))
			if cl < 6 || off+cl > n {
				return errBadVersion
			}
			if err := walk(b[off:off+cl], depth+1); err != nil {
				return err
			}
			off = (off + cl + 3) &^ 3
		}
		return nil
	}
	return out, walk(data, 0)
}

func decodeUTF16(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = le.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u))
}

// --- секция .rsrc и объектный файл ---

// rsrcSection — данные секции .rsrc: каталоги «тип → номер → язык», записи о данных, сами данные.
// relocs — где лежат поля OffsetToData записей (смещение от начала секции).
func rsrcSection(items []resItem) (sect []byte, relocs []uint32) {
	items = slices.Clone(items)
	slices.SortFunc(items, func(a, b resItem) int {
		if a.typ != b.typ {
			return int(a.typ) - int(b.typ)
		}
		if a.id != b.id {
			return int(a.id) - int(b.id)
		}
		return int(a.lang) - int(b.lang)
	})
	type name struct{ typ, id uint32 }
	var types []uint32
	ids := map[uint32][]uint32{}
	langs := map[name][]int{} // номера в items
	for i, it := range items {
		if len(types) == 0 || types[len(types)-1] != it.typ {
			types = append(types, it.typ)
		}
		if l := ids[it.typ]; len(l) == 0 || l[len(l)-1] != it.id {
			ids[it.typ] = append(l, it.id)
		}
		langs[name{it.typ, it.id}] = append(langs[name{it.typ, it.id}], i)
	}
	dirSize := func(n int) int { return 16 + 8*n }
	off := dirSize(len(types))
	typeAt := map[uint32]int{}
	for _, t := range types {
		typeAt[t] = off
		off += dirSize(len(ids[t]))
	}
	nameAt := map[name]int{}
	for _, t := range types {
		for _, id := range ids[t] {
			nameAt[name{t, id}] = off
			off += dirSize(len(langs[name{t, id}]))
		}
	}
	entryAt := make([]int, len(items))
	for i := range items {
		entryAt[i] = off
		off += 16
	}
	dataAt := make([]int, len(items))
	for i, it := range items {
		off = (off + 7) &^ 7
		dataAt[i] = off
		off += len(it.data)
	}
	sect = make([]byte, (off+3)&^3)
	const subdir = 0x80000000
	putDir := func(at int, entries [][2]uint32) { // все записи — с номерами, без имён
		le.PutUint16(sect[at+14:], uint16(len(entries)))
		for i, e := range entries {
			le.PutUint32(sect[at+16+8*i:], e[0])
			le.PutUint32(sect[at+16+8*i+4:], e[1])
		}
	}
	var root [][2]uint32
	for _, t := range types {
		root = append(root, [2]uint32{t, subdir | uint32(typeAt[t])})
		var byID [][2]uint32
		for _, id := range ids[t] {
			byID = append(byID, [2]uint32{id, subdir | uint32(nameAt[name{t, id}])})
			var byLang [][2]uint32
			for _, i := range langs[name{t, id}] {
				byLang = append(byLang, [2]uint32{items[i].lang, uint32(entryAt[i])})
			}
			putDir(nameAt[name{t, id}], byLang)
		}
		putDir(typeAt[t], byID)
	}
	putDir(0, root)
	for i, it := range items {
		le.PutUint32(sect[entryAt[i]:], uint32(dataAt[i]))
		le.PutUint32(sect[entryAt[i]+4:], uint32(len(it.data)))
		copy(sect[dataAt[i]:], it.data)
		relocs = append(relocs, uint32(entryAt[i]))
	}
	return sect, relocs
}

// coffObject — объектный файл COFF для x64: секция .rsrc, её перемещения и её символ.
func coffObject(sect []byte, relocs []uint32) []byte {
	const (
		headers     = 20 + 40    // заголовок файла и одной секции
		relocSize   = 10         //
		machine     = 0x8664     // IMAGE_FILE_MACHINE_AMD64
		addr32NB    = 3          // IMAGE_REL_AMD64_ADDR32NB — адрес относительно начала exe
		rsrcFlags   = 0x40000040 // IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ
		classStatic = 3          // IMAGE_SYM_CLASS_STATIC
	)
	relocAt := headers + len(sect)
	symAt := relocAt + relocSize*len(relocs)
	name := []byte(".rsrc\x00\x00\x00")
	var b []byte
	b = le.AppendUint16(b, machine)
	b = le.AppendUint16(b, 1)             // секций
	b = le.AppendUint32(b, 0)             // время — ноль: одинаковый код даёт одинаковый файл
	b = le.AppendUint32(b, uint32(symAt)) // таблица символов
	b = le.AppendUint32(b, 1)             // символов
	b = le.AppendUint16(b, 0)             // необязательного заголовка нет
	b = le.AppendUint16(b, 0)             // признаки
	b = append(b, name...)
	b = le.AppendUint32(b, 0) // VirtualSize
	b = le.AppendUint32(b, 0) // VirtualAddress
	b = le.AppendUint32(b, uint32(len(sect)))
	b = le.AppendUint32(b, headers)
	b = le.AppendUint32(b, uint32(relocAt))
	b = le.AppendUint32(b, 0) // номера строк
	b = le.AppendUint16(b, uint16(len(relocs)))
	b = le.AppendUint16(b, 0)
	b = le.AppendUint32(b, rsrcFlags)
	b = append(b, sect...)
	for _, r := range relocs {
		b = le.AppendUint32(b, r)
		b = le.AppendUint32(b, 0) // символ 0 — сама секция .rsrc
		b = le.AppendUint16(b, addr32NB)
	}
	b = append(b, name...)
	b = le.AppendUint32(b, 0) // значение
	b = le.AppendUint16(b, 1) // секция 1
	b = le.AppendUint16(b, 0) // тип
	b = append(b, classStatic, 0)
	return le.AppendUint32(b, 4) // таблица строк — пустая
}

// --- проверка ---

// readResources — ресурсы из exe или .syso (у .syso адрес секции — ноль, поэтому смещения те же).
func readResources(file []byte) ([]resItem, error) {
	f, err := pe.NewFile(bytes.NewReader(file))
	if err != nil {
		return nil, err
	}
	s := f.Section(".rsrc")
	if s == nil {
		return nil, errors.New("нет ресурсов (секции .rsrc)")
	}
	data, err := s.Data()
	if err != nil {
		return nil, err
	}
	bad := errors.New("ресурсы испорчены")
	var items []resItem
	var walk func(at uint32, level int, path [3]uint32) error
	walk = func(at uint32, level int, path [3]uint32) error {
		if uint64(at)+16 > uint64(len(data)) {
			return bad
		}
		n := uint32(le.Uint16(data[at+12:])) + uint32(le.Uint16(data[at+14:]))
		for i := uint32(0); i < n; i++ {
			e := at + 16 + 8*i
			if uint64(e)+8 > uint64(len(data)) {
				return bad
			}
			path[level] = le.Uint32(data[e:])
			target := le.Uint32(data[e+4:])
			if target&0x80000000 != 0 {
				if level == 2 {
					return bad
				}
				if err := walk(target&^0x80000000, level+1, path); err != nil {
					return err
				}
				continue
			}
			if level != 2 || uint64(target)+16 > uint64(len(data)) {
				return bad
			}
			rva, size := le.Uint32(data[target:]), le.Uint32(data[target+4:])
			start := uint64(rva) - uint64(s.VirtualAddress)
			if rva < s.VirtualAddress || start+uint64(size) > uint64(len(data)) {
				return bad
			}
			items = append(items, resItem{path[0], path[1], path[2], data[start : start+uint64(size)]})
		}
		return nil
	}
	return items, walk(0, 0, [3]uint32{})
}

// checkExeResources — в собранном exe есть значок и сведения о версии, и версия в них нужная.
func checkExeResources(exe []byte, version string) error {
	items, err := readResources(exe)
	if err != nil {
		return err
	}
	var icons, groups int
	var ver []byte
	for _, it := range items {
		switch it.typ {
		case rtIcon:
			icons++
		case rtGroupIcon:
			groups++
		case rtVersion:
			ver = it.data
		}
	}
	if icons == 0 || groups != 1 {
		return fmt.Errorf("нет значка (картинок %d, наборов %d)", icons, groups)
	}
	if ver == nil {
		return errors.New("нет сведений о версии")
	}
	strs, err := readVersionStrings(ver)
	if err != nil {
		return err
	}
	if strs["FileVersion"] != version || strs["ProductVersion"] != version {
		return fmt.Errorf("в сведениях о версии %q / %q, ждали %s", strs["FileVersion"], strs["ProductVersion"], version)
	}
	return nil
}
