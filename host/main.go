// Command waysplit-host — компаньон расширения Waysplit (SPEC.md, раздел 5).
//
// Режимы: native messaging (Chrome запускает с аргументом chrome-extension://…),
// install / uninstall — регистрация в Chrome, parse / config / try — проверка без браузера.
package main

import (
	"fmt"
	"os"
	"strings"

	"waysplit/host/internal/hostlog"
	"waysplit/host/internal/singbox"
)

const version = "1.0.0"

const usage = `waysplit-host %s — компаньон расширения Waysplit.

Регистрация в Chrome (без прав администратора):
  install    зарегистрировать компаньон для расширения Waysplit
  uninstall  убрать регистрацию

Проверка без браузера (ссылки берутся из файла links.local.txt, по одной на строку;
можно вставить и адрес подписки https://…):
  parse    показать, какие серверы распознаны, а какие пропущены и почему
  config   собрать конфиг sing-box, проверить его и показать порты серверов
  try      запустить sing-box и держать прокси, пока не нажмёте Enter

Диагностика подписки (адрес не печатается):
  subinfo файл|адрес   скачать подписку с User-Agent разных клиентов и показать,
                       что пришло: формат, серверы, заголовки (без секретов)
           -device     ещё и с заголовками устройства (x-hwid) — провайдер может
                       засчитать компьютер как ещё одно устройство
           -proxy N    через локальный прокси 127.0.0.1:N (сервер в работающем ядре)

Параметры:
  -f файл     взять ссылки из другого файла
  -port N     первый локальный порт (по умолчанию 27101)
  -ua текст   User-Agent для подписок (по умолчанию v2rayN/7.0)
  -show       (config) показать конфиг на экране, секреты скрыты
  -seconds N  (try) остановить сам через N секунд
  -device     подписки — сразу с идентификатором устройства (без параметра — как в
              расширении: с ним, только если без него серверов нет)

  version  версия компаньона
`

func main() {
	args := os.Args[1:]
	migrateOnStart() // переход с LinkVPN: до того, как что-то появится в новой папке данных (migrate.go)
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			runNativeMessaging(a) // в stdout здесь — только сообщения для Chrome
			return
		}
	}
	hostlog.Open(singbox.DataDir())
	defer hostlog.Close()
	if migrationNote != "" {
		hostlog.Printf("%s", migrationNote)
	}

	cmd := ""
	if len(args) > 0 {
		cmd = strings.ToLower(args[0])
		args = args[1:]
	}
	var err error
	switch cmd {
	case "install":
		err = cmdInstall()
	case "uninstall":
		err = cmdUninstall()
	case "parse":
		err = cmdParse(args)
	case "config":
		err = cmdConfig(args)
	case "try":
		err = cmdTry(args)
	case "subinfo":
		err = cmdSubinfo(args)
	case "version", "-v", "--version":
		fmt.Println("waysplit-host", version)
	case "", "help", "-h", "--help", "/?":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, "Неизвестная команда «%s».\n\n", cmd)
		fmt.Printf(usage, version)
		os.Exit(2)
	}
	if err != nil {
		hostlog.Printf("%s: %v", cmd, err)
		fmt.Fprintln(os.Stderr, "\nОшибка: "+err.Error())
		hostlog.Close()
		os.Exit(1)
	}
}
