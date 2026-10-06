import { validateQuietHours } from './schedule.js';

// Only portable preferences are returned; device credentials and runtime state
// never cross this boundary, even when a historic state contains extra fields.
export function validateSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Hatırlatıcı ayarları geçersiz.');
  const quietHours = validateQuietHours(input);
  const displayAlwaysOn = input.displayAlwaysOn ?? false;
  if ((input.displayAlwaysOn !== undefined && typeof input.displayAlwaysOn !== 'boolean'))
    throw new Error('Ekranın sürekli açık kalma ayarı geçersiz.');
  const bounds = {
    displaySleepMinutes: [1, 1440, 2],
    displayWakeBeforeMinutes: [0, 1440, 10],
    displayWakeAfterMinutes: [0, 1440, 10]
  };
  const display = { displayAlwaysOn };
  for (const [key, [minimum, maximum, defaultValue]] of Object.entries(bounds)) {
    const value = input[key] === undefined ? defaultValue : input[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`Ekran süreleri ${minimum}–${maximum} arasında tam dakika olmalı.`);
    display[key] = value;
  }
  return { ...quietHours, ...display };
}

export function deviceDisplaySettings(settings = {}) {
  const normalized = validateSettings(settings);
  return { alwaysOn: normalized.displayAlwaysOn, sleepMinutes: normalized.displaySleepMinutes,
    wakeBeforeMinutes: normalized.displayWakeBeforeMinutes, wakeAfterMinutes: normalized.displayWakeAfterMinutes };
}
