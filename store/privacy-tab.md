# Вкладка «Конфиденциальность» (Privacy practices)

Что вставить в каждое поле. Тексты для полей — по-английски: их читают проверяющие магазина. Под каждым — перевод и объяснение для вас. Сверено с документацией магазина 8 ноября 2026 г. (cws-dashboard-privacy, user-data-faq, limited-use, program-policies).

## Единственное назначение (Single purpose description)

```text
Waysplit is a browser-only VPN client: it routes Chrome's traffic through the user's own VLESS / Hysteria2 proxy servers (run by a companion Windows app via native messaging) and lets the user choose per site whether it goes through the VPN or directly.
```

Перевод: VPN-клиент только для браузера: пускает трафик Chrome через собственные серверы пользователя (их запускает компаньон через native messaging) и даёт для каждого сайта выбрать — через VPN или напрямую.

## Обоснование разрешений (Permission justification)

Поле для каждого разрешения из manifest.json. Вставлять по одному:

**nativeMessaging**
```text
Talks to the Waysplit companion, a separate Windows program the user installs. It runs the sing-box / Xray cores that connect to the user's VPN servers; the extension itself cannot speak VLESS or Hysteria2. Used for: parsing server links, downloading the user's subscriptions, starting/stopping the cores, ping checks.
```

**proxy**
```text
Core function: sets a PAC script so that Chrome sends sites through the local proxy port of the selected server (127.0.0.1) or directly, according to the user's per-site rules. The previous proxy setting is cleared when the VPN and rules are off.
```

**storage**
```text
Keeps the user's servers, subscriptions, site rules and settings locally (chrome.storage.local), and the current connection state and diagnostic events for this browser session (chrome.storage.session). Nothing is synced or sent to the developer.
```

**alarms**
```text
A one-minute watchdog alarm wakes the service worker while the VPN is on to check that the companion and the core are still running (and restart them if not), and a periodic alarm updates the user's subscriptions on the schedule chosen in settings.
```

**activeTab**
```text
When the user opens the popup, the extension reads the hostname of the active tab to show whether this site goes through the VPN or directly and to let the user add a rule for it with one click. The hostname is not stored or transmitted.
```

**privacy**
```text
While the VPN is on, sets chrome.privacy.network.webRTCIPHandlingPolicy to "disable_non_proxied_udp" so that WebRTC cannot reveal the user's real IP address outside the proxy; the previous value is restored when the VPN is turned off. The user can disable this protection in settings.
```

**favicon**
```text
Shows website icons next to the user's site rules and next to the active site in the popup, so the list is easier to read. Icons are read only from Chrome's own local favicon cache through the extension's _favicon URL: no network requests and no third-party icon services, so the user's list of rules never leaves the computer. If Chrome has no icon for a site, the first letter of the domain is shown instead.
```

Перевод: значки сайтов у правил и у открытого сайта в окне — чтобы список легче читался. Значки берутся только из памяти самого Chrome (адрес `_favicon` расширения): никаких запросов в интернет и сторонних сервисов, список правил не уходит с компьютера. Нет значка — первая буква домена.

**webRequest (необязательное) и доступ к сайтам `<all_urls>` (необязательный)** — если панель спросит обоснование для них (Host permission justification):
```text
Optional, requested only when the user clicks "Domains of this tab" in the popup. Observes (never blocks or modifies) which domains the tabs load — e.g. videos and images served from other domains — so the user can add those domains to the VPN rules. Only domain names are kept, per tab, in session memory until the browser closes; nothing is transmitted. The user can revoke the permission at any time.
```

## Удалённый код (Remote code)

Выбрать: **«No, I am not using remote code»** («Нет, я не использую удалённый код»).

Почему: весь код — в архиве расширения; сборка (`tools\build-store.ps1`) проверяет, что нет `<script>` с чужих адресов, `eval`, `new Function`, `import` с чужих адресов и т. п. Расширение не скачивает код из интернета; списки серверов из подписок — это данные, а не код.

## Использование данных (Data usage)

Первая группа галочек — какие данные расширение «собирает». По правилам магазина (User Data FAQ, вопрос 3) раскрывать нужно и то, что обрабатывается **только на компьютере** и никуда не отправляется. Ниже — решение по каждой категории (8 ноября 2026 г., решение автора) и почему. **Точные пояснения под галочками в панели в документации не опубликованы (только на картинках) — сверьте их с доводами ниже; если что-то в панели сказано иначе, напишите мне.**

| Категория в панели | Отметить? | Почему |
|---|---|---|
| Personally identifiable information (личные данные: имя, адрес, e-mail, возраст, номера документов) | **нет** (решение автора) | имён, почты и т. п. нет; идентификатор устройства — случайный номер, см. ниже |
| Health information | нет | — |
| Financial and payment information | нет | — |
| **Authentication information** (пароли, учётные данные) | **да** | ссылки серверов содержат ключи и пароли, адрес подписки — секретный токен; хранятся в Chrome и уходят компаньону и вашим же серверам / провайдеру — в этом смысл расширения |
| Personal communications | нет | — |
| Location (регион, IP-адрес, GPS) | нет | расширение не определяет ваше местоположение; «Мой IP сейчас» показывает IP сервера VPN, а не ваш |
| **Web history** (посещённые страницы) | **да** | расширение видит домен открытой вкладки (activeTab), чтобы показать маршрут сайта; только на компьютере, не сохраняется |
| **User activity** (в т. ч. «network monitoring») | **да** | «Домены этой вкладки» после вашего разрешения следит, к каким доменам обращаются вкладки (webRequest); только имена доменов, только в памяти браузера |
| Website content | нет | содержимое страниц не читается |

**Идентификатор устройства — не «личные данные»** (решение автора). Это случайный номер, не связанный с оборудованием и с человеком; он уходит только провайдеру подписки, только если тот требует, и только по https (так и в политике конфиденциальности). В «личные данные» магазин относит то, что указывает на человека (имя, адрес, почта, номера документов). Если проверяющие сочтут иначе и попросят отметить «Personally identifiable information», — отметим, это не меняет ничего в работе расширения.

Вторая группа — подтверждения (certify). Отметить **все три**: данные не продаются и не передаются третьим лицам вне разрешённых случаев; не используются для целей, не связанных с единственным назначением; не используются для оценки кредитоспособности. Всё это правда: разработчик данных вообще не получает.

## Политика конфиденциальности (Privacy policy URL)

```text
https://jacks553.github.io/waysplit/privacy.html
```

Страница — `docs/privacy.html` (русский и английский), публикуется через GitHub Pages на шаге 4. В ней есть всё, что требует магазин: что хранится, какие запросы и куда, идентификатор устройства, как всё удалить, и фраза о соответствии Chrome Web Store User Data Policy, включая Limited Use.
