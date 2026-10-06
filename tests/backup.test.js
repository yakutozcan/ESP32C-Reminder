import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, parseBackup } from '../src/core/backup.js';

const reminder = { id: 'portable-1', title: 'Mola ver', frequency: 'daily', time: '09:00', melody: 'chime', enabled: true };
const portable = reminders => ({ format: 'masa-reminders', version: 1, reminders });

test('portable export preserves definitions and quiet preferences without credentials or runtime data', () => {
  const state = { reminders: [{ ...reminder, nextDue: 42, token: 'secret' }],
    device: { url: 'http://secret', token: 'secret' }, jobs: [{ title: 'private history' }],
    scheduler: { ownerId: 'secret-owner' }, settings: { quietEnabled: true, quietStart: '22:00', quietEnd: '08:00', token: 'secret' } };
  const backup = createBackup(state, 0);
  assert.equal(backup.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(backup.reminders[0].id, reminder.id);
  assert.equal(JSON.stringify(backup).includes('secret'), false);
  for (const key of ['device', 'jobs', 'scheduler']) assert.equal(key in backup, false);
  assert.equal('nextDue' in backup.reminders[0], false);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.deepEqual(parsed.reminders, backup.reminders);
  assert.deepEqual(parsed.settings, state.settings && { quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' });
});

test('current and legacy state exports import definitions only without mutating source', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const entry = version === 1 ? { ...reminder, melody: undefined, vibrationMs: 0 } : reminder;
    const data = { version, reminders: [entry], jobs: [{ arbitrary: true }], device: { token: 'secret' } };
    const before = JSON.stringify(data);
    const parsed = parseBackup(data);
    assert.equal(parsed.reminders[0].melody, version === 1 ? 'none' : 'chime');
    assert.equal('device' in parsed, false);
    assert.equal('jobs' in parsed, false);
    assert.equal(JSON.stringify(data), before);
  }
});

test('malformed and unsupported files fail validation before importing', () => {
  for (const input of ['{', 'x'.repeat(1024 * 1024 + 1), null, [], {},
    { ...portable([]), version: 2 }, { ...portable([]), format: 'other' },
    portable([{ ...reminder, title: '' }]), portable([{ ...reminder, id: '' }]),
    portable([{ ...reminder, id: '<unsafe>' }]), portable([{ ...reminder, enabled: 'yes' }]),
    portable([reminder, reminder]), portable(Array.from({ length: 101 }, (_, i) => ({ ...reminder, id: 'r' + i }))),
    { ...portable([reminder]), settings: { quietEnabled: true, quietStart: '22:00', quietEnd: '22:00' } },
    { ...portable([reminder]), settings: { quietEnabled: 'true' } }, { ...portable([reminder]), settings: null },
    { version: 1, reminders: [{ ...reminder, vibrationMs: 5001 }], jobs: [] }]) assert.throws(() => parseBackup(input));
});

test('portable backup retains two-week and interval schedules as stable definitions', () => {
  const reminders = [
    { ...reminder, frequency: 'weekly', weekdays: [1, 5], weekInterval: 2, anchorDate: '2026-10-05' },
    { ...reminder, id: 'interval', frequency: 'interval', intervalMinutes: 120,
      anchorAt: new Date('2026-10-06T08:00:00').getTime(), weekdays: [1, 2, 3, 4, 5, 6], workStart: '09:00', workEnd: '18:00' }
  ];
  const data = parseBackup(createBackup({ reminders }));
  assert.equal(data.reminders[0].anchorDate, '2026-10-05');
  assert.equal(data.reminders[0].weekInterval, 2);
  assert.equal(data.reminders[1].anchorAt, reminders[1].anchorAt);
  assert.equal(data.reminders[1].workEnd, '18:00');
});
