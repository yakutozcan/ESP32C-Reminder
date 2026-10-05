import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, migrateState } from '../src/core/engine.js';
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
  assert.equal(migrated.version, 2);
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
