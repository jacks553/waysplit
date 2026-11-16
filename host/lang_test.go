package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"testing"
)

// Английские сообщения компаньона (второй аргумент say) — только ASCII: тогда они показываются
// верно в консоли с любой кодовой страницей. Проверяются все вызовы say в коде пакета.
func TestCliEnglishIsASCII(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if id, ok := call.Fun.(*ast.Ident); !ok || id.Name != "say" || len(call.Args) != 2 {
					return true
				}
				lit, ok := call.Args[1].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					if name != "lang_test.go" {
						t.Errorf("%s: английский текст в say должен быть строкой в коде", fset.Position(call.Pos()))
					}
					return true
				}
				calls++
				text, _ := strconv.Unquote(lit.Value)
				for _, r := range text {
					if r > 127 {
						t.Errorf("%s: в английском сообщении не только ASCII: %q", fset.Position(call.Pos()), text)
						break
					}
				}
				return true
			})
		}
	}
	if calls < 10 {
		t.Errorf("найдено только %d вызовов say: проверка смотрит не туда", calls)
	}
}
