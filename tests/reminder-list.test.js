import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReminders, reminderTags } from '../src/frontend/reminder-list.js';

const now = new Date('2026-10-06T08:00:00').getTime();
const reminders = [
  { id: 'work', title: 'İşleri kontrol et', enabled: true, frequency: 'daily', tags: ['İş', 'Rutin'], nextDue: now + 60000 },
  { id: 'paused', title: 'İş molası', enabled: false, frequency: 'daily', tags: ['iş'], nextDue: now + 120000 },
  { id: 'weekly', title: 'İşleri haftalık gözden geçir', enabled: true, frequency: 'weekly', tags: ['İş'], nextDue: now + 180000 },
  { id: 'personal', title: 'Çiçeği sula', enabled: true, frequency: 'daily', tags: ['Kişisel'], nextDue: now + 240000 },
  { id: 'old', title: 'Etiketsiz not', enabled: true, frequency: 'cron', nextDue: now + 86400000 },
  { id: 'ended', title: 'İşleri bir kez kontrol et', enabled: false, frequency: 'once', tags: [], nextDue: null }
];
const ids = options => filterReminders(reminders, options).map(r => r.id);

test('title search and all three filters intersect without changing stored reminders', () => {
  const before = structuredClone(reminders);
  assert.deepEqual(ids({ query: '  işleri ', status: 'enabled', frequency: 'daily', tag: 'tag:iş' }), ['work']);
  assert.deepEqual(ids({ query: 'iş', status: 'paused', frequency: 'daily', tag: 'tag:İş' }), ['paused']);
  assert.deepEqual(ids({ query: 'iş', status: 'enabled', frequency: 'daily', tag: 'tag:Kişisel' }), []);
  assert.deepEqual(reminders, before);
});

test('Turkish case and decomposed Unicode search consistently by title', () => {
  assert.deepEqual(ids({ query: 'İŞLERİ', status: 'enabled' }), ['work', 'weekly']);
  assert.deepEqual(ids({ query: 'C\u0327İÇEĞİ' }), ['personal']);
  assert.deepEqual(ids({ query: 'Rutin' }), []); // Labels are filtered independently.
});

test('old untagged and ended reminders remain discoverable and sorted last', () => {
  assert.deepEqual(ids({ tag: 'untagged' }), ['old', 'ended']);
  assert.deepEqual(ids({ status: 'paused' }), ['paused', 'ended']);
  assert.deepEqual(ids({ tag: 'tag:Missing' }), []);
  assert.equal(ids({}).length, reminders.length);
});

test('today still restricts the intersection to enabled reminders due on the selected day', () => {
  assert.deepEqual(ids({ today: true, now, query: 'iş', tag: 'tag:İş' }), ['work', 'weekly']);
  assert.deepEqual(ids({ today: true, now, status: 'paused' }), []);
  assert.deepEqual(ids({ today: true, now, tag: 'untagged' }), []);
});

test('tag choices are independent of filters, deduplicated with Turkish case and accept unusual user labels', () => {
  assert.deepEqual(reminderTags(reminders), ['İş', 'Kişisel', 'Rutin']);
  const unusual = [{ ...reminders[0], tags: ['untagged', '<İş>'] }];
  assert.equal(filterReminders(unusual, { tag: 'tag:untagged' }).length, 1);
  assert.equal(filterReminders(unusual, { tag: 'untagged' }).length, 0);
  assert.equal(filterReminders(unusual, { tag: 'tag:<iş>' }).length, 1);
});
