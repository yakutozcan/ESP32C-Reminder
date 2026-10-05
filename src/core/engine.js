import { DAY, validateReminder, nextAfter, latestDue } from './schedule.js';
import { validateDevice } from './device.js';

const clone = value => JSON.parse(JSON.stringify(value));
export const newState = () => ({ version: 2, reminders: [], jobs: [], device: { url: '', token: '' } });

export function migrateState(saved) {
  if (![1, 2].includes(saved.version) || !Array.isArray(saved.reminders) || !Array.isArray(saved.jobs))
    throw new Error('Kayıt biçimi desteklenmiyor. Veriyi yedeklemeden sıfırlama.');
  const state = clone(saved);
  if (state.version === 1) {
    for (const entry of [...state.reminders, ...state.jobs]) {
      if (!Number.isInteger(entry.vibrationMs) || entry.vibrationMs < 0 || entry.vibrationMs > 5000)
        throw new Error('Eski ses ayarı okunamadı. Veriyi yedeklemeden sıfırlama.');
      entry.melody = entry.vibrationMs === 0 ? 'none' : 'chime';
      delete entry.vibrationMs;
    }
    state.version = 2;
  }
  return state;
}

export class ReminderEngine {
  constructor({ state = newState(), persist, send, notify = () => {}, clock = Date.now,
    id = () => crypto.randomUUID() }) {
    this.state = migrateState(state);
    this.persist = persist;
    this.send = send;
    this.notify = notify;
    this.clock = clock;
    this.id = id;
    this.chain = Promise.resolve();
  }
  serial(fn) {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }
  async commit(state) {
    // Never send an occurrence before its queue entry has reached disk.
    if (await this.persist(clone(state)) === false) throw new Error('Veri diske kaydedilemedi. Disk alanını ve yazma iznini kontrol et.');
    this.state = state;
  }
  snapshot() { return clone(this.state); }
  saveReminder(input) {
    return this.serial(async () => {
      const value = validateReminder(input);
      const state = this.snapshot();
      const index = state.reminders.findIndex(r => r.id === input.id);
      if (input.id && index < 0) throw new Error('Hatırlatıcı bulunamadı.');
      if (index < 0 && state.reminders.length >= 100) throw new Error('En fazla 100 hatırlatıcı ekleyebilirsin.');
      const reminder = { ...value, id: input.id || this.id(), nextDue: nextAfter(value, this.clock()) };
      if (index < 0) state.reminders.push(reminder);
      else state.reminders[index] = reminder;
      for (const job of state.jobs) if (job.reminderId === reminder.id && job.status === 'queued') job.status = 'cancelled';
      await this.commit(state);
      return reminder;
    });
  }
  removeReminder(id) {
    return this.serial(async () => {
      const state = this.snapshot();
      state.reminders = state.reminders.filter(r => r.id !== id);
      for (const job of state.jobs) if (job.reminderId === id && job.status === 'queued') job.status = 'cancelled';
      await this.commit(state);
    });
  }
  setDevice(input) {
    return this.serial(async () => {
      const state = this.snapshot();
      state.device = validateDevice(input);
      for (const job of state.jobs) if (job.status === 'queued') job.retryAt = this.clock();
      await this.commit(state);
    });
  }
  testDevice() {
    return this.serial(async () => {
      const job = { id: 'test-' + this.id(), title: 'Masa hazir. Biraz mola ver.', melody: 'chime' };
      return this.send(this.state.device, job);
    });
  }
  tick() {
    return this.serial(async () => {
      const now = this.clock();
      let state = this.snapshot();
      let changed = false;
      const desktop = [];
      for (const reminder of state.reminders) {
        if (!reminder.enabled || reminder.nextDue > now) continue;
        const due = latestDue(reminder, reminder.nextDue, now);
        reminder.nextDue = nextAfter(reminder, now);
        changed = true;
        if (due === null) continue;
        const id = reminder.id + ':' + due;
        if (state.jobs.some(job => job.id === id)) continue;
        state.jobs.push({ id, reminderId: reminder.id, title: reminder.title, melody: reminder.melody,
          due, expiresAt: due + DAY, retryAt: now, attempts: 0, status: 'queued', error: '' });
        desktop.push(reminder.title);
      }
      for (const job of state.jobs) {
        if (job.status === 'queued' && job.expiresAt <= now) { job.status = 'expired'; changed = true; }
      }
      // Keep pending deliveries plus the most recent 100 finished deliveries.
      const pending = state.jobs.filter(j => j.status === 'queued');
      const history = state.jobs.filter(j => j.status !== 'queued').slice(-100);
      if (pending.length + history.length !== state.jobs.length) { state.jobs = [...history, ...pending]; changed = true; }
      if (changed) {
        await this.commit(state);
        for (const title of desktop) { try { await this.notify(title); } catch {} }
      }
      const job = this.state.jobs.find(j => j.status === 'queued' && j.retryAt <= now);
      if (!job) return;
      let error = '';
      try { await this.send(this.state.device, { id: job.id, title: job.title, melody: job.melody }); }
      catch (e) { error = e.message || 'Cihaza ulaşılamadı.'; }
      state = this.snapshot();
      const updated = state.jobs.find(j => j.id === job.id);
      updated.attempts++;
      updated.error = error;
      if (!error) { updated.status = 'delivered'; updated.deliveredAt = this.clock(); }
      else updated.retryAt = this.clock() + Math.min(300000, 10000 * 2 ** Math.min(updated.attempts - 1, 5));
      await this.commit(state);
    });
  }
}
