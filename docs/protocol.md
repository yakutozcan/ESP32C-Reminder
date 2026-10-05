# Local notification protocol · version 2

Desktop → device over the same LAN. The firmware listens on TCP port 80.
Notification endpoints require `Authorization: Bearer <DEVICE_TOKEN>`.
AyresWiFiManager owns the passwordless captive portal only in setup mode.
No cloud, MQTT broker or desktop inbound port is required.
HTTP is unencrypted; this protocol is for a trusted local network.

## Health

`GET /api/health`

```json
{"protocol":2,"name":"Masa ESP32-C3","firmware":"0.2.3","pending":0,"ip":"192.168.1.50","rssi":-50}
```

`pending` includes the currently displayed notification. A health response is
not evidence of the OLED or buzzer functioning.

## Notification

`POST /api/notify`, `Content-Type: application/json`

```json
{"id":"reminder-uuid:1791176400000","title":"Bitkileri sula","melody":"chime"}
```

The desktop generates a stable ID from the reminder ID and occurrence timestamp.
Retries keep the same ID. Test notifications have fresh `test-` IDs.

Limits: non-empty ID ≤160 bytes, title ≤320 UTF-8 bytes, `melody` must be `"chime"` or `"none"`, body ≤1024 bytes. The desktop additionally enforces one-line titles
of 1–80 Unicode code points. Both software versions must agree on protocol `2`.

```json
{"protocol":2,"id":"reminder-uuid:1791176400000","accepted":true,"duplicate":false}
```

The device commits to NVS **before** replying 200. Its pending queue holds 8
notifications. IDs in that queue and the last 32 completed IDs are deduplicated
across restarts. Receipt means queued, not completed by the user. A reboot while
displaying a notice may show it again. Resetting NVS or evicting old IDs removes
their deduplication guarantee.

| HTTP | Meaning | Desktop behavior |
| --- | --- | --- |
| 200 | Accepted or already accepted | Mark delivered if protocol, ID and accepted match |
| 400 | Invalid body/fields | Keep queued, retry until expiry; inspect configuration |
| 401 | Invalid token | Show key mismatch; retry after settings correction |
| 413 | Oversized body | Reject; valid desktop payloads fit |
| 429 | Queue full | Retry with the same ID |
| 503 | Wi-Fi setup active or corrupt NVS queue | Complete Wi-Fi setup or inspect device storage |
| 507 | Persistence failed | Retry; the device has not accepted the notice |

The desktop waits at most 5 seconds per attempt. Retry delays are 10, 20, 40,
80, 160 and then 300 seconds. A pending notice expires 24 hours after its
scheduled occurrence. Desktop edits, pauses and deletes cancel only notices
still in the desktop queue. Already accepted device notices are not recalled.

Queue processing is serialized with desktop edits and storage writes, so no
network send races with a pause/delete. If the desktop crashes after acceptance
but before saving its acknowledgement, retrying the same ID is safe within the
device’s deduplication window.

## Upgrade and setup

Protocol 2 replaces `vibrationMs` with `melody`. `chime` plays a fixed four-note,
approximately 0.9-second PWM melody; `none` leaves the buzzer silent. Protocol 1
responses produce an explicit firmware-upgrade message in the desktop. New firmware
rejects old notification payloads; existing NVS queue entries are read without
erasing them, mapping zero vibration to silence and positive durations to chime.
The desktop migrates state version 1 to 2 after storing a copy in
`reminder-state-v1-backup`; occurrence IDs and scheduling timestamps stay unchanged.

Firmware 0.2.2 uses **AyresWiFiManager 2.3.0** for provisioning, scanning, DNS
and Wi-Fi connectivity. When unconfigured, the initial connection attempt fails,
or after a 5-second BOOT hold, the device exposes an open `Masa-XXXX` access point.
The OLED and USB output show its name and `http://192.168.4.1`.
Ayres owns port 80 in setup mode; the notification server stops before opening
the portal and starts on normal Wi-Fi. Notification APIs are unavailable in setup.
The device key stays in NVS and appears on the Turkish setup page and USB `INFO`.
BOOT remains controlled by Masa; holding it opens setup without deleting credentials.

The Turkish page is installed into LittleFS `/masa/` by the firmware and served
by Ayres. `GET /scan` (alias `/scan.json`) returns an array of
`{"ssid":"Home","rssi":-45,"secure":true,"encryption":1}` or HTTP 202 with
`{"scanning":true}`. A driver failure returns HTTP 503 with
`{"error":"scan_failed"}`; a successful scan with no networks returns `[]`.
Errors and empty results are different UI states. The page
scans on load, deduplicates SSIDs by strongest signal, and allows hidden SSIDs.
A scan may block the portal briefly; the independent buzzer task still stops PWM
on time. Results are cached for 20 seconds by Ayres. USB `SCAN` tests the same
HTTP handler, rather than implementing another scanner.
`POST /save` writes Wi-Fi settings to LittleFS `/wifi.json` and reboots. Setup
requests do not require a device key; the notification API still does. The
passwordless setup network does not remove a home network's password requirement.

The first transition copies legacy NVS Wi-Fi credentials (or compile-time defaults)
only if Ayres has no credential file and no import marker. Successful import leaves
the original NVS record intact for rollback, and persists `ayresimported` in NVS.
Subsequent boots preserve Ayres settings; deleted settings are not resurrected from
the old backup. Pending/recent notification IDs and the device key are unchanged.
LittleFS auto-formats on first mount failure, as required by Ayres. Normal firmware
uploads do not upload a filesystem image; do not use `uploadfs` to upgrade this app.

The pinned dependencies need two build-local compatibility fixes, implemented in
`firmware/scripts/ayres_compat.py`: initialize Arduino 2.0.17's IDF scan configuration,
and let Arduino manage Ayres' scan lifecycle and result records. This avoids a race
between a direct IDF scan and Arduino's event handler consuming the same records.
Ayres' scan JSON capacity is increased and reconnection accepts open Wi-Fi networks.
The build uses patched copies; installed dependencies are never edited. Unexpected
upstream changes fail the build and must be reviewed before updating version pins.
HTTP, local filesystem and NVS contents are unencrypted; keep the device key private.

## OLED text

Firmware 0.2.3 retains original UTF-8 notification titles in NVS. The 6×12
Latin Extended font includes `ç Ç ğ Ğ ı İ ö Ö ş Ş ü Ü`; rendering uses `drawUTF8`.
Rows contain 12 Unicode characters and pages contain 36, regardless of byte length.
Unsupported glyphs are replaced with `?` only during rendering. Older queue entries
remain readable; already transliterated titles cannot recover their lost accents.
USB `TEST` displays all twelve Turkish glyphs. `INFO` reports font coverage.
