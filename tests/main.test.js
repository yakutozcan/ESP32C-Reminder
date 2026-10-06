import test from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../src/core/engine.js';
import { init, api } from '../src/main.js';

function appFixture(saved, failKey) {
  const values = new Map([['reminder-state', saved]]);
  const writes = [];
  const app = {
    store: {
      get: async key => values.get(key),
      set: async (key, value) => {
        writes.push(key);
        if (key === failKey) return false;
        values.set(key, structuredClone(value));
        return true;
      }
    },
    setHideOnClose: async () => {}, tray: { set: async () => {} },
    push: async () => {}, notify: async () => {}
  };
  return { app, values, writes };
}

test('desktop startup stores v2 backup before committing v7 and retains an existing backup', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const saved = { version: 2, reminders: [], jobs: [], device: { url: '', token: '' } };
  const f = appFixture(saved);
  init(f.app);
  assert.equal((await api.snapshot()).version, 7);
  assert.deepEqual(f.writes, ['reminder-state-v2-backup', 'reminder-state']);
  assert.deepEqual(f.values.get('reminder-state-v2-backup'), saved);
  const existing = { ...saved, jobs: [{ id: 'previous-backup' }] };
  f.values.set('reminder-state', saved);
  f.values.set('reminder-state-v2-backup', existing);
  f.writes.length = 0;
  init(f.app);
  await api.snapshot();
  assert.deepEqual(f.values.get('reminder-state-v2-backup'), existing);
  assert.deepEqual(f.writes, ['reminder-state']);
});

test('desktop startup refuses migration when the backup cannot be saved', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(console, 'error', () => {});
  const saved = { version: 2, reminders: [], jobs: [], device: { url: '', token: '' } };
  const f = appFixture(saved, 'reminder-state-v2-backup');
  init(f.app);
  await assert.rejects(api.snapshot(), /yedeği/);
  assert.deepEqual(f.writes, ['reminder-state-v2-backup']);
  assert.deepEqual(f.values.get('reminder-state'), saved);
});

test('desktop startup skips migration and backup writes for v7', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const f = appFixture(newState());
  init(f.app);
  await api.snapshot();
  assert.deepEqual(f.writes, []);
});

test('desktop startup backs up v3 before separating task and delivery states', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const saved = { version: 3, reminders: [], jobs: [{ id: 'prior', status: 'snoozed', snoozedTo: 'child', deliveredAt: 123 }], device: { url: '', token: '' } };
  const f = appFixture(saved); init(f.app);
  const state = await api.snapshot();
  assert.equal(state.jobs[0].status, 'delivered');
  assert.equal(state.jobs[0].outcome, 'snoozed');
  assert.deepEqual(f.values.get('reminder-state-v3-backup'), saved);
  assert.deepEqual(f.writes, ['reminder-state-v3-backup', 'reminder-state']);
});

test('desktop startup backs up v4 before adding quiet settings and scheduler ownership', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const saved = { version: 4, reminders: [], jobs: [], deviceEvents: ['old-receipt'], device: { url: '', token: '' } };
  const f = appFixture(saved); init(f.app);
  const state = await api.snapshot();
  assert.equal(state.version, 7); assert.deepEqual(state.deviceEvents, saved.deviceEvents);
  assert.equal(state.scheduler.mode, 'desktop'); assert.equal(state.settings.quietEnabled, false);
  assert.deepEqual(f.values.get('reminder-state-v4-backup'), saved);
  assert.deepEqual(f.writes, ['reminder-state-v4-backup', 'reminder-state']);
});

test('desktop startup backs up v5 and preserves device ownership before committing v7', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const saved = { ...newState(), version: 5, scheduler: { mode: 'device', desired: true, ownerId: 'kept-owner', revision: 4, syncedRevision: 4 }, device: { url: '', token: '' } };
  const f = appFixture(saved); init(f.app);
  const state = await api.snapshot();
  assert.equal(state.version, 7); assert.deepEqual(state.scheduler, saved.scheduler);
  assert.deepEqual(f.values.get('reminder-state-v5-backup'), saved);
  assert.deepEqual(f.writes, ['reminder-state-v5-backup', 'reminder-state']);
});

test('desktop startup backs up v6 before adding display settings without changing schedule ownership', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const saved = { ...newState(), version: 6, settings: { quietEnabled: true, quietStart: '21:00', quietEnd: '07:00' },
    scheduler: { mode: 'device', desired: true, ownerId: 'screen-owner', revision: 8, syncedRevision: 8 },
    device: { url: '', token: '' } };
  const f = appFixture(saved); init(f.app);
  const state = await api.snapshot();
  assert.equal(state.version, 7); assert.deepEqual(state.scheduler, saved.scheduler);
  assert.equal(state.settings.displayWakeBeforeMinutes, 10); assert.equal(state.settings.displayWakeAfterMinutes, 10);
  assert.equal(state.settings.quietStart, '21:00');
  assert.deepEqual(f.values.get('reminder-state-v6-backup'), saved);
  assert.deepEqual(f.writes, ['reminder-state-v6-backup', 'reminder-state']);
});
