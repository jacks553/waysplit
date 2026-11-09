package corebin

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// HideWindow — дочерний процесс без окна консоли.
func HideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
