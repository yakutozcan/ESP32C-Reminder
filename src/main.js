import { ReminderEngine, newState } from './core/engine.js';
import { requestDevice } from './core/device.js';

let engine;
let ready;
let appHandle;
let busy = false;
let lastError = '';
let connection = { status: 'unknown', checkedAt: null };
async function getEngine() {
  if (!ready) throw new Error('Uygulama başlatılıyor; bir saniye sonra tekrar dene.');
  await ready;
  return engine;
}
async function snapshot() {
  const state = (await getEngine()).snapshot();
  return { ...state, connection, lastError, now: Date.now(), localOffset: new Date().getTimezoneOffset() };
}
export const api = {
  snapshot,
  async saveReminder(input) { await (await getEngine()).saveReminder(input); return snapshot(); },
  async removeReminder({ id }) { await (await getEngine()).removeReminder(id); return snapshot(); },
  async saveDevice(input) { await (await getEngine()).setDevice(input); connection = { status: 'unknown', checkedAt: null }; return snapshot(); },
  async checkDevice() {
    const e = await getEngine();
    const device = e.snapshot().device;
    let result;
    try {
      const health = await requestDevice(device, '/api/health');
      result = { ...health, status: 'online', checkedAt: Date.now() };
    } catch (error) { result = { status: 'offline', checkedAt: Date.now(), error: error.message }; }
    if (e.state.device.url === device.url && e.state.device.token === device.token) connection = result;
    return snapshot();
  },
  async testDevice() {
    const result = await (await getEngine()).testDevice();
    connection = { status: 'online', checkedAt: Date.now() };
    return result;
  },
  async launchAtLogin({ enabled }) {
    await appHandle.launchAtLogin.set(enabled);
    return appHandle.launchAtLogin.get();
  },
  async loginStatus() { return appHandle.launchAtLogin.get(); }
};
async function cycle() {
  if (busy) return;
  busy = true;
  try {
    await (await getEngine()).tick();
    lastError = '';
    await appHandle.push('state', await snapshot());
  } catch (error) {
    lastError = error.message;
    console.error('Scheduler:', error.message);
    try { await appHandle.push('state', await snapshot()); } catch {}
  } finally { busy = false; }
}
export function init(app) {
  appHandle = app;
  ready = (async () => {
    const saved = await app.store.get('reminder-state');
    engine = new ReminderEngine({ state: saved ?? newState(),
      persist: state => app.store.set('reminder-state', state),
      send: (device, job) => requestDevice(device, '/api/notify', job),
      notify: title => app.notify({ title: 'Masa', body: title }) });
    if (saved?.version === 1) {
      if (await app.store.get('reminder-state-v1-backup') == null &&
          await app.store.set('reminder-state-v1-backup', saved) === false)
        throw new Error('Eski hatırlatıcıların yedeği kaydedilemedi.');
      await engine.commit(engine.snapshot());
    }
    await app.setHideOnClose(true);
    await app.tray.set({ title: 'Masa', tooltip: 'Masa hatırlatıcı çalışıyor',
      menu: [{ id: 'show', label: 'Ajandayı aç' }, { separator: true }, { id: 'quit', label: 'Masa’dan çık' }] });
  })();
  ready.then(() => { cycle(); setInterval(cycle, 1000); }).catch(error => {
    console.error(error.message);
    app.push('fatal', error.message);
  });
}
export function onTray(id, app) { if (id === 'quit') app.quit(); else app.show(); }
export function onSystem(kind) { if (kind === 'wake') cycle(); }
