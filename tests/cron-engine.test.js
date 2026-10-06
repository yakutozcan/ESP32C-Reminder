import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, newState, migrateState } from '../src/core/engine.js';
import { validateSettings } from '../src/core/settings.js';
import { createBackup, parseBackup } from '../src/core/backup.js';
import { requestDevice, readDeviceEvents } from '../src/core/device.js';
import { createSimulator } from '../tools/device-simulator.js';
const at = text => new Date(text).getTime();
const input = { title: 'Saat başı mola', frequency: 'cron', cronExpression: '0 * * * *', melody: 'none' };
function fixture(options = {}) {
  let now = at('2026-10-06T08:12:30'), saved, sequence = 0;
  const sent = [], notifications = [];
  const config = { clock: () => now, id: () => 'cron-' + (++sequence),
    persist: async state => { saved = structuredClone(state); }, send: async (_, job) => sent.push(job),
    backup: async () => true, notify: title => notifications.push(title), ...options };
  let engine = new ReminderEngine(config);
  return { get engine() { return engine; }, sent, notifications, advance: value => { now = value; },
    restart: () => { engine = new ReminderEngine({ ...config, state: saved }); } };
}
async function deviceFixture(t, cron = true) {
  const f = fixture();
  const notices = [], simulator = createSimulator({ cron, clock: () => at('2026-10-06T08:12:30'), onNotice: n => notices.push(n) });
  await new Promise(resolve => simulator.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => simulator.close(resolve)));
  await f.engine.setDevice({ url: `http://127.0.0.1:${simulator.address().port}`, token: 'local-simulator-token-12345678' });
  f.engine.health = d => requestDevice(d, '/api/health');
  f.engine.readSchedule = d => requestDevice(d, '/api/schedule');
  f.engine.writeSchedule = (d, p) => requestDevice(d, '/api/schedule', p);
  f.engine.readEvents = readDeviceEvents;
  f.engine.ackEvents = (d, ids) => requestDevice(d, '/api/events/ack', { ids });
  return { ...f, engine: f.engine, notices, simulator };
}

test('cron preview uses the scheduler clock and never changes saved reminders', () => {
  const f = fixture(), before = f.engine.snapshot();
  const preview = f.engine.previewSchedule({ reminder: { ...input, title: '', cronExpression: '@hourly' } });
  assert.deepEqual(preview, { cronExpression: '0 * * * *', occurrences: [at('2026-10-06T09:00:00'), at('2026-10-06T10:00:00'), at('2026-10-06T11:00:00')] });
  assert.deepEqual(f.engine.snapshot(), before);
  assert.throws(() => f.engine.previewSchedule({ reminder: { ...input, cronExpression: 'bad' } }));
});

test('cron retry and restart retain one occurrence ID and the next recurrence', async () => {
  const f = fixture();
  const reminder = await f.engine.saveReminder(input);
  f.engine.send = async () => { throw new Error('offline'); };
  f.advance(at('2026-10-06T09:00:05')); await f.engine.tick();
  assert.equal(f.engine.state.jobs[0].id, reminder.id + ':' + at('2026-10-06T09:00:00'));
  assert.equal(f.engine.state.reminders[0].nextDue, at('2026-10-06T10:00:00'));
  f.restart(); f.advance(at('2026-10-06T09:01:00')); await f.engine.tick(); await f.engine.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.engine.state.jobs.length, 1);
  f.advance(at('2026-10-06T10:00:00')); await f.engine.tick();
  assert.equal(f.sent.length, 2); assert.notEqual(f.sent[0].id, f.sent[1].id);
});

test('minute cron collapses a long absence into the latest occurrence', async () => {
  const f = fixture(); await f.engine.saveReminder({ ...input, cronExpression: '* * * * *' });
  f.advance(at('2026-10-10T10:03:42')); await f.engine.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.engine.state.jobs[0].due, at('2026-10-10T10:03:00'));
  assert.equal(f.engine.state.reminders[0].nextDue, at('2026-10-10T10:04:00'));
});

test('cron definitions roundtrip portable and v6 backups with merge idempotence', async () => {
  const f = fixture(); await f.engine.saveReminder({ ...input, cronExpression: '0 9 * * MON-FRI' });
  const backup = createBackup(f.engine.state);
  assert.equal(backup.reminders[0].cronExpression, '0 9 * * 1-5');
  assert.deepEqual(parseBackup(backup).reminders, parseBackup(f.engine.state).reminders);
  const other = fixture(); await other.engine.importBackup({ text: JSON.stringify(backup), mode: 'merge' });
  const before = other.engine.snapshot(); await other.engine.importBackup({ text: JSON.stringify(backup), mode: 'merge' });
  assert.deepEqual(other.engine.snapshot(), before);
  assert.equal(other.engine.state.reminders[0].frequency, 'cron');
});

test('v5 migration preserves ownership, cursors, quiet hours and credentials; unsupported future state fails closed', () => {
  const old = { ...newState(), version: 5, reminders: [{ id: 'kept', nextDue: 123 }],
    settings: { quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' },
    scheduler: { mode: 'device', desired: true, ownerId: 'owner', revision: 3, syncedRevision: 3 },
    device: { url: 'http://device', token: 'saved-private-key' } };
  assert.deepEqual(migrateState(old), { ...old, settings: validateSettings(old.settings), version: 7 });
  assert.equal(old.version, 5);
  assert.throws(() => migrateState({ ...old, version: 8 }), /desteklenmiyor/);
});

test('old firmware refuses cron handover, active edits and imports before changing local state', async t => {
  const f = await deviceFixture(t, false);
  await f.engine.saveReminder(input);
  const before = f.engine.snapshot();
  await assert.rejects(f.engine.setAutonomous({ enabled: true }), /0\.7\.0/);
  assert.deepEqual(f.engine.snapshot(), before);
  await f.engine.removeReminder(f.engine.state.reminders[0].id);
  await f.engine.saveReminder({ title: 'Eski günlük', frequency: 'daily', time: '09:00', melody: 'none' });
  await f.engine.setAutonomous({ enabled: true });
  const active = f.engine.snapshot();
  await assert.rejects(f.engine.saveReminder(input), /0\.7\.0/);
  assert.deepEqual(f.engine.snapshot(), active);
  const backup = createBackup({ ...newState(), reminders: [{ ...input, id: 'incoming' }] });
  await assert.rejects(f.engine.importBackup({ text: JSON.stringify(backup), mode: 'merge' }), /0\.7\.0/);
  assert.deepEqual(f.engine.snapshot(), active);
});

test('cron works with device ownership, quiet hours, completion, handback and next occurrence', async t => {
  const f = await deviceFixture(t);
  await f.engine.saveReminder({ ...input, melody: 'chime' });
  await f.engine.saveSettings({ quietEnabled: true, quietStart: '08:00', quietEnd: '10:00' });
  await f.engine.setAutonomous({ enabled: true });
  f.advance(at('2026-10-06T09:00:00')); f.simulator.syncClock(at('2026-10-06T09:00:00')); f.simulator.tick();
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].melody, 'none');
  await f.engine.syncDevice();
  const job = f.engine.state.jobs[0]; assert.equal(job.due, at('2026-10-06T09:00:00'));
  await f.engine.completeJob(job.id); await f.engine.syncDevice();
  assert.equal(f.simulator.snapshot().schedule.history[0].outcome, 'completed');
  await f.engine.setAutonomous({ enabled: false }); await f.engine.tick();
  assert.equal(f.engine.state.scheduler.mode, 'desktop'); assert.equal(f.sent.length, 0);
  f.advance(at('2026-10-06T10:00:00')); await f.engine.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].melody, 'chime');
});


test('known cron-capable ownership accepts offline edits and rechecks firmware before upload', async t => {
  const f = await deviceFixture(t);
  await f.engine.saveReminder(input); await f.engine.setAutonomous({ enabled: true });
  assert.equal(f.engine.state.scheduler.cronSupported, true);
  f.engine.health = async () => { throw new Error('offline'); };
  await f.engine.saveReminder({ ...f.engine.state.reminders[0], cronExpression: '0 */2 * * *' });
  assert.equal(f.engine.state.reminders[0].cronExpression, '0 */2 * * *');
  const beforeRemote = f.simulator.snapshot().schedule;
  await assert.rejects(f.engine.syncSchedule(), /offline/);
  assert.deepEqual(f.simulator.snapshot().schedule, beforeRemote);
  assert.equal(f.engine.state.scheduler.mode, 'device');
  f.engine.health = async () => ({ protocol: 4, cron: false });
  await assert.rejects(f.engine.syncSchedule(), /0\.7\.0/);
  assert.deepEqual(f.simulator.snapshot().schedule, beforeRemote);
  assert.equal(f.engine.state.scheduler.mode, 'device');
});
