# Contributing

Please open an issue with reproduction steps before proposing a substantial change.
Keep the desktop app local, avoid external services, and preserve the shared notification protocol.

1. Install Node.js 22+, tinyjs 0.47.1+, and PlatformIO 6.1.19.
2. Run `npm test`, `pio run -d firmware`, `python3 tools/test-oled-text.py`,
   `python3 tools/test-button-gesture.py`, and `python3 tools/test-autonomous-firmware.py`.
   The OLED test needs a C/C++ compiler on macOS or Linux and uses the pinned U8g2 font.
3. Exercise the changed flow in `tinyjs dev` with the device simulator or hardware.
4. Describe observable before/after behavior and your verification in the pull request.

Masa 0.7.0 uses local state version 6; firmware 0.7.0 uses protocol 4 with the
`cron: true` health capability. Cron must be rejected before device-owned edits
or handover if that capability is missing. Preserve
protocol 2/3 desktop delivery and existing migration backups. Autonomous changes
must cover ownership transfer, lost replies, restart, device cursor progress,
completion/snooze families, and atomic persistence before acknowledging effects.
Portable backups contain reminder definitions and quiet preferences only; never
include device credentials or runtime queues. Import must remain atomic and keep
the pre-import full-state recovery snapshot.

Simulator, browser, native-core, and firmware tests do not prove physical hardware
behavior. Record the exact board and separately verify OLED, buzzer, BOOT gestures,
real NTP, reboot, and power interruption. Firmware stores queues/events/schedules
in LittleFS `/masa-state.json`; preserved legacy NVS is stale after migration.
Disable and confirm autonomous handback, drain queues/events, and back up before
testing a downgrade. Do not format an existing filesystem or overwrite Wi-Fi records.

Do not commit `firmware/include/config.h`, Wi-Fi credentials, device keys, or personal reminder data.
Hardware changes must state the exact board revision and tested pin mapping.
Fonts retain their bundled SIL Open Font Licenses; all original project code uses MIT.
