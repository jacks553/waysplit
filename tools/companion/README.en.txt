Waysplit companion {{VERSION}}
========================

Инструкция по-русски лежит в файле "Прочитай меня.txt".

Waysplit is a Chrome extension. It gives you a VPN for the browser only,
through your own VLESS and Hysteria2 servers. VLESS works with XHTTP too.
Some sites go through the VPN, the rest go without it.

The extension does not connect to servers by itself. The companion does
that. It is a small program for Windows 10 and 11 from this archive. Chrome
starts it, you never open it yourself.

Waysplit does not provide servers. You need your own vless:// and
hysteria2:// links or a subscription from your provider.


Install
-------
1. Extract the archive. Right-click it and choose "Extract All".
2. In the extracted folder, run Install.cmd.
   Windows may show a warning. See "Why Windows warns you" below.
3. Wait for the line "Done: the companion is installed" and go back to
   Chrome.

You need neither administrator rights nor the internet. The sing-box and
Xray cores are already in the archive. The installer does three things:
  - checks the files against SHA256SUMS.txt and tells you which file is
    missing or damaged;
  - copies the companion and the cores to %LOCALAPPDATA%\Programs\Waysplit;
  - registers the companion in Chrome for the Waysplit extension only.

To update, do the same. Download the new archive and run Install.cmd. Your
servers, rules and settings are stored in Chrome and stay in place.

The files with Russian names do the same as Install.cmd and Uninstall.cmd.
The installer shows its messages in Russian on Russian Windows and in
English otherwise.


Why Windows warns you
---------------------
Windows marks files from the internet as downloaded. It checks programs
without a digital signature more strictly. The companion is not signed: a
signature needs a paid certificate in the author's name. So when you run
Install.cmd, Windows may show the "Windows protected your PC" window. It
says "Publisher: Unknown publisher". Another possible window is "Open File -
Security Warning". This does not mean the program has a virus. Windows
simply does not know it yet.

First check the SHA-256 of the archive. The section "Check the archive"
explains how. If the fingerprint matches, click "More info", then "Run
anyway". In the second window, click "Run".

You can remove the warning in advance, for example when you update. Download
the archive and check its SHA-256. Before extracting, right-click the
archive and open "Properties". At the bottom of the "General" tab, check
"Unblock" and click "OK". Do this only if the SHA-256 matches.


Check the archive
-----------------
SHA-256 is a fingerprint of a file. If a single byte of the archive changes,
the fingerprint changes too. The fingerprint of the real archive is on the
release page. It is written in the release notes and attached as the file
Waysplit-companion.zip.sha256.
{{REPO_URL}}/releases

1. Click "Start", type PowerShell and open Windows PowerShell.
2. Run the command below. It is written for an archive in the Downloads
   folder. If the archive is somewhere else, use its path.
     Get-FileHash "$env:USERPROFILE\Downloads\Waysplit-companion.zip"
3. Compare the Hash line with the fingerprint on the release page. Check all
   64 characters. Upper and lower case do not matter. If they differ, do not
   run the program and download the archive again from the release page.


Uninstall
---------
Run Uninstall.cmd. It is in this archive and in the folder
%LOCALAPPDATA%\Programs\Waysplit. It unregisters the companion from Chrome
and deletes the program and its data. The data is in %LOCALAPPDATA%\Waysplit:
logs and core settings.

It asks about the device ID separately. Your subscription provider uses the
ID to recognize this computer if the subscription is linked to a device. If
you just press Enter, the ID stays. Then the provider will see the same
computer after a new install. If you answer "yes", the ID is deleted. Then
the provider will treat the computer as a new device after a reinstall, and
the device limit of your subscription may run out.

Remove the extension itself in Chrome. Right-click the Waysplit icon and
choose "Remove from Chrome".


If something goes wrong
-----------------------
  - The installer says "the file is missing" or "the file is damaged". The
    archive was not fully extracted, the download was broken, or an
    antivirus deleted the file. Download the archive again, check its
    SHA-256 and extract all of it.
  - An antivirus deleted or blocked waysplit-host.exe, sing-box.exe or
    xray.exe. Antivirus programs sometimes flag new programs by mistake.
    This happens to VPN cores too. If the SHA-256 of the archive matches,
    restore the file from quarantine. Add an exclusion for the folder
    %LOCALAPPDATA%\Programs\Waysplit and run Install.cmd again.
  - Smart App Control is on in Windows 11. It may block unsigned programs,
    and it cannot make an exception for a single program.

Error details are in the Waysplit popup. Open the "Settings" tab and click
"Diagnostics".

Source code and questions: {{REPO_URL}}


Licenses
--------
Waysplit is distributed under the Apache License 2.0. Its text is in
LICENSE.txt. Third-party code inside waysplit-host.exe and its license texts
are listed in THIRD-PARTY-LICENSES.txt.

The cores are separate programs. They are taken from their authors' official
releases and are not modified. sing-box is licensed under GPL-3.0 or later:
the notice is in sing-box-LICENSE.txt, the full GPL-3.0 text is in
sing-box-GPL-3.0.txt. Xray-core is licensed under MPL-2.0, its text is in
xray-LICENSE.txt.

The core versions, where they come from and where to get the source code of
these exact versions are listed in CORES.txt. Source archives are attached
to every Waysplit release on the release page.
