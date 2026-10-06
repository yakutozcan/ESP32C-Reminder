import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, deviceDisplaySettings } from '../src/core/settings.js';

const defaults = { quietEnabled: false, quietStart: '22:00', quietEnd: '08:00', displayAlwaysOn: false,
  displaySleepMinutes: 2, displayWakeBeforeMinutes: 10, displayWakeAfterMinutes: 10 };

test('settings default existing quiet preferences and screen behavior independently', () => {
  assert.deepEqual(validateSettings(), defaults);
  assert.deepEqual(validateSettings({ quietEnabled: true, quietStart: '23:00', quietEnd: '07:00' }),
    { ...defaults, quietEnabled: true, quietStart: '23:00', quietEnd: '07:00' });
  assert.deepEqual(validateSettings({ displaySleepMinutes: 5 }), { ...defaults, displaySleepMinutes: 5 });
});

test('screen bounds allow zero wake windows, one-minute sleep and a full day', () => {
  assert.deepEqual(validateSettings({ displayAlwaysOn: true, displaySleepMinutes: 1, displayWakeBeforeMinutes: 0, displayWakeAfterMinutes: 0 }),
    { ...defaults, displayAlwaysOn: true, displaySleepMinutes: 1, displayWakeBeforeMinutes: 0, displayWakeAfterMinutes: 0 });
  assert.deepEqual(deviceDisplaySettings({ displaySleepMinutes: 1440, displayWakeBeforeMinutes: 1440, displayWakeAfterMinutes: 1440 }),
    { alwaysOn: false, sleepMinutes: 1440, wakeBeforeMinutes: 1440, wakeAfterMinutes: 1440 });
});

test('settings reject invalid object, boolean, integer and quiet-hour types', () => {
  for (const input of [null, false, 2, 'settings', [], { displayAlwaysOn: null }, { displayAlwaysOn: 1 },
    { displayAlwaysOn: 'false' }, { quietEnabled: 'true' }, { quietStart: 22 },
    { quietEnabled: true, quietStart: '08:00', quietEnd: '08:00' }]) assert.throws(() => validateSettings(input));
  for (const key of ['displaySleepMinutes', 'displayWakeBeforeMinutes', 'displayWakeAfterMinutes']) {
    for (const value of [-1, 1441, 1.5, '2', true, null, NaN, Infinity]) assert.throws(() => validateSettings({ [key]: value }), `${key}: ${value}`);
  }
  assert.throws(() => validateSettings({ displaySleepMinutes: 0 }));
});

test('device display projection and portable normalization omit unknown keys without mutating input', () => {
  const input = { quietEnabled: true, displayAlwaysOn: true, displaySleepMinutes: 5,
    displayWakeBeforeMinutes: 15, displayWakeAfterMinutes: 20, token: 'private', runtime: { awake: 123 } };
  const before = JSON.stringify(input);
  assert.deepEqual(validateSettings(input), { ...defaults, quietEnabled: true, displayAlwaysOn: true,
    displaySleepMinutes: 5, displayWakeBeforeMinutes: 15, displayWakeAfterMinutes: 20 });
  assert.deepEqual(deviceDisplaySettings(input), { alwaysOn: true, sleepMinutes: 5, wakeBeforeMinutes: 15, wakeAfterMinutes: 20 });
  assert.deepEqual(deviceDisplaySettings(), { alwaysOn: false, sleepMinutes: 2, wakeBeforeMinutes: 10, wakeAfterMinutes: 10 });
  assert.equal(JSON.stringify(input), before);
});
