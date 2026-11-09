// Command icons рисует значки расширения:
//
//	extension/icons/icon{16,32,48}.png — основной значок: белый знак на сине-бирюзовом фоне;
//	extension/icons/icon128.png        — для магазина и страницы установки: рисунок 96×96
//	                                     и по 16 пикселей прозрачных полей (правило Chrome Web Store);
//	extension/icons/state-{off,on,rules,error}-{16,32}.png — значок на панели по состоянию:
//	серый — выключено, зелёный — VPN включён, жёлтый — работают только правила, красный — ошибка;
//	tools/companion/waysplit.ico — значок waysplit-host.exe (тот же, что у расширения): картинки
//	16…256 в PNG, его вшивает в exe сборка архива компаньона (tools/release, winres.go).
//
// Знак — глиф call_split из Material Symbols (Google, стиль Rounded, лицензия Apache-2.0).
// Файл call_split_24px.svg рядом взят как есть из github.com/google/material-design-icons
// (symbols/web/call_split/materialsymbolsrounded/call_split_24px.svg); текст лицензии лежит
// рядом со значками — extension/icons/LICENSE-material-symbols.txt. Фон — скруглённый квадрат
// с переходом цвета. Края сглажены: 8×8 проб на пиксель.
//
// Запуск из папки tools:
//
//	go run ./icons                    — значки расширения;
//	go run ./icons -preview файл.png  — лист для проверки: значки на светлой и тёмной панели,
//	                                    маленькие — ещё и увеличенными.
package main

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type rgb struct{ r, g, b float64 }

// style — цвета фона: сверху-слева → снизу-справа.
type style struct{ top, bottom rgb }

var (
	brand  = style{rgb{0x25, 0x63, 0xeb}, rgb{0x0d, 0x94, 0x88}} // синий → бирюзовый
	states = map[string]style{
		"off":   {rgb{0x9a, 0xa3, 0xb2}, rgb{0x6b, 0x73, 0x80}}, // серый
		"on":    {rgb{0x16, 0xa3, 0x4a}, rgb{0x0d, 0x94, 0x88}}, // зелёный
		"rules": {rgb{0xf5, 0x9e, 0x0b}, rgb{0xd9, 0x77, 0x06}}, // жёлтый
		"error": {rgb{0xef, 0x44, 0x44}, rgb{0xb9, 0x1c, 0x1c}}, // красный
	}
)

//go:embed call_split_24px.svg
var glyphSVG string

// glyph — контуры знака в квадрате 0…1 (это поле 24×24 Material Symbols; сам знак — 16×16 в середине).
var glyph = mustGlyph(glyphSVG)

const (
	samples = 8   // проб на пиксель по каждой оси
	radius  = 0.2 // скругление углов фона, в долях стороны
)

func main() {
	preview := flag.String("preview", "", "нарисовать лист для проверки в этот файл")
	promo := flag.String("promo", "", "нарисовать малую промо-картинку магазина 440×280 в этот файл")
	ico := flag.String("ico", filepath.Join("companion", "waysplit.ico"), "значок компаньона (.ico)")
	flag.Parse()
	if *preview != "" {
		save(*preview, previewSheet())
		return
	}
	if *promo != "" {
		save(*promo, promoTile(440, 280))
		return
	}
	dir := filepath.Join("..", "extension", "icons")
	if flag.NArg() > 0 {
		dir = flag.Arg(0)
	}
	for _, size := range []int{16, 32, 48} {
		save(filepath.Join(dir, fmt.Sprintf("icon%d.png", size)), render(size, brand))
	}
	save(filepath.Join(dir, "icon128.png"), storeIcon(brand))
	for name, st := range states {
		for _, size := range []int{16, 32} {
			save(filepath.Join(dir, fmt.Sprintf("state-%s-%d.png", name, size)), render(size, st))
		}
	}
	data, err := iconICO(exeSizes, brand)
	if err == nil {
		err = os.WriteFile(*ico, data, 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Ошибка:", err)
		os.Exit(1)
	}
	fmt.Println("нарисован", *ico)
}

// exeSizes — картинки в значке компаньона: Проводник, панель задач и окна Windows берут
// подходящую под масштаб экрана.
var exeSizes = []int{16, 20, 24, 32, 40, 48, 64, 256}

// iconICO — файл .ico из картинок render нужных размеров; каждая — PNG (так умеют Windows Vista
// и новее, а файл в разы меньше).
func iconICO(sizes []int, st style) ([]byte, error) {
	le := binary.LittleEndian
	var imgs [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		if err := png.Encode(&buf, render(s, st)); err != nil {
			return nil, err
		}
		imgs = append(imgs, buf.Bytes())
	}
	b := le.AppendUint16(nil, 0)               // резерв
	b = le.AppendUint16(b, 1)                  // тип: значок
	b = le.AppendUint16(b, uint16(len(sizes))) // картинок
	off := 6 + 16*len(sizes)
	for i, s := range sizes {
		side := byte(s) // 256 записывается нулём
		b = append(b, side, side, 0, 0)
		b = le.AppendUint16(b, 1)  // плоскостей
		b = le.AppendUint16(b, 32) // бит на точку
		b = le.AppendUint32(b, uint32(len(imgs[i])))
		b = le.AppendUint32(b, uint32(off))
		off += len(imgs[i])
	}
	for _, img := range imgs {
		b = append(b, img...)
	}
	return b, nil
}

func save(path string, img image.Image) {
	f, err := os.Create(path)
	if err == nil {
		err = png.Encode(f, img)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Ошибка:", err)
		os.Exit(1)
	}
	fmt.Println("нарисован", path)
}

// storeIcon — значок 128×128 по правилу магазина: рисунок 96×96 в середине, по 16 пикселей
// прозрачных полей с каждой стороны.
func storeIcon(st style) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 128, 128))
	draw.Draw(img, image.Rect(16, 16, 112, 112), render(96, st), image.Point{}, draw.Src)
	return img
}

// glyphBox — сторона поля знака (24×24 у Material Symbols) в долях значка. На 16 пикселях
// знак чуть крупнее: иначе линии тоньше полутора пикселей и сереют.
func glyphBox(size int) float64 {
	if size <= 16 {
		return 1.125
	}
	return 1
}

// render — фон на весь квадрат size×size и белый знак в середине.
func render(size int, st style) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	box := glyphBox(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var bg, white float64
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					px := (float64(x) + (float64(sx)+0.5)/samples) / float64(size)
					py := (float64(y) + (float64(sy)+0.5)/samples) / float64(size)
					if roundRect(px, py, 0.5, 0.5, 0.5, 0.5, radius) > 0 {
						continue
					}
					bg++
					if inside(glyph, (px-0.5)/box+0.5, (py-0.5)/box+0.5) {
						white++
					}
				}
			}
			if bg == 0 {
				continue
			}
			t := (float64(x) + float64(y) + 1) / float64(2*size)
			c := rgb{lerp(st.top.r, st.bottom.r, t), lerp(st.top.g, st.bottom.g, t), lerp(st.top.b, st.bottom.b, t)}
			k := white / bg // доля белого внутри фона
			c = rgb{lerp(c.r, 255, k), lerp(c.g, 255, k), lerp(c.b, 255, k)}
			img.SetNRGBA(x, y, color.NRGBA{uint8(c.r + 0.5), uint8(c.g + 0.5), uint8(c.b + 0.5), uint8(bg/(samples*samples)*255 + 0.5)})
		}
	}
	return img
}

// roundRect — расстояние до скруглённого прямоугольника (отрицательное — внутри).
func roundRect(x, y, cx, cy, hw, hh, r float64) float64 {
	qx := math.Abs(x-cx) - hw + r
	qy := math.Abs(y-cy) - hh + r
	return math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - r
}

func lerp(a, b, t float64) float64 { return a + (b-a)*t }

// --- знак из SVG ---

type pt struct{ x, y float64 }

// mustGlyph — контуры из атрибута d первого <path>, приведённые к квадрату 0…1 по viewBox.
func mustGlyph(svg string) [][]pt {
	vb := regexp.MustCompile(`\sviewBox="([^"]+)"`).FindStringSubmatch(svg)
	d := regexp.MustCompile(`<path[^>]*\sd="([^"]+)"`).FindStringSubmatch(svg)
	if vb == nil || d == nil {
		panic("в SVG знака нет viewBox или <path d>")
	}
	var box [4]float64
	f := strings.Fields(strings.ReplaceAll(vb[1], ",", " "))
	if len(f) != 4 {
		panic("viewBox знака: нужно 4 числа")
	}
	for i := range box {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			panic("viewBox знака: " + err.Error())
		}
		box[i] = v
	}
	polys, err := parsePath(d[1])
	if err != nil {
		panic("путь знака: " + err.Error())
	}
	for _, poly := range polys {
		for i, p := range poly {
			poly[i] = pt{(p.x - box[0]) / box[2], (p.y - box[1]) / box[3]}
		}
	}
	return polys
}

type token struct {
	cmd byte // 0 — число
	v   float64
}

func pathTokens(d string) ([]token, error) {
	var toks []token
	for i := 0; i < len(d); {
		c := d[i]
		switch {
		case c == ' ' || c == ',' || c == '\t' || c == '\n' || c == '\r':
			i++
		case strings.IndexByte("MmLlHhVvQqTtCcSsZz", c) >= 0:
			toks = append(toks, token{cmd: c})
			i++
		case c == '-' || c == '+' || c == '.' || c >= '0' && c <= '9':
			j := i
			if c == '-' || c == '+' {
				j++
			}
			dot, digits := false, false
			for ; j < len(d); j++ {
				if d[j] >= '0' && d[j] <= '9' {
					digits = true
				} else if d[j] == '.' && !dot {
					dot = true
				} else {
					break
				}
			}
			if digits && j < len(d) && (d[j] == 'e' || d[j] == 'E') {
				k := j + 1
				if k < len(d) && (d[k] == '-' || d[k] == '+') {
					k++
				}
				if k < len(d) && d[k] >= '0' && d[k] <= '9' {
					for j = k; j < len(d) && d[j] >= '0' && d[j] <= '9'; j++ {
					}
				}
			}
			v, err := strconv.ParseFloat(d[i:j], 64)
			if err != nil || !digits {
				return nil, fmt.Errorf("плохое число на месте %d", i)
			}
			toks = append(toks, token{v: v})
			i = j
		default:
			return nil, fmt.Errorf("неизвестная команда %q на месте %d", c, i)
		}
	}
	return toks, nil
}

// parsePath — путь SVG (команды M L H V Q T C S Z, большие и малые буквы) в многоугольники:
// кривые разбиты на мелкие отрезки.
func parsePath(d string) ([][]pt, error) {
	toks, err := pathTokens(d)
	if err != nil {
		return nil, err
	}
	const steps = 24 // отрезков на кривую
	var (
		polys          [][]pt
		cur            []pt
		p, start, ctrl pt
		cmd, prev      byte
	)
	flush := func() {
		if len(cur) > 2 {
			polys = append(polys, cur)
		}
		cur = nil
	}
	t := 0
	nums := func(k int) ([]float64, error) {
		if t+k > len(toks) {
			return nil, fmt.Errorf("команде %c не хватает чисел", cmd)
		}
		out := make([]float64, k)
		for i := range out {
			if toks[t+i].cmd != 0 {
				return nil, fmt.Errorf("команде %c не хватает чисел", cmd)
			}
			out[i] = toks[t+i].v
		}
		t += k
		return out, nil
	}
	for t < len(toks) {
		if toks[t].cmd != 0 {
			cmd = toks[t].cmd
			t++
		} else if cmd == 0 {
			return nil, fmt.Errorf("путь начинается не с команды")
		}
		up := cmd &^ 0x20
		var base pt
		if cmd != up {
			base = p // малая буква — от текущей точки
		}
		at := func(v []float64, i int) pt { return pt{base.x + v[i], base.y + v[i+1]} }
		switch up {
		case 'Z':
			flush()
			p = start
			cmd = 0 // после Z числа без команды — ошибка
		case 'M':
			v, err := nums(2)
			if err != nil {
				return nil, err
			}
			flush()
			p = at(v, 0)
			start = p
			cur = []pt{p}
			cmd = 'L' | cmd&0x20 // числа после M — это L
		case 'L':
			v, err := nums(2)
			if err != nil {
				return nil, err
			}
			p = at(v, 0)
			cur = append(cur, p)
		case 'H':
			v, err := nums(1)
			if err != nil {
				return nil, err
			}
			p.x = base.x + v[0]
			cur = append(cur, p)
		case 'V':
			v, err := nums(1)
			if err != nil {
				return nil, err
			}
			p.y = base.y + v[0]
			cur = append(cur, p)
		case 'Q', 'T':
			var c, e pt
			if up == 'Q' {
				v, err := nums(4)
				if err != nil {
					return nil, err
				}
				c, e = at(v, 0), at(v, 2)
			} else {
				v, err := nums(2)
				if err != nil {
					return nil, err
				}
				c, e = p, at(v, 0)
				if prev == 'Q' || prev == 'T' {
					c = pt{2*p.x - ctrl.x, 2*p.y - ctrl.y}
				}
			}
			for i := 1; i <= steps; i++ {
				s := float64(i) / steps
				u := 1 - s
				cur = append(cur, pt{u*u*p.x + 2*u*s*c.x + s*s*e.x, u*u*p.y + 2*u*s*c.y + s*s*e.y})
			}
			p, ctrl = e, c
		case 'C', 'S':
			var c1, c2, e pt
			if up == 'C' {
				v, err := nums(6)
				if err != nil {
					return nil, err
				}
				c1, c2, e = at(v, 0), at(v, 2), at(v, 4)
			} else {
				v, err := nums(4)
				if err != nil {
					return nil, err
				}
				c1, c2, e = p, at(v, 0), at(v, 2)
				if prev == 'C' || prev == 'S' {
					c1 = pt{2*p.x - ctrl.x, 2*p.y - ctrl.y}
				}
			}
			for i := 1; i <= steps; i++ {
				s := float64(i) / steps
				u := 1 - s
				a, b, cc, dd := u*u*u, 3*u*u*s, 3*u*s*s, s*s*s
				cur = append(cur, pt{a*p.x + b*c1.x + cc*c2.x + dd*e.x, a*p.y + b*c1.y + cc*c2.y + dd*e.y})
			}
			p, ctrl = e, c2
		}
		prev = up
	}
	flush()
	if len(polys) == 0 {
		return nil, fmt.Errorf("пустой путь")
	}
	return polys, nil
}

// inside — точка внутри знака (правило ненулевого обхода, как fill-rule по умолчанию в SVG).
func inside(polys [][]pt, x, y float64) bool {
	w := 0
	for _, poly := range polys {
		for i := range poly {
			a, b := poly[i], poly[(i+1)%len(poly)]
			cross := (b.x-a.x)*(y-a.y) - (x-a.x)*(b.y-a.y)
			if a.y <= y {
				if b.y > y && cross > 0 {
					w++
				}
			} else if b.y <= y && cross < 0 {
				w--
			}
		}
	}
	return w != 0
}

// --- лист для проверки ---

var (
	lightPanel = color.NRGBA{0xf1, 0xf3, 0xf4, 0xff} // панель Chrome, светлая тема
	darkPanel  = color.NRGBA{0x35, 0x36, 0x3a, 0xff} // тёмная тема
)

// previewSheet — две половины (светлая и тёмная панель): сверху 128 (с прозрачными полями), 48,
// 32, 16 как есть; ниже 16 ×6 и 32 ×3; ниже состояния 32 и 16 как есть и 16 ×4.
func previewSheet() *image.NRGBA {
	const half, h = 300, 372
	img := image.NewNRGBA(image.Rect(0, 0, 2*half, h))
	for i, bg := range []color.NRGBA{lightPanel, darkPanel} {
		x0 := i * half
		draw.Draw(img, image.Rect(x0, 0, x0+half, h), &image.Uniform{bg}, image.Point{}, draw.Src)
		paste(img, storeIcon(brand), x0+6, 6, 1)
		paste(img, render(48, brand), x0+150, 46, 1)
		paste(img, render(32, brand), x0+214, 54, 1)
		paste(img, render(16, brand), x0+262, 62, 1)
		paste(img, render(16, brand), x0+16, 146, 6)
		paste(img, render(32, brand), x0+130, 146, 3)
		for j, name := range []string{"off", "on", "rules", "error"} {
			paste(img, render(32, states[name]), x0+16+j*70, 258, 1)
			paste(img, render(16, states[name]), x0+54+j*70, 266, 1)
			paste(img, render(16, states[name]), x0+16+j*70, 298, 4)
		}
	}
	return img
}

// paste — наложить src (с прозрачностью) в точку (x, y), увеличив в scale раз.
func paste(dst *image.NRGBA, src *image.NRGBA, x, y, scale int) {
	b := src.Bounds()
	for sy := 0; sy < b.Dy(); sy++ {
		for sx := 0; sx < b.Dx(); sx++ {
			c := src.NRGBAAt(sx, sy)
			if c.A == 0 {
				continue
			}
			a := float64(c.A) / 255
			for ky := 0; ky < scale; ky++ {
				for kx := 0; kx < scale; kx++ {
					px, py := x+sx*scale+kx, y+sy*scale+ky
					d := dst.NRGBAAt(px, py)
					mix := func(s, t uint8) uint8 { return uint8(float64(s)*a + float64(t)*(1-a) + 0.5) }
					dst.SetNRGBA(px, py, color.NRGBA{mix(c.R, d.R), mix(c.G, d.G), mix(c.B, d.B), 0xff})
				}
			}
		}
	}
}

// --- промо-картинка магазина ---

// promoTile — малая промо-картинка Chrome Web Store (440×280): по правилам магазина без текста,
// насыщенные цвета на всю площадь, читается и вдвое меньше. Фон — переход цвета значка, мягкое
// светлое пятно за знаком, знак — белый, высотой в половину картинки.
func promoTile(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	const n = 6              // проб на пиксель по каждой оси
	box := float64(h) * 0.75 // поле 24×24 Material: сам знак — 2/3 поля, то есть половина высоты
	cx, cy := float64(w)/2, float64(h)/2
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			t := (float64(x)/float64(w) + float64(y)/float64(h)) / 2
			c := rgb{lerp(brand.top.r, brand.bottom.r, t), lerp(brand.top.g, brand.bottom.g, t), lerp(brand.top.b, brand.bottom.b, t)}
			// Светлое пятно за знаком: к краям сходит на нет.
			d := math.Hypot(float64(x)+0.5-cx, (float64(y)+0.5-cy)*1.15) / (float64(h) * 0.62)
			glow := 0.16 * math.Max(0, 1-d*d)
			c = rgb{lerp(c.r, 255, glow), lerp(c.g, 255, glow), lerp(c.b, 255, glow)}
			white := 0.0
			gx, gy := (float64(x)-cx)/box+0.5, (float64(y)-cy)/box+0.5
			if gx > 0.1 && gx < 0.9 && gy > 0.1 && gy < 0.9 { // знак — только в середине поля
				for sy := 0; sy < n; sy++ {
					for sx := 0; sx < n; sx++ {
						px := (float64(x) + (float64(sx)+0.5)/n - cx) / box
						py := (float64(y) + (float64(sy)+0.5)/n - cy) / box
						if inside(glyph, px+0.5, py+0.5) {
							white++
						}
					}
				}
				white /= n * n
			}
			c = rgb{lerp(c.r, 255, white), lerp(c.g, 255, white), lerp(c.b, 255, white)}
			img.SetNRGBA(x, y, color.NRGBA{uint8(c.r + 0.5), uint8(c.g + 0.5), uint8(c.b + 0.5), 0xff})
		}
	}
	return img
}
