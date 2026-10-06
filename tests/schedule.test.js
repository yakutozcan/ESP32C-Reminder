import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAfter, latestDue, validateReminder, normalizeDeviceReminder, validateQuietHours, isQuietAt, deviceTimezone, DAY } from '../src/core/schedule.js';
const base = { title: 'Bitkileri sula', frequency: 'daily', time: '09:00', weekdays: [], monthDay: 31, melody: 'chime' };
const local = text => new Date(text).getTime();
test('daily recurrence stays at local wall clock and is strictly after the boundary', () => {
  assert.equal(nextAfter(base, local('2026-10-05T08:59:59')), local('2026-10-05T09:00:00'));
  assert.equal(nextAfter(base, local('2026-10-05T09:00:00')), local('2026-10-06T09:00:00'));
});
test('weekly recurrence crosses year boundaries and respects multiple days', () => {
  const r = { ...base, frequency: 'weekly', weekdays: [1, 5] };
  assert.equal(nextAfter(r, local('2026-12-31T11:00:00')), local('2027-01-01T09:00:00'));
  assert.equal(nextAfter(r, local('2027-01-01T09:00:00')), local('2027-01-04T09:00:00'));
});
test('monthly day 31 clamps for February without drifting in March', () => {
  const r = { ...base, frequency: 'monthly' };
  const feb = nextAfter(r, local('2026-01-31T09:00:00'));
  assert.equal(feb, local('2026-02-28T09:00:00'));
  assert.equal(nextAfter(r, feb), local('2026-03-31T09:00:00'));
  assert.equal(nextAfter(r, local('2028-01-31T09:00:00')), local('2028-02-29T09:00:00'));
});
test('missed repeats collapse to the most recent occurrence within 24 hours', () => {
  assert.equal(latestDue(base, local('2026-09-01T09:00:00'), local('2026-10-05T12:00:00')), local('2026-10-05T09:00:00'));
  const monthly = { ...base, frequency: 'monthly', monthDay: 1 };
  assert.equal(latestDue(monthly, local('2026-09-01T09:00:00'), local('2026-10-05T12:00:00')), null);
});
test('invalid schedule and melody values are rejected', () => {
  for (const change of [{ title: '' }, { time: '24:00' }, { frequency: 'weekly', weekdays: [] },
    { frequency: 'monthly', monthDay: 32 }, { melody: 'unknown' }, { melody: 800 }, { title: 'a\nb' }]) {
    assert.throws(() => validateReminder({ ...base, ...change }));
  }
});
test('DST keeps the chosen hour instead of adding a fixed 24 hours', () => {
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const before = new Date(2026, 2, 7, 9).getTime();
    const after = nextAfter(base, before);
    assert.equal(new Date(after).getHours(), 9);
    assert.equal(after - before, DAY - 3600000);
    const gap = nextAfter({ ...base, time: '02:30' }, new Date(2026, 2, 8, 0).getTime());
    assert.equal(new Date(gap).getHours(), 3);
    const fold = nextAfter({ ...base, time: '01:30' }, new Date(2026, 10, 1, 0).getTime());
    assert.equal(nextAfter({ ...base, time: '01:30' }, fold), new Date(2026, 10, 2, 1, 30).getTime());
  } finally { process.env.TZ = old; }
});

test('one-off schedules have one local occurrence and no next repeat', () => {
  const reminder = validateReminder({ ...base, frequency: 'once', onceDate: '2026-10-06' });
  const due = local('2026-10-06T09:00:00');
  assert.equal(reminder.scheduledAt, due);
  assert.equal(nextAfter(reminder, due - 1), due);
  assert.equal(nextAfter(reminder, due), null);
  assert.equal(latestDue(reminder, due, due - 1), null);
  assert.equal(latestDue(reminder, due, due + DAY - 1), due);
  assert.equal(latestDue(reminder, due, due + DAY), null);
  assert.equal(latestDue(reminder, null, due), null);
});

test('one-off dates reject missing and normalized invalid calendar dates', () => {
  for (const onceDate of [undefined, '', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '0099-01-01']) {
    assert.throws(() => validateReminder({ ...base, frequency: 'once', onceDate }), /tarih/);
  }
  assert.equal(validateReminder({ ...base, frequency: 'once', onceDate: '2028-02-29' }).onceDate, '2028-02-29');
});


const intervalReminder = changes => validateReminder({ ...base, frequency: 'interval', weekdays: undefined, intervalMinutes: 120,
  anchorAt: local('2026-10-05T09:00:00'), ...changes });

test('interval recurrence retains its anchor and computes large missed gaps arithmetically', () => {
  const r = intervalReminder();
  const anchor = r.anchorAt;
  assert.equal(nextAfter(r, anchor - 1), anchor);
  assert.equal(nextAfter(r, anchor), anchor + 120 * 60000);
  assert.equal(nextAfter(r, anchor + 60000), anchor + 120 * 60000);
  const now = anchor + 500000 * 120 * 60000 + 9000;
  assert.equal(latestDue(r, anchor, now), now - 9000);
  assert.equal(latestDue(r, now + 1, now), null);
  assert.equal(latestDue(r, null, now), null);
  assert.equal(normalizeDeviceReminder(r).anchorAt, anchor);
  assert.deepEqual(r.weekdays, [0, 1, 2, 3, 4, 5, 6]);
});

test('interval work windows reset each day, exclude the end, and skip weekends', () => {
  const r = intervalReminder({ intervalMinutes: 120, weekdays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00' });
  assert.equal(nextAfter(r, local('2026-10-05T08:00:00')), local('2026-10-05T09:00:00'));
  assert.equal(nextAfter(r, local('2026-10-05T10:30:00')), local('2026-10-05T11:00:00'));
  assert.equal(nextAfter(r, local('2026-10-05T15:00:00')), local('2026-10-06T09:00:00'));
  assert.equal(nextAfter(r, local('2026-10-09T16:30:00')), local('2026-10-12T09:00:00'));
  assert.equal(latestDue(r, r.anchorAt, local('2026-10-09T18:00:00')), local('2026-10-09T15:00:00'));
  assert.equal(latestDue(r, r.anchorAt, local('2026-10-11T12:00:00')), null);
});

test('restricted intervals keep the global grid and retain previous allowed-day due', () => {
  const r = intervalReminder({ intervalMinutes: 90, weekdays: [1, 2, 3, 4, 5] });
  assert.equal(nextAfter(r, local('2026-10-09T23:59:00')), local('2026-10-12T00:00:00'));
  assert.equal(latestDue(r, r.anchorAt, local('2026-10-10T00:30:00')), local('2026-10-09T22:30:00'));
  assert.equal(latestDue(r, r.anchorAt, local('2026-10-11T12:00:00')), null);
});

test('interval grace boundary is strict and future firstDue is retained', () => {
  const r = intervalReminder({ intervalMinutes: 2880 });
  assert.equal(latestDue(r, r.anchorAt, r.anchorAt + DAY), null);
  assert.equal(latestDue(r, r.anchorAt, r.anchorAt + DAY - 1), r.anchorAt);
  assert.equal(latestDue(r, r.anchorAt + 2880 * 60000, r.anchorAt + 60000), null);
});

test('invalid interval schedules reject corrupt values and impossible weekday combinations', () => {
  for (const change of [{ intervalMinutes: 0 }, { intervalMinutes: 10081 }, { intervalMinutes: 1.5 },
    { anchorAt: -1 }, { anchorAt: NaN }, { weekdays: [] }, { weekdays: [7] }, { workStart: '09:00' },
    { workStart: '17:00', workEnd: '09:00' }, { workStart: '09:00', workEnd: '09:00' }]) {
    assert.throws(() => intervalReminder(change));
  }
  const old = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Istanbul';
    assert.throws(() => intervalReminder({ intervalMinutes: 10080, weekdays: [2] }), /uygun/);
  } finally { process.env.TZ = old; }
});

test('biweekly recurrence anchors Monday weeks across years and DST', () => {
  const r = validateReminder({ ...base, frequency: 'weekly', weekdays: [1, 5], weekInterval: 2, anchorDate: '2026-12-30' });
  assert.equal(nextAfter(r, local('2026-12-31T11:00:00')), local('2027-01-01T09:00:00'));
  assert.equal(nextAfter(r, local('2027-01-01T09:00:00')), local('2027-01-11T09:00:00'));
  assert.equal(validateReminder({ ...base, frequency: 'weekly', weekdays: [1] }).weekInterval, 1);
  assert.throws(() => validateReminder({ ...r, weekInterval: 3 }));
  assert.throws(() => validateReminder({ ...r, anchorDate: '2026-02-29' }));
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const spring = { ...r, weekdays: [1], anchorDate: '2026-03-02' };
    assert.equal(nextAfter(spring, local('2026-03-02T09:00:00')), local('2026-03-16T09:00:00'));
  } finally { process.env.TZ = old; }
});

test('work-window and global intervals keep their distinct DST behavior', () => {
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const r = intervalReminder({ workStart: '09:00', workEnd: '17:00' });
    assert.equal(nextAfter(r, local('2026-03-07T15:00:00')), local('2026-03-08T09:00:00'));
    const anchored = intervalReminder({ intervalMinutes: 1440, anchorAt: local('2026-03-07T09:00:00') });
    assert.equal(nextAfter(anchored, anchored.anchorAt), local('2026-03-08T10:00:00'));
  } finally { process.env.TZ = old; }
});

test('quiet hours handle overnight and same-day windows with exact boundaries', () => {
  const overnight = validateQuietHours({ quietEnabled: true });
  assert.equal(isQuietAt(overnight, local('2026-10-05T21:59:59')), false);
  assert.equal(isQuietAt(overnight, local('2026-10-05T22:00:00')), true);
  assert.equal(isQuietAt(overnight, local('2026-10-06T07:59:59')), true);
  assert.equal(isQuietAt(overnight, local('2026-10-06T08:00:00')), false);
  const daytime = { quietEnabled: true, quietStart: '12:00', quietEnd: '14:00' };
  assert.equal(isQuietAt(daytime, local('2026-10-05T13:00:00')), true);
  assert.equal(isQuietAt(daytime, local('2026-10-05T23:00:00')), false);
  assert.equal(isQuietAt(validateQuietHours(), local('2026-10-05T23:00:00')), false);
  assert.throws(() => validateQuietHours({ quietEnabled: true, quietStart: '08:00', quietEnd: '08:00' }));
  assert.throws(() => validateQuietHours({ quietStart: '24:00' }));
  for (const value of [null, { quietEnabled: 'yes' }, { quietEnabled: 1 }, { quietStart: null }, { quietEnd: 800 }]) assert.throws(() => validateQuietHours(value));
});

test('device timezone uses fixed POSIX offsets and stable standard DST M rules', () => {
  const old = process.env.TZ;
  try {
    const at = Date.UTC(2026, 9, 6);
    for (const [zone, expected] of [
      ['Europe/Istanbul', 'STD-3'], ['UTC', 'STD0'], ['Asia/Kolkata', 'STD-5:30'],
      ['America/New_York', 'STD5DST4,M3.2.0/2,M11.1.0/2'],
      ['Europe/Berlin', 'STD-1DST-2,M3.5.0/2,M10.5.0/3'],
      ['Australia/Sydney', 'STD-10DST-11,M10.1.0/2,M4.1.0/3']
    ]) {
      process.env.TZ = zone;
      assert.equal(deviceTimezone(at), expected, zone);
    }
    process.env.TZ = 'Africa/Casablanca';
    assert.throws(() => deviceTimezone(at), /desteklenmiyor/);
  } finally { process.env.TZ = old; }
});
