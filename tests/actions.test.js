import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderEngine, migrateState } from '../src/core/engine.js';
import { requestDevice, readDeviceEvents } from '../src/core/device.js';
import { createSimulator } from '../tools/device-simulator.js';

async function fixture(t, { protocol = 3 } = {}) {
  let now = new Date('2026-10-06T08:00:00').getTime();
  let saved, failDesktop = false, failDevice = false, sequence = 0;
  const notices = [];
  const server = createSimulator({ protocol, onNotice: n => notices.push(n), persist: () => !failDevice });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { clock: () => now, id: () => 'a' + (++sequence),
    persist: async value => { if (failDesktop) return false; saved = value; return true; },
    send: (device, job) => requestDevice(device, '/api/notify', job), readEvents: readDeviceEvents,
    ackEvents: (device, ids) => requestDevice(device, '/api/events/ack', { ids }) };
  let engine = new ReminderEngine(options);
  await engine.setDevice({ url: `http://127.0.0.1:${server.address().port}`, token: 'local-simulator-token-12345678' });
  await engine.saveReminder({ title: 'Mola ver', frequency: 'daily', time: '09:00', melody: 'none' });
  now += 3600000; await engine.tick();
  return { get engine() { return engine; }, server, notices, now: () => now, advance: n => { now = n; },
    failDesktop: value => { failDesktop = value; }, failDevice: value => { failDevice = value; },
    restart: () => { engine = new ReminderEngine({ ...options, state: saved }); }, saved: () => saved };
}

test('completion preserves delivery proof and recurrence; duplicate completion is idempotent', async t => {
  const f = await fixture(t);
  const original = f.engine.snapshot(); const id = original.jobs[0].id;
  await f.engine.completeJob(id);
  assert.equal(f.engine.state.jobs[0].outcome, 'completed');
  assert.equal(f.engine.state.jobs[0].status, 'delivered');
  assert.equal(f.engine.state.jobs[0].deliveredAt, original.jobs[0].deliveredAt);
  assert.equal(f.engine.state.reminders[0].nextDue, original.reminders[0].nextDue);
  const completedAt = f.engine.state.jobs[0].completedAt;
  f.advance(f.now() + 60000); await f.engine.completeJob(id);
  assert.equal(f.engine.state.jobs[0].completedAt, completedAt);
  await assert.rejects(f.engine.snoozeJob(id, 15), /ertelenemiyor/);
  f.restart(); assert.equal(f.engine.state.jobs[0].outcome, 'completed');
});

test('completing a snooze family cancels its pending children but keeps future recurrence', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  await f.engine.snoozeJob(id, 15);
  await f.engine.completeJob(id);
  assert.equal(f.engine.state.jobs[1].status, 'cancelled');
  assert.equal(f.engine.state.jobs[1].outcome, 'completed');
  assert.equal(f.engine.state.jobs[1].rootId, f.engine.state.jobs[0].rootId);
  f.advance(f.now() + 15 * 60000); await f.engine.tick();
  assert.equal(f.notices.length, 1);
  f.advance(f.engine.state.reminders[0].nextDue); await f.engine.tick();
  assert.equal(f.notices.length, 2);
  assert.equal(f.engine.state.jobs[2].outcome, 'pending');
  await assert.rejects(f.engine.completeJob('missing'), /işaretlenemiyor/);
});

test('completion rejects future jobs and a disk failure leaves outcomes unchanged', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  f.failDesktop(true);
  const before = f.engine.snapshot();
  await assert.rejects(f.engine.completeJob(id), /diske/);
  assert.deepEqual(f.engine.snapshot(), before);
  f.failDesktop(false); await f.engine.snoozeJob(id, 15);
  await assert.rejects(f.engine.completeJob(f.engine.state.jobs[1].id), /işaretlenemiyor/);
});

test('device completion and event acknowledgement persist together across restart', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  const event = f.server.recordAction(id, 'completed');
  await f.engine.syncDevice();
  assert.equal(f.engine.state.jobs[0].outcome, 'completed');
  assert.equal(f.engine.state.jobs[0].actionSource, 'device');
  assert.deepEqual(f.engine.state.deviceEvents, [event.id]);
  assert.equal(f.server.snapshot().events.length, 0);
  f.restart(); await f.engine.syncDevice();
  assert.equal(f.engine.state.jobs[0].completedAt, f.now());
});

test('device snooze replay after failed acknowledgement never schedules twice', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  f.server.recordAction(id, 'snoozed');
  f.failDevice(true);
  await assert.rejects(f.engine.syncDevice(), /507/);
  const child = f.engine.snapshot().jobs[1];
  assert.equal(child.due, f.now() + 15 * 60000);
  assert.equal(f.engine.state.jobs[0].status, 'delivered');
  assert.equal(f.engine.state.jobs[0].outcome, 'snoozed');
  assert.equal(f.server.snapshot().events.length, 1);
  f.restart(); f.failDevice(false); f.advance(f.now() + 60000);
  await f.engine.syncDevice();
  assert.equal(f.engine.state.jobs.length, 2);
  assert.equal(f.engine.state.jobs[1].id, child.id);
  assert.equal(f.engine.state.jobs[1].due, child.due);
  assert.equal(f.server.snapshot().events.length, 0);
  f.advance(child.due - 1); await f.engine.tick(); assert.equal(f.notices.length, 1);
  f.advance(child.due); await f.engine.tick(); assert.equal(f.notices.length, 2);
});

test('desktop persistence failure leaves device events unacknowledged for retry', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  f.server.recordAction(id, 'completed'); f.failDesktop(true);
  await assert.rejects(f.engine.syncDevice(), /diske/);
  assert.equal(f.server.snapshot().events.length, 1);
  assert.equal(f.engine.state.jobs[0].outcome, 'pending');
  f.failDesktop(false); f.restart(); await f.engine.syncDevice();
  assert.equal(f.engine.state.jobs[0].outcome, 'completed');
  assert.equal(f.server.snapshot().events.length, 0);
});

test('device action persistence failure does not dismiss its notification', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  const before = f.server.snapshot(); f.failDevice(true);
  assert.throws(() => f.server.recordAction(id, 'completed'), /Persistence/);
  assert.deepEqual(f.server.snapshot(), before);
});

test('retained device events survive simulator restart and their acknowledgements are idempotent', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  const event = f.server.recordAction(id, 'completed');
  const server = createSimulator({ state: f.server.snapshot(), onNotice: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const device = { ...f.engine.state.device, url: `http://127.0.0.1:${server.address().port}` };
  assert.deepEqual(await readDeviceEvents(device), [event]);
  const reply = await requestDevice(device, '/api/notify', { id, title: 'Mola ver', melody: 'none' });
  assert.equal(reply.duplicate, true);
  await requestDevice(device, '/api/events/ack', { ids: [event.id] });
  await requestDevice(device, '/api/events/ack', { ids: [event.id] });
  assert.deepEqual(await readDeviceEvents(device), []);
});

test('late snoozes for deleted or paused reminders are acknowledged without reviving them', async t => {
  for (const remove of [false, true]) {
    const f = await fixture(t);
    f.server.recordAction(f.engine.state.jobs[0].id, 'snoozed');
    const reminder = f.engine.state.reminders[0];
    if (remove) await f.engine.removeReminder(reminder.id);
    else await f.engine.saveReminder({ ...reminder, enabled: false });
    await f.engine.syncDevice();
    assert.equal(f.engine.state.jobs.length, 1);
    assert.equal(f.server.snapshot().events.length, 0);
  }
});

test('protocol 2 remains usable for notifications and desktop completion', async t => {
  const f = await fixture(t, { protocol: 2 });
  await f.engine.syncDevice(); await f.engine.completeJob(f.engine.state.jobs[0].id);
  assert.equal(f.engine.state.jobs[0].outcome, 'completed');
  assert.equal(f.notices.length, 1);
});

test('legacy snooze migration separates outcome and delivery while retaining snooze families', () => {
  const old = { version: 3, reminders: [], device: { url: '', token: '' }, jobs: [
    { id: 'root', status: 'snoozed', snoozedTo: 'child', deliveredAt: 123 },
    { id: 'child', status: 'snoozed', snoozedTo: 'grandchild' },
    { id: 'grandchild', status: 'queued' }
  ] };
  const before = JSON.stringify(old); const state = migrateState(old);
  assert.equal(state.version, 6);
  assert.deepEqual(state.jobs.map(j => j.rootId), ['root', 'root', 'root']);
  assert.deepEqual(state.jobs.map(j => j.outcome), ['snoozed', 'snoozed', 'pending']);
  assert.deepEqual(state.jobs.map(j => j.status), ['delivered', 'cancelled', 'queued']);
  assert.equal(JSON.stringify(old), before);
  assert.deepEqual(migrateState(state), state);
});

test('malformed event batches and missing acknowledgements are refused', async () => {
  const device = { url: 'http://device', token: 'local-simulator-token-12345678' };
  const good = { id: 'a'.repeat(32), notificationId: 'one', action: 'snoozed', minutes: 15 };
  for (const events of [[null], [good, good], [{ ...good, minutes: 10 }], [{ ...good, action: 'unknown' }], [{ ...good, id: 'invalid' }], Array(17).fill(good)]) {
    await assert.rejects(requestDevice(device, '/api/events', undefined,
      async () => new Response(JSON.stringify({ protocol: 3, events }))), /geçerli değil/);
  }
  await assert.rejects(requestDevice(device, '/api/events/ack', { ids: [good.id] },
    async () => new Response(JSON.stringify({ protocol: 3, acknowledged: [] }))), /onaylamadı/);
});

test('a device completion repairs lost delivery evidence and cancels retries', async t => {
  const f = await fixture(t);
  // Crash-equivalent snapshot: the device accepted it but the desktop did not save the acknowledgement.
  f.engine.state.jobs[0].status = 'queued'; delete f.engine.state.jobs[0].deliveredAt;
  f.server.recordAction(f.engine.state.jobs[0].id, 'completed');
  await f.engine.syncDevice(); await f.engine.tick();
  assert.equal(f.engine.state.jobs[0].status, 'delivered');
  assert.equal(f.engine.state.jobs[0].outcome, 'completed');
  assert.equal(f.notices.length, 1);
});

test('event capacity never evicts an unacknowledged action', async t => {
  const f = await fixture(t);
  f.server.recordAction(f.engine.state.jobs[0].id, 'completed');
  const device = f.engine.state.device;
  for (let i = 1; i < 16; i++) {
    await requestDevice(device, '/api/notify', { id: 'capacity-' + i, title: 'Kuyruk testi', melody: 'none' });
    f.server.recordAction('capacity-' + i, 'completed');
  }
  await requestDevice(device, '/api/notify', { id: 'overflow', title: 'Son not', melody: 'none' });
  const before = f.server.snapshot();
  assert.throws(() => f.server.recordAction('overflow', 'snoozed'), /queue full/);
  assert.deepEqual(f.server.snapshot(), before);
  await f.engine.syncDevice();
  assert.equal(f.server.snapshot().events.length, 0);
  assert.equal(f.server.snapshot().pending[0].id, 'overflow');
});

test('a stale device snooze cannot undo desktop completion', async t => {
  const f = await fixture(t); const id = f.engine.state.jobs[0].id;
  f.server.recordAction(id, 'snoozed');
  await f.engine.completeJob(id); await f.engine.syncDevice();
  assert.equal(f.engine.state.jobs.length, 1);
  assert.equal(f.engine.state.jobs[0].outcome, 'completed');
  assert.equal(f.server.snapshot().events.length, 0);
});
