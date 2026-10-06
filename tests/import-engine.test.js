import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings } from '../src/core/settings.js';
import { ReminderEngine } from '../src/core/engine.js';

const base = { title: 'Mola ver', frequency: 'daily', time: '09:00', melody: 'chime', enabled: true };
const text = (reminders, settings = {}) => JSON.stringify({ format: 'masa-reminders', version: 1, reminders, settings });
function fixture(overrides = {}) {
  let sequence = 0;
  const saves = [], backups = [];
  const engine = new ReminderEngine({ clock: () => new Date('2026-10-06T08:00:00').getTime(), id: () => 'import-' + (++sequence),
    persist: async state => { saves.push(structuredClone(state)); return true; },
    backup: async state => { backups.push(structuredClone(state)); return true; }, send: async () => {}, ...overrides });
  return { engine, saves, backups };
}

test('export and preview are read-only and do not expose device credentials', async () => {
  const { engine, saves } = fixture();
  await engine.setDevice({ url: 'http://192.168.1.50', token: 'device-token-123456789012345678' });
  await engine.saveReminder(base);
  const before = engine.snapshot(), saveCount = saves.length;
  const backup = engine.exportBackup();
  assert.equal('device' in backup, false); assert.equal('jobs' in backup, false);
  assert.equal(JSON.stringify(backup).includes(before.device.token), false);
  const preview = engine.previewImport({ text: JSON.stringify(backup) });
  assert.equal(preview.count, 1); assert.equal(preview.reminders[0].title, base.title);
  assert.throws(() => engine.previewImport({ text: '{' }));
  assert.deepEqual(engine.snapshot(), before); assert.equal(saves.length, saveCount);
});

test('merge import is idempotent by reminder ID and restores quiet settings', async () => {
  const { engine, backups, saves } = fixture();
  await engine.saveReminder(base);
  const imported = { ...base, id: 'stable-id', title: 'Su iç' };
  const settings = { quietEnabled: true, quietStart: '23:00', quietEnd: '07:00' };
  await engine.importBackup({ text: text([imported], settings), mode: 'merge' });
  await engine.importBackup({ text: text([{ ...imported, title: 'Su iç, tekrar' }], settings), mode: 'merge' });
  assert.equal(engine.state.reminders.length, 2);
  assert.equal(engine.state.reminders.find(r => r.id === 'stable-id').title, 'Su iç, tekrar');
  assert.deepEqual(engine.state.settings, validateSettings(settings));
  assert.equal(backups.length, 2);
  const before = engine.snapshot(), saveCount = saves.length;
  await engine.importBackup({ text: text([{ ...imported, title: 'Su iç, tekrar' }], settings), mode: 'merge' });
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(backups.length, 2); assert.equal(saves.length, saveCount);
});

test('replace stores full recovery backup, cancels pending deliveries and retains credentials', async () => {
  const { engine, backups } = fixture();
  await engine.saveReminder(base);
  await engine.setDevice({ url: 'http://192.168.1.50', token: 'device-token-123456789012345678' });
  engine.state.jobs.push({ id: 'old-delivery', rootId: 'old-delivery', reminderId: engine.state.reminders[0].id,
    title: base.title, melody: 'chime', outcome: 'pending', status: 'queued', due: 1, expiresAt: 9999999999999, retryAt: 1, attempts: 0 });
  const before = engine.snapshot();
  await engine.importBackup({ text: text([{ ...base, id: 'replacement', title: 'Yeni not' }]), mode: 'replace' });
  assert.equal(backups.length, 1); assert.deepEqual(backups[0], before);
  assert.equal(engine.state.reminders.length, 1); assert.equal(engine.state.reminders[0].id, 'replacement');
  assert.deepEqual(engine.state.device, before.device);
  assert.equal(engine.state.jobs.some(j => j.id === 'old-delivery' && j.status === 'queued'), false);
});

test('failed recovery backup or failed persistence leaves all current data unchanged', async () => {
  for (const failure of ['backup', 'persist']) {
    const { engine } = fixture(); await engine.saveReminder(base);
    const before = engine.snapshot(); engine[failure] = async () => false;
    await assert.rejects(engine.importBackup({ text: text([{ ...base, id: 'replacement' }]), mode: 'replace' }));
    assert.deepEqual(engine.snapshot(), before);
  }
});

test('merge counts the combined unique IDs and rejects over capacity atomically', async () => {
  const { engine } = fixture();
  const hundred = Array.from({ length: 100 }, (_, index) => ({ ...base, id: 'r-' + index }));
  await engine.importBackup({ text: text(hundred), mode: 'merge' });
  await engine.importBackup({ text: text([{ ...base, id: 'r-0', title: 'Güncel not' }]), mode: 'merge' });
  const before = engine.snapshot();
  await assert.rejects(engine.importBackup({ text: text([{ ...base, id: 'one-too-many' }]), mode: 'merge' }), /100/);
  assert.deepEqual(engine.snapshot(), before);
  await assert.rejects(engine.importBackup({ text: text([]), mode: 'unknown' }));
  assert.deepEqual(engine.snapshot(), before);
});
