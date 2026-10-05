# Contributing

Please open an issue with reproduction steps before proposing a substantial change.
Keep the desktop app local, avoid external services, and preserve the shared notification protocol.

1. Install Node.js 22+, tinyjs 0.47.1+, and PlatformIO 6.1.19.
2. Run `npm test` and `pio run -d firmware`.
3. Exercise the changed flow in `tinyjs dev` with the device simulator or hardware.
4. Describe observable before/after behavior and your verification in the pull request.

Do not commit `firmware/include/config.h`, Wi-Fi credentials, device keys, or personal reminder data.
Hardware changes must state the exact board revision and tested pin mapping.
Fonts retain their bundled SIL Open Font Licenses; all original project code uses MIT.
