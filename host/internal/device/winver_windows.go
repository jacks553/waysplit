package device

import "golang.org/x/sys/windows"

// windowsVersion — «11» или «10» (Windows 11 — сборки 22000 и новее). Только версия системы,
// без серийных номеров и других данных компьютера.
func windowsVersion() string {
	v := windows.RtlGetVersion()
	if v.MajorVersion == 10 && v.BuildNumber >= 22000 {
		return "11"
	}
	if v.MajorVersion == 10 {
		return "10"
	}
	return ""
}
