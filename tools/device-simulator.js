import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DAY, validateReminder, validateQuietHours, nextAfter, latestDue, isQuietAt, deviceTimezone } from '../src/core/schedule.js';
const clone = value => JSON.parse(JSON.stringify(value));
const validId = (value, maximum = 160) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum;
const validMillis = value => Number.isSafeInteger(value) && value >= 946684800000 && value <= 4102444800000;
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const config = reminder => { const copy = { ...reminder }; delete copy.nextDue; return stable(copy); };
const emptySchedule = () => ({ ownerId: '', revision: 0, enabled: false, timezone: 'UTC0',
  quietHours: validateQuietHours(), reminders: [], deferred: [], history: [], fingerprint: '' });
const zones = new Map();
// Node does not implement POSIX TZ strings. Resolve the same annual Date pattern
// to an IANA zone for the simulator; the actual ESP32 consumes POSIX TZ directly.
function inZone(timezone, timestamp, action) {
  const normalized = timezone.replace(/^[A-Za-z]+/, 'STD').replace(/([0-9])([A-Za-z]+)/, '$1DST');
  const old = process.env.TZ;
  try {
    let zone = zones.get(normalized);
    if (!zone) {
      let current; try { current = deviceTimezone(timestamp); } catch {}
      if (current === normalized) zone = old || Intl.DateTimeFormat().resolvedOptions().timeZone;
      else {
        const match = normalized.match(/^STD([+-]?\d+)(?::(\d+))?/);
        const expected = match ? (Number(match[1]) * 60 + (Number(match[1]) < 0 ? -1 : 1) * Number(match[2] || 0)) : NaN;
        for (const candidate of ['UTC', ...Intl.supportedValuesOf('timeZone')]) {
          process.env.TZ = candidate;
          const year = new Date(timestamp).getFullYear();
          const offsets = [new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset()];
          if (!offsets.includes(expected)) continue;
          try { if (deviceTimezone(timestamp) === normalized) { zone = candidate; break; } } catch {}
        }
      }
      if (!zone) throw new Error('Unsupported simulator timezone');
      zones.set(normalized, zone);
    }
    process.env.TZ = zone;
    return action();
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}
function validateJob(job) {
  if (!job || !validId(job.id) || !validId(job.rootId) || !validId(job.reminderId, 128) || typeof job.title !== 'string' || !job.title.trim() || Buffer.byteLength(job.title) > 320 || [...job.title].length > 80 || /[\x00-\x1f\x7f]/.test(job.title) ||
    !['chime', 'none'].includes(job.melody) || !validMillis(job.due) || !validMillis(job.expiresAt) || job.expiresAt <= job.due || job.expiresAt - job.due > DAY ||
    !['pending', 'completed', 'snoozed'].includes(job.outcome ?? 'pending')) throw new Error('Invalid deferred job');
  return { ...clone(job), status: 'queued', outcome: job.outcome ?? 'pending' };
}
function validateSchedule(input) {
  if (!input || !validId(input.ownerId, 128) || !Number.isInteger(input.revision) || input.revision < 0 || input.revision > 0xffffffff || typeof input.enabled !== 'boolean' ||
    typeof input.timezone !== 'string' || !/^[A-Za-z0-9+.,/:\-]{3,128}$/.test(input.timezone) || !validMillis(input.utcNow) ||
    !Array.isArray(input.reminders) || input.reminders.length > 24 || !Array.isArray(input.deferred) || input.deferred.length > 24 || typeof input.quietHours?.quietEnabled !== 'boolean')
    throw new Error('Invalid schedule');
  const quietHours = validateQuietHours(input.quietHours);
  const reminders = input.reminders.map(reminder => {
    if (!validId(reminder.id, 128) || (reminder.nextDue !== null && !validMillis(reminder.nextDue)) || typeof reminder.enabled !== 'boolean') throw new Error('Invalid reminder');
    const normalized = validateReminder(reminder);
    if ((normalized.frequency === 'once' && !validMillis(normalized.scheduledAt)) ||
      (normalized.frequency === 'interval' && !validMillis(normalized.anchorAt)) ||
      (normalized.frequency === 'weekly' && Number(normalized.anchorDate.slice(0, 4)) > 2099)) throw new Error('Unsupported schedule date');
    return { id: reminder.id, ...normalized, nextDue: reminder.nextDue };
  });
  if (new Set(reminders.map(r => r.id)).size !== reminders.length) throw new Error('Duplicate reminder');
  const deferred = input.deferred.map(validateJob);
  if (new Set(deferred.map(j => j.id)).size !== deferred.length) throw new Error('Duplicate deferred job');
  const completedRoots = input.completedRoots ?? [], cancelledIds = input.cancelledIds ?? [];
  for (const ids of [completedRoots, cancelledIds]) if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !validId(id))) throw new Error('Invalid cancellation');
  return { ownerId: input.ownerId, revision: input.revision, enabled: input.enabled, timezone: input.timezone,
    quietHours, reminders, deferred, completedRoots, cancelledIds };
}
export function createSimulator({ token = process.env.DEVICE_TOKEN || 'local-simulator-token-12345678',
  onNotice = console.log, protocol = 4, cron = true, state: saved, persist = () => true, clock = Date.now } = {}) {
  let state = clone(saved || { pending: [], recent: [], events: [] });
  state.schedule ??= emptySchedule();
  let timeValid = false, clockOffset = 0;
  const now = () => clock() + clockOffset;
  const commit = next => {
    try { if (persist(clone(next)) === false) throw new Error('Persistence failed'); }
    catch { throw new Error('Persistence failed'); }
    state = next;
  };
  const responseSchedule = () => {
    const { ownerId, revision, enabled, timezone, quietHours, deferred, history, reminders } = state.schedule;
    return clone({ ownerId, revision, enabled, timezone, quietHours, timeValid,
      cursors: reminders.map(({ id, nextDue }) => ({ id, nextDue })), deferred, history });
  };
  const known = (next, id) => next.recent.includes(id) || next.pending.some(n => n.id === id) || next.events.some(e => e.notificationId === id) || next.schedule.history.some(j => j.id === id);
  const appendHistory = (next, job) => {
    if (next.schedule.history.some(j => j.id === job.id)) return true;
    if (next.schedule.history.length >= 32) {
      const index = next.schedule.history.findIndex(j => !next.pending.some(n => n.id === j.id) && !next.events.some(e => e.notificationId === j.id));
      if (index < 0) return false;
      next.schedule.history.splice(index, 1);
    }
    next.schedule.history.push(job); return true;
  };
  const applySchedule = input => {
    if (!cron && input?.reminders?.some(r => r.frequency === 'cron')) throw new Error('Cron unsupported');
    const incoming = inZone(input.timezone, input.utcNow, () => validateSchedule(input));
    const previous = state.schedule;
    const fingerprint = stable({ ownerId: incoming.ownerId, enabled: incoming.enabled, timezone: incoming.timezone, quietHours: incoming.quietHours,
      reminders: incoming.reminders.map(config), completedRoots: incoming.completedRoots, cancelledIds: incoming.cancelledIds });
    if (previous.ownerId && previous.ownerId !== incoming.ownerId && !input.takeover) return { status: 409, error: 'Different schedule owner' };
    if (previous.ownerId === incoming.ownerId && incoming.revision < previous.revision) return { status: 409, error: 'Stale revision' };
    if (previous.ownerId === incoming.ownerId && incoming.revision === previous.revision) {
      if (previous.fingerprint !== fingerprint) return { status: 409, error: 'Revision conflict' };
      server.syncClock(input.utcNow); return { status: 200 };
    }
    const next = clone(state);
    const sameOwner = previous.ownerId === incoming.ownerId;
    const changedIds = new Set(previous.reminders.filter(old => !incoming.reminders.some(r => r.id === old.id && r.enabled && config(r) === config(old))).map(r => r.id));
    const cancelled = job => incoming.completedRoots.includes(job.rootId) || incoming.cancelledIds.includes(job.id) || changedIds.has(job.reminderId);
    const priorDeferred = sameOwner ? previous.deferred : [];
    const merged = [...priorDeferred, ...incoming.deferred.filter(job => !priorDeferred.some(old => old.id === job.id))]
      .filter(job => !cancelled(job) && job.outcome === 'pending' && !(sameOwner && previous.history.some(old => old.id === job.id)));
    if (merged.length > 24) return { status: 429, error: 'Deferred queue full' };
    for (const job of next.schedule.history) if (incoming.completedRoots.includes(job.rootId)) {
      job.outcome = 'completed'; job.completedAt ??= input.utcNow;
    }
    next.pending = next.pending.filter(notice => {
      const job = previous.history.find(j => j.id === notice.id);
      return !job || (sameOwner && !cancelled(job));
    });
    next.schedule = { ...incoming, deferred: merged, history: sameOwner ? next.schedule.history : [], fingerprint,
      reminders: incoming.reminders.map(reminder => {
        const old = sameOwner && previous.timezone === incoming.timezone && previous.reminders.find(r => r.id === reminder.id && config(r) === config(reminder));
        return old ? { ...reminder, nextDue: old.nextDue } : reminder;
      }) };
    delete next.schedule.completedRoots; delete next.schedule.cancelledIds;
    commit(next); server.syncClock(input.utcNow);
    return { status: 200 };
  };
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ protocol, ...body })); };
    if (req.headers.authorization !== 'Bearer ' + token) return json(401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/api/health') return json(200, {
      name: 'Masa simulator', firmware: 'simulator', pending: state.pending.length, eventsPending: state.events.length,
      ...(protocol === 4 ? { cron, autonomous: state.schedule.enabled, timeValid, ownerId: state.schedule.ownerId, revision: state.schedule.revision, scheduleMaxTimestamp: 4102444800000 } : {}) });
    if (protocol >= 3 && req.method === 'GET' && req.url === '/api/events') return json(200, { events: state.events });
    if (protocol === 4 && req.method === 'GET' && req.url === '/api/schedule') return json(200, responseSchedule());
    const ack = protocol >= 3 && req.url === '/api/events/ack';
    const schedule = protocol === 4 && req.url === '/api/schedule';
    if (req.method !== 'POST' || (!ack && !schedule && req.url !== '/api/notify')) return json(404, { error: 'Not found' });
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > (schedule ? 32768 : ack ? 2048 : 1024)) return json(413, { error: 'Payload too large' }); }
      const input = JSON.parse(body);
      if (schedule) { const result = applySchedule(input); return json(result.status, result.error ? { error: result.error } : { ...responseSchedule(), accepted: true }); }
      if (ack) {
        if (!Array.isArray(input.ids) || input.ids.length > 16 || input.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) return json(400, { error: 'Invalid acknowledgement' });
        const next = clone(state); next.events = next.events.filter(event => !input.ids.includes(event.id));
        if (next.events.length !== state.events.length) commit(next);
        return json(200, { acknowledged: input.ids });
      }
      const notice = input;
      if (!validId(notice.id) || typeof notice.title !== 'string' || !notice.title.trim() || Buffer.byteLength(notice.title) > 320 || !['chime', 'none'].includes(notice.melody)) return json(400, { error: 'Invalid notification' });
      if (protocol === 4 && state.schedule.enabled && !notice.id.startsWith('test-') && !notice.id.startsWith('usb-test-')) return json(409, { error: 'Device owns scheduling' });
      const duplicate = known(state, notice.id);
      if (!duplicate) {
        if (state.pending.length >= 8) return json(429, { error: 'Queue full' });
        const next = clone(state); next.pending.push(notice); commit(next); onNotice(notice);
      }
      json(200, { id: notice.id, accepted: true, duplicate });
    } catch (error) { json(error.message === 'Persistence failed' ? 507 : 400, { error: error.message }); }
  });
  server.syncClock = (timestamp = clock()) => { if (!validMillis(timestamp)) throw new Error('Invalid clock'); clockOffset = timestamp - clock(); timeValid = true; };
  server.tick = () => {
    if (protocol !== 4 || !timeValid || !state.schedule.enabled) return [];
    const timestamp = now(), next = clone(state), notices = [];
    inZone(next.schedule.timezone, timestamp, () => {
      const enqueue = job => {
        if (known(next, job.id)) return true;
        if (next.pending.length >= 8 || !appendHistory(next, { ...job, status: 'delivered' })) return false;
        const notice = { id: job.id, title: job.title, melody: isQuietAt(next.schedule.quietHours, timestamp) ? 'none' : job.melody };
        next.pending.push(notice); notices.push(notice); return true;
      };
      next.schedule.deferred = next.schedule.deferred.filter(job => {
        if (job.expiresAt <= timestamp || job.outcome !== 'pending') return false;
        return job.due > timestamp || !enqueue(job);
      });
      for (const reminder of next.schedule.reminders) {
        if (!reminder.enabled || reminder.nextDue === null || reminder.nextDue > timestamp) continue;
        const due = latestDue(reminder, reminder.nextDue, timestamp);
        const id = reminder.id + ':' + due;
        if (due !== null && !enqueue({ id, rootId: id, reminderId: reminder.id, title: reminder.title, melody: reminder.melody,
          due, expiresAt: due + DAY, status: 'delivered', outcome: 'pending' })) continue;
        reminder.nextDue = nextAfter(reminder, timestamp);
      }
    });
    if (stable(next) !== stable(state)) commit(next);
    for (const notice of notices) onNotice(notice);
    return clone(notices);
  };
  // Test/terminal control mirrors a device button; it is not an HTTP API.
  server.recordAction = (notificationId, action) => {
    if (action !== null && (protocol < 3 || !['completed', 'snoozed'].includes(action))) throw new Error('Invalid action');
    if (!state.pending.some(n => n.id === notificationId)) throw new Error('Notification not pending');
    if (action && state.events.length >= 16) throw new Error('Event queue full');
    const next = clone(state), job = next.schedule.history.find(j => j.id === notificationId);
    const event = action ? { id: randomBytes(16).toString('hex'), notificationId, action, ...(action === 'snoozed' ? { minutes: 15 } : {}) } : null;
    if (job && event) {
      if (!timeValid) throw new Error('Clock is not trusted');
      if (action === 'completed') {
        for (const member of next.schedule.history.filter(j => j.rootId === job.rootId)) { member.outcome = 'completed'; member.completedAt ??= now(); }
        next.schedule.deferred = next.schedule.deferred.filter(j => j.rootId !== job.rootId);
        next.pending = next.pending.filter(n => !next.schedule.history.some(j => j.id === n.id && j.rootId === job.rootId));
      } else {
        if (next.schedule.deferred.length >= 24) throw new Error('Deferred queue full');
        const due = now() + 15 * 60000;
        const deferred = { id: 'snooze-' + event.id, rootId: job.rootId, reminderId: job.reminderId, title: job.title, melody: job.melody,
          due, expiresAt: due + DAY, status: 'queued', outcome: 'pending' };
        job.outcome = 'snoozed'; job.snoozedTo = deferred.id;
        next.schedule.deferred.push(deferred); event.deferred = clone(deferred);
      }
      event.job = clone(job);
    }
    if (event) next.events.push(event);
    next.pending = next.pending.filter(n => n.id !== notificationId);
    next.recent = [...next.recent, notificationId].slice(-32); commit(next);
    return clone(event);
  };
  server.snapshot = () => clone(state);
  return server;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || 8787);
  const server = createSimulator();
  server.listen(port, '127.0.0.1', () => console.log(`Cihaz simülatörü: http://127.0.0.1:${port}\nAnahtar: DEVICE_TOKEN ortam değişkeni veya local-simulator-token-12345678\nDüğme: done <id>, snooze <id>, close <id>`));
  const timer = setInterval(() => { try { server.tick(); } catch (error) { console.error(error.message); } }, 1000); timer.unref();
  createInterface({ input: process.stdin }).on('line', line => {
    const [command, id] = line.trim().split(/\s+/);
    try {
      if (!['done', 'snooze', 'close'].includes(command)) throw new Error('done, snooze veya close ve bildirim kimliği kullan.');
      console.log(server.recordAction(id, command === 'close' ? null : command === 'done' ? 'completed' : 'snoozed') || 'Bildirim kapatıldı.');
    } catch (error) { console.error(error.message); }
  });
}
