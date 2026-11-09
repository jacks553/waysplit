package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// Значок компаньона в репозитории (tools/companion/waysplit.ico) совпадает с тем, что рисует
// код: поменяли рисунок — перерисуйте (go run ./icons). Сравниваются точки, а не байты PNG.
func TestICOUpToDate(t *testing.T) {
	ico, err := os.ReadFile(filepath.Join("..", "companion", "waysplit.ico"))
	if err != nil {
		t.Fatal(err)
	}
	le := binary.LittleEndian
	n := int(le.Uint16(ico[4:]))
	if le.Uint16(ico[0:]) != 0 || le.Uint16(ico[2:]) != 1 || n != len(exeSizes) {
		t.Fatalf("заголовок .ico: картинок %d, нужно %d", n, len(exeSizes))
	}
	for i, size := range exeSizes {
		e := ico[6+16*i:]
		if side := int(e[0]); side != size%256 || int(e[1]) != side {
			t.Errorf("картинка %d: размер %d×%d, нужно %d", i, e[0], e[1], size)
		}
		length, off := le.Uint32(e[8:]), le.Uint32(e[12:])
		img, err := png.Decode(bytes.NewReader(ico[off : off+length]))
		if err != nil {
			t.Fatalf("картинка %d: %v", size, err)
		}
		got := image.NewNRGBA(img.Bounds())
		draw.Draw(got, got.Bounds(), img, image.Point{}, draw.Src)
		if want := render(size, brand); !bytes.Equal(got.Pix, want.Pix) {
			t.Errorf("картинка %d×%d устарела: перерисуйте значок (go run ./icons)", size, size)
		}
	}
}

// Знак call_split в поле 960×960 занимает 160…800 по обеим осям (viewBox 0 -960 960 960).
func TestGlyphBounds(t *testing.T) {
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, poly := range glyph {
		for _, p := range poly {
			minX, minY = math.Min(minX, p.x), math.Min(minY, p.y)
			maxX, maxY = math.Max(maxX, p.x), math.Max(maxY, p.y)
		}
	}
	want := [4]float64{160.0 / 960, 160.0 / 960, 800.0 / 960, 800.0 / 960}
	got := [4]float64{minX, minY, maxX, maxY}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Fatalf("границы знака %v, нужно %v", got, want)
		}
	}
	if len(glyph) != 2 {
		t.Fatalf("контуров %d, нужно 2 (левая ветка со стволом и правая)", len(glyph))
	}
}

func TestGlyphInside(t *testing.T) {
	at := func(x, y float64) bool { return inside(glyph, x/960, (y+960)/960) }
	cases := []struct {
		x, y float64
		in   bool
		what string
	}{
		{480, -300, true, "ствол"},
		{200, -760, true, "угол левой стрелки"},
		{760, -760, true, "угол правой стрелки"},
		{480, -672, false, "между ветками сверху"},
		{300, -300, false, "слева от ствола"},
		{100, -100, false, "за краем знака"},
	}
	for _, c := range cases {
		if at(c.x, c.y) != c.in {
			t.Errorf("%s (%v, %v): внутри=%v, нужно %v", c.what, c.x, c.y, !c.in, c.in)
		}
	}
}

func TestStoreIconPadding(t *testing.T) {
	img := storeIcon(brand)
	for y := 0; y < 128; y++ {
		for x := 0; x < 128; x++ {
			a := img.NRGBAAt(x, y).A
			inArt := x >= 16 && x < 112 && y >= 16 && y < 112
			if !inArt && a != 0 {
				t.Fatalf("пиксель (%d, %d) в полях не прозрачный", x, y)
			}
		}
	}
	// Края рисунка 96×96 — по самой границе полей: середины сторон непрозрачные.
	for _, p := range [][2]int{{16, 64}, {111, 64}, {64, 16}, {64, 111}} {
		if a := img.NRGBAAt(p[0], p[1]).A; a != 255 {
			t.Errorf("край рисунка (%d, %d): прозрачность %d, нужно 255", p[0], p[1], a)
		}
	}
}

func TestParsePathErrors(t *testing.T) {
	for _, d := range []string{"", "10 10", "M10", "M0 0A1 1 0 0 0 5 5Z", "M0 0L1 1Z 5 5"} {
		if _, err := parsePath(d); err == nil {
			t.Errorf("путь %q: ждали ошибку", d)
		}
	}
}

// Промо-картинка магазина: 440×280, непрозрачная, белый знак в середине, фон — цвета значка.
func TestPromoTile(t *testing.T) {
	img := promoTile(440, 280)
	if b := img.Bounds(); b.Dx() != 440 || b.Dy() != 280 {
		t.Fatalf("размер %v", b)
	}
	for y := 0; y < 280; y += 7 {
		for x := 0; x < 440; x += 7 {
			if img.NRGBAAt(x, y).A != 255 {
				t.Fatalf("пиксель (%d, %d) прозрачный: картинка должна заполнять всю площадь", x, y)
			}
		}
	}
	// Ствол знака — внизу по центру (в поле 960: x 440…520, y до −160).
	if c := img.NRGBAAt(220, 175); c.R != 255 || c.G != 255 || c.B != 255 {
		t.Errorf("в стволе знака не белый: %v", c)
	}
	if c := img.NRGBAAt(4, 4); c.B < 200 || c.R > 80 {
		t.Errorf("угол — не синий цвет значка: %v", c)
	}
}
