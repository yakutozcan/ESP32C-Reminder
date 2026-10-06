import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTags } from '../src/core/tags.js';
import { validateReminder, normalizeDeviceReminder } from '../src/core/schedule.js';
import { ReminderEngine, migrateState, newState } from '../src/core/engine.js';
import { createBackup, parseBackup } from '../src/core/backup.js';
import { createSimulator } from '../tools/device-simulator.js';
import { requestDevice } from '../src/core/device.js';

const base = { title: 'İşleri kontrol et', frequency: 'daily', time: '09:00', melody: 'chime', enabled: true };
const now = new Date('2026-10-06T08:00:00').getTime();
const fixture = options => new ReminderEngine({ clock: () => now, id: () => 'tagged', persist: async () => true, ...options });

test('labels normalize Turkish case, Unicode and spacing while retaining user spelling', () => {
  assert.deepEqual(validateTags([' İş ', 'iş', '  Kişisel   işler ', 'Rutin', 'ç', 'c\u0327', 'IŞIK', 'ışık']), ['İş', 'Kişisel işler', 'Rutin', 'ç', 'IŞIK']);
  assert.deepEqual(validateReminder(base).tags, []);
});

test('invalid or unbounded labels fail at the shared validation boundary', () => {
  for (const tags of [null, 'İş', {}, [''], ['  '], [5], ['a,b'], ['a\nb'], ['a\tb'], ['a\x7f'], ['a'.repeat(25)], Array(9).fill('İş')]) {
    assert.throws(() => validateReminder({ ...base, tags }));
    assert.throws(() => parseBackup({ format: 'masa-reminders', version: 1, reminders: [{ ...base, id: 'r', tags }] }));
  }
  assert.deepEqual(validateTags(['🌿'.repeat(24)]), ['🌿'.repeat(24)]);
});

test('historic local records open untagged without changing queues, timers or ownership', () => {
  const saved = newState();
  saved.reminders.push({ ...base, id: 'old', nextDue: now + 60000 });
  saved.jobs.push({ id: 'old:due', rootId: 'old:due', reminderId: 'old', status: 'queued', outcome: 'pending' });
  saved.scheduler = { ...saved.scheduler, mode: 'device', desired: true, ownerId: 'owner', revision: 4 };
  const original = structuredClone(saved);
  const migrated = migrateState(saved);
  assert.deepEqual(migrated.reminders[0], original.reminders[0]);
  assert.deepEqual(validateReminder(migrated.reminders[0]).tags, []);
  assert.deepEqual(migrated.jobs, original.jobs);
  assert.deepEqual(migrated.scheduler, original.scheduler);
  assert.deepEqual(saved, original);
});

test('editing only labels preserves pending deliveries and next occurrence across restart', async () => {
  const engine = fixture();
  const reminder = await engine.saveReminder({ ...base, tags: ['İş'] });
  // A device cursor can differ from the locally recomputed next occurrence.
  engine.state.reminders[0].nextDue = now + 120000;
  engine.state.jobs.push({ id: 'pending', rootId: 'pending', reminderId: reminder.id, status: 'queued', outcome: 'pending' });
  const before = engine.snapshot();
  await engine.saveReminder({ ...reminder, tags: ['Kişisel'] });
  const restarted = fixture({ state: engine.snapshot() });
  assert.deepEqual(restarted.state.reminders[0].tags, ['Kişisel']);
  assert.equal(restarted.state.reminders[0].nextDue, before.reminders[0].nextDue);
  assert.deepEqual(restarted.state.jobs, before.jobs);
  assert.deepEqual(restarted.state.scheduler, before.scheduler);
  await restarted.saveReminder({ ...restarted.state.reminders[0], tags: [] });
  assert.deepEqual(restarted.state.reminders[0].tags, []);
});

test('failed label save or invalid input leaves the stored reminder intact', async () => {
  const engine = fixture();
  const reminder = await engine.saveReminder({ ...base, tags: ['İş'] });
  const before = engine.snapshot();
  await assert.rejects(engine.saveReminder({ ...reminder, tags: ['a'.repeat(25)] }));
  engine.persist = async () => false;
  await assert.rejects(engine.saveReminder({ ...reminder, tags: ['Yeni'] }), /diske/);
  assert.deepEqual(engine.snapshot(), before);
});

test('label-only edits keep consumed one-off reminders disabled', async () => {
  const engine = fixture();
  await engine.saveReminder({ ...base, frequency: 'once', onceDate: '2026-10-06', tags: ['İş'] });
  engine.state.reminders[0].enabled = false;
  engine.state.reminders[0].nextDue = null;
  engine.state.reminders[0].deviceConsumed = true;
  const consumed = engine.snapshot().reminders[0];
  await engine.saveReminder({ ...consumed, tags: ['Rutin'] });
  assert.deepEqual(engine.state.reminders[0], { ...consumed, tags: ['Rutin'] });
});

test('portable backups restore tags with merge, replace and an idempotent repeat', async () => {
  const source = fixture();
  await source.saveReminder({ ...base, tags: ['İş', 'Rutin'] });
  const text = JSON.stringify(source.exportBackup());
  assert.deepEqual(parseBackup(text).reminders[0].tags, ['İş', 'Rutin']);
  for (const mode of ['merge', 'replace']) {
    const engine = fixture({ backup: async () => true });
    await engine.importBackup({ text, mode });
    const before = engine.snapshot();
    await engine.importBackup({ text, mode });
    assert.deepEqual(engine.snapshot(), before);
    assert.deepEqual(engine.state.reminders[0].tags, ['İş', 'Rutin']);
  }
  assert.deepEqual(parseBackup(createBackup({ reminders: [{ ...base, id: 'old' }] })).reminders[0].tags, []);
});

test('label-only backup merge preserves device timers and pending deliveries', async () => {
  const engine = fixture({ backup: async () => true });
  await engine.saveReminder({ ...base, tags: ['İş'] });
  engine.state.reminders[0].nextDue = now + 120000;
  engine.state.jobs.push({ id: 'pending', rootId: 'pending', reminderId: 'tagged', status: 'queued', outcome: 'pending' });
  const before = engine.snapshot(), backup = engine.exportBackup();
  backup.reminders[0].tags = ['Rutin'];
  await engine.importBackup({ text: JSON.stringify(backup), mode: 'merge' });
  assert.equal(engine.state.reminders[0].nextDue, before.reminders[0].nextDue);
  assert.deepEqual(engine.state.jobs, before.jobs);
  assert.deepEqual(engine.state.reminders[0].tags, ['Rutin']);
});

test('device wire definitions omit desktop labels', () => {
  assert.equal('tags' in normalizeDeviceReminder({ ...base, tags: ['İş'] }), false);
});

test('autonomous HTTP handover and handback retain local labels without sending them to the device', async t => {
  const server = createSimulator({ clock: () => now, onNotice: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const payloads = [];
  const engine = fixture({
    health: device => requestDevice(device, '/api/health'),
    readSchedule: device => requestDevice(device, '/api/schedule'),
    writeSchedule: (device, payload) => { payloads.push(payload); return requestDevice(device, '/api/schedule', payload); }
  });
  await engine.setDevice({ url: `http://127.0.0.1:${server.address().port}`, token: 'local-simulator-token-12345678' });
  await engine.saveReminder({ ...base, tags: ['İş'] });
  await engine.setAutonomous({ enabled: true });
  assert.deepEqual(engine.state.reminders[0].tags, ['İş']);
  const before = engine.snapshot();
  await engine.saveReminder({ ...engine.state.reminders[0], tags: ['Rutin'] });
  assert.deepEqual(engine.state.scheduler, before.scheduler);
  await engine.setAutonomous({ enabled: false });
  assert.deepEqual(engine.state.reminders[0].tags, ['Rutin']);
  assert.ok(payloads.length >= 2);
  assert.ok(payloads.every(payload => payload.reminders.every(reminder => !('tags' in reminder))));
});

test('tagged reminders still enforce the autonomous 24-reminder capacity', async () => {
  const state = newState();
  state.scheduler = { ...state.scheduler, mode: 'device', desired: true, ownerId: 'owner' };
  state.reminders = Array.from({ length: 24 }, (_, i) => ({ ...base, id: 'r' + i, tags: ['İş'], nextDue: now + 60000 }));
  const engine = fixture({ state });
  await assert.rejects(engine.saveReminder({ ...base, tags: ['Yeni'] }), /24/);
  assert.equal(engine.state.reminders.length, 24);
});
