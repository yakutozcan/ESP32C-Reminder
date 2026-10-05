#pragma once
// Optional: copy to config.h for compile-time settings. config.h is ignored by Git.
// Empty settings enable an open setup network and automatic Wi-Fi scanning.
// The notification API still uses a device-generated key.
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define DEVICE_TOKEN ""
#define DEVICE_HOSTNAME "masa-reminder"
#define OLED_SDA 5
#define OLED_SCL 6
#define OLED_ADDRESS 0x3C
// ABRobot: 128x64 buffer, 72x40 visible window (see docs/hardware.md).
#define OLED_X_OFFSET 30
#define OLED_Y_OFFSET 12
#define BUZZER_PIN 3
#define ACK_BUTTON_PIN 9
