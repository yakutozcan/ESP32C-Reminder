import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulator } from '../tools/device-simulator.js';
import { DAY, deviceTimezone, validateReminder } from '../src/core/schedule.js';
const token = 'local-simulator-token-12345678';
const local = value => new Date(value).getTime();
async function fixture(t, saved) {
  let time = local('2026-10-06T08:00:00'), failing = false;
  const notices = [];
  const simulator = createSimulator({ clock: () => time, state: saved, onNotice: notice => notices.push(notice), persist: () => !failing });
  await new Promise(resolve => simulator.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => simulator.close(resolve)));
  const url = `http://127.0.0.1:${simulator.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(url + path, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const reminder = { id: 'water', ...validateReminder({ title: 'Su iç', frequency: 'daily', time: '09:00', melody: 'chime' }), nextDue: local('2026-10-06T09:00:00') };
  const payload = changes => ({ ownerId: 'desktop-a', revision: 1, enabled: true, timezone: deviceTimezone(time), utcNow: time,
    quietHours: { quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' }, reminders: [reminder], deferred: [], ...changes });
  return { simulator, request, payload, reminder, notices, advance: value => { time = value; }, fail: value => { failing = value; } };
}

test('autonomous simulator runs offline, persists cursors, and distrusts clock after restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/health')).body.protocol, 4);
  assert.equal((await f.request('/api/health')).body.timeValid, false);
  assert.equal((await f.request('/api/schedule', f.payload())).status, 200);
  f.advance(local('2026-10-06T09:00:00'));
  assert.equal(f.simulator.tick().length, 1);
  assert.equal(f.simulator.tick().length, 0);
  assert.equal(f.simulator.snapshot().schedule.history[0].id, 'water:' + local('2026-10-06T09:00:00'));
  const restart = await fixture(t, f.simulator.snapshot());
  restart.advance(local('2026-10-07T09:00:00'));
  assert.deepEqual(restart.simulator.tick(), []);
  restart.simulator.syncClock();
  assert.equal(restart.simulator.tick().length, 1);
  assert.equal(restart.simulator.snapshot().schedule.history.length, 2);
});

test('same revision retries preserve cursor/deferred progress and reject conflicting owners or configurations', async t => {
  const f = await fixture(t); const original = f.payload();
  await f.request('/api/schedule', original);
  f.advance(local('2026-10-06T09:00:00')); f.simulator.tick();
  const id = f.simulator.snapshot().schedule.history[0].id;
  f.simulator.recordAction(id, 'snoozed');
  const before = f.simulator.snapshot();
  assert.equal((await f.request('/api/schedule', { ...original, utcNow: local('2026-10-06T09:01:00') })).status, 200);
  assert.deepEqual(f.simulator.snapshot(), before);
  assert.equal((await f.request('/api/schedule', { ...original, enabled: false })).status, 409);
  assert.equal((await f.request('/api/schedule', { ...original, ownerId: 'desktop-b' })).status, 409);
  assert.equal((await f.request('/api/schedule', { ...original, revision: 0 })).status, 409);
  assert.equal((await f.request('/api/schedule', { ...original, ownerId: 'desktop-b', takeover: true })).status, 200);
  assert.equal(f.simulator.snapshot().schedule.ownerId, 'desktop-b');
});

test('snooze carries durable job snapshots, fires offline, and completion cancels root timers', async t => {
  const f = await fixture(t); await f.request('/api/schedule', f.payload());
  f.advance(local('2026-10-06T09:00:00')); f.simulator.tick();
  const job = f.simulator.snapshot().schedule.history[0];
  const event = f.simulator.recordAction(job.id, 'snoozed');
  assert.equal(event.job.outcome, 'snoozed');
  assert.equal(event.deferred.rootId, job.id);
  assert.equal(event.deferred.due, job.due + 15 * 60000);
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 1);
  // A newer desktop revision must retain a snooze created after its snapshot.
  await f.request('/api/schedule', f.payload({ revision: 2 }));
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 1);
  f.advance(event.deferred.due); assert.equal(f.simulator.tick().length, 1);
  const second = f.simulator.recordAction(event.deferred.id, 'snoozed');
  await f.request('/api/schedule', f.payload({ revision: 3, completedRoots: [job.rootId] }));
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 0);
  assert.ok(f.simulator.snapshot().schedule.history.every(j => j.outcome === 'completed'));
  f.advance(second.deferred.due); assert.equal(f.simulator.tick().length, 0);
});

test('changed and deleted reminders recall pending notices and snoozes', async t => {
  const f = await fixture(t); await f.request('/api/schedule', f.payload());
  f.advance(local('2026-10-06T09:00:00')); f.simulator.tick();
  const id = f.simulator.snapshot().schedule.history[0].id;
  f.simulator.recordAction(id, 'snoozed');
  const changed = { ...f.reminder, title: 'Yeni başlık' };
  await f.request('/api/schedule', f.payload({ revision: 2, reminders: [changed] }));
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 0);
  f.advance(local('2026-10-07T09:00:00')); f.simulator.tick();
  assert.equal(f.simulator.snapshot().pending.length, 1);
  await f.request('/api/schedule', f.payload({ revision: 3, reminders: [] }));
  assert.equal(f.simulator.snapshot().pending.length, 0);
});

test('clock sync, tick, action and acknowledgement stay atomic on persistence failure', async t => {
  const f = await fixture(t); f.fail(true);
  assert.equal((await f.request('/api/schedule', f.payload())).status, 507);
  assert.equal((await f.request('/api/health')).body.timeValid, false);
  f.fail(false); await f.request('/api/schedule', f.payload());
  f.advance(local('2026-10-06T09:00:00'));
  const before = f.simulator.snapshot(); f.fail(true);
  assert.throws(() => f.simulator.tick(), /Persistence/);
  assert.deepEqual(f.simulator.snapshot(), before); assert.equal(f.notices.length, 0);
  f.fail(false); f.simulator.tick();
  const ready = f.simulator.snapshot(); f.fail(true);
  assert.throws(() => f.simulator.recordAction(ready.pending[0].id, 'snoozed'), /Persistence/);
  assert.deepEqual(f.simulator.snapshot(), ready);
  f.fail(false); const event = f.simulator.recordAction(ready.pending[0].id, 'completed');
  f.fail(true); assert.equal((await f.request('/api/events/ack', { ids: [event.id] })).status, 507);
  assert.equal(f.simulator.snapshot().events.length, 1);
});

test('quiet hours mute autonomous notices while retaining the chosen job melody', async t => {
  const f = await fixture(t);
  await f.request('/api/schedule', f.payload({ quietHours: { quietEnabled: true, quietStart: '08:00', quietEnd: '10:00' } }));
  f.advance(local('2026-10-06T09:00:00')); f.simulator.tick();
  assert.equal(f.notices[0].melody, 'none');
  assert.equal(f.simulator.snapshot().schedule.history[0].melody, 'chime');
  assert.equal((await f.request('/api/notify', { id: 'ordinary', title: 'Mola', melody: 'none' })).status, 409);
  assert.equal((await f.request('/api/notify', { id: 'test-local', title: 'Deneme', melody: 'none' })).status, 200);
});

test('one-off misses beyond the grace window advance without a stale alert', async t => {
  const f = await fixture(t);
  const due = local('2026-10-06T09:00:00');
  const once = { id: 'once', ...validateReminder({ title: 'Randevu', frequency: 'once', onceDate: '2026-10-06', time: '09:00', melody: 'none' }), nextDue: due };
  await f.request('/api/schedule', f.payload({ reminders: [once] }));
  f.advance(due + DAY); assert.deepEqual(f.simulator.tick(), []);
  assert.equal(f.simulator.snapshot().schedule.reminders[0].nextDue, null);
});

test('deferred queue capacity refuses snooze atomically and pending queue drains in bounded batches', async t => {
  const f = await fixture(t);
  const due = local('2026-10-07T09:00:00');
  const deferred = Array.from({ length: 24 }, (_, index) => ({ id: 'later-' + index, rootId: 'later-' + index,
    reminderId: 'water', title: 'Sonra', melody: 'none', due, expiresAt: due + DAY, status: 'queued', outcome: 'pending' }));
  assert.equal((await f.request('/api/schedule', f.payload({ deferred }))).status, 200);
  assert.equal((await f.request('/api/schedule')).body.deferred[0].status, 'queued');
  f.advance(local('2026-10-06T09:00:00')); f.simulator.tick();
  const before = f.simulator.snapshot();
  assert.throws(() => f.simulator.recordAction(before.pending[0].id, 'snoozed'), /Deferred queue full/);
  assert.deepEqual(f.simulator.snapshot(), before);
  f.simulator.recordAction(before.pending[0].id, null);
  f.advance(due);
  assert.equal(f.simulator.tick().length, 8);
  assert.equal(f.simulator.snapshot().schedule.deferred.length, 16);
  assert.ok(f.simulator.snapshot().schedule.history.every(job => job.status === 'delivered'));
  assert.equal(f.simulator.tick().length, 0);
});

test('journal retains the latest 32 deliveries without replay after pruning', async t => {
  const f = await fixture(t); await f.request('/api/schedule', f.payload());
  for (let day = 0; day < 35; day++) {
    const due = new Date(2026, 9, 6 + day, 9).getTime(); f.advance(due);
    const [notice] = f.simulator.tick();
    assert.ok(notice);
    f.simulator.recordAction(notice.id, null);
  }
  const snapshot = f.simulator.snapshot();
  assert.equal(snapshot.schedule.history.length, 32);
  assert.equal(snapshot.schedule.history[0].due, new Date(2026, 9, 9, 9).getTime());
  assert.deepEqual(f.simulator.tick(), []);
});

test('malformed schedules never alter device state or establish a trusted clock', async t => {
  const f = await fixture(t);
  const before = f.simulator.snapshot();
  for (const change of [{ ownerId: '' }, { ownerId: 'a'.repeat(129) }, { revision: -1 }, { revision: 1.5 },
    { enabled: 'yes' }, { utcNow: 0 }, { quietHours: { quietEnabled: 'yes' } },
    { reminders: [f.reminder, f.reminder] }, { reminders: Array(25).fill(f.reminder) },
    { deferred: [{ id: 'bad' }] }, { completedRoots: [''] }, { timezone: ':/etc/localtime' },
    { reminders: [{ ...f.reminder, id: 'a'.repeat(129) }] }]) {
    assert.equal((await f.request('/api/schedule', f.payload(change))).status, 400);
    assert.deepEqual(f.simulator.snapshot(), before);
  }
  assert.equal((await f.request('/api/health')).body.timeValid, false);
});

test('simulator resolves the device POSIX timezone independently of the desktop host timezone', async t => {
  const f = await fixture(t);
  const due = Date.UTC(2026, 9, 6, 13);
  const reminder = { ...f.reminder, nextDue: due };
  assert.equal((await f.request('/api/schedule', f.payload({ timezone: 'STD5DST4,M3.2.0/2,M11.1.0/2', reminders: [reminder] }))).status, 200);
  f.advance(due); assert.equal(f.simulator.tick().length, 1);
  assert.equal(f.simulator.snapshot().schedule.reminders[0].nextDue, Date.UTC(2026, 9, 7, 13));
});

test('timezone-only updates rebase calendar cursors while retaining absolute deferred jobs', async t => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Istanbul';
    const f = await fixture(t); await f.request('/api/schedule', f.payload());
    const due = local('2026-10-06T09:00:00'); f.advance(due); f.simulator.tick();
    const event = f.simulator.recordAction(f.simulator.snapshot().pending[0].id, 'snoozed');
    const deferred = event.deferred;
    const nextDue = Date.UTC(2026, 9, 7, 9);
    assert.equal((await f.request('/api/schedule', f.payload({ revision: 2, timezone: 'STD0',
      reminders: [{ ...f.reminder, nextDue }] }))).status, 200);
    const state = f.simulator.snapshot().schedule;
    assert.equal(state.reminders[0].nextDue, nextDue);
    assert.deepEqual(state.deferred, [deferred]);
    f.advance(deferred.due);
    const [notice] = f.simulator.tick();
    assert.equal(notice.id, deferred.id);
    assert.equal(f.simulator.snapshot().schedule.history.at(-1).due, deferred.due);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
