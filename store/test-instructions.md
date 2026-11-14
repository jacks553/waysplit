# Заметки для проверяющих (вкладка «Test instructions»)

По документации магазина (cws-dashboard-test-instructions) эта вкладка необязательна и нужна, когда без особых условий не проверить всё. У Waysplit такое условие есть — компаньон и свои серверы, поэтому заполнить стоит. Текст — по-английски, вставить целиком.

```text
Waysplit is a VPN client for the user's OWN servers. It does not provide any servers or accounts, so there are no test credentials from us.

What the extension needs to work:
1. Windows 10/11 (64-bit) and the Waysplit companion app. The extension itself cannot speak the VLESS / Hysteria2 protocols; the companion (a small Windows program, connected via native messaging) runs the open-source sing-box and Xray cores.
2. A server link (vless:// or hysteria2://) or a subscription URL from the user's VPN provider.

What you will see without the companion:
- After installation the "Getting started" page opens. Step 1 says the companion is not installed and shows how to install it: three steps and a "Скачать" (Download) button for the companion archive from GitHub Releases.
- The popup (toolbar icon) shows "Компаньон не установлен" (Companion is not installed) right away, with the same steps and the "Скачать" button; the same appears if you try to add a server link. Nothing breaks, and the extension makes no network requests.

To test with the companion:
1. Download https://github.com/jacks553/waysplit/releases/latest/download/Waysplit-companion.zip (the latest release; its SHA-256 is on https://github.com/jacks553/waysplit/releases/latest).
2. Extract it and run "Установить.cmd" (Install). No admin rights are needed. It needs no internet: the official sing-box and Xray cores are included in the archive. It checks the files against SHA256SUMS.txt from the archive, copies the companion and the cores to %LOCALAPPDATA%\Programs\Waysplit and registers the companion for this extension only. Windows may show a SmartScreen warning because the program is not code-signed: click "Подробнее" (More info) → "Выполнить в любом случае" (Run anyway).
3. On the "Getting started" page click "Проверить ещё раз" (Check again), paste a vless:// or hysteria2:// link and click "Включить VPN" (Turn on VPN).
4. Everything else is in the popup, on the tabs at the bottom: "Главная" (Home: the VPN button, the current server, and "Этот сайт" — This site: a VPN/direct switch and a server choice for the open site), "Серверы" (Servers), "Правила" (Site rules), "Настройки" (Settings). The expand button in the popup header opens the same interface in a full tab.
5. Site domains (new in 1.1.0): after you add a "через VPN" (through VPN) rule for a site, the popup shows a card that explains and asks for an optional permission (webRequest + site access; Chrome asks once). If you allow it, the domains that this site's tab loads its video, images and scripts from are attached to the site's rule (rule menu "⋯" → "Домены сайта": the list, any domain can be removed); the option is "Автоматически добавлять домены сайта" in "Настройки". Requests are only observed, never blocked or modified, and nothing is sent anywhere. If you choose "Не сейчас" (Not now), everything else works as before.
6. To remove it, run "Удалить.cmd" (Uninstall). It asks whether to delete the device identifier as well (press Enter to keep it, type "да" to delete it).

Source code: https://github.com/jacks553/waysplit (Apache 2.0)
Privacy policy: https://jacks553.github.io/waysplit/privacy.html
The interface is in Russian; the screenshots show it with fictional sample data.
```

## Короткий вариант — для поля до 500 знаков (версия 1.1.0)

Если поле в панели принимает не больше 500 знаков, вставьте этот текст (498 знаков):

```text
Client for the user's OWN VLESS/Hysteria2 servers; no test accounts. Without our Windows companion it only shows install steps. To test: get https://github.com/jacks553/waysplit/releases/latest/download/Waysplit-companion.zip, extract, run Установить.cmd (no admin; SmartScreen: More info > Run anyway), paste a vless:// or hysteria2:// link. New in 1.1.0: an OPTIONAL permission (webRequest + site access), asked once after adding a "through VPN" site rule; "Не сейчас" declines. UI is in Russian.
```

Перевод: клиент для СОБСТВЕННЫХ серверов пользователя VLESS/Hysteria2; тестовых учётных записей нет. Без нашего компаньона для Windows показывает только шаги установки. Как проверить: скачать архив по ссылке, распаковать, запустить «Установить.cmd» (права администратора не нужны; SmartScreen: «Подробнее» → «Выполнить в любом случае»), вставить ссылку vless:// или hysteria2://. Новое в 1.1.0: НЕОБЯЗАТЕЛЬНОЕ разрешение (webRequest + доступ к сайтам), спрашивается один раз после добавления правила «через VPN»; «Не сейчас» — отказ. Интерфейс на русском.

## Перевод полного текста

Перевод вкратце: серверов и учётных записей Waysplit не даёт; без компаньона расширение сразу показывает понятную инструкцию по установке (страница «Начало работы» и окно), ничего не ломается и в сеть не ходит; с компаньоном — скачать архив, запустить «Установить.cmd», вставить ссылку, включить; удалить — «Удалить.cmd» (спросит про идентификатор устройства).

Тестовый сервер проверяющим не даём (решение автора, 8 ноября 2026 г.).
