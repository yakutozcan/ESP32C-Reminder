# Local reminder protocol · version 4

Masa 0.8.0 and firmware 0.8.0 communicate on the same LAN, on TCP port 80.
All `/api/` endpoints require `Authorization: Bearer <DEVICE_TOKEN>`.
The passwordless captive portal is available only in setup mode, where Ayres
owns port 80 and the reminder endpoints are unavailable. No cloud or incoming
desktop port is required. HTTP and device storage are unencrypted; keep the key
private and use a trusted network.

Desktop delivery supports protocol 2, 3 and 4. Device actions need protocol 3+;
autonomous scheduling needs protocol 4. Upgrade the desktop before the firmware.
Protocol 1 produces an explicit upgrade message.

## Health and delivery

`GET /api/health`

```json
{"protocol":4,"name":"Masa ESP32-C3","firmware":"0.8.0","cron":true,"displaySettings":true,"pending":0,"eventsPending":0,"autonomous":true,"timeValid":true,"ownerId":"desktop-uuid","revision":7,"scheduleMaxTimestamp":2145916800000,"ip":"192.168.1.50","rssi":-50}
```

`pending` includes the displayed notice (maximum 8). `eventsPending` counts
unacknowledged actions (maximum 16). Health does not prove that the physical
OLED or buzzer works. `scheduleMaxTimestamp` reflects the firmware's `time_t`
range; the desktop checks transferred timestamps before handing over ownership.

`POST /api/notify`, JSON body up to 1024 bytes:

```json
{"id":"reminder-uuid:1791176400000","title":"Bitkileri sula","melody":"chime"}
```

```json
{"protocol":4,"id":"reminder-uuid:1791176400000","accepted":true,"duplicate":false}
```

ID: 1–160 UTF-8 bytes. Title: 1–320 UTF-8 bytes; the desktop also enforces
1–80 Unicode code points on one line. Melody: `chime` or `none`.
Recurring and one-off IDs are `<reminderId>:<dueMilliseconds>`; snoozes have
fresh `snooze-` IDs retained across retries. Test IDs begin with `test-`.
While the device owns scheduling, ordinary desktop notifications return 409;
explicit test notifications remain supported.

The queue, last 32 dismissed IDs, action receipts and autonomous history
provide bounded deduplication across restarts. Acceptance means durably queued,
not completed. A reboot can redisplay an accepted notice. Resetting storage or
pruning old receipts ends their deduplication guarantee.

| HTTP | Meaning |
| --- | --- |
| 200 | Valid acceptance or an idempotent repeat |
| 400 | Invalid fields or schedule capacity |
| 401 | Bearer key mismatch |
| 409 | Scheduler ownership, revision or deferred reconciliation conflict |
| 413 | Oversized request |
| 429 | Notification queue full |
| 503 | Setup mode or unreadable persistent storage |
| 507 | Persistence failed; mutation rolled back |

The desktop times out after five seconds. Delivery retries use 10, 20, 40,
80, 160 and then 300 seconds; a queued occurrence expires after 24 hours.
Missed recurrences collapse to the latest valid occurrence within that window.
Desktop scheduling persists a job before sending it. Retries retain its ID.
Quiet hours are evaluated when sending, including retries, without changing the
stored melody preference. Native desktop notifications also silence their sound.

## Autonomous schedule

`POST /api/schedule`, JSON body up to 32768 bytes:

```json
{
  "ownerId":"desktop-uuid","revision":7,"enabled":true,
  "takeover":false,"timezone":"STD-3","utcNow":1791262800000,
  "quietHours":{"quietEnabled":true,"quietStart":"22:00","quietEnd":"08:00"},
  "reminders":[{
    "id":"water","title":"Su iç","frequency":"interval","time":"09:00",
    "intervalMinutes":60,"anchorAt":1791262800000,
    "workStart":"09:00","workEnd":"18:00","weekdays":[1,2,3,4,5],
    "monthDay":1,"melody":"chime","enabled":true,"nextDue":1791266400000
  }],
  "deferred":[],"completedRoots":[],"cancelledIds":[]
}
```

Limits: 24 reminder definitions, 24 deferred deliveries, 32 delivered journal
entries; reminder and owner IDs up to 128 bytes. Both active and paused
definitions count toward capacity. `completedRoots` and `cancelledIds` each
contain at most 100 occurrence IDs. They recall device notices and deferred
timers explicitly; an upload merges new deferred jobs with offline device
timers rather than silently replacing them with an older desktop snapshot.
Changed, paused or removed definitions recall their pending notices/timers.
Accepted notices cannot be recalled through the legacy protocol 2/3 interface.

Recurrence fields:

| Frequency | Fields and meaning |
| --- | --- |
| `once` | `onceDate` (`YYYY-MM-DD`), local `time`, `scheduledAt` milliseconds |
| `daily` | Local `time` |
| `weekly` | `weekdays` (Sunday 0), `weekInterval` 1 or 2, `anchorDate` anchoring Monday weeks |
| `monthly` | `monthDay` 1–31, clamped to the last day of each month |
| `cron` | `cronExpression`, a normalized numeric five-field cron expression; `time` is unused |
| `interval` | `intervalMinutes` 1–10080, fixed `anchorAt`, allowed `weekdays`; optional paired `workStart`/`workEnd` |

Cron uses local-time minute matching, with lists, inclusive ranges and steps.
Desktop accepts JAN–DEC/SUN–SAT names and standard hourly/daily/weekly/monthly/yearly
aliases, then sends numeric expressions. Leading `*` in either day field selects
AND semantics; two restricted day fields select OR, following
[Cronie](https://github.com/cronie-crond/cronie/blob/master/man/crontab.5).
Missing DST minutes are skipped; repeated minutes create separate UTC occurrence
IDs. No seconds, year or command field is accepted. Invalid or impossible rules
fail validation. `GET /api/health` must advertise `cron: true` before desktop
handover, cron edits or imports in device mode. Older protocol-4 devices remain
usable for other recurrence types; absent capability means cron is unsupported.

Without a work window, intervals use an elapsed-time grid from their anchor.
With a window, each allowed local day starts a new grid at `workStart`, and
`workEnd` is exclusive. Calendar days and weeks follow local wall time across
DST; global intervals retain elapsed-time spacing. Daily and monthly weekdays
are unused. `nextDue: null` means no future occurrence.

`timezone` is a POSIX TZ rule (Istanbul: `STD-3`), derived from the desktop's
Date offsets. Stable annual DST `M` rules are supported; irregular political or
lunar rules are rejected. Desktop timezone changes recalculate future schedule
cursors before upload. Deferred timers retain their absolute due timestamps.
Quiet windows may cross midnight; their start is inclusive and end exclusive.

`GET /api/schedule` and successful POST replies return:

```json
{
  "protocol":4,"ownerId":"desktop-uuid","revision":7,"enabled":true,
  "timeValid":true,"timezone":"STD-3",
  "quietHours":{"quietEnabled":true,"quietStart":"22:00","quietEnd":"08:00"},
  "cursors":[{"id":"water","nextDue":1791266400000}],
  "history":[],"deferred":[],"accepted":true
}
```

Only POST replies include `accepted`. Journal/deferred jobs contain `id`,
`rootId`, `reminderId`, `title`, original `melody`, `due`, `expiresAt`, delivery
`status` and user `outcome`. History is `delivered`; deferred jobs are `queued`.
Optional `completedAt` and `snoozedTo` describe actions. A timer moving into
history retains its ID and root. History and deferred IDs do not overlap.

A different active owner needs explicit `takeover:true`. A lower revision from
the current owner is rejected. Repeating a revision with the same immutable
configuration refreshes time and returns live progress without resetting it;
changed configuration at that revision is rejected. `utcNow`, `takeover`,
`nextDue` and moving deferred entries are excluded from revision equality.
Unchanged definitions preserve device cursors across newer revisions, including
handback. Command lists are frozen on the desktop for each upload revision.

The desktop persists device ownership **before** enabling it remotely. Failed
or lost responses keep desktop generation and delivery stopped. Disabling
persists the desired setting while retaining that fence, sends `enabled:false`,
then durably imports live cursors/history/timers before resuming desktop work.
A failed handback can be retried with “Takvimi eşitle.” Switching the device
address is blocked until that handback is confirmed.

Time is deliberately untrusted at every device boot. Neither saved UTC nor
build time enables scheduling. Fresh authenticated desktop UTC or an SNTP
callback establishes trust. The device can then schedule without the desktop
and during network outages; another power loss requires fresh synchronization.
The OLED shows waiting for time and health reports `timeValid:false` until then.

## Device actions

`GET /api/events` returns up to 16 actions in creation order:

```json
{"protocol":4,"events":[{"id":"0123456789abcdef0123456789abcdef","notificationId":"water:1791262800000","action":"snoozed","minutes":15}]}
```

Event IDs are persistent 32-character lowercase hex strings. Actions are
`completed` or `snoozed` (15 minutes). Autonomous events also include a full
`job` snapshot; snoozes include the new `deferred` job, whose timer starts on
the device immediately. Legacy desktop-owned actions have no autonomous job
snapshot, so their snooze starts when the desktop receives the event.

`POST /api/events/ack`, body up to 2048 bytes:

```json
{"ids":["0123456789abcdef0123456789abcdef"]}
```

```json
{"protocol":4,"acknowledged":["0123456789abcdef0123456789abcdef"]}
```

Reading does not remove events. Repeated ACKs succeed. The desktop validates
whole batches, durably merges effects and retains its last 64 processed IDs
before ACK. Failed desktop writes leave device events intact; failed device
writes restore queue/events/schedule together. A full event queue never evicts
an unacknowledged action and leaves the notice available with an OLED warning.
Completing an occurrence cancels its snooze family, preserving future repeats.
Unknown legacy/test IDs are acknowledged without creating reminders.

BOOT: 40 ms debounce, 350 ms second-press window. Single press dismisses;
double press completes; releasing a 1–5 second hold snoozes; five seconds opens
setup and suppresses both actions. A gesture pins the displayed notice.
Timeout/dismiss do not mark completion. Idle BOOT wakes the screen. These
behaviors have host tests; physical board verification remains pending.

## Storage, migration and rollback

Firmware 0.8.0 atomically renames `/masa-state.tmp` to `/masa-state.json` in
LittleFS, storing pending/recent/events/schedule together before acknowledging
a mutation. An interrupted or failed write preserves the previous snapshot.
`/wifi.json` and the original NVS queue/key remain separate and intact. First
migration reads the old NVS queue, preserving IDs and events, then commits the
new snapshot. Corrupt state fails closed. Only a completely erased filesystem
partition is formatted automatically; a damaged existing partition is preserved.
Normal updates must not use `uploadfs`.

The retained NVS queue is a **pre-migration backup**, not a current mirror.
Before downgrade: disable autonomous scheduling, synchronize/drain actions,
retain backups, and account for stale NVS notices replaying. An old firmware
cannot consume the new LittleFS schedule; rollback is not seamless.

Desktop state version 7 adds screen preferences; version 6 added cron
definitions; version 5 added quiet preferences
and persisted scheduler ownership. Migration preserves schedules, IDs, snooze
families, receipts, device credentials and active ownership. Original v1–6 states are backed up under `reminder-state-v<version>-backup` before startup
migration. v1 vibration settings become chime/silence; v3's legacy snoozed status
becomes an outcome separate from delivery status. Returning to an older desktop
requires confirmed device handback, quitting the app and restoring the matching
state backup. Versions 6 and 7 prevent an old desktop from interpreting cron as a
daily reminder. Later changes do not appear in that backup.

Portable `masa-reminders` JSON version 1 exports definitions/preferences only,
including quiet and screen preferences, excluding keys, Wi-Fi, runtime jobs and ownership. Import validates the full
file and combined capacity before writing. Existing data is saved under
`reminder-import-backup` as `{createdAt,state}` before a changed import; failures
preserve current state. Merge replaces matching IDs without duplicates and keeps
other definitions; replace removes other definitions. An identical import is
read-only. Historical raw desktop state v1–7 can be imported as definitions.

## Display settings · firmware 0.8.0+

`GET /api/health` advertises `displaySettings: true`. Missing capability leaves
screen preferences saved locally with an explicit upgrade/pending status.

Authenticated `GET /api/display` returns current `{protocol:4, settings,
nextDue}`. Authenticated `POST /api/display` accepts:

```json
{
  "settings":{"alwaysOn":false,"sleepMinutes":2,"wakeBeforeMinutes":10,"wakeAfterMinutes":10},
  "nextDue":1791288000000,
  "utcNow":1791287100000
}
```

POST replies with the same settings/hint plus `accepted:true`. This endpoint
works independently of schedule ownership and does not change its owner,
revision, enabled state, cursors or delivery records. `nextDue` is a UTC
millisecond timestamp or null; desktop sends its nearest active occurrence or
snooze. Autonomous mode uses actual device cursors/deferred jobs instead.
UTC synchronization does not reset the manual idle timer.

`alwaysOn` must be boolean; integer `sleepMinutes` is 1–1440 and both wake
windows are 0–1440. Missing legacy display state defaults to false/2/10/10.
Preferences and hints are stored atomically with the device journal; identical
updates only refresh the clock without writing flash. HTTP 507 preserves the
previous state and does not claim acceptance.

The before window is `[due-before,due)`, the after window is `[due,due+after)`;
zero disables that side. A passed hint retains the after window when its cursor
advances. A future removed/paused hint stops pre-waking. Actual notice receipt
and display start preserve a post-window for delayed/restored notices. Closely
spaced reminder windows overlap. Epoch windows require a trusted clock;
always-on, active notices and BOOT wake remain effective without it. Outside
windows idle contrast dims halfway through the configured sleep interval and
then powers down. Window rendering does not extend the idle timer.

## OLED, simulator and provisioning

Active notices take priority over idle clock/date, next title, countdown and
connection/clock state, rotating every five seconds. Default idle contrast dims
at 60 seconds and turns off at 120 seconds; configured display settings and
reminder windows override these defaults. BOOT or a new notice wakes it. The
72×40 OLED displays 12 characters × 3 rows in a Latin Extended 6×12 font with
Turkish glyphs. Paging uses code points; original UTF-8 titles stay in storage.

`npm run simulator` implements protocol 4 on localhost. Terminal controls:
`done <id>`, `snooze <id>`, `close <id>`. CLI state is volatile; tests inject
snapshots, persistent writes and a clock for restart/failure scenarios. The
simulator resolves POSIX rules through matching IANA rules in Node; firmware
uses its C library directly. It does not prove physical device operation.

AyresWiFiManager 2.3.0 handles the open `Masa-XXXX` setup AP, scanning and
`POST /save` credentials. Legacy NVS Wi-Fi is imported once only if no existing
file/import marker exists; original NVS remains for recovery. Pinned compatibility
patches are applied to build-local dependency copies. See the hardware guide for
wiring and physical verification.
