// Calendar arithmetic deliberately uses the computer's local time zone.
// txiki.js has Date but no Intl. Do not replace calendar days with 24h offsets.
export const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60000;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const clockMinutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
const dateText = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Geçerli bir tarih seç.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (year < 2000 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    throw new Error('Geçerli bir tarih seç.');
  return date;
}
// Use calendar serials so weeks do not change length at daylight-saving boundaries.
const calendarSerial = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
const mondaySerial = date => calendarSerial(date) - (date.getDay() + 6) % 7;
function activeWeek(reminder, date) {
  if ((reminder.weekInterval ?? 1) === 1) return true;
  return (mondaySerial(date) - mondaySerial(calendarDate(reminder.anchorDate))) % 14 === 0;
}

export function validateReminder(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || [...title].length > 80 || /[\x00-\x1f\x7f]/.test(title))
    throw new Error('Başlık 1–80 karakter olmalı ve tek satırdan oluşmalı.');
  if (!['once', 'daily', 'weekly', 'monthly', 'interval'].includes(input.frequency))
    throw new Error('Geçerli bir tekrar seç.');
  const time = input.frequency === 'interval' ? (input.time ?? '09:00') : input.time;
  if (!CLOCK.test(time)) throw new Error('Geçerli bir saat seç (00:00–23:59).');
  const weekdays = [...new Set(input.weekdays ?? (input.frequency === 'interval' ? [0, 1, 2, 3, 4, 5, 6] : []))].sort();
  if (['weekly', 'interval'].includes(input.frequency) && (!weekdays.length || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)))
    throw new Error('Tekrar için en az bir geçerli gün seç.');
  if (input.frequency === 'monthly' && (!Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31))
    throw new Error('Ayın günü 1–31 arasında olmalı.');
  if (!['chime', 'none'].includes(input.melody)) throw new Error('Kısa melodi veya sessiz seç.');
  let scheduledAt = null;
  if (input.frequency === 'once') {
    const date = calendarDate(input.onceDate);
    const [hour, minute] = time.split(':').map(Number);
    scheduledAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime();
  }
  const recurrence = {};
  if (input.frequency === 'weekly') {
    const weekInterval = input.weekInterval ?? 1;
    if (![1, 2].includes(weekInterval)) throw new Error('Hafta aralığı 1 veya 2 olmalı.');
    const anchorDate = input.anchorDate ?? dateText(new Date());
    calendarDate(anchorDate);
    Object.assign(recurrence, { weekInterval, anchorDate });
  }
  if (input.frequency === 'interval') {
    const intervalMinutes = input.intervalMinutes;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)
      throw new Error('Tekrar aralığı 1–10080 dakika olmalı.');
    const anchorAt = input.anchorAt ?? Date.now();
    if (!Number.isSafeInteger(anchorAt) || anchorAt < 0 || !Number.isFinite(new Date(anchorAt).getTime()))
      throw new Error('Geçerli bir başlangıç zamanı seç.');
    const workStart = input.workStart ?? '', workEnd = input.workEnd ?? '';
    if ((workStart || workEnd) && (!CLOCK.test(workStart) || !CLOCK.test(workEnd) || clockMinutes(workStart) >= clockMinutes(workEnd)))
      throw new Error('Çalışma saatlerinde başlangıç bitişten önce olmalı.');
    Object.assign(recurrence, { intervalMinutes, anchorAt, workStart, workEnd });
    if (!workStart && weekdays.length < 7) intervalAfter({ ...recurrence, weekdays }, anchorAt - 1);
  }
  return { title, frequency: input.frequency, time,
    ...(input.frequency === 'once' ? { onceDate: input.onceDate, scheduledAt } : {}),
    ...recurrence, weekdays: ['weekly', 'interval'].includes(input.frequency) ? weekdays : [],
    monthDay: input.frequency === 'monthly' ? input.monthDay : 1,
    melody: input.melody, enabled: input.enabled !== false };
}

// This is the shared wire recurrence shape. Engine adds id and nextDue.
export function normalizeDeviceReminder(reminder) { return validateReminder(reminder); }

function intervalAfter(reminder, after) {
  const interval = reminder.intervalMinutes * MINUTE;
  const days = reminder.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
  if (!reminder.workStart && days.length === 7) {
    return reminder.anchorAt + Math.max(0, Math.floor((after - reminder.anchorAt) / interval) + 1) * interval;
  }
  const base = new Date(Math.max(after, reminder.workStart ? after : reminder.anchorAt - 1));
  // At most two years of calendar days; avoids an endless search for incompatible
  // anchor/weekday combinations (e.g. every 7 days on Monday, Tuesdays only).
  for (let offset = 0; offset < 732; offset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
    if (!days.includes(day.getDay())) continue;
    let start = day.getTime(), end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    let anchor = reminder.anchorAt;
    if (reminder.workStart) {
      const [sh, sm] = reminder.workStart.split(':').map(Number), [eh, em] = reminder.workEnd.split(':').map(Number);
      start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm).getTime();
      end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em).getTime();
      anchor = start;
    }
    const candidate = anchor + Math.max(0, Math.ceil((start - anchor) / interval), Math.floor((after - anchor) / interval) + 1) * interval;
    if (candidate >= start && candidate < end && candidate > after) return candidate;
  }
  throw new Error('Seçilen günlerde bu aralığa uygun bir hatırlatma bulunamadı.');
}

export function nextAfter(reminder, after) {
  if (reminder.frequency === 'once') return reminder.scheduledAt > after ? reminder.scheduledAt : null;
  if (reminder.frequency === 'interval') return intervalAfter(reminder, after);
  const base = new Date(after);
  const [hour, minute] = reminder.time.split(':').map(Number);
  if (reminder.frequency === 'monthly') {
    for (let offset = 0; offset < 3; offset++) {
      const year = base.getFullYear(), month = base.getMonth() + offset;
      const last = new Date(year, month + 1, 0).getDate();
      const candidate = new Date(year, month, Math.min(reminder.monthDay, last), hour, minute);
      if (candidate.getTime() > base.getTime()) return candidate.getTime();
    }
  } else {
    for (let offset = 0; offset < 16; offset++) {
      const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hour, minute);
      if (reminder.frequency === 'weekly' && (!reminder.weekdays.includes(candidate.getDay()) || !activeWeek(reminder, candidate))) continue;
      if (candidate.getTime() > base.getTime()) return candidate.getTime();
    }
  }
  throw new Error('Bir sonraki hatırlatma hesaplanamadı.');
}

export function latestDue(reminder, firstDue, now) {
  if (firstDue === null || firstDue > now) return null;
  if (reminder.frequency === 'once') return firstDue > now - DAY ? firstDue : null;
  if (reminder.frequency === 'interval') {
    const interval = reminder.intervalMinutes * MINUTE;
    if (!reminder.workStart) {
      const due = reminder.anchorAt + Math.floor((now - reminder.anchorAt) / interval) * interval;
      // The grace window spans at most two local dates; inspect arithmetic slots
      // by date instead of replaying every missed minute since the anchor.
      if ((reminder.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(new Date(due).getDay()) && due >= firstDue && due > now - DAY) return due;
    }
    const boundary = Math.max(firstDue - 1, now - DAY);
    const base = new Date(now);
    let latest = null;
    for (let offset = -2; offset <= 0; offset++) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
      if (!(reminder.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(day.getDay())) continue;
      let start = day.getTime(), end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(), anchor = reminder.anchorAt;
      if (reminder.workStart) {
        const [sh, sm] = reminder.workStart.split(':').map(Number), [eh, em] = reminder.workEnd.split(':').map(Number);
        start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm).getTime();
        end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em).getTime();
        anchor = start;
      }
      const due = anchor + Math.floor((Math.min(now, end - 1) - anchor) / interval) * interval;
      if (due >= anchor && due >= start && due > boundary && (latest === null || due > latest)) latest = due;
    }
    return latest;
  }
  // Calendar schedules have at most two occurrences within the grace window.
  let due = nextAfter(reminder, Math.max(firstDue - 1, now - DAY));
  let latest = null;
  while (due <= now) { latest = due; due = nextAfter(reminder, due); }
  return latest;
}

export function validateQuietHours(settings = {}) {
  if (!settings || typeof settings !== 'object' ||
    (settings.quietEnabled !== undefined && typeof settings.quietEnabled !== 'boolean') ||
    (settings.quietStart !== undefined && typeof settings.quietStart !== 'string') ||
    (settings.quietEnd !== undefined && typeof settings.quietEnd !== 'string'))
    throw new Error('Sessiz saatler için geçerli ayarlar seç.');
  const quietEnabled = settings.quietEnabled === true;
  const quietStart = settings.quietStart ?? '22:00', quietEnd = settings.quietEnd ?? '08:00';
  if (!CLOCK.test(quietStart) || !CLOCK.test(quietEnd) || (quietEnabled && quietStart === quietEnd))
    throw new Error('Sessiz saatler için farklı geçerli başlangıç ve bitiş saatleri seç.');
  return { quietEnabled, quietStart, quietEnd };
}

export function isQuietAt(settings, timestamp) {
  if (!settings?.quietEnabled) return false;
  const { quietStart, quietEnd } = validateQuietHours(settings);
  const date = new Date(timestamp), minute = date.getHours() * 60 + date.getMinutes();
  const start = clockMinutes(quietStart), end = clockMinutes(quietEnd);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function posixOffset(minutes) {
  const sign = minutes < 0 ? '-' : '';
  const value = Math.abs(minutes), h = Math.floor(value / 60), m = value % 60;
  return `${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
function zoneYear(year) {
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  const changes = [], offsets = new Set([new Date(start).getTimezoneOffset()]);
  let previous = start, oldOffset = new Date(start).getTimezoneOffset();
  for (let tick = start + 12 * 3600000; tick <= end; tick += 12 * 3600000) {
    const offset = new Date(tick).getTimezoneOffset();
    offsets.add(offset);
    if (offset !== oldOffset) {
      let lo = previous, hi = tick;
      while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (new Date(mid).getTimezoneOffset() === oldOffset) lo = mid; else hi = mid; }
      const at = Math.ceil(hi / 1000) * 1000;
      // POSIX rules describe the wall clock immediately before the transition.
      const wall = new Date(at - oldOffset * MINUTE);
      const d = wall.getUTCDate(), month = wall.getUTCMonth(), last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const week = d + 7 > last ? 5 : Math.floor((d - 1) / 7) + 1;
      const h = wall.getUTCHours(), m = wall.getUTCMinutes(), s = wall.getUTCSeconds();
      const clock = `${h}${m || s ? `:${String(m).padStart(2, '0')}` : ''}${s ? `:${String(s).padStart(2, '0')}` : ''}`;
      changes.push({ from: oldOffset, to: offset, rule: `M${month + 1}.${week}.${wall.getUTCDay()}/${clock}` });
      oldOffset = offset;
    }
    previous = tick;
  }
  return { offsets: [...offsets].sort((a, b) => a - b), changes };
}

// Firmware's C library accepts POSIX TZ, whereas the desktop only exposes Date.
// Confirm two consecutive annual patterns; reject political/irregular rules
// rather than silently sending a timezone that will fire reminders incorrectly.
export function deviceTimezone(now = Date.now()) {
  const year = new Date(now).getFullYear();
  if (!Number.isFinite(year)) throw new Error('Geçerli bir zaman seç.');
  const first = zoneYear(year), second = zoneYear(year + 1);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Bu saat diliminin değişken kuralları cihazda desteklenmiyor.');
  if (first.offsets.length === 1 && !first.changes.length) return `STD${posixOffset(first.offsets[0])}`;
  if (first.offsets.length !== 2 || first.changes.length !== 2) throw new Error('Bu saat diliminin değişken kuralları cihazda desteklenmiyor.');
  const [dst, std] = first.offsets;
  const enter = first.changes.find(change => change.from === std && change.to === dst);
  const leave = first.changes.find(change => change.from === dst && change.to === std);
  if (!enter || !leave) throw new Error('Bu saat dilimi cihazda desteklenmiyor.');
  return `STD${posixOffset(std)}DST${posixOffset(dst)},${enter.rule},${leave.rule}`;
}
