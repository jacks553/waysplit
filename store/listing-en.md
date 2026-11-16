# Waysplit in the Chrome Web Store: English listing

Тексты для английского языка карточки магазина (версия 1.2.0). Русские тексты лежат в `listing-ru.md`. Как добавить язык в панели и что проверить, написано в `STORE-CHECKLIST.md`, раздел про обновление до 1.2.0.

## Название

Waysplit. Берётся из manifest.json, на обоих языках одно.

## Краткое описание

Берётся из `extension/_locales/en/messages.json`, в панели не меняется. Сейчас 128 знаков:

> VPN for Chrome via your own VLESS, XHTTP and Hysteria2 servers: some sites through VPN, some without. Needs a Windows companion.

## Подробное описание

Текст автора от 2026-11-16. Вставить в поле Description для языка English целиком:

```text
Waysplit is a VPN for the Chrome browser only, through your own servers. The sites you choose go through VPN, the rest go without it. Other programs on your computer are not affected.

What it does
• VLESS servers (including Reality, Vision and XHTTP) and Hysteria2, added by vless:// and hysteria2:// links or by a subscription from your provider.
• Site rules: "always through VPN" (the current server or one you choose) and "always without VPN". A rule covers all subdomains, and you can set a whole domain zone.
• Site domains: the domains a site loads its video, images and scripts from follow the site's rule. For example, on a video site both the page and the video itself go through VPN. The list is shown next to the rule, and you can remove any domain.
• "Russian sites without VPN": a switch on the Home tab. When it is on, sites in the .ru, .рф and .su zones and Russian services on other domains open without VPN even when the VPN is on. Your own rules take priority.
• Rules can work when the VPN is off: only the sites you chose go through VPN.
• Everything is controlled from the extension popup, on the Home, Servers, Rules and Settings tabs. For the open site there is a "through VPN / without VPN" switch and a server picker right on the Home tab.
• One-click server selection, favorites, ping check, and picking the server with the lowest latency.
• Leak protection: while the VPN is on, WebRTC does not reveal your real IP address. If the server is unavailable, the site will not open without VPN (or it will, if you set it so).
• Subscriptions update automatically. Traffic, expiry date and provider messages are shown.
• Diagnostics and a debug report with no keys or passwords.
• Interface in English and Russian.

What you need
• Windows 10 or 11 (64-bit) and Chrome 120 or later.
• The Waysplit companion app for Windows. The extension does not connect to servers by itself: the companion does, using the open-source sing-box and Xray cores. To install it, download the archive, extract it and run Install.cmd. No administrator rights are needed, and the cores are already in the archive. The link and the steps are on the Getting started page, which opens after you install the extension.
• Your own servers: links or a subscription URL from your VPN provider. Waysplit does not provide servers.

Privacy
Servers, subscriptions, rules and settings are stored only on your computer. Waysplit has no server of its own, no accounts, analytics or ads, and the developer receives none of your data. The permission to see which domains tabs contact is optional: Waysplit asks for it once, and you can decline. It is needed only for site domains (to add them automatically and to show the list of a tab's domains). Details are in the privacy policy.

Open source (Apache 2.0 license). Questions and bug reports: https://github.com/jacks553/waysplit
```

## Снимки

Пять кадров 1280×800 лежат в `store/screenshots-en`. Их делает команда `node tools/store-shots.js --lang=en`: то же окно и те же кадры, что в русских снимках, но окно, подписи и вымышленные данные английские.

## Ссылки

Те же, что у русского языка: домашняя страница `https://github.com/jacks553/waysplit`, поддержка `https://github.com/jacks553/waysplit/issues`, политика `https://jacks553.github.io/waysplit/privacy.html`.
