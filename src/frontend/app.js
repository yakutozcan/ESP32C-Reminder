const $ = selector => document.querySelector(selector);
const form = $('#reminder-form');
const deviceForm = $('#device-form');
const snoozeForm = $('#snooze-form');
const preferencesForm = $('#preferences-form');
const importForm = $('#import-form');
const api = (method, params = {}) => {
  if (!globalThis.tiny) return Promise.reject(new Error('Masa’yı tinyjs dev ile aç. Tarayıcı önizlemesi cihaza bağlanmaz.'));
  return tiny.api.call(method, params);
};
let state;
let view = 'all';
let filter = 'all';
let editId;
let snoozeId;
let mutationBusy = false;
let renderedState = '';
let importText = '';
let previewTimer;
let previewGeneration = 0;
const simpleIntervals = { hourly: 60, two_hourly: 120 };
const weekdays = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
const frequency = { once: 'Tek seferlik', daily: 'Her gün', weekly: 'Her hafta', monthly: 'Her ay', interval: 'Aralıklı', cron: 'Cron' };
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateText = value => new Date(value).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const localDate = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');

function toast(message, undo) {
  const el = $('#toast');
  el.hidden = false;
  el.querySelector('span').textContent = message;
  const button = el.querySelector('button');
  button.hidden = !undo;
  button.onclick = async () => { el.hidden = true; try { await undo(); } catch (e) { toast(e.message); } };
}
$('.dismiss-toast').onclick = () => { $('#toast').hidden = true; };
function repeatText(r) {
  if (r.frequency === 'once') return 'Tek seferlik · ' + dateText(r.scheduledAt);
  if (r.frequency === 'cron') return 'Cron · ' + escapeHTML(r.cronExpression);
  if (r.frequency === 'weekly') return (r.weekInterval === 2 ? 'İki haftada bir · ' : '') + r.weekdays.map(d => weekdays[d]).join(', ');
  if (r.frequency === 'interval') return `${r.intervalMinutes % 60 === 0 ? r.intervalMinutes / 60 + ' saatte' : r.intervalMinutes + ' dakikada'} bir` + (r.weekdays.length < 7 ? ' · ' + r.weekdays.map(d => weekdays[d]).join(', ') : '') + (r.workStart ? ` · ${r.workStart}–${r.workEnd}` : '');
  if (r.frequency === 'monthly') return 'Her ayın ' + r.monthDay + '. günü';
  return frequency[r.frequency];
}
function renderScheduleStatus() {
  const scheduler = state.scheduler || {};
  const supported = state.connection.status === 'online' && Number(state.connection.protocol) >= 4;
  const desired = scheduler.desired === true;
  const pending = desired && scheduler.revision !== scheduler.syncedRevision;
  $('#autonomous-toggle').checked = desired;
  $('#autonomous-toggle').disabled = !desired && !supported;
  $('#sync-schedule').disabled = !supported || (!desired && scheduler.mode !== 'device');
  $('#takeover-schedule').hidden = !supported || !scheduler.error || !/başka|sahip|devret/i.test(scheduler.error);
  $('#takeover-note').hidden = $('#takeover-schedule').hidden;
  $('#schedule-result').textContent = scheduler.error || (desired && scheduler.timeValid === false ? 'Cihazın saati hazır değil. Hatırlatmalar saat eşitlenene kadar bekler; bağlantıyı ve cihazın gücünü kontrol et.' : !supported ? 'Bağımsız çalışma için cihazı bağla ve cihaz yazılımını 0.6.0 veya daha yeni sürüme güncelle.' : pending ? 'Takvim değişiklikleri aktarılmayı bekliyor. Son aktarılan takvim cihazda çalışmaya devam eder.' : scheduler.mode === 'device' ? 'Takvim cihaza aktarıldı. Bilgisayar kapalıyken de hatırlatır.' : 'Hatırlatmaları şu anda bilgisayar başlatıyor.');
}
function render() {
  if (!state) return;
  const key = JSON.stringify([view, filter, state.reminders, state.jobs, state.connection, state.scheduler, state.settings, state.lastError, Math.floor(state.now / 60000), new Date().toDateString()]);
  if (key === renderedState) return;
  renderedState = key;
  $('#today-label').textContent = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#zone-label').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone + ' · yerel saat';
  $('#nav-count').textContent = state.reminders.length;
  const online = state.connection.status === 'online';
  $('#open-device').classList.toggle('online', online);
  $('#sidebar-status').textContent = !state.device.url ? 'Bağlantı ayarlanmadı' : online ? 'Bağlı · Wi-Fi' : state.connection.status === 'offline' ? 'Cihaza ulaşılamıyor' : 'Kontrol bekleniyor';
  $('#device-result').textContent = state.connection.error || (online ? 'Bağlantı hazır. Cihaz bildirim alabilir.' + (state.connection.protocol === 2 ? ' Düğme işlemleri için cihaz yazılımını 0.3.0 sürümüne güncelle.' : '') : 'Bağlantı henüz kontrol edilmedi.');
  renderScheduleStatus();
  const queued = state.jobs.filter(j => j.status === 'queued');
  const waiting = queued.filter(j => j.due <= state.now).length;
  const snoozed = queued.length - waiting;
  $('#footer-status').textContent = state.lastError || ([waiting ? waiting + ' bildirim cihaz için bekliyor.' : '', snoozed ? snoozed + ' ertelenen bildirim zamanı bekliyor.' : ''].filter(Boolean).join(' ') || (state.scheduler?.mode === 'device' ? 'Takvim cihazda çalışıyor.' : 'Uygulama açıkken hatırlatır.'));
  $('#week-strip').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(); day.setDate(day.getDate() + i);
    const count = state.reminders.filter(r => r.enabled && sameDay(r.nextDue, day)).length;
    return `<div class="week-day ${i === 0 ? 'current' : ''}"><span>${weekdays[day.getDay()]}</span><strong>${day.getDate()}</strong><small>${count ? count + ' sıradaki' : '—'}</small></div>`;
  }).join('');
  const history = view === 'history' || view === 'completed';
  $('#page-title').textContent = view === 'completed' ? 'Bugün yaptıkların.' : view === 'history' ? 'Masana ulaşan notlar.' : view === 'today' ? 'Bugün, aklında kalmasın.' : 'Günün küçük notları.';
  $('#page-description').textContent = view === 'completed' ? 'Yapıldı olarak işaretlediğin işler burada. Tekrar takvimlerin devam eder.' : view === 'history' ? 'Teslimatları ve bekleyen bildirimleri buradan takip et.' : 'Rutinlerini bir kez yaz. Zamanı gelince masan hatırlatsın.';
  $('#filters').hidden = history;
  $('#week-strip').hidden = history;
  $('#list-heading').textContent = view === 'completed' ? 'Bugün tamamlanan işler' : view === 'history' ? 'Bildirim geçmişi' : 'Hatırlatıcılar';
  const el = $('#reminders');
  el.setAttribute('aria-busy', 'false');
  if (history) {
    const statuses = { queued: 'Bekliyor', delivered: 'Cihaz kabul etti', expired: 'Süresi doldu', cancelled: 'Teslimat iptal edildi' };
    const outcomes = { pending: 'Henüz yapılmadı', completed: 'Yapıldı', snoozed: 'Ertelendi' };
    const jobs = view === 'completed' ? [...new Map(state.jobs.filter(j => j.outcome === 'completed' && sameDay(j.completedAt, state.now)).map(j => [j.rootId, j])).values()].sort((a, b) => b.completedAt - a.completedAt) : [...state.jobs].reverse();
    $('#summary').textContent = jobs.length + (view === 'completed' ? ' iş tamamlandı' : ' bildirim');
    el.innerHTML = jobs.length ? jobs.map(j => {
      const canSnooze = j.outcome === 'pending' && ['queued', 'delivered'].includes(j.status) && j.due <= state.now && j.expiresAt > state.now && state.reminders.some(r => r.id === j.reminderId);
      const canComplete = j.outcome !== 'completed' && j.due <= state.now && (j.status !== 'cancelled' || j.outcome === 'snoozed');
      const status = j.status === 'queued' && j.due > state.now ? 'Erteleme zamanı bekleniyor' : statuses[j.status];
      const detail = view === 'completed' ? 'Yapıldı · ' + dateText(j.completedAt) + (j.actionSource === 'device' ? ' · Cihazdan aktarıldı' : '') : dateText(j.due) + ' · ' + status + ' · ' + outcomes[j.outcome];
      return `<article class="reminder-row"><div class="reminder-time">${new Date(view === 'completed' ? j.completedAt : j.due).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</div><div><h3 class="reminder-title">${escapeHTML(j.title)}</h3><p class="reminder-detail">${detail}${j.error ? ' · ' + escapeHTML(j.error) : ''}</p></div><div class="row-actions">${view === 'completed' ? '' : `<span class="reminder-detail">${j.attempts} deneme</span>`}${canComplete ? `<button data-action="complete" data-id="${escapeHTML(j.id)}" aria-label="${escapeHTML(j.title)}: yapıldı">Yaptım</button>` : ''}${canSnooze ? `<button data-action="snooze" data-id="${escapeHTML(j.id)}" aria-label="${escapeHTML(j.title)}: ertele">Ertele</button>` : ''}</div></article>`;
    }).join('') : `<div class="empty"><span class="empty-mark" aria-hidden="true">∴</span><h3>${view === 'completed' ? 'Bugün henüz tamamlanan iş yok.' : 'Henüz bildirim yok.'}</h3><p>${view === 'completed' ? 'Bildirim geçmişindeki Yaptım düğmesiyle veya cihazda çift basışla işaretle.' : 'Hatırlatıcının zamanı geldiğinde teslimat durumu burada görünür.'}</p></div>`;
    return;
  }
  const reminders = state.reminders.filter(r => (filter === 'all' || r.frequency === filter) && (view !== 'today' || r.enabled && sameDay(r.nextDue, Date.now()))).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextDue - b.nextDue);
  const enabled = state.reminders.filter(r => r.enabled).length;
  const ended = state.reminders.filter(r => r.frequency === 'once' && r.nextDue === null).length;
  $('#summary').textContent = enabled + ' etkin · ' + (state.reminders.length - enabled - ended) + ' duraklatılmış' + (ended ? ' · ' + ended + ' zamanı geçmiş' : '');
  el.innerHTML = reminders.length ? reminders.map(r => `<article class="reminder-row ${r.enabled ? '' : 'paused'}"><div class="reminder-time">${['interval', 'cron'].includes(r.frequency) ? r.nextDue ? new Date(r.nextDue).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—' : r.time}</div><div><h3 class="reminder-title">${escapeHTML(r.title)}</h3><p class="reminder-detail">${repeatText(r)} · ${r.enabled ? 'Sıradaki: ' + dateText(r.nextDue) : r.nextDue === null ? 'Takvim sona erdi' : 'Duraklatıldı'} · ${r.melody === 'chime' ? 'Kısa melodi' : 'Sessiz'}</p></div><div class="row-actions">${r.nextDue === null ? '' : `<button data-action="toggle" data-id="${escapeHTML(r.id)}" aria-label="${escapeHTML(r.title)}: ${r.enabled ? 'duraklat' : 'başlat'}">${r.enabled ? 'Duraklat' : 'Başlat'}</button>`}<button data-action="edit" data-id="${escapeHTML(r.id)}">Düzenle</button><button data-action="delete" data-id="${escapeHTML(r.id)}">Sil</button></div></article>`).join('') : `<div class="empty"><span class="empty-mark" aria-hidden="true">∴</span><h3>${state.reminders.length ? 'Bu görünümde not yok.' : 'İlk notunu bırak.'}</h3><p>${state.reminders.length ? 'Diğer tekrarları görebilir veya yeni bir hatırlatıcı ekleyebilirsin.' : 'Su içmek, bitkileri sulamak, bir mola vermek. Tekrar eden küçük işleri Masa’ya bırak.'}</p><button class="primary" data-action="add">Hatırlatıcı ekle</button></div>`;
}
function updateRecurrenceFields() {
  const selected = form.elements.frequency.value;
  const interval = selected === 'interval';
  const simple = Object.hasOwn(simpleIntervals, selected);
  const cron = selected === 'cron';
  const weekly = selected === 'weekly';
  $('#weekday-field').hidden = !weekly && !interval;
  $('#weekly-options').hidden = !weekly;
  $('#interval-field').hidden = !interval;
  $('#time-field').hidden = interval || simple || cron;
  $('#recurrence-row').classList.toggle('single-column', interval || simple || cron);
  form.elements.time.disabled = interval || simple || cron;
  form.elements.time.required = !form.elements.time.disabled;
  $('#simple-interval-note').hidden = !simple;
  $('#cron-field').hidden = !cron;
  form.elements.cronExpression.disabled = !cron;
  form.elements.cronExpression.required = cron;
  form.elements.intervalMinutes.disabled = !interval;
  form.elements.anchorDate.disabled = !weekly;
  form.elements.anchorDate.required = weekly;
  $('#work-hours-field').hidden = !interval || !form.elements.workHours.checked;
  for (const field of ['workStart', 'workEnd']) { form.elements[field].disabled = !interval || !form.elements.workHours.checked; form.elements[field].required = interval && form.elements.workHours.checked; }
  $('#monthday-field').hidden = form.elements.frequency.value !== 'monthly';
  const once = form.elements.frequency.value === 'once';
  $('#once-field').hidden = !once;
  form.elements.onceDate.disabled = !once;
  form.elements.onceDate.required = once;
  form.elements.monthDay.disabled = form.elements.frequency.value !== 'monthly';
}
function reminderInput() {
  const selected = form.elements.frequency.value;
  const simple = Object.hasOwn(simpleIntervals, selected);
  const existing = state?.reminders.find(r => r.id === editId);
  return { id: editId, title: form.elements.title.value, frequency: simple ? 'interval' : selected,
    ...(selected === 'cron' ? { cronExpression: form.elements.cronExpression.value } : { time: form.elements.time.value }),
    weekdays: simple ? [0, 1, 2, 3, 4, 5, 6] : [...$('#weekday-field').querySelectorAll('input:checked')].map(b => Number(b.value)),
    onceDate: form.elements.onceDate.value, monthDay: Number(form.elements.monthDay.value), melody: form.elements.melody.value,
    weekInterval: Number(form.elements.weekInterval.value), anchorDate: form.elements.anchorDate.value,
    intervalMinutes: simple ? simpleIntervals[selected] : Number(form.elements.intervalMinutes.value), anchorAt: existing?.anchorAt ?? Date.now(),
    ...(selected === 'interval' && form.elements.workHours.checked ? { workStart: form.elements.workStart.value, workEnd: form.elements.workEnd.value } : {}),
    enabled: existing ? existing.nextDue === null || existing.enabled : true };
}
function cancelPreview() {
  previewGeneration++; clearTimeout(previewTimer);
}
function schedulePreview() {
  cancelPreview();
  $('#cron-error').textContent = ''; $('#cron-occurrences').replaceChildren();
  form.elements.cronExpression.removeAttribute('aria-invalid');
  $('#cron-preview-status').textContent = '';
  if (form.elements.frequency.value !== 'cron' || !$('#reminder-dialog').open) return;
  const generation = previewGeneration;
  $('#cron-preview-status').textContent = 'Sıradaki zamanlar hesaplanıyor…';
  previewTimer = setTimeout(async () => {
    const reminder = reminderInput();
    try {
      const result = await api('previewSchedule', { reminder });
      if (generation !== previewGeneration || !$('#reminder-dialog').open) return;
      $('#cron-preview-status').textContent = 'Sıradaki üç hatırlatma';
      $('#cron-occurrences').innerHTML = result.occurrences.slice(0, 3).map(at => '<li>' + escapeHTML(new Date(at).toLocaleString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</li>').join('');
    } catch (error) {
      if (generation !== previewGeneration || !$('#reminder-dialog').open) return;
      $('#cron-preview-status').textContent = '';
      $('#cron-error').textContent = error.message;
      form.elements.cronExpression.setAttribute('aria-invalid', 'true');
    }
  }, 250);
}
form.elements.cronExpression.oninput = schedulePreview;
for (const button of document.querySelectorAll('[data-cron]')) button.onclick = () => {
  form.elements.cronExpression.value = button.dataset.cron;
  form.elements.cronExpression.focus(); schedulePreview();
};
$('#reminder-dialog').addEventListener('close', cancelPreview);
function openReminder(reminder) {
  form.reset(); editId = reminder?.id;
  form.elements.id.value = editId || '';
  $('#reminder-error').textContent = '';
  $('#reminder-heading').textContent = reminder ? 'Notunu düzenle.' : 'Bir not bırak.';
  form.elements.onceDate.value = reminder?.onceDate || localDate(new Date());
  form.elements.anchorDate.value = reminder?.anchorDate || localDate(new Date());
  form.elements.weekInterval.value = reminder?.weekInterval || 1;
  form.elements.intervalMinutes.value = reminder?.intervalMinutes || 120;
  form.elements.workHours.checked = Boolean(reminder?.workStart);
  form.elements.workStart.value = reminder?.workStart || '09:00';
  form.elements.workEnd.value = reminder?.workEnd || '18:00';
  form.elements.cronExpression.value = reminder?.cronExpression || '0 9 * * *';
  if (reminder) {
    for (const key of ['title', 'frequency', 'time', 'monthDay', 'melody']) form.elements[key].value = reminder[key];
    for (const box of $('#weekday-field').querySelectorAll('input')) box.checked = reminder.weekdays.includes(Number(box.value));
    if (reminder.frequency === 'interval' && reminder.weekdays.length === 7 && !reminder.workStart && !reminder.workEnd) {
      if (reminder.intervalMinutes === 60) form.elements.frequency.value = 'hourly';
      if (reminder.intervalMinutes === 120) form.elements.frequency.value = 'two_hourly';
    }
  } else $('#weekday-field input[value="1"]').checked = true;
  updateRecurrenceFields(); $('#reminder-dialog').showModal(); form.elements.title.focus(); schedulePreview();
}
form.elements.frequency.onchange = () => {
  for (const box of $('#weekday-field').querySelectorAll('input')) box.checked = form.elements.frequency.value === 'interval' || box.value === '1';
  updateRecurrenceFields();
  schedulePreview();
};
form.elements.workHours.onchange = updateRecurrenceFields;
$('#quick-reminder').onclick = () => {
  const date = new Date(Math.ceil((Date.now() + 30 * 60000) / 60000) * 60000);
  form.elements.onceDate.value = localDate(date);
  form.elements.time.value = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
};
$('#add-reminder').onclick = () => openReminder();
for (const button of document.querySelectorAll('.close-dialog')) button.onclick = () => button.closest('dialog').close();
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', e => { if (e.target === dialog) { const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); } });
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b === button); if (b === button) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  render();
};
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', b === button)); render();
};
async function withBusy(button, action, errorTarget) {
  if (mutationBusy) return;
  mutationBusy = true;
  const label = button.textContent;
  button.disabled = true; button.textContent = 'Bekle…'; button.setAttribute('aria-busy', 'true');
  try { await action(); } catch (e) { if (errorTarget) errorTarget.textContent = e.message; else toast(e.message); }
  finally { button.disabled = false; button.textContent = label; button.removeAttribute('aria-busy'); mutationBusy = false; if (state) renderScheduleStatus(); }
}
form.onsubmit = e => {
  e.preventDefault(); $('#reminder-error').textContent = '';
  withBusy(form.querySelector('[type="submit"]'), async () => {
    state = await api('saveReminder', reminderInput());
    $('#reminder-dialog').close(); render();
  }, $('#reminder-error'));
};
$('#reminders').onclick = e => {
  const button = e.target.closest('button'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'complete') return withBusy(button, async () => {
    state = await api('completeJob', { id: button.dataset.id }); render(); toast('Yapıldı olarak işaretlendi.');
  });
  if (action === 'snooze') {
    const job = state.jobs.find(j => j.id === button.dataset.id);
    snoozeId = job.id;
    snoozeForm.reset();
    $('#snooze-title').textContent = job.title;
    $('#snooze-note').textContent = 'Tekrar takvimi değişmez. ' + (state.scheduler?.mode === 'device' ? 'Erteleme cihaza aktarılır; aktarım için bağlantı gerekir. ' : 'Bilgisayar açık ve Masa çalışıyor olmalı. ') + 'Yapıldı olarak işaretlersen bekleyen ertelemeler iptal edilir.';
    $('#snooze-error').textContent = '';
    $('#snooze-dialog').showModal();
    snoozeForm.elements.minutes.focus();
    return;
  }
  const r = state.reminders.find(r => r.id === button.dataset.id);
  if (action === 'add') return openReminder();
  if (action === 'edit') return openReminder(r);
  withBusy(button, async () => {
    if (action === 'toggle') state = await api('saveReminder', { ...r, enabled: !r.enabled });
    if (action === 'delete') {
      state = await api('removeReminder', { id: r.id });
      toast('Hatırlatıcı silindi.', async () => { state = await api('saveReminder', { ...r, id: undefined }); render(); $('#toast').hidden = true; });
    }
    render();
  });
};
snoozeForm.onsubmit = e => {
  e.preventDefault(); $('#snooze-error').textContent = '';
  withBusy(snoozeForm.querySelector('[type="submit"]'), async () => {
    state = await api('snoozeJob', { id: snoozeId, minutes: Number(snoozeForm.elements.minutes.value) });
    $('#snooze-dialog').close(); render(); toast('Bildirim ertelendi.');
  }, $('#snooze-error'));
};
$('#open-device').onclick = async () => {
  if (!state) return;
  deviceForm.elements.url.value = state.device.url;
  deviceForm.elements.token.value = state.device.token;
  $('#device-error').textContent = '';
  $('#device-dialog').showModal();
  deviceForm.elements.url.focus();
  try {
    const status = await api('loginStatus');
    $('#login-toggle').checked = status === 'enabled';
    $('#login-toggle').disabled = status === 'unsupported';
    $('#login-help').textContent = status === 'unsupported' ? 'Başlangıç ayarı için paketlenmiş uygulamayı aç.' : status === 'requires-approval' ? 'Sistem Ayarları → Genel → Giriş Öğeleri bölümünden Masa’ya izin ver.' : 'Masa, oturum açtığında çalışmaya başlar.';
  } catch { $('#login-help').textContent = 'Başlangıç ayarı bu ortamda desteklenmiyor.'; }
};
async function saveDevice() {
  state = await api('saveDevice', { url: deviceForm.elements.url.value, token: deviceForm.elements.token.value }); render();
}
deviceForm.onsubmit = e => { e.preventDefault(); $('#device-error').textContent = ''; withBusy(deviceForm.querySelector('[type="submit"]'), async () => { await saveDevice(); state = await api('checkDevice'); render(); }, $('#device-error')); };
$('#check-device').onclick = () => withBusy($('#check-device'), async () => { await saveDevice(); state = await api('checkDevice'); render(); }, $('#device-error'));
$('#test-device').onclick = () => withBusy($('#test-device'), async () => { await saveDevice(); await api('testDevice'); state = await api('snapshot'); render(); $('#device-result').textContent = 'Test bildirimi cihaz tarafından kabul edildi. Ekranı ve kısa melodiyi kontrol et.'; }, $('#device-error'));
$('#login-toggle').onchange = async e => {
  const checked = e.target.checked;
  try {
    const result = await api('launchAtLogin', { enabled: checked });
    e.target.checked = result === 'enabled';
    if (result === 'requires-approval') $('#login-help').textContent = 'Sistem Ayarları → Genel → Giriş Öğeleri bölümünden Masa’ya izin ver.';
    else if (e.target.checked !== checked) throw new Error('Başlangıç ayarı değiştirilemedi. Paketlenmiş uygulamayı kullan.');
  }
  catch (error) { e.target.checked = !checked; $('#device-error').textContent = error.message; }
};
$('#autonomous-toggle').onchange = async e => {
  const enabled = e.target.checked;
  if (mutationBusy) { renderScheduleStatus(); return; }
  mutationBusy = true; e.target.disabled = true; $('#device-error').textContent = '';
  try { state = await api('setAutonomous', { enabled }); renderedState = ''; render(); }
  catch (error) {
    $('#device-error').textContent = error.message;
    try { state = await api('snapshot'); renderedState = ''; render(); } catch {}
    renderScheduleStatus();
  }
  finally { mutationBusy = false; renderScheduleStatus(); }
};
$('#sync-schedule').onclick = () => withBusy($('#sync-schedule'), async () => {
  state = await api('syncSchedule'); renderedState = ''; render();
}, $('#device-error'));
$('#takeover-schedule').onclick = () => withBusy($('#takeover-schedule'), async () => {
  state = await api('setAutonomous', { enabled: true, takeover: true }); renderedState = ''; render();
}, $('#device-error'));
$('#open-preferences').onclick = () => {
  if (!state) return;
  const settings = state.settings || {};
  preferencesForm.elements.quietEnabled.checked = settings.quietEnabled === true;
  preferencesForm.elements.quietStart.value = settings.quietStart || '22:00';
  preferencesForm.elements.quietEnd.value = settings.quietEnd || '08:00';
  $('#preferences-error').textContent = ''; $('#backup-error').textContent = ''; $('#backup-file').value = '';
  $('#preferences-dialog').showModal();
};
preferencesForm.onsubmit = e => {
  e.preventDefault(); $('#preferences-error').textContent = '';
  withBusy(preferencesForm.querySelector('[type="submit"]'), async () => {
    state = await api('saveSettings', { quietEnabled: preferencesForm.elements.quietEnabled.checked,
      quietStart: preferencesForm.elements.quietStart.value, quietEnd: preferencesForm.elements.quietEnd.value });
    render(); toast('Sessiz saatler kaydedildi.');
  }, $('#preferences-error'));
};
$('#export-backup').onclick = () => withBusy($('#export-backup'), async () => {
  const data = await api('exportBackup');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'masa-yedek-' + localDate(new Date()) + '.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Hatırlatıcı yedeği indirildi.');
}, $('#backup-error'));
$('#backup-file').onchange = async e => {
  const file = e.target.files[0]; $('#backup-error').textContent = ''; importText = '';
  if (!file) return;
  if (file.size > 1024 * 1024) { $('#backup-error').textContent = 'Yedek dosyası 1 MB sınırını aşıyor.'; e.target.value = ''; return; }
  try {
    const text = await file.text();
    const preview = await api('previewImport', { text }); importText = text;
    $('#import-summary').textContent = preview.count + ' hatırlatıcı ve sessiz saat ayarları geri yüklenecek.';
    $('#import-titles').innerHTML = preview.reminders.map(r => '<li>' + escapeHTML(typeof r === 'string' ? r : r.title) + '</li>').join('');
    importForm.reset(); $('#import-error').textContent = ''; updateImportNote();
    $('#import-dialog').showModal();
  } catch (error) { $('#backup-error').textContent = error.message; }
  finally { e.target.value = ''; }
};
function updateImportNote() {
  $('#import-note').textContent = importForm.elements.mode.value === 'replace' ? 'Mevcut hatırlatıcılar ve bekleyen bildirimler kaldırılır. İşlemden önce otomatik geri dönüş yedeği saklanır. Sessiz saatler yedekten alınır.' : 'Mevcut notlar korunur; aynı kimlikteki notlar güncellenir. Sessiz saatler yedekten alınır.';
}
for (const radio of importForm.querySelectorAll('[name="mode"]')) radio.onchange = updateImportNote;
importForm.onsubmit = e => {
  e.preventDefault(); $('#import-error').textContent = '';
  withBusy(importForm.querySelector('[type="submit"]'), async () => {
    state = await api('importBackup', { text: importText, mode: importForm.elements.mode.value });
    importText = ''; $('#import-dialog').close(); $('#preferences-dialog').close(); render(); toast('Yedek geri yüklendi.');
  }, $('#import-error'));
};
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!document.querySelector('dialog[open]')) openReminder(); } });
async function init() {
  if (!globalThis.tiny) { $('#reminders').innerHTML = '<div class="empty"><h3>Masa’yı masaüstünde aç.</h3><p>Bu sayfa önizlemedir. Hatırlatıcıları kullanmak için proje klasöründe tinyjs dev çalıştır.</p></div>'; $('#summary').textContent = 'Masaüstü bağlantısı bekleniyor'; return; }
  tiny.api.on('state', value => { state = value; render(); });
  tiny.api.on('fatal', message => toast(message));
  state = await api('snapshot'); render();
  if (state.device.url) { state = await api('checkDevice'); render(); }
  setInterval(async () => { if (!state?.device.url) return; try { state = await api('checkDevice'); render(); } catch {} }, 30000);
}
init().catch(e => { $('#reminders').textContent = e.message; $('#summary').textContent = 'Başlatılamadı'; });
