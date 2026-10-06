import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, migrateState, newState } from '../src/core/engine.js';
import { DAY } from '../src/core/schedule.js';
const input = { title: 'Mola ver', frequency: 'daily', time: '09:00', melody: 'chime' };
function fixture(overrides = {}) {
  let now = new Date('2026-10-05T08:00:00').getTime();
  let saved;
  let sequence = 0;
  const received = [];
  const notices = [];
  const engine = new ReminderEngine({ clock: () => now, id: () => 'r' + (++sequence),
    persist: async state => { saved = state; return true; }, send: async (device, job) => received.push(job),
    notify: title => notices.push(title), ...overrides });
  return { engine, received, notices, advance: value => { now = value; }, now: () => now, saved: () => saved };
}
test('persist before send; multiple ticks send and notify once', async () => {
  const f = fixture();
  await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-05T09:00:00').getTime());
  f.engine.send = async (_, job) => { assert.equal(f.saved().jobs[0].status, 'queued'); f.received.push(job); };
  await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
  assert.equal(f.received.length, 1); assert.deepEqual(f.notices, ['Mola ver']);
  assert.equal(f.engine.state.jobs[0].status, 'delivered');
});
test('offline delivery survives restart and retries with the same ID', async () => {
  const f = fixture({ send: async () => { throw new Error('offline'); } });
  await f.engine.saveReminder(input); f.advance(new Date('2026-10-05T09:00:00').getTime());
  await f.engine.tick();
  const old = f.saved();
  assert.equal(old.jobs[0].attempts, 1);
  const replay = fixture({ state: old }); replay.advance(old.jobs[0].retryAt);
  await replay.engine.tick();
  assert.equal(replay.received[0].id, old.jobs[0].id); assert.equal(replay.notices.length, 0);
  assert.equal(replay.engine.state.jobs[0].status, 'delivered');
});
test('storage failure never sends an unpersisted occurrence', async () => {
  const f = fixture(); await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-05T09:00:00').getTime()); f.engine.persist = async () => false;
  await assert.rejects(f.engine.tick(), /diske/);
  assert.equal(f.received.length, 0); assert.equal(f.engine.state.jobs.length, 0);
});
test('failed delivery acknowledgement save retries with stable ID', async () => {
  const f = fixture(); await f.engine.saveReminder(input);
  let saves = 0;
  f.engine.persist = async () => ++saves === 1;
  f.advance(new Date('2026-10-05T09:00:00').getTime());
  await assert.rejects(f.engine.tick());
  assert.equal(f.engine.state.jobs[0].status, 'queued');
  f.engine.persist = async () => true;
  await f.engine.tick(); assert.equal(f.received[0].id, f.received[1].id);
});
test('wake after weeks collapses missed reminders; expired jobs are not sent', async () => {
  const f = fixture(); await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-20T12:00:00').getTime()); await f.engine.tick();
  assert.equal(f.received.length, 1);
  assert.equal(f.engine.state.jobs[0].due, new Date('2026-10-20T09:00:00').getTime());
  const offline = fixture({ send: async () => { throw new Error('offline'); } });
  await offline.engine.saveReminder(input); offline.advance(new Date('2026-10-05T09:00:00').getTime()); await offline.engine.tick();
  const r = offline.engine.state.reminders[0]; await offline.engine.saveReminder({ ...r, enabled: false });
  assert.equal(offline.engine.state.jobs[0].status, 'cancelled');
});
test('deleting a reminder cancels its pending delivery', async () => {
  const f = fixture({ send: async () => { throw new Error('offline'); } });
  const r = await f.engine.saveReminder(input); f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  await f.engine.removeReminder(r.id); assert.equal(f.engine.state.jobs[0].status, 'cancelled');
});
test('concurrent CRUD operations do not lose updates', async () => {
  const f = fixture(); await Promise.all([f.engine.saveReminder(input), f.engine.saveReminder({ ...input, title: 'Su iç' })]);
  assert.equal(f.saved().reminders.length, 2);
});
test('unsupported saved versions fail closed', () => {
  assert.throws(() => fixture({ state: { version: 99, reminders: [], jobs: [] } }), /desteklenmiyor/);
});
test('queued delivery expires after 24 hours', async () => {
  const f = fixture({ send: async () => { throw new Error('offline'); } });
  await f.engine.saveReminder({ ...input, frequency: 'monthly', monthDay: 5 });
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  f.advance(new Date('2026-10-06T09:00:01').getTime()); await f.engine.tick();
  assert.equal(f.engine.state.jobs[0].status, 'expired'); assert.equal(f.engine.state.jobs[0].attempts, 1);
});
test('v1 migration preserves schedules, device key and queued IDs without mutating the backup', async () => {
  const now = new Date('2026-10-05T08:00:00').getTime();
  const legacy = { version: 1, device: { url: 'http://device', token: 'legacy-token-12345678901234' },
    reminders: [{ ...input, melody: undefined, vibrationMs: 2000, id: 'legacy', nextDue: now + 3600000 },
      { ...input, melody: undefined, vibrationMs: 0, id: 'silent', enabled: false, nextDue: now + 3600000 }],
    jobs: [{ id: 'legacy:stable', reminderId: 'legacy', title: 'Mola ver', vibrationMs: 800,
      due: now - 1, expiresAt: now + 1000, retryAt: now, attempts: 2, status: 'queued', error: 'offline' }] };
  const before = JSON.stringify(legacy);
  const f = fixture({ state: legacy });
  const migrated = f.engine.snapshot();
  assert.equal(migrated.version, 7);
  assert.deepEqual(migrated.device, legacy.device);
  assert.equal(migrated.reminders[0].nextDue, legacy.reminders[0].nextDue);
  assert.equal(migrated.reminders[0].melody, 'chime');
  assert.equal(migrated.reminders[1].melody, 'none');
  assert.equal(migrated.reminders[1].enabled, false);
  assert.equal('vibrationMs' in migrated.jobs[0], false);
  assert.deepEqual(migrateState(migrated), migrated);
  await f.engine.tick();
  assert.deepEqual(f.received, [{ id: 'legacy:stable', title: 'Mola ver', melody: 'chime' }]);
  assert.equal(JSON.stringify(legacy), before);
});
test('test notification always requests the short melody', async () => {
  const f = fixture(); await f.engine.testDevice();
  assert.equal(f.received[0].melody, 'chime');
  assert.equal('vibrationMs' in f.received[0], false);
});

test('one-off sends once, stops its schedule and remains stopped after restart', async () => {
  const f = fixture();
  await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-05' });
  f.advance(new Date('2026-10-05T09:00:00').getTime());
  await f.engine.tick();
  assert.equal(f.received.length, 1);
  assert.equal(f.engine.state.reminders[0].enabled, false);
  assert.equal(f.engine.state.reminders[0].nextDue, null);
  const replay = fixture({ state: f.saved() }); replay.advance(f.now() + DAY);
  await replay.engine.tick();
  assert.equal(replay.received.length, 0);
  assert.equal(replay.engine.state.jobs.length, 1);
});

test('one-off catches up within 24 hours but skips stale occurrences', async () => {
  for (const [delay, count] of [[3600000, 1], [DAY, 0]]) {
    const f = fixture();
    await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-05' });
    f.advance(new Date('2026-10-05T09:00:00').getTime() + delay);
    await f.engine.tick(); await f.engine.tick();
    assert.equal(f.received.length, count);
    assert.equal(f.engine.state.reminders[0].nextDue, null);
    assert.equal(f.engine.state.reminders[0].enabled, false);
  }
});

test('past enabled one-offs are rejected; expired entries can be rescheduled', async () => {
  const f = fixture();
  await assert.rejects(f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-04' }), /gelecekte/);
  const r = await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-05' });
  f.advance(r.nextDue); await f.engine.tick();
  await f.engine.saveReminder({ ...f.engine.state.reminders[0], onceDate: '2026-10-06', enabled: true });
  f.advance(new Date('2026-10-06T09:00:00').getTime()); await f.engine.tick();
  assert.equal(f.received.length, 2);
});

test('snooze survives restart, preserves the repeat schedule and does not send early', async () => {
  const f = fixture();
  await f.engine.saveReminder({ ...input, melody: 'none' });
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  const nextDue = f.engine.state.reminders[0].nextDue;
  const original = f.engine.state.jobs[0];
  await f.engine.snoozeJob(original.id, 15);
  const saved = f.saved(); const snoozed = saved.jobs[1];
  assert.equal(saved.jobs[0].outcome, 'snoozed');
  assert.equal(saved.jobs[0].status, 'delivered');
  assert.notEqual(snoozed.id, original.id);
  assert.equal(snoozed.due, f.now() + 15 * 60000);
  assert.equal(saved.reminders[0].nextDue, nextDue);
  assert.equal(f.notices.length, 1);
  const replay = fixture({ state: saved });
  await replay.engine.setDevice({ url: 'http://127.0.0.1:8787', token: 'local-simulator-token-12345678' });
  replay.advance(snoozed.due - 1); await replay.engine.tick();
  assert.equal(replay.received.length, 0); assert.equal(replay.notices.length, 0);
  replay.advance(snoozed.due); await Promise.all([replay.engine.tick(), replay.engine.tick()]);
  assert.deepEqual(replay.received, [{ id: snoozed.id, title: input.title, melody: 'none' }]);
  assert.deepEqual(replay.notices, [input.title]);
  assert.equal(replay.engine.state.reminders[0].nextDue, nextDue);
});

test('snoozed one-offs can be snoozed again without reactivating their schedule', async () => {
  const f = fixture();
  await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-05' });
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  await f.engine.snoozeJob(f.engine.state.jobs[0].id, 5);
  f.advance(f.now() + 5 * 60000); await f.engine.tick();
  await f.engine.snoozeJob(f.engine.state.jobs[1].id, 30);
  f.advance(f.now() + 30 * 60000); await f.engine.tick();
  assert.equal(f.received.length, 3); assert.equal(f.notices.length, 3);
  assert.equal(f.engine.state.reminders[0].nextDue, null);
  assert.equal(f.engine.state.reminders[0].enabled, false);
});

test('offline snooze replaces desktop pending delivery and retries with its new stable ID', async () => {
  const f = fixture({ send: async () => { throw new Error('offline'); } });
  await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  await f.engine.snoozeJob(f.engine.state.jobs[0].id, 5);
  f.advance(f.now() + 5 * 60000); await f.engine.tick();
  const snoozed = f.engine.state.jobs[1];
  assert.equal(snoozed.attempts, 1); assert.equal(f.notices.length, 2);
  f.engine.send = async (_, job) => f.received.push(job);
  f.advance(snoozed.retryAt); await f.engine.tick();
  assert.equal(f.received[0].id, snoozed.id); assert.equal(f.notices.length, 2);
  assert.equal(f.engine.state.jobs[0].attempts, 1);
});

test('failed snooze persistence leaves original delivery and schedule unchanged', async () => {
  const f = fixture(); await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  const before = f.engine.snapshot(); f.engine.persist = async () => false;
  await assert.rejects(f.engine.snoozeJob(before.jobs[0].id, 15), /diske/);
  assert.deepEqual(f.engine.snapshot(), before);
});

test('future, duplicate, expired and deleted reminder snoozes are rejected', async () => {
  const f = fixture(); await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  const original = f.engine.state.jobs[0].id;
  await assert.rejects(f.engine.snoozeJob(original, 10), /5, 15/);
  await assert.rejects(f.engine.snoozeJob('missing', 5), /ertelenemiyor/);
  await f.engine.snoozeJob(original, 5);
  await assert.rejects(f.engine.snoozeJob(original, 5), /ertelenemiyor/);
  await assert.rejects(f.engine.snoozeJob(f.engine.state.jobs[1].id, 5), /zamanı gelmiş/);
  await f.engine.removeReminder(f.engine.state.reminders[0].id);
  assert.equal(f.engine.state.jobs[1].status, 'cancelled');
  const expired = fixture(); await expired.engine.saveReminder(input);
  expired.advance(new Date('2026-10-05T09:00:00').getTime()); await expired.engine.tick();
  expired.advance(expired.now() + DAY);
  await assert.rejects(expired.engine.snoozeJob(expired.engine.state.jobs[0].id, 5), /24 saatte/);
});

test('snooze notification is not emitted or sent when its due-time save fails', async () => {
  const f = fixture(); await f.engine.saveReminder(input);
  f.advance(new Date('2026-10-05T09:00:00').getTime()); await f.engine.tick();
  await f.engine.snoozeJob(f.engine.state.jobs[0].id, 5);
  f.advance(f.now() + 5 * 60000); f.engine.persist = async () => false;
  await assert.rejects(f.engine.tick(), /diske/);
  assert.equal(f.notices.length, 1); assert.equal(f.received.length, 1);
  assert.equal(f.engine.state.jobs[1].desktopPending, true);
});

test('v2 migration adds user outcomes and leaves its backup intact', () => {
  const legacy = { version: 2, reminders: [{ ...input, id: 'old', enabled: true, nextDue: 1791176400000 }],
    jobs: [{ id: 'old:stable', status: 'queued', melody: 'none', due: 100, retryAt: 101, attempts: 3 }],
    device: { url: 'http://device', token: 'kept-private' } };
  const before = JSON.stringify(legacy);
  assert.deepEqual(migrateState(legacy), { ...newState(), ...legacy, version: 7, deviceEvents: [], jobs: legacy.jobs.map(j => ({ ...j, rootId: j.id, outcome: 'pending' })) });
  assert.equal(JSON.stringify(legacy), before);
});
