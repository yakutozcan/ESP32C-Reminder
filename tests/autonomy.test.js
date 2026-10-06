import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, newState, migrateState } from '../src/core/engine.js';
import { requestDevice, readDeviceEvents, validateScheduleReply } from '../src/core/device.js';
import { createSimulator } from '../tools/device-simulator.js';
const at = text => new Date(text).getTime();
const input = { title: 'Su iç', frequency: 'daily', time: '09:00', melody: 'chime' };
async function fixture(t, { protocol = 4, state } = {}) {
  let now = at('2026-10-06T08:00:00'), saved, failed = false, sequence = 0;
  const notices = [], sends = [], desktop = [];
  const simulator = createSimulator({ protocol, clock: () => now, onNotice: n => notices.push(n) });
  await new Promise(resolve => simulator.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => simulator.close(resolve)));
  const options = { state, clock: () => now, id: () => 'owner-' + (++sequence),
    persist: async value => { if (failed) return false; saved = value; return true; },
    health: device => requestDevice(device, '/api/health'),
    readSchedule: device => requestDevice(device, '/api/schedule'),
    writeSchedule: (device, payload) => requestDevice(device, '/api/schedule', payload),
    readEvents: readDeviceEvents, ackEvents: (device, ids) => requestDevice(device, '/api/events/ack', { ids }),
    send: (device, job) => { sends.push(job); return requestDevice(device, '/api/notify', job); },
    notify: (title, quiet) => desktop.push({ title, quiet }) };
  let engine = new ReminderEngine(options);
  await engine.setDevice({ url: `http://127.0.0.1:${simulator.address().port}`, token: 'local-simulator-token-12345678' });
  if (!state) await engine.saveReminder(input);
  return { get engine() { return engine; }, simulator, notices, sends, desktop,
    advance: n => { now = n; }, now: () => now, fail: value => { failed = value; },
    restart: () => { engine = new ReminderEngine({ ...options, state: saved }); }, saved: () => saved };
}

test('device handover persists the fence before upload, runs with desktop off, imports history and returns cursors', async t => {
  const f = await fixture(t);
  const write = f.engine.writeSchedule;
  f.engine.writeSchedule = (device, payload) => {
    assert.equal(f.saved().scheduler.mode, 'device');
    assert.equal(f.saved().scheduler.revision, payload.revision);
    return write(device, payload);
  };
  await f.engine.setAutonomous({ enabled: true });
  f.advance(at('2026-10-06T09:00:00'));
  await f.engine.tick(); assert.equal(f.sends.length, 0);
  f.simulator.tick(); assert.equal(f.notices.length, 1);
  await f.engine.syncDevice();
  assert.equal(f.engine.state.jobs.length, 1);
  assert.equal(f.engine.state.jobs[0].status, 'delivered');
  await f.engine.setAutonomous({ enabled: false });
  assert.equal(f.engine.state.scheduler.mode, 'desktop');
  assert.equal(f.simulator.snapshot().schedule.enabled, false);
  await f.engine.tick(); assert.equal(f.notices.length, 1);
  f.advance(at('2026-10-07T09:00:00')); await f.engine.tick();
  assert.equal(f.sends.length, 1); assert.equal(f.notices.length, 2);
});

test('lost handover or handback acknowledgement survives restart without a second scheduler', async t => {
  const f = await fixture(t); const write = f.engine.writeSchedule;
  f.engine.writeSchedule = async (device, payload) => { await write(device, payload); throw new Error('lost acknowledgement'); };
  await assert.rejects(f.engine.setAutonomous({ enabled: true }), /lost/);
  assert.equal(f.engine.state.scheduler.mode, 'device');
  f.restart(); f.advance(at('2026-10-06T09:00:00')); await f.engine.tick(); f.simulator.tick();
  assert.equal(f.sends.length, 0); assert.equal(f.notices.length, 1);
  await f.engine.syncDevice();
  f.engine.writeSchedule = async (device, payload) => { await write(device, payload); throw new Error('lost acknowledgement'); };
  await assert.rejects(f.engine.setAutonomous({ enabled: false }), /lost/);
  assert.equal(f.engine.state.scheduler.mode, 'device'); assert.equal(f.engine.state.scheduler.desired, false);
  f.restart(); await f.engine.tick(); assert.equal(f.sends.length, 0);
  await f.engine.syncDevice(); assert.equal(f.engine.state.scheduler.mode, 'desktop');
  await f.engine.tick(); assert.equal(f.notices.length, 1);
});

test('failed ownership persistence never changes the device schedule; legacy firmware remains desktop owned', async t => {
  const f = await fixture(t); f.fail(true);
  await assert.rejects(f.engine.setAutonomous({ enabled: true }), /diske/);
  assert.equal(f.engine.state.scheduler.mode, 'desktop'); assert.equal(f.simulator.snapshot().schedule.enabled, false);
  const legacy = await fixture(t, { protocol: 3 });
  await assert.rejects(legacy.engine.setAutonomous({ enabled: true }), /güncelle/);
  assert.equal(legacy.engine.state.scheduler.mode, 'desktop');
});

test('offline device snooze starts on device immediately and transfers remaining timer on handback', async t => {
  const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
  f.advance(at('2026-10-06T09:00:00')); f.simulator.tick();
  const event = f.simulator.recordAction(f.notices[0].id, 'snoozed');
  f.advance(at('2026-10-06T09:10:00')); await f.engine.syncDevice();
  const child = f.engine.state.jobs.find(j => j.id === event.deferred.id);
  assert.equal(child.due, at('2026-10-06T09:15:00')); assert.equal(child.status, 'queued');
  await f.engine.setAutonomous({ enabled: false });
  f.advance(child.due - 1); await f.engine.tick(); assert.equal(f.notices.length, 1);
  f.advance(child.due); await f.engine.tick(); await f.engine.tick();
  assert.equal(f.notices.length, 2); assert.equal(f.notices[1].id, child.id);
});

test('device completion cancels a desktop-created snooze family and desktop completion cancels remote timers', async t => {
  const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
  f.advance(at('2026-10-06T09:00:00')); f.simulator.tick(); await f.engine.syncDevice();
  const source = f.engine.state.jobs[0];
  await f.engine.snoozeJob(source.id, 5); await f.engine.syncDevice();
  const child = f.engine.state.jobs.find(j => j.status === 'queued');
  f.advance(child.due); f.simulator.tick();
  f.simulator.recordAction(child.id, 'snoozed'); await f.engine.syncDevice();
  await f.engine.completeJob(source.id); await f.engine.syncDevice();
  assert.ok(f.engine.state.jobs.every(j => j.outcome === 'completed'));
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 0);
  f.advance(child.due + 15 * 60000); f.simulator.tick(); assert.equal(f.notices.length, 2);
});

test('device events remain until downloaded history and effects have reached desktop disk', async t => {
  const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
  f.advance(at('2026-10-06T09:00:00')); f.simulator.tick(); f.simulator.recordAction(f.notices[0].id, 'completed');
  f.fail(true); await assert.rejects(f.engine.syncDevice(), /diske/);
  assert.equal(f.simulator.snapshot().events.length, 1); assert.equal(f.engine.state.jobs.length, 0);
  f.fail(false); f.restart(); await f.engine.syncDevice();
  assert.equal(f.simulator.snapshot().events.length, 0); assert.equal(f.engine.state.jobs[0].outcome, 'completed');
});

test('device edits, deletion and ownership transfer cannot silently point the desktop at a second active device', async t => {
  const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
  await assert.rejects(f.engine.setDevice({ url: 'http://127.0.0.1:9999', token: 'local-simulator-token-12345678' }), /kapat/);
  f.advance(at('2026-10-06T09:00:00')); f.simulator.tick(); await f.engine.syncDevice();
  f.simulator.recordAction(f.notices[0].id, 'snoozed'); await f.engine.syncDevice();
  await f.engine.removeReminder(f.engine.state.reminders[0].id); await f.engine.syncDevice();
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 0);
  f.advance(at('2026-10-06T09:15:00')); f.simulator.tick(); assert.equal(f.notices.length, 1);
});

test('quiet hours are evaluated at retry send time and also passed to native notifications', async t => {
  const f = await fixture(t); await f.engine.saveSettings({ quietEnabled: true, quietStart: '08:00', quietEnd: '10:00' });
  f.advance(at('2026-10-06T09:00:00')); await f.engine.tick();
  assert.equal(f.sends[0].melody, 'none'); assert.equal(f.engine.state.jobs[0].melody, 'chime'); assert.equal(f.desktop[0].quiet, true);
  await f.engine.snoozeJob(f.engine.state.jobs[0].id, 5);
  f.engine.send = async () => { throw new Error('offline'); };
  f.advance(at('2026-10-06T09:05:00')); await f.engine.tick();
  f.engine.send = async (_, job) => f.sends.push(job);
  f.advance(at('2026-10-06T10:00:00')); await f.engine.tick(); assert.equal(f.sends[1].melody, 'chime');
});

test('v4 migration preserves existing cursors and receipts while v5 ownership corruption fails closed', () => {
  const saved = { version: 4, reminders: [{ id: 'saved', nextDue: 123 }], jobs: [], deviceEvents: ['kept'], device: { url: 'http://device', token: 'secret' } };
  const state = migrateState(saved);
  assert.equal(state.version, 6); assert.deepEqual(state.reminders, saved.reminders); assert.deepEqual(state.deviceEvents, saved.deviceEvents);
  assert.equal(state.scheduler.mode, 'desktop'); assert.equal(saved.version, 4);
  assert.throws(() => migrateState({ ...newState(), scheduler: { mode: 'device', desired: true, ownerId: '', revision: 1 } }), /sahiplik/);
});

test('untrusted or malformed schedule replies never enable desktop handback', () => {
  const base = { protocol: 4, ownerId: 'owner', revision: 1, enabled: true, timeValid: false, cursors: [], history: [], deferred: [] };
  for (const invalid of [{ ...base, cursors: [{}] }, { ...base, revision: -1 }, { ...base, history: [null] }, { ...base, timeValid: 'yes' }])
    assert.throws(() => validateScheduleReply(invalid), /geçerli değil/);
});

test('consumed device one-offs disable locally without changing same-revision configuration on clock refresh', async t => {
  const f = await fixture(t);
  await f.engine.removeReminder(f.engine.state.reminders[0].id);
  await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-06' });
  await f.engine.setAutonomous({ enabled: true });
  f.advance(at('2026-10-06T09:00:00')); f.simulator.tick(); await f.engine.syncDevice();
  assert.equal(f.engine.state.reminders[0].enabled, false); assert.equal(f.engine.state.reminders[0].nextDue, null);
  f.advance(at('2026-10-06T10:00:00')); await f.engine.syncDevice();
  assert.equal(f.notices.length, 1); assert.equal(f.engine.exportBackup().reminders[0].enabled, false);
  await f.engine.setAutonomous({ enabled: false }); await f.engine.tick(); assert.equal(f.notices.length, 1);
});

test('device timestamp range is checked before ownership and before active schedule edits', async t => {
  const f = await fixture(t); const max = at('2037-12-31T00:00:00Z');
  f.engine.health = async () => ({ protocol: 4, scheduleMaxTimestamp: max });
  await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2040-01-01' });
  await assert.rejects(f.engine.setAutonomous({ enabled: true }), /desteklemiyor/);
  assert.equal(f.engine.state.scheduler.mode, 'desktop'); assert.equal(f.simulator.snapshot().schedule.enabled, false);
  await f.engine.removeReminder(f.engine.state.reminders[1].id); await f.engine.setAutonomous({ enabled: true });
  const before = f.engine.snapshot();
  await assert.rejects(f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2040-01-01' }), /desteklemiyor/);
  assert.deepEqual(f.engine.snapshot(), before);
});

test('timezone changes rebase future local schedules and retain absolute snooze timers', async t => {
  const initial = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Istanbul';
    const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
    const original = f.engine.state.reminders[0].nextDue;
    process.env.TZ = 'UTC'; await f.engine.syncSchedule();
    const shifted = f.engine.state.reminders[0].nextDue;
    assert.equal(shifted, original + 3 * 3600000);
    assert.equal(f.simulator.snapshot().schedule.reminders[0].nextDue, shifted);
  } finally { if (initial === undefined) delete process.env.TZ; else process.env.TZ = initial; }
});

test('a timezone change leaves an existing absolute snooze timer due at the original instant', async t => {
  const initial = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Istanbul';
    const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
    f.advance(f.engine.state.reminders[0].nextDue); f.simulator.tick();
    const event = f.simulator.recordAction(f.notices[0].id, 'snoozed'); await f.engine.syncDevice();
    process.env.TZ = 'UTC'; await f.engine.syncSchedule();
    assert.equal(f.simulator.snapshot().schedule.deferred[0].due, event.deferred.due);
    f.advance(event.deferred.due); f.simulator.tick(); assert.equal(f.notices.length, 2);
    assert.equal(f.notices[1].id, event.deferred.id);
  } finally { if (initial === undefined) delete process.env.TZ; else process.env.TZ = initial; }
});

test('pending desktop one-off and its legacy notice action survive handover to device scheduling', async t => {
  const f = await fixture(t);
  await f.engine.removeReminder(f.engine.state.reminders[0].id);
  await f.engine.saveReminder({ ...input, frequency: 'once', onceDate: '2026-10-06' });
  f.engine.send = async () => { throw new Error('offline'); };
  f.advance(at('2026-10-06T09:00:00')); await f.engine.tick();
  const source = f.engine.state.jobs[0]; assert.equal(source.status, 'queued');
  await f.engine.setAutonomous({ enabled: true }); f.simulator.tick();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].id, source.id);
  await f.engine.syncDevice(); assert.equal(f.engine.state.jobs[0].status, 'delivered');
  f.simulator.recordAction(source.id, 'snoozed'); await f.engine.syncDevice();
  f.advance(at('2026-10-06T09:15:00')); f.simulator.tick(); assert.equal(f.notices.length, 2);
});

test('a legacy desktop-owned notice snoozed after device handover uploads its newly created timer', async t => {
  const f = await fixture(t); f.advance(at('2026-10-06T09:00:00')); await f.engine.tick();
  await f.engine.setAutonomous({ enabled: true });
  const event = f.simulator.recordAction(f.notices[0].id, 'snoozed'); assert.equal(event.job, undefined);
  await f.engine.syncDevice(); const child = f.engine.state.jobs.find(j => j.status === 'queued');
  await f.engine.syncDevice(); assert.equal(f.simulator.snapshot().schedule.deferred[0].id, child.id);
  f.advance(child.due); f.simulator.tick(); assert.equal(f.notices.length, 2);
});

test('late native snooze snapshots cannot revive a paused or deleted device reminder', async t => {
  for (const remove of [false, true]) {
    const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
    f.advance(at('2026-10-06T09:00:00')); f.simulator.tick();
    const event = f.simulator.recordAction(f.notices[0].id, 'snoozed');
    const reminder = f.engine.state.reminders[0];
    if (remove) await f.engine.removeReminder(reminder.id); else await f.engine.saveReminder({ ...reminder, enabled: false });
    await f.engine.syncDevice();
    assert.ok(!f.engine.state.jobs.some(j => j.id === event.deferred.id && j.status === 'queued'));
    assert.equal(f.simulator.snapshot().schedule.deferred.length, 0);
    await f.engine.setAutonomous({ enabled: false });
    f.advance(event.deferred.due); await f.engine.tick(); assert.equal(f.notices.length, 1);
  }
});

test('handback remains available after travel to a timezone unsupported by firmware POSIX rules', async t => {
  const initial = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Istanbul';
    const f = await fixture(t); await f.engine.setAutonomous({ enabled: true });
    process.env.TZ = 'Africa/Casablanca';
    await assert.rejects(f.engine.syncSchedule(), /değişken/);
    assert.equal(f.engine.state.scheduler.mode, 'device');
    await f.engine.setAutonomous({ enabled: false });
    assert.equal(f.engine.state.scheduler.mode, 'desktop'); assert.equal(f.simulator.snapshot().schedule.enabled, false);
    assert.equal(new Date(f.engine.state.reminders[0].nextDue).getHours(), 9);
  } finally { if (initial === undefined) delete process.env.TZ; else process.env.TZ = initial; }
});
