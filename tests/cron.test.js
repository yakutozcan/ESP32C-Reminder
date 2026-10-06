import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextCronAfter, latestCronDue } from '../src/core/cron.js';
import { validateReminder, nextAfter, latestDue, DAY } from '../src/core/schedule.js';
const local = value => new Date(value).getTime();
const reminder = expression => validateReminder({ title: 'Cron hatırlatması', frequency: 'cron', cronExpression: expression, melody: 'none' });
const withTimezone = (zone, action) => {
  const previous = process.env.TZ;
  try { process.env.TZ = zone; action(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
};

test('parser canonicalizes names and spacing while retaining numeric ranges, steps, lists and star flags', () => {
  const rule = parseCron('  00,15-45/015\t08-18/2  */02  jan,mar-dec/3  mon-fri,7 ');
  assert.equal(rule.expression, '0,15-45/15 8-18/2 */2 1,3-12/3 1-5,7');
  assert.deepEqual(rule.minutes, [0, 15, 30, 45]);
  assert.deepEqual(rule.hours, [8, 10, 12, 14, 16, 18]);
  assert.deepEqual(rule.months, [1, 3, 6, 9, 12]);
  assert.deepEqual(rule.daysOfWeek, [0, 1, 2, 3, 4, 5]);
  assert.equal(rule.dayOfMonthStar, true); assert.equal(rule.dayOfWeekStar, false);
  assert.deepEqual(parseCron('5/15 * * * *').minutes, [5, 20, 35, 50]);
  assert.deepEqual(parseCron('*/100 * * * *').minutes, [0]);
  assert.equal(parseCron('0 0 1,* * 1').dayOfMonthStar, false);
  assert.equal(parseCron('0 0 *,1 * 1').dayOfMonthStar, true);
  assert.equal(parseCron(rule.expression).expression, rule.expression);
});

test('named aliases expand to canonical five-field schedules', () => {
  for (const [alias, expected] of [['@hourly', '0 * * * *'], ['@DAILY', '0 0 * * *'], ['@weekly', '0 0 * * 0'],
    ['@monthly', '0 0 1 * *'], ['@yearly', '0 0 1 1 *'], ['@annually', '0 0 1 1 *'], ['@midnight', '0 0 * * *']]) {
    assert.equal(parseCron(alias).expression, expected);
  }
});

test('invalid syntax, unsupported field forms and impossible dates fail before saving', () => {
  for (const expression of [undefined, null, '', '@reboot', '0 0 * *', '0 0 0 * * *', '0 0 * * * command',
    '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 0 *', '* * * * 8', '*/0 * * * *',
    '*/-1 * * * *', '*/1.5 * * * *', '*/2147483648 * * * *', '45-15 * * * *', '1,,2 * * * *',
    '0 0 ? * *', '0 0 L * *', '0 0 1W * *', '0 0 * * MON#2', '0 0 * JAN1 *', '0 0 * */JAN *',
    '0 0 * FOO *', '0 0 * * MONTUE', '0 0 31 FEB *', '0 0 31 APR */2', 'x'.repeat(257)]) {
    assert.throws(() => parseCron(expression), expression);
    assert.throws(() => reminder(expression), expression);
  }
  assert.equal(parseCron('0 0 29 FEB *').expression, '0 0 29 2 *');
  // With both day fields restricted, Mondays are valid even though February 31 is not.
  assert.equal(parseCron('0 0 31 FEB MON').expression, '0 0 31 2 1');
});

test('minute precision is strictly after the timestamp and validation needs no time', () => {
  const r = reminder('*/15 * * * *');
  assert.equal(r.time, '00:00');
  assert.equal(nextAfter(r, local('2026-10-06T09:14:59.999')), local('2026-10-06T09:15:00'));
  assert.equal(nextAfter(r, local('2026-10-06T09:15:00')), local('2026-10-06T09:30:00'));
  assert.equal(nextAfter(r, local('2026-10-06T09:15:00.001')), local('2026-10-06T09:30:00'));
  assert.equal(nextCronAfter('@hourly', local('2026-12-31T23:59:59')), local('2027-01-01T00:00:00'));
});

test('Vixie day rules use OR for restricted DOM/DOW and AND when a field begins with star', () => {
  const before = local('2026-10-06T10:00:00'); // Tuesday, October 6.
  assert.equal(nextCronAfter('0 9 13 * MON', before), local('2026-10-12T09:00:00'));
  assert.equal(nextCronAfter('0 9 13 * MON', local('2026-10-12T09:00:00')), local('2026-10-13T09:00:00'));
  assert.equal(nextCronAfter('0 9 * * MON', before), local('2026-10-12T09:00:00'));
  assert.equal(nextCronAfter('0 9 */2 * MON', before), local('2026-10-19T09:00:00'));
  assert.equal(nextCronAfter('0 9 13 * *', before), local('2026-10-13T09:00:00'));
  assert.equal(nextCronAfter('0 9 31 FEB MON', local('2026-02-01T10:00:00')), local('2026-02-02T09:00:00'));
});

test('leap schedules remain valid in non-leap years and cross the non-leap century gap', () => {
  assert.equal(nextCronAfter('0 9 29 FEB *', local('2026-02-28T12:00:00')), local('2028-02-29T09:00:00'));
  assert.equal(nextCronAfter('0 0 29 2 *', local('2096-02-29T00:00:00')), local('2104-02-29T00:00:00'));
  assert.equal(nextCronAfter('0 9 31 * *', local('2026-01-31T09:00:00')), local('2026-03-31T09:00:00'));
});

test('DST gaps skip missing wall minutes and folds emit both distinct epochs', () => withTimezone('America/New_York', () => {
  assert.equal(nextCronAfter('30 2 * * *', local('2026-03-08T00:00:00')), local('2026-03-09T02:30:00'));
  const fold = '30 1 * * *';
  const first = Date.UTC(2026, 10, 1, 5, 30), second = Date.UTC(2026, 10, 1, 6, 30);
  assert.equal(nextCronAfter(fold, local('2026-11-01T00:00:00')), first);
  assert.equal(nextCronAfter(fold, first), second);
  assert.equal(nextCronAfter(fold, first + 1), second);
  assert.equal(nextCronAfter(fold, second), local('2026-11-02T01:30:00'));
  assert.equal(latestCronDue(fold, first, second), second);
  assert.equal(latestCronDue(fold, first, second - 1), first);
}));

test('30-minute DST folds also emit both wall minutes without assuming a one-hour transition', () => withTimezone('Australia/Lord_Howe', () => {
  const first = Date.UTC(2026, 3, 4, 14, 45), second = Date.UTC(2026, 3, 4, 15, 15);
  assert.equal(nextCronAfter('45 1 * * *', local('2026-04-05T00:00:00')), first);
  assert.equal(nextCronAfter('45 1 * * *', first), second);
}));

test('latest cron collapses years of backlog to the latest minute and respects its strict grace window', () => {
  const r = reminder('* * * * *');
  const now = local('2026-10-06T09:17:45.123');
  assert.equal(latestDue(r, local('2020-01-01T00:00:00'), now), local('2026-10-06T09:17:00'));
  assert.equal(latestDue(r, null, now), null);
  assert.equal(latestDue(r, now + 1, now), null);
  const annual = reminder('0 9 6 10 *'), due = local('2026-10-06T09:00:00');
  assert.equal(latestDue(annual, due, due + DAY - 1), due);
  assert.equal(latestDue(annual, due, due + DAY), null);
});

test('latest cron checks elapsed-time grace correctly across short and long DST days', () => withTimezone('America/New_York', () => {
  const r = reminder('0 9 * * *');
  const march = local('2026-03-07T09:00:00');
  assert.equal(latestDue(r, march, local('2026-03-08T08:30:00')), march);
  const october = local('2026-10-31T09:00:00');
  assert.equal(latestDue(r, october, local('2026-11-01T08:30:00')), null);
}));


test('star-prefixed weekday restrictions can leave valid gaps longer than eight years', () => withTimezone('UTC', () => {
  const firstSunday = '0 0 */31 2 SUN'; // */31 contains only the first day of the month.
  assert.equal(nextCronAfter(firstSunday, local('2037-02-01T00:00:00')), local('2043-02-01T00:00:00'));
  assert.equal(nextCronAfter(firstSunday, local('2043-02-01T00:00:00')), local('2054-02-01T00:00:00'));
  const leapSunday = '0 0 29 2 */7'; // Star flag requires both February 29 and Sunday.
  assert.equal(nextCronAfter(leapSunday, local('2032-02-29T00:00:00')), local('2060-02-29T00:00:00'));
  assert.equal(nextCronAfter(leapSunday, local('2088-02-29T00:00:00')), local('2128-02-29T00:00:00'));
  assert.equal(nextAfter(reminder(leapSunday), local('2088-02-29T00:00:00')), local('2128-02-29T00:00:00'));
}));
