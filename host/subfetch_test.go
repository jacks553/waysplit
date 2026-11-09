package main

import (
	"context"
	"errors"
	"testing"

	"waysplit/host/internal/nm"
)

// Подписка привязана к устройству, а адрес — http:// не на этот компьютер: идентификатор не
// отправляется и даже не создаётся (ошибка раньше, чем device.Load).
func TestFetchSubDeviceNeedsHTTPS(t *testing.T) {
	_, _, err := fetchSub(context.Background(), "http://sub.example.invalid/x", "", nil, true)
	var ne *nm.Error
	if !errors.As(err, &ne) || ne.Code != "DEVICE_NEEDS_HTTPS" {
		t.Fatalf("ждали DEVICE_NEEDS_HTTPS, получили %v", err)
	}
}
