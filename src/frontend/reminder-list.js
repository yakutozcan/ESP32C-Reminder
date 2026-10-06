const textKey = value => value.normalize('NFC').toLocaleLowerCase('tr-TR');

export function reminderTags(reminders) {
  const tags = new Map();
  for (const reminder of reminders) for (const tag of reminder.tags || []) {
    const key = textKey(tag);
    if (!tags.has(key)) tags.set(key, tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b, 'tr'));
}

export function filterReminders(reminders, { query = '', status = 'all', frequency = 'all', tag = '', today = false, now = Date.now() } = {}) {
  const search = textKey(query.trim());
  return reminders.filter(r =>
    (!search || textKey(r.title).includes(search)) &&
    (status === 'all' || (status === 'enabled' ? r.enabled : !r.enabled)) &&
    (frequency === 'all' || r.frequency === frequency) &&
    (!tag || (tag === 'untagged' ? !r.tags?.length : (r.tags || []).some(value => textKey(value) === textKey(tag.slice(4))))) &&
    (!today || r.enabled && r.nextDue !== null && new Date(r.nextDue).toDateString() === new Date(now).toDateString())
  ).sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextDue ?? Infinity) - (b.nextDue ?? Infinity));
}
