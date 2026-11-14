# Вкладка «Конфиденциальность» (Privacy practices)

Что вставить в каждое поле. Тексты для полей — по-английски: их читают проверяющие магазина. Под каждым — перевод и объяснение для вас. Сверено с документацией магазина 8 ноября 2026 г. (cws-dashboard-privacy, user-data-faq, limited-use, program-policies).

> **Версия 1.1.0 («домены сайта»), 14 ноября 2026 г.** Перед отправкой 1.1.0 на проверку в панели нужно заменить три текста — они помечены ниже «ИЗМЕНЕНО в 1.1.0»: **storage**, **webRequest** и **доступ к сайтам**. Галочки в «Использовании данных» остаются те же (Authentication information, Web history, User activity), изменились только наши объяснения, почему. Остальные поля не менялись. В панели у каждого поля обоснования есть предел длины (в документации он не назван; в панели виден счётчик) — тексты ниже короче 1000 знаков; если какой-то не влезет, напишите мне.

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

**storage** — ИЗМЕНЕНО в 1.1.0
```text
Keeps the user's servers, subscriptions, site rules (including the content domains attached to each rule) and settings locally (chrome.storage.local), and the current connection state, diagnostic events and per-tab domain lists for this browser session (chrome.storage.session). Nothing is synced or sent to the developer.
```

Перевод: локально хранятся серверы, подписки, правила сайтов (вместе с привязанными к правилу доменами сайта) и настройки; на время сеанса браузера — состояние подключения, события для диагностики и списки доменов вкладок. Ничего не синхронизируется и не отправляется разработчику.

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

**webRequest (необязательное)** — ИЗМЕНЕНО в 1.1.0
```text
Optional; asked once, with an explanation in the popup, after the user creates a "through VPN" site rule (or clicks "Domains of this tab"). Only observes which domains the tabs request; never blocks or modifies requests. Purpose — per-site VPN routing: a site loads its video, images and scripts from other domains, and Chrome picks a proxy by request URL, not by tab. (1) While a site with the user's "through VPN" rule is open in a tab, the domains this tab loads from are attached to that rule, so the whole site goes through the VPN. They are stored locally as part of the rule and listed in its menu, where the user can remove any; the feature can be turned off in settings. Never attached: common services (search, analytics, ads, script CDNs) and anything from incognito tabs. (2) "Domains of this tab" lists the current tab's domains so the user can add rules manually; kept in session memory only. Only domain names are read — no URLs, no page content. Nothing is transmitted.
```

Перевод: необязательное; спрашивается один раз, с объяснением в окне, после первого правила «через VPN» (или по кнопке «Домены этой вкладки»). Только наблюдает, к каким доменам обращаются вкладки; запросы не блокирует и не меняет. Зачем — маршрут для каждого сайта: сайт грузит видео, картинки и скрипты с других доменов, а Chrome выбирает прокси по адресу запроса, а не по вкладке. (1) Пока во вкладке открыт сайт с правилом «через VPN», домены, с которых эта вкладка грузит данные, привязываются к этому правилу — через VPN идёт весь сайт. Они хранятся локально как часть правила и видны в его меню, где любой можно убрать; функцию можно выключить в настройках. Никогда не привязываются: общие сервисы (поиск, счётчики, реклама, библиотеки скриптов) и всё из вкладок инкогнито. (2) «Домены этой вкладки» — список доменов текущей вкладки, чтобы добавить правила вручную; только в памяти сеанса. Читаются только имена доменов — не адреса страниц и не содержимое. Ничего никуда не отправляется.

**Доступ к сайтам `<all_urls>` (необязательный; Host permission justification)** — ИЗМЕНЕНО в 1.1.0
```text
Optional, granted together with webRequest. Chrome delivers webRequest events only for hosts the extension has access to, and the sites the user makes rules for — and the domains those sites load their content from — are not known in advance, so the access cannot be narrowed to a fixed list. It is used only to observe the domain names of the tabs' requests (see the webRequest justification). The extension injects no scripts, reads no page content and changes nothing on any site. The user can revoke the permission at any time in Chrome's extension settings; the rest of the extension keeps working without it.
```

Перевод: необязательный, даётся вместе с webRequest. Chrome отдаёт события webRequest только для сайтов, к которым у расширения есть доступ, а сайты, для которых пользователь делает правила, и домены, с которых они грузят содержимое, заранее неизвестны — сузить доступ до списка нельзя. Доступ нужен только чтобы видеть имена доменов в запросах вкладок. Расширение не внедряет скрипты, не читает содержимое страниц и ничего на сайтах не меняет. Разрешение можно отозвать в настройках расширения в Chrome; остальное продолжит работать.

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
| **Web history** (посещённые страницы) | **да** | расширение видит домен открытой вкладки (activeTab), чтобы показать маршрут сайта. С версии 1.1.0 ещё и сохраняет на компьютере «домены сайта» — домены, с которых грузят данные сайты из ваших правил «через VPN» (часть правила; адреса страниц не сохраняются). Никуда не отправляется |
| **User activity** (в т. ч. «network monitoring») | **да** | после вашего разрешения расширение следит, к каким доменам обращаются вкладки (webRequest): для «доменов сайта» и для «Доменов этой вкладки». Только имена доменов, только на компьютере |
| Website content | нет | содержимое страниц не читается |

**Идентификатор устройства — не «личные данные»** (решение автора). Это случайный номер, не связанный с оборудованием и с человеком; он уходит только провайдеру подписки, только если тот требует, и только по https (так и в политике конфиденциальности). В «личные данные» магазин относит то, что указывает на человека (имя, адрес, почта, номера документов). Если проверяющие сочтут иначе и попросят отметить «Personally identifiable information», — отметим, это не меняет ничего в работе расширения.

Вторая группа — подтверждения (certify). Отметить **все три**: данные не продаются и не передаются третьим лицам вне разрешённых случаев; не используются для целей, не связанных с единственным назначением; не используются для оценки кредитоспособности. Всё это правда: разработчик данных вообще не получает.

## Политика конфиденциальности (Privacy policy URL)

```text
https://jacks553.github.io/waysplit/privacy.html
```

Страница — `docs/privacy.html` (русский и английский), публикуется через GitHub Pages на шаге 4. В ней есть всё, что требует магазин: что хранится, какие запросы и куда, идентификатор устройства, как всё удалить, и фраза о соответствии Chrome Web Store User Data Policy, включая Limited Use.
