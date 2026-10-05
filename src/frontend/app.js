const $ = selector => document.querySelector(selector);
const form = $('#reminder-form');
const deviceForm = $('#device-form');
const api = (method, params = {}) => {
  if (!globalThis.tiny) return Promise.reject(new Error('Masa’yı tinyjs dev ile aç. Tarayıcı önizlemesi cihaza bağlanmaz.'));
  return tiny.api.call(method, params);
};
let state;
let view = 'all';
let filter = 'all';
let editId;
let mutationBusy = false;
let renderedState = '';
const weekdays = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
const frequency = { daily: 'Her gün', weekly: 'Her hafta', monthly: 'Her ay' };
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateText = value => new Date(value).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

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
  if (r.frequency === 'weekly') return r.weekdays.map(d => weekdays[d]).join(', ');
  if (r.frequency === 'monthly') return 'Her ayın ' + r.monthDay + '. günü';
  return frequency[r.frequency];
}
function render() {
  if (!state) return;
  const key = JSON.stringify([view, filter, state.reminders, state.jobs, state.connection, state.lastError, new Date().toDateString()]);
  if (key === renderedState) return;
  renderedState = key;
  $('#today-label').textContent = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#zone-label').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone + ' · yerel saat';
  $('#nav-count').textContent = state.reminders.length;
  const online = state.connection.status === 'online';
  $('#open-device').classList.toggle('online', online);
  $('#sidebar-status').textContent = !state.device.url ? 'Bağlantı ayarlanmadı' : online ? 'Bağlı · Wi-Fi' : state.connection.status === 'offline' ? 'Cihaza ulaşılamıyor' : 'Kontrol bekleniyor';
  $('#device-result').textContent = state.connection.error || (online ? 'Bağlantı hazır. Cihaz bildirim alabilir.' : 'Bağlantı henüz kontrol edilmedi.');
  const queued = state.jobs.filter(j => j.status === 'queued');
  $('#footer-status').textContent = state.lastError || (queued.length ? queued.length + ' bildirim cihaz için bekliyor.' : 'Uygulama açıkken hatırlatır.');
  $('#week-strip').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(); day.setDate(day.getDate() + i);
    const count = state.reminders.filter(r => r.enabled && sameDay(r.nextDue, day)).length;
    return `<div class="week-day ${i === 0 ? 'current' : ''}"><span>${weekdays[day.getDay()]}</span><strong>${day.getDate()}</strong><small>${count ? count + ' sıradaki' : '—'}</small></div>`;
  }).join('');
  $('#page-title').textContent = view === 'history' ? 'Masana ulaşan notlar.' : view === 'today' ? 'Bugün, aklında kalmasın.' : 'Günün küçük notları.';
  $('#page-description').textContent = view === 'history' ? 'Teslimatları ve bekleyen bildirimleri buradan takip et.' : 'Rutinlerini bir kez yaz. Zamanı gelince masan hatırlatsın.';
  $('#filters').hidden = view === 'history';
  $('#week-strip').hidden = view === 'history';
  $('#list-heading').textContent = view === 'history' ? 'Bildirim geçmişi' : 'Hatırlatıcılar';
  const el = $('#reminders');
  el.setAttribute('aria-busy', 'false');
  if (view === 'history') {
    const statuses = { queued: 'Bekliyor', delivered: 'Cihaz kabul etti', expired: 'Süresi doldu', cancelled: 'İptal edildi' };
    $('#summary').textContent = state.jobs.length + ' bildirim';
    el.innerHTML = state.jobs.length ? [...state.jobs].reverse().map(j => `<article class="reminder-row"><div class="reminder-time">${new Date(j.due).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</div><div><h3 class="reminder-title">${escapeHTML(j.title)}</h3><p class="reminder-detail">${dateText(j.due)} · ${statuses[j.status]}${j.error ? ' · ' + escapeHTML(j.error) : ''}</p></div><span class="reminder-detail">${j.attempts} deneme</span></article>`).join('') : '<div class="empty"><span class="empty-mark" aria-hidden="true">∴</span><h3>Henüz bildirim yok.</h3><p>Hatırlatıcının zamanı geldiğinde teslimat durumu burada görünür.</p></div>';
    return;
  }
  const reminders = state.reminders.filter(r => (filter === 'all' || r.frequency === filter) && (view !== 'today' || r.enabled && sameDay(r.nextDue, Date.now()))).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextDue - b.nextDue);
  const enabled = state.reminders.filter(r => r.enabled).length;
  $('#summary').textContent = enabled + ' etkin · ' + (state.reminders.length - enabled) + ' duraklatılmış';
  el.innerHTML = reminders.length ? reminders.map(r => `<article class="reminder-row ${r.enabled ? '' : 'paused'}"><div class="reminder-time">${r.time}</div><div><h3 class="reminder-title">${escapeHTML(r.title)}</h3><p class="reminder-detail">${repeatText(r)} · ${r.enabled ? 'Sıradaki: ' + dateText(r.nextDue) : 'Duraklatıldı'} · ${r.melody === 'chime' ? 'Kısa melodi' : 'Sessiz'}</p></div><div class="row-actions"><button data-action="toggle" data-id="${escapeHTML(r.id)}" aria-label="${escapeHTML(r.title)}: ${r.enabled ? 'duraklat' : 'başlat'}">${r.enabled ? 'Duraklat' : 'Başlat'}</button><button data-action="edit" data-id="${escapeHTML(r.id)}">Düzenle</button><button data-action="delete" data-id="${escapeHTML(r.id)}">Sil</button></div></article>`).join('') : `<div class="empty"><span class="empty-mark" aria-hidden="true">∴</span><h3>${state.reminders.length ? 'Bu görünümde not yok.' : 'İlk notunu bırak.'}</h3><p>${state.reminders.length ? 'Diğer tekrarları görebilir veya yeni bir hatırlatıcı ekleyebilirsin.' : 'Su içmek, bitkileri sulamak, bir mola vermek. Tekrar eden küçük işleri Masa’ya bırak.'}</p><button class="primary" data-action="add">Hatırlatıcı ekle</button></div>`;
}
function updateRecurrenceFields() {
  $('#weekday-field').hidden = form.elements.frequency.value !== 'weekly';
  $('#monthday-field').hidden = form.elements.frequency.value !== 'monthly';
}
function openReminder(reminder) {
  form.reset(); editId = reminder?.id;
  form.elements.id.value = editId || '';
  $('#reminder-error').textContent = '';
  $('#reminder-heading').textContent = reminder ? 'Notunu düzenle.' : 'Bir not bırak.';
  if (reminder) {
    for (const key of ['title', 'frequency', 'time', 'monthDay', 'melody']) form.elements[key].value = reminder[key];
    for (const box of $('#weekday-field').querySelectorAll('input')) box.checked = reminder.weekdays.includes(Number(box.value));
  } else $('#weekday-field input[value="1"]').checked = true;
  updateRecurrenceFields(); $('#reminder-dialog').showModal(); form.elements.title.focus();
}
form.elements.frequency.onchange = updateRecurrenceFields;
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
  finally { button.disabled = false; button.textContent = label; button.removeAttribute('aria-busy'); mutationBusy = false; }
}
form.onsubmit = e => {
  e.preventDefault(); $('#reminder-error').textContent = '';
  withBusy(form.querySelector('[type="submit"]'), async () => {
    state = await api('saveReminder', { id: editId, title: form.elements.title.value, frequency: form.elements.frequency.value,
      time: form.elements.time.value, weekdays: [...$('#weekday-field').querySelectorAll('input:checked')].map(b => Number(b.value)),
      monthDay: Number(form.elements.monthDay.value), melody: form.elements.melody.value, enabled: editId ? state.reminders.find(r => r.id === editId).enabled : true });
    $('#reminder-dialog').close(); render();
  }, $('#reminder-error'));
};
$('#reminders').onclick = e => {
  const button = e.target.closest('button'); if (!button) return;
  const action = button.dataset.action;
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
