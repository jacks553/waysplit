//go:build !windows

package corebin

import "os/exec"

// HideWindow — окно консоли есть только у Windows.
func HideWindow(*exec.Cmd) {}
