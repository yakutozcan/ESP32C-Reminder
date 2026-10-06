import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, newState } from '../src/core/engine.js';
import { requestDevice, validateDisplayReply } from '../src/core/device.js';
import { createSimulator } from '../tools/device-simulator.js';
import { deviceDisplaySettings } from '../src/core/settings.js';
const at = text => new Date(text).getTime();
const token = 'local-simulator-token-12345678';
async function fixture(t, { displaySettings = true } = {}) {
  let now = at('2026-10-06T08:00:00'), saved, sequence = 0, failWrite = false, deviceWrites = 0;
  const simulator = createSimulator({ displaySettings, clock: () => now, persist: () => { deviceWrites++; return !failWrite; }, onNotice: () => {} });
  await new Promise(resolve => simulator.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => simulator.close(resolve)));
  const config = { clock: () => now, id: () => 'display-' + (++sequence), persist: async value => { saved = structuredClone(value); }, send: async () => {},
    health: d => requestDevice(d, '/api/health'), readDisplay: d => requestDevice(d, '/api/display'),
    writeDisplay: (d, p) => requestDevice(d, '/api/display', p),
    readSchedule: d => requestDevice(d, '/api/schedule'), writeSchedule: (d, p) => requestDevice(d, '/api/schedule', p) };
  let engine = new ReminderEngine(config);
  await engine.setDevice({ url: `http://127.0.0.1:${simulator.address().port}`, token });
  return { get engine() { return engine; }, simulator, advance: n => { now = n; },
    restart: () => { engine = new ReminderEngine({ ...config, state: saved }); },
    fail: value => { failWrite = value; }, writes: () => deviceWrites };
}

test('display settings sync in desktop mode without transferring scheduler ownership', async t => {
  const f = await fixture(t);
  await f.engine.saveSettings({ displayAlwaysOn: true, displaySleepMinutes: 5, displayWakeBeforeMinutes: 10, displayWakeAfterMinutes: 15 });
  const before = f.engine.snapshot().scheduler;
  assert.equal(f.engine.displayStatus().status, 'pending');
  assert.equal((await f.engine.syncDisplay()).status, 'synced');
  assert.deepEqual(f.simulator.snapshot().display.settings, { alwaysOn: true, sleepMinutes: 5, wakeBeforeMinutes: 10, wakeAfterMinutes: 15 });
  assert.deepEqual(f.engine.state.scheduler, before);
  assert.equal(f.simulator.snapshot().schedule.enabled, false);
  assert.equal(f.simulator.snapshot().schedule.ownerId, '');
});

test('nearest reminder and snooze hint follows edits, pause and completion', async t => {
  const f = await fixture(t);
  const a = await f.engine.saveReminder({ title: 'Günlük', frequency: 'daily', time: '09:00', melody: 'none' });
  const b = await f.engine.saveReminder({ title: 'Sonraki', frequency: 'daily', time: '10:00', melody: 'none' });
  await f.engine.syncDisplay(); assert.equal(f.simulator.snapshot().display.nextDue, a.nextDue);
  await f.engine.saveReminder({ ...a, enabled: false }); await f.engine.syncDisplay();
  assert.equal(f.simulator.snapshot().display.nextDue, b.nextDue);
  f.advance(b.nextDue); await f.engine.tick();
  const job = f.engine.state.jobs[0]; await f.engine.snoozeJob(job.id, 5); await f.engine.syncDisplay();
  assert.equal(f.simulator.snapshot().display.nextDue, b.nextDue + 5 * 60000);
  await f.engine.completeJob(job.id); await f.engine.syncDisplay();
  assert.equal(f.simulator.snapshot().display.nextDue, at('2026-10-07T10:00:00'));
});

test('settings and hints persist across device and desktop restart without repeated flash writes', async t => {
  const f = await fixture(t);
  await f.engine.saveReminder({ title: 'Bir kez', frequency: 'once', onceDate: '2026-10-06', time: '09:00', melody: 'none' });
  await f.engine.saveSettings({ displayAlwaysOn: true, displayWakeBeforeMinutes: 0, displayWakeAfterMinutes: 0 });
  await f.engine.syncDisplay(); const saved = f.simulator.snapshot(), writes = f.writes();
  await f.engine.syncDisplay(); await f.engine.syncDisplay(); assert.equal(f.writes(), writes);
  f.restart(); await f.engine.syncDisplay(); assert.equal(f.writes(), writes);
  const restored = createSimulator({ state: saved, onNotice: () => {} });
  assert.deepEqual(restored.snapshot().display, saved.display);
  assert.equal(restored.snapshot().display.settings.alwaysOn, true);
  assert.equal(restored.snapshot().display.settings.wakeBeforeMinutes, 0);
});

test('display-only edits leave an autonomous schedule revision and cursor unchanged', async t => {
  const f = await fixture(t);
  await f.engine.saveReminder({ title: 'Cihaz rutini', frequency: 'daily', time: '09:00', melody: 'none' });
  await f.engine.setAutonomous({ enabled: true }); const before = f.simulator.snapshot().schedule;
  await f.engine.saveSettings({ displaySleepMinutes: 3, displayWakeBeforeMinutes: 20, displayWakeAfterMinutes: 5 });
  await f.engine.syncDisplay();
  assert.deepEqual(f.simulator.snapshot().schedule, before);
  assert.equal(f.engine.state.scheduler.revision, before.revision);
  assert.deepEqual(f.simulator.snapshot().display.settings, deviceDisplaySettings(f.engine.state.settings));
});

test('offline, legacy firmware and disk failures never claim successful display transfer', async t => {
  const old = await fixture(t, { displaySettings: false });
  await old.engine.saveSettings({ displayAlwaysOn: true });
  assert.equal((await old.engine.syncDisplay()).status, 'unsupported');
  assert.equal(old.simulator.snapshot().display.settings.alwaysOn, false);
  const f = await fixture(t); await f.engine.saveSettings({ displayAlwaysOn: true });
  const before = f.simulator.snapshot(); f.fail(true);
  assert.equal((await f.engine.syncDisplay()).status, 'offline');
  assert.deepEqual(f.simulator.snapshot(), before);
  f.fail(false); assert.equal((await f.engine.syncDisplay()).status, 'synced');
  f.engine.health = async () => { throw new Error('offline'); };
  assert.equal((await f.engine.syncDisplay()).status, 'offline');
  assert.equal(f.engine.state.settings.displayAlwaysOn, true);
});

test('display response validation rejects missing fields, wrong types and out-of-range values', () => {
  const base = { protocol: 4, settings: deviceDisplaySettings({}), nextDue: null };
  for (const value of [{}, { ...base, protocol: 3 }, { ...base, nextDue: -1 }, { ...base, settings: { alwaysOn: true } },
    { ...base, settings: { ...base.settings, sleepMinutes: 0 } }, { ...base, settings: { ...base.settings, wakeBeforeMinutes: '10' } },
    { ...base, settings: { ...base.settings, wakeAfterMinutes: 1441 } }]) assert.throws(() => validateDisplayReply(value));
  assert.deepEqual(validateDisplayReply(base), base);
});

test('local screen preference validation fails before persistence and partial quiet updates retain screen settings', async t => {
  const f = await fixture(t);
  await f.engine.saveSettings({ displayAlwaysOn: true, displayWakeBeforeMinutes: 0 });
  await f.engine.saveSettings({ quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' });
  assert.equal(f.engine.state.settings.displayAlwaysOn, true); assert.equal(f.engine.state.settings.displayWakeBeforeMinutes, 0);
  const before = f.engine.snapshot();
  await assert.rejects(f.engine.saveSettings({ displaySleepMinutes: -1 })); assert.deepEqual(f.engine.snapshot(), before);
  assert.equal(new ReminderEngine({ state: { ...newState(), version: 6 }, persist: async () => {}, send: async () => {} }).state.version, 7);
});
