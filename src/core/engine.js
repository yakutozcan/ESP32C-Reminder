import { DAY, validateReminder, nextAfter, latestDue, validateQuietHours, isQuietAt, deviceTimezone, normalizeDeviceReminder } from './schedule.js';
import { validateDevice, validateDeviceJob, validateScheduleReply } from './device.js';

import { createBackup, parseBackup } from './backup.js';

const defaultScheduler = () => ({ mode: 'desktop', desired: false, ownerId: '', revision: 0, syncedRevision: null });
const clone = value => JSON.parse(JSON.stringify(value));
export const newState = () => ({ version: 5, reminders: [], jobs: [], deviceEvents: [], settings: validateQuietHours(), scheduler: defaultScheduler(), device: { url: '', token: '' } });

export function migrateState(saved) {
  if (![1, 2, 3, 4, 5].includes(saved.version) || !Array.isArray(saved.reminders) || !Array.isArray(saved.jobs))
    throw new Error('Kayıt biçimi desteklenmiyor. Veriyi yedeklemeden sıfırlama.');
  const state = clone(saved);
  if (state.version >= 4 && (!Array.isArray(state.deviceEvents) || state.jobs.some(j =>
      typeof j.rootId !== 'string' || !['pending', 'completed', 'snoozed'].includes(j.outcome))))
    throw new Error('Kayıt biçimi desteklenmiyor. Veriyi yedeklemeden sıfırlama.');
  if (state.version === 1) {
    for (const entry of [...state.reminders, ...state.jobs]) {
      if (!Number.isInteger(entry.vibrationMs) || entry.vibrationMs < 0 || entry.vibrationMs > 5000)
        throw new Error('Eski ses ayarı okunamadı. Veriyi yedeklemeden sıfırlama.');
      entry.melody = entry.vibrationMs === 0 ? 'none' : 'chime';
      delete entry.vibrationMs;
    }
    state.version = 2;
  }
  if (state.version < 4) {
    for (const job of state.jobs) {
      job.outcome = job.status === 'snoozed' ? 'snoozed' : 'pending';
      if (job.status === 'snoozed') job.status = job.deliveredAt ? 'delivered' : 'cancelled';
      job.rootId = job.id;
    }
    // Preserve snooze families, including chains whose original row was already pruned.
    for (const job of state.jobs) {
      let parent = job;
      const visited = new Set([job.id]);
      while (true) {
        const previous = state.jobs.find(j => j.snoozedTo === parent.id && !visited.has(j.id));
        if (!previous) break;
        visited.add(previous.id); parent = previous;
      }
      job.rootId = parent.id;
    }
    state.deviceEvents = [];
  }
  if (state.version < 5) { state.settings = validateQuietHours(); state.scheduler = defaultScheduler(); }
  else {
    state.settings = validateQuietHours(state.settings);
    const owner = state.scheduler;
    if (!owner || !['desktop', 'device'].includes(owner.mode) || typeof owner.desired !== 'boolean' ||
        typeof owner.ownerId !== 'string' || !Number.isSafeInteger(owner.revision) || owner.revision < 0 ||
        (owner.mode === 'device' && !owner.ownerId) || (owner.mode === 'desktop' && owner.desired))
      throw new Error('Zamanlayıcı sahiplik kaydı geçerli değil. Veriyi yedeklemeden sıfırlama.');
  }
  state.version = 5;
  return state;
}

export class ReminderEngine {
  constructor({ state = newState(), persist, send, readEvents, ackEvents, readSchedule, writeSchedule, health, backup, notify = () => {}, clock = Date.now,
    id = () => crypto.randomUUID() }) {
    this.state = migrateState(state);
    this.persist = persist;
    this.send = send;
    this.readEvents = readEvents;
    this.ackEvents = ackEvents;
    this.notify = notify;
    this.readSchedule = readSchedule; this.writeSchedule = writeSchedule; this.health = health; this.backup = backup;
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
  assertDeviceRange(state, max = state.scheduler.maxTimestamp) {
    if (!max) return;
    const stamps = [this.clock(), ...state.reminders.flatMap(r => [r.nextDue, r.scheduledAt, r.anchorAt]), ...state.jobs.filter(j => j.status === 'queued').flatMap(j => [j.due, j.expiresAt])].filter(n => n !== undefined && n !== null);
    if (stamps.some(n => n < 946684800000 || n > max)) throw new Error('Bu cihaz seçilen tarihlerden birini desteklemiyor. Daha yakın bir tarih seç.');
  }
  bump(state) { state.scheduler.revision++; delete state.scheduler.commands; delete state.scheduler.error; }
  saveReminder(input) {
    return this.serial(async () => {
      const value = validateReminder({ ...input, ...(input.frequency === 'interval' && input.anchorAt === undefined ? { anchorAt: this.clock() } : {}) });
      const state = this.snapshot();
      const index = state.reminders.findIndex(r => r.id === input.id);
      if (input.id && index < 0) throw new Error('Hatırlatıcı bulunamadı.');
      if (index < 0 && state.scheduler.mode === 'device' && state.reminders.length >= 24) throw new Error('Bağımsız cihaz en fazla 24 hatırlatıcı saklar.');
      if (index < 0 && state.reminders.length >= 100) throw new Error('En fazla 100 hatırlatıcı ekleyebilirsin.');
      const nextDue = nextAfter(value, this.clock());
      if (value.enabled && nextDue === null) throw new Error('Tek seferlik hatırlatma için gelecekte bir tarih ve saat seç.');
      const reminder = { ...value, id: input.id || this.id(), nextDue };
      if (index < 0) state.reminders.push(reminder);
      else state.reminders[index] = reminder;
      for (const job of state.jobs) if (job.reminderId === reminder.id && job.status === 'queued') job.status = 'cancelled';
      if (state.scheduler.mode === 'device') this.assertDeviceRange(state);
      this.bump(state);
      await this.commit(state);
      return reminder;
    });
  }
  removeReminder(id) {
    return this.serial(async () => {
      const state = this.snapshot();
      state.reminders = state.reminders.filter(r => r.id !== id);
      this.bump(state);
      for (const job of state.jobs) if (job.reminderId === id && job.status === 'queued') job.status = 'cancelled';
      await this.commit(state);
    });
  }
  setDevice(input) {
    return this.serial(async () => {
      const state = this.snapshot();
      const device = validateDevice(input);
      if (state.scheduler.mode === 'device' && JSON.stringify(device) !== JSON.stringify(state.device))
        throw new Error('Cihaz adresini değiştirmeden önce bağımsız çalışmayı kapatıp eşitle.');
      state.device = device;
      for (const job of state.jobs) if (job.status === 'queued') job.retryAt = this.clock();
      await this.commit(state);
    });
  }
  snoozeJob(id, minutes) {
    return this.serial(async () => {
      if (![5, 15, 30].includes(minutes)) throw new Error('5, 15 veya 30 dakika seç.');
      const state = this.snapshot();
      const source = state.jobs.find(job => job.id === id);
      const now = this.clock();
      if (!source || source.outcome !== 'pending' || !['queued', 'delivered'].includes(source.status)) throw new Error('Bu bildirim ertelenemiyor.');
      if (source.due > now || source.expiresAt <= now) throw new Error('Yalnızca son 24 saatte zamanı gelmiş bildirimler ertelenebilir.');
      if (!state.reminders.some(r => r.id === source.reminderId)) throw new Error('Hatırlatıcı silinmiş.');
      if (state.scheduler.mode === 'device' && state.jobs.filter(j => j.status === 'queued').length >= 24)
        throw new Error('Cihaz erteleme kuyruğu dolu.');
      this.snoozeInState(state, source, minutes, now, 'desktop');
      if (state.scheduler.mode === 'device') this.assertDeviceRange(state);
      this.bump(state);
      await this.commit(state);
    });
  }
  snoozeInState(state, source, minutes, now, actionSource) {
    const due = now + minutes * 60000;
    const nextId = 'snooze-' + this.id();
    if (source.status === 'queued') source.status = 'cancelled';
    source.outcome = 'snoozed'; source.snoozedTo = nextId; source.actionSource = actionSource;
    source.error = '';
    state.jobs.push({ id: nextId, rootId: source.rootId, outcome: 'pending', reminderId: source.reminderId,
      title: source.title, melody: source.melody, due, expiresAt: due + DAY, retryAt: due,
      attempts: 0, status: 'queued', error: '', desktopPending: true });
  }
  completeInState(state, source, now, actionSource) {
    if (state.jobs.some(j => j.rootId === source.rootId && j.outcome === 'completed')) return false;
    for (const job of state.jobs.filter(j => j.rootId === source.rootId)) {
      job.outcome = 'completed'; job.completedAt = now; job.actionSource = actionSource;
      if (job.status === 'queued') { job.status = 'cancelled'; delete job.desktopPending; }
    }
    return true;
  }
  completeJob(id) {
    return this.serial(async () => {
      const state = this.snapshot();
      const source = state.jobs.find(job => job.id === id);
      if (!source || source.due > this.clock() || (source.status === 'cancelled' && source.outcome === 'pending'))
        throw new Error('Bu bildirim tamamlandı olarak işaretlenemiyor.');
      if (this.completeInState(state, source, this.clock(), 'desktop')) { this.bump(state); await this.commit(state); }
    });
  }
  syncDevice() {
    return this.serial(async () => {
      if (!this.state.device.url) return;
      if (this.state.scheduler.mode === 'device') {
        await this.syncScheduleInternal();
      }
      if (!this.readEvents || !this.ackEvents) return;
      const events = await this.readEvents(this.state.device);
      if (!events.length) return;
      const state = this.snapshot();
      const now = this.clock();
      let changed = false;
      for (const event of events) {
        if (state.deviceEvents.includes(event.id)) continue;
        if (state.scheduler.mode === 'device' && event.job) {
          this.mergeDeviceJobs(state, [event.job, ...(event.deferred ? [event.deferred] : [])]);
        }
        const source = state.jobs.find(job => job.id === event.notificationId);
        const reminder = source && state.reminders.find(r => r.id === source.reminderId);
        if (source && source.due <= now && !(state.scheduler.mode === 'device' && event.job)) {
          // A persisted device action also proves acceptance after a lost delivery acknowledgement.
          if (source.status === 'queued') { source.status = 'delivered'; source.deliveredAt = now; }
          if (event.action === 'completed') {
            if (this.completeInState(state, source, now, 'device') && state.scheduler.mode === 'device') this.bump(state);
          }
          else if (event.action === 'snoozed' && source.outcome === 'pending' &&
              ['queued', 'delivered'].includes(source.status) && source.expiresAt > now &&
              reminder && (reminder.enabled || reminder.frequency === 'once' && reminder.nextDue === null))
            {
              this.snoozeInState(state, source, event.minutes, now, 'device');
              if (state.scheduler.mode === 'device') this.bump(state);
            }
        }
        state.deviceEvents.push(event.id);
        changed = true;
      }
      state.deviceEvents = state.deviceEvents.slice(-64);
      // Persist effects and receipts together before removing events from the device.
      if (changed) await this.commit(state);
      await this.ackEvents(this.state.device, events.map(e => e.id));
    });
  }
  exportBackup() { return createBackup(this.state, this.clock()); }
  previewImport({ text }) {
    const parsed = parseBackup(text);
    return { count: parsed.reminders.length, ...parsed };
  }
  importBackup({ text, mode }) {
    return this.serial(async () => {
      if (!['merge', 'replace'].includes(mode)) throw new Error('Birleştir veya değiştir seç.');
      const parsed = parseBackup(text), state = this.snapshot();
      const importedIds = new Set(parsed.reminders.map(r => r.id));
      const kept = mode === 'merge' ? state.reminders.filter(r => !importedIds.has(r.id)) : [];
      if (kept.length + parsed.reminders.length > (state.scheduler.mode === 'device' ? 24 : 100))
        throw new Error('İçe aktarma ' + (state.scheduler.mode === 'device' ? 24 : 100) + ' hatırlatıcı kapasitesini aşıyor.');
      const now = this.clock();
      const changedIds = new Set();
      const imported = parsed.reminders.map(r => {
        const existing = state.reminders.find(value => value.id === r.id);
        if (existing && JSON.stringify({ id: existing.id, ...validateReminder(existing) }) === JSON.stringify(r)) return existing;
        changedIds.add(r.id);
        const nextDue = nextAfter(r, now);
        return { ...r, nextDue, ...(r.frequency === 'once' && nextDue === null ? { enabled: false } : {}) };
      });
      for (const job of state.jobs) if (job.status === 'queued' && (mode === 'replace' && !importedIds.has(job.reminderId) || changedIds.has(job.reminderId))) {
        job.status = 'cancelled'; delete job.desktopPending;
      }
      state.reminders = [...kept, ...imported]; state.settings = parsed.settings;
      if (state.scheduler.mode === 'device') this.assertDeviceRange(state);
      if (JSON.stringify(state) === JSON.stringify(this.state)) return;
      this.bump(state);
      if (!this.backup || await this.backup(this.snapshot()) === false)
        throw new Error('İçe aktarmadan önce mevcut verinin yedeği kaydedilemedi.');
      await this.commit(state);
    });
  }
  saveSettings(input) {
    return this.serial(async () => {
      const state = this.snapshot(); state.settings = validateQuietHours(input);
      this.bump(state); await this.commit(state);
    });
  }
  setAutonomous({ enabled, takeover = false }) {
    return this.serial(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Bağımsız çalışma ayarı geçersiz.');
      if (!this.health || !this.writeSchedule || !this.readSchedule) throw new Error('Bağımsız cihaz bağlantısı hazır değil.');
      const state = this.snapshot();
      if (enabled) {
        const health = await this.health(state.device);
        if (health.protocol !== 4) throw new Error('Bağımsız çalışma için cihaz yazılımını 0.6.0 sürümüne güncelle.');
        if (state.reminders.length > 24 || state.jobs.filter(j => j.status === 'queued' && j.expiresAt > this.clock()).length > 24)
          throw new Error('Bağımsız cihaz en fazla 24 hatırlatıcı ve 24 bekleyen erteleme saklar.');
        if (Number.isSafeInteger(health.scheduleMaxTimestamp)) {
          this.assertDeviceRange(state, health.scheduleMaxTimestamp); state.scheduler.maxTimestamp = health.scheduleMaxTimestamp;
        }
        state.reminders = state.reminders.map(r => ({ ...r, ...normalizeDeviceReminder(r),
          ...(r.frequency === 'once' && r.nextDue === null && state.jobs.some(j => j.reminderId === r.id && j.outcome === 'pending' && ['queued', 'delivered'].includes(j.status)) ? { deviceConsumed: true } : {}) }));
        const timezone = deviceTimezone(this.clock());
        state.scheduler.timezone = timezone;
        state.scheduler.localOffset = new Date(this.clock()).getTimezoneOffset();
        state.scheduler.ownerId ||= this.id();
        // Persist the ownership fence before the first network mutation. An uncertain
        // response keeps desktop delivery stopped until the device confirms handback.
        state.scheduler.mode = 'device';
      } else if (state.scheduler.mode === 'desktop') return;
      state.scheduler.desired = enabled; state.scheduler.takeover = takeover === true;
      this.bump(state); await this.commit(state);
      await this.syncScheduleInternal();
    });
  }
  syncSchedule() { return this.serial(() => this.syncScheduleInternal()); }
  mergeDeviceJobs(state, jobs) {
    for (const raw of jobs) {
      validateDeviceJob(raw);
      if (raw.outcome === 'completed' && !state.jobs.some(j => j.rootId === raw.rootId && j.outcome === 'completed' && j.actionSource === 'desktop')) {
        for (const member of state.jobs.filter(j => j.rootId === raw.rootId)) {
          member.outcome = 'completed'; member.completedAt = raw.completedAt ?? this.clock(); member.actionSource = 'device';
          if (member.status === 'queued') { member.status = 'cancelled'; delete member.desktopPending; }
        }
      }
      const existing = state.jobs.find(j => j.id === raw.id);
      const completed = state.jobs.find(j => j.rootId === raw.rootId && j.outcome === 'completed');
      // Desktop actions waiting to reach the device are authoritative; remote
      // receipts cannot revive a cancelled timer or undo a completed family.
      if (existing && (existing.status === 'cancelled' && raw.status === 'queued' || existing.actionSource === 'desktop' && existing.outcome !== 'pending')) continue;
      if (raw.status === 'queued' && (completed || !state.reminders.some(r => r.id === raw.reminderId &&
          (r.enabled || r.frequency === 'once' && r.nextDue === null && r.deviceConsumed)))) continue;
      const value = { id: raw.id, rootId: raw.rootId, reminderId: raw.reminderId, title: raw.title, melody: raw.melody,
        due: raw.due, expiresAt: raw.expiresAt, status: raw.status, outcome: completed ? 'completed' : raw.outcome,
        retryAt: raw.due, attempts: 0, error: '', actionSource: 'device',
        ...(raw.status === 'delivered' ? { deliveredAt: raw.deliveredAt ?? raw.due } : {}),
        ...(raw.completedAt !== undefined ? { completedAt: raw.completedAt } : {}),
        ...(completed ? { completedAt: completed.completedAt } : {}),
        ...(raw.snoozedTo ? { snoozedTo: raw.snoozedTo } : {}) };
      if (existing) Object.assign(existing, value); else state.jobs.push(value);
    }
  }
  mergeSchedule(state, remote) {
    validateScheduleReply(remote);
    if (remote.ownerId !== state.scheduler.ownerId) return;
    this.mergeDeviceJobs(state, [...remote.history, ...remote.deferred]);
    if (remote.revision === state.scheduler.revision) {
      for (const cursor of remote.cursors) {
        const reminder = state.reminders.find(r => r.id === cursor.id);
        if (reminder) {
          reminder.nextDue = cursor.nextDue;
          if (reminder.frequency === 'once' && cursor.nextDue === null && reminder.enabled) {
            reminder.enabled = false; reminder.deviceConsumed = true;
          }
        }
      }
    }
    state.scheduler.timeValid = remote.timeValid;
    state.jobs = [...state.jobs.filter(j => j.status !== 'queued').slice(-100), ...state.jobs.filter(j => j.status === 'queued')];
  }
  async syncScheduleInternal() {
    if (this.state.scheduler.mode !== 'device') return;
    if (!this.writeSchedule || !this.readSchedule) throw new Error('Cihaz takvim bağlantısı hazır değil.');
    try {
      const remote = await this.readSchedule(this.state.device);
      let state = this.snapshot(); this.mergeSchedule(state, remote);
      const owner = state.scheduler;
      // Handback must remain possible even after travel to a timezone whose
      // political rules cannot be represented on the device. Disable using the
      // last accepted device rule, then resume the desktop's local calendar.
      const timezone = owner.desired ? deviceTimezone(this.clock()) : owner.timezone;
      if (timezone !== owner.timezone) {
        owner.timezone = timezone;
        state.reminders = state.reminders.map(r => {
          const definition = normalizeDeviceReminder(r);
          return { ...r, ...definition, nextDue: nextAfter(definition, this.clock()) };
        });
        this.assertDeviceRange(state); this.bump(state);
      }
      const needsWrite = owner.syncedRevision !== owner.revision || remote.revision !== owner.revision ||
        remote.ownerId !== owner.ownerId || remote.enabled !== owner.desired || !remote.timeValid || !owner.lastSync || this.clock() - owner.lastSync >= 3600000;
      // Keep newly downloaded device timers durable before reconfiguration.
      if (JSON.stringify(state) !== JSON.stringify(this.state)) await this.commit(state);
      if (needsWrite) {
        const deferred = state.jobs.filter(j => j.status === 'queued' && j.outcome === 'pending' && j.expiresAt > this.clock());
        if (deferred.length > 24 || state.reminders.length > 24) throw new Error('Cihaz takvim kapasitesi aşılıyor.');
        if (owner.commands?.revision !== owner.revision) {
          owner.commands = { revision: owner.revision,
            completedRoots: [...new Set(state.jobs.filter(j => j.outcome === 'completed').map(j => j.rootId))].slice(-100),
            cancelledIds: state.jobs.filter(j => j.status === 'cancelled' || j.outcome === 'snoozed' && j.actionSource === 'desktop').map(j => j.id).slice(-100) };
          // Freeze command lists with this revision: device-origin changes must
          // not turn a clock refresh or lost-ACK retry into a revision conflict.
          await this.commit(state);
        }
        const payload = { ownerId: owner.ownerId, revision: owner.revision, enabled: owner.desired, takeover: owner.takeover === true,
          timezone, utcNow: this.clock(), quietHours: state.settings,
          reminders: state.reminders.map(r => ({ ...normalizeDeviceReminder(r.deviceConsumed ? { ...r, enabled: true } : r), id: r.id, nextDue: r.nextDue })),
          deferred: deferred.map(j => ({ id: j.id, rootId: j.rootId, reminderId: j.reminderId, title: j.title, melody: j.melody,
            due: j.due, expiresAt: j.expiresAt, status: 'queued', outcome: 'pending' })),
          completedRoots: owner.commands.completedRoots, cancelledIds: owner.commands.cancelledIds };
        const reply = await this.writeSchedule(state.device, payload);
        validateScheduleReply(reply);
        if (reply.accepted !== true || reply.ownerId !== owner.ownerId || reply.revision !== owner.revision || reply.enabled !== owner.desired)
          throw new Error('Cihaz takvim aktarımını onaylamadı.');
        state = this.snapshot(); this.mergeSchedule(state, reply);
        state.scheduler.syncedRevision = state.scheduler.revision;
        state.scheduler.lastSync = this.clock(); state.scheduler.takeover = false;
        if (!state.scheduler.desired) {
          state.scheduler.mode = 'desktop';
          if (state.scheduler.localOffset !== undefined && state.scheduler.localOffset !== new Date(this.clock()).getTimezoneOffset()) {
            state.reminders = state.reminders.map(r => {
              const definition = normalizeDeviceReminder(r);
              return { ...r, ...definition, nextDue: r.frequency === 'once' && r.nextDue === null ? null : nextAfter(definition, this.clock()) };
            });
          }
        } else state.scheduler.localOffset = new Date(this.clock()).getTimezoneOffset();
      }
      delete state.scheduler.error;
      await this.commit(state);
    } catch (error) {
      const state = this.snapshot(); state.scheduler.error = error.message;
      await this.commit(state); throw error;
    }
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
      if (this.state.scheduler.mode === 'device') return;
      let state = this.snapshot();
      let changed = false;
      const desktop = [];
      for (const reminder of state.reminders) {
        if (!reminder.enabled || reminder.nextDue === null || reminder.nextDue > now) continue;
        const due = latestDue(reminder, reminder.nextDue, now);
        reminder.nextDue = nextAfter(reminder, now);
        if (reminder.frequency === 'once') { reminder.enabled = false; reminder.deviceConsumed = true; }
        changed = true;
        if (due === null) continue;
        const id = reminder.id + ':' + due;
        if (state.jobs.some(job => job.id === id)) continue;
        state.jobs.push({ id, rootId: id, outcome: 'pending', reminderId: reminder.id, title: reminder.title, melody: reminder.melody,
          due, expiresAt: due + DAY, retryAt: now, attempts: 0, status: 'queued', error: '' });
        desktop.push({ title: reminder.title, melody: reminder.melody });
      }
      for (const job of state.jobs) {
        if (job.status === 'queued' && job.expiresAt <= now) { job.status = 'expired'; changed = true; }
        if (job.status === 'queued' && job.desktopPending && job.due <= now) {
          delete job.desktopPending;
          desktop.push({ title: job.title, melody: job.melody });
          changed = true;
        }
      }
      // Keep pending deliveries plus the most recent 100 finished deliveries.
      const pending = state.jobs.filter(j => j.status === 'queued');
      const history = state.jobs.filter(j => j.status !== 'queued').slice(-100);
      if (pending.length + history.length !== state.jobs.length) { state.jobs = [...history, ...pending]; changed = true; }
      if (changed) {
        await this.commit(state);
        for (const notice of desktop) { try { await this.notify(notice.title, notice.melody === 'none' || isQuietAt(state.settings, now)); } catch {} }
      }
      const job = this.state.jobs.find(j => j.status === 'queued' && j.due <= now && j.retryAt <= now);
      if (!job) return;
      let error = '';
      try { await this.send(this.state.device, { id: job.id, title: job.title, melody: isQuietAt(this.state.settings, now) ? 'none' : job.melody }); }
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
