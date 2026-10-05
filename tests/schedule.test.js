import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAfter, latestDue, validateReminder, DAY } from '../src/core/schedule.js';
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
