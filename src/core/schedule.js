// Calendar arithmetic deliberately uses the computer's local time zone.
// txiki.js has Date but no Intl. Do not replace calendar days with 24h offsets.
export const DAY = 24 * 60 * 60 * 1000;

export function validateReminder(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || [...title].length > 80 || /[\x00-\x1f\x7f]/.test(title))
    throw new Error('Başlık 1–80 karakter olmalı ve tek satırdan oluşmalı.');
  if (!['daily', 'weekly', 'monthly'].includes(input.frequency))
    throw new Error('Günlük, haftalık veya aylık tekrar seç.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    throw new Error('Geçerli bir saat seç (00:00–23:59).');
  const weekdays = [...new Set(input.weekdays ?? [])].sort();
  if (input.frequency === 'weekly' && (!weekdays.length || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)))
    throw new Error('Haftalık tekrar için en az bir gün seç.');
  if (input.frequency === 'monthly' && (!Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31))
    throw new Error('Ayın günü 1–31 arasında olmalı.');
  if (!['chime', 'none'].includes(input.melody))
    throw new Error('Kısa melodi veya sessiz seç.');
  return { title, frequency: input.frequency, time: input.time,
    weekdays: input.frequency === 'weekly' ? weekdays : [],
    monthDay: input.frequency === 'monthly' ? input.monthDay : 1,
    melody: input.melody, enabled: input.enabled !== false };
}

export function nextAfter(reminder, after) {
  const base = new Date(after);
  const [hour, minute] = reminder.time.split(':').map(Number);
  if (reminder.frequency === 'monthly') {
    for (let offset = 0; offset < 3; offset++) {
      const year = base.getFullYear();
      const month = base.getMonth() + offset;
      const last = new Date(year, month + 1, 0).getDate();
      const candidate = new Date(year, month, Math.min(reminder.monthDay, last), hour, minute);
      if (candidate.getTime() > base.getTime()) return candidate.getTime();
    }
  } else {
    for (let offset = 0; offset < 9; offset++) {
      const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hour, minute);
      if (reminder.frequency === 'weekly' && !reminder.weekdays.includes(candidate.getDay())) continue;
      if (candidate.getTime() > base.getTime()) return candidate.getTime();
    }
  }
  throw new Error('Bir sonraki hatırlatma hesaplanamadı.');
}

export function latestDue(reminder, firstDue, now) {
  if (firstDue > now) return null;
  // Collapse missed repeats to the most recent occurrence within the grace window.
  let due = nextAfter(reminder, Math.max(firstDue - 1, now - DAY));
  let latest = null;
  while (due <= now) {
    latest = due;
    due = nextAfter(reminder, due);
  }
  return latest;
}
