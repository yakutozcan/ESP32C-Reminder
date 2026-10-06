import { validateReminder, validateQuietHours } from './schedule.js';

export const BACKUP_FORMAT = 'masa-reminders';
export const MAX_BACKUP_BYTES = 1024 * 1024;

function preferences(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      (settings.quietEnabled !== undefined && typeof settings.quietEnabled !== 'boolean') ||
      ['quietStart', 'quietEnd'].some(key => settings[key] !== undefined && typeof settings[key] !== 'string'))
    throw new Error('Yedekteki sessiz saat ayarları geçersiz.');
  return validateQuietHours(settings);
}

function definitions(reminders, legacy = false) {
  if (!Array.isArray(reminders) || reminders.length > 100)
    throw new Error('Yedekte en fazla 100 hatırlatıcı bulunabilir.');
  const ids = new Set();
  return reminders.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) || ids.has(entry.id))
      throw new Error('Yedekte geçersiz veya tekrar eden hatırlatıcı kimliği var.');
    ids.add(entry.id);
    let value = entry;
    if (legacy) {
      if (!Number.isInteger(entry.vibrationMs) || entry.vibrationMs < 0 || entry.vibrationMs > 5000)
        throw new Error('Eski yedekteki ses ayarı okunamadı.');
      value = { ...entry, melody: entry.vibrationMs === 0 ? 'none' : 'chime' };
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
      throw new Error('Yedekteki etkinlik ayarı geçersiz.');
    return { id: entry.id, ...validateReminder(value) };
  });
}

// Only portable definitions and user preferences cross the export boundary.
export function createBackup(state, now = Date.now()) {
  return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date(now).toISOString(),
    reminders: definitions(state.reminders), settings: preferences(state.settings) };
}

export function parseBackup(input) {
  let data = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BACKUP_BYTES) throw new Error('Yedek dosyası 1 MB sınırını aşıyor.');
    try { data = JSON.parse(input); } catch { throw new Error('Yedek dosyası geçerli bir JSON dosyası değil.'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Yedek biçimi desteklenmiyor.');
  const portable = data.format === BACKUP_FORMAT;
  const historic = data.format === undefined && [1, 2, 3, 4, 5].includes(data.version) && Array.isArray(data.jobs);
  if (portable ? data.version !== 1 : !historic) throw new Error('Yedek biçimi veya sürümü desteklenmiyor.');
  return { reminders: definitions(data.reminders, historic && data.version === 1),
    settings: preferences(data.settings) };
}
