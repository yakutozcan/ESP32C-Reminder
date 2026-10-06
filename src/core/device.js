export function validateDevice(input) {
  const raw = String(input.url ?? '').trim();
  if (!raw) return { url: '', token: '' };
  let url;
  try { url = new URL(raw); } catch { throw new Error('Cihaz adresini http://192.168.1.50 biçiminde yaz.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Cihaz adresi yalnızca HTTP(S) adresi ve isteğe bağlı port içermeli.');
  const token = String(input.token ?? '').trim();
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) throw new Error('Cihaz anahtarı 24–64 harf, rakam, tire veya alt çizgi olmalı.');
  return { url: url.origin, token };
}

export async function requestDevice(device, path, body, fetcher = fetch, timeoutMs = 5000) {
  if (!device.url) throw new Error('Cihaz adresi henüz kaydedilmedi.');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetcher(device.url + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: abort.signal,
      headers: { Authorization: 'Bearer ' + device.token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 401) throw new Error('Cihaz anahtarı eşleşmiyor. Bağlantı ayarlarını kontrol et.');
    if (response.status === 409) throw new Error('Cihaz başka bir zamanlayıcıya ait veya takvim sürümü çakışıyor. Sahipliği devretmeyi seç ya da yeniden eşitle.');
    if (response.status === 429) throw new Error('Cihaz kuyruğu dolu; yeniden denenecek.');
    if (!response.ok) throw new Error('Cihaz HTTP ' + response.status + ' yanıtı verdi.');
    const data = await response.json();
    if (data.protocol === 1) throw new Error('Cihaz yazılımını melodi destekleyen 0.2.0 veya üzeri sürüme güncelle.');
    if (!data || ![2, 3, 4].includes(data.protocol))
      throw new Error('Cihaz geçerli bir teslimat onayı vermedi.');
    if (path === '/api/notify' && (data.id !== body.id || data.accepted !== true))
      throw new Error('Cihaz geçerli bir teslimat onayı vermedi.');
    if (path === '/api/events') {
      if (![3, 4].includes(data.protocol) || !Array.isArray(data.events) || data.events.length > 16 ||
          new Set(data.events.map(e => e?.id)).size !== data.events.length || data.events.some(e =>
            !e || typeof e.id !== 'string' || !/^[a-f0-9]{32}$/.test(e.id) ||
            typeof e.notificationId !== 'string' || !e.notificationId || e.notificationId.length > 160 ||
            !['completed', 'snoozed'].includes(e.action) || (e.action === 'snoozed' && e.minutes !== 15)))
        throw new Error('Cihaz düğme işlemleri geçerli değil.');
    }
    if (path === '/api/events/ack' && (![3, 4].includes(data.protocol) || !Array.isArray(data.acknowledged) ||
        JSON.stringify([...data.acknowledged].sort()) !== JSON.stringify([...body.ids].sort())))
      throw new Error('Cihaz düğme işlemlerini onaylamadı.');
    if (path === '/api/schedule') {
      validateScheduleReply(data);
      if (body && (data.accepted !== true || data.ownerId !== body.ownerId || data.revision !== body.revision || data.enabled !== body.enabled))
        throw new Error('Cihaz takvim aktarımını onaylamadı.');
    }
    if (path === '/api/events') for (const event of data.events) {
      if (event.job !== undefined) {
        validateDeviceJob(event.job);
        if (event.job.id !== event.notificationId || event.job.outcome !== event.action) throw new Error('Cihaz düğme işlemleri geçerli değil.');
      }
      if (event.deferred !== undefined) {
        validateDeviceJob(event.deferred);
        if (!event.job || event.action !== 'snoozed' || event.job.snoozedTo !== event.deferred.id ||
            event.deferred.rootId !== event.job.rootId || event.deferred.reminderId !== event.job.reminderId ||
            event.deferred.status !== 'queued' || event.deferred.outcome !== 'pending') throw new Error('Cihaz düğme işlemleri geçerli değil.');
      }
    }
    return data;
  } catch (error) {
    if (abort.signal.aborted) throw new Error('Cihaz 5 saniyede yanıt vermedi. Aynı Wi-Fi ağını ve adresi kontrol et.');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function readDeviceEvents(device) {
  const health = await requestDevice(device, '/api/health');
  if (health.protocol === 2) return [];
  return (await requestDevice(device, '/api/events')).events;
}


export function validateDeviceJob(job) {
  if (!job || typeof job.id !== 'string' || !job.id || job.id.length > 160 ||
      typeof job.rootId !== 'string' || !job.rootId || job.rootId.length > 160 ||
      typeof job.reminderId !== 'string' || !job.reminderId || job.reminderId.length > 128 ||
      typeof job.title !== 'string' || !job.title.trim() || [...job.title].length > 80 || /[\x00-\x1f\x7f]/.test(job.title) ||
      !['chime', 'none'].includes(job.melody) || !['queued', 'delivered', 'expired', 'cancelled'].includes(job.status) ||
      !['pending', 'completed', 'snoozed'].includes(job.outcome) || !Number.isSafeInteger(job.due) || job.due < 0 ||
      !Number.isSafeInteger(job.expiresAt) || job.expiresAt <= job.due || job.expiresAt - job.due > 86400000 ||
      (job.completedAt !== undefined && (!Number.isSafeInteger(job.completedAt) || job.completedAt < 0)) ||
      (job.snoozedTo !== undefined && (typeof job.snoozedTo !== 'string' || !job.snoozedTo || job.snoozedTo.length > 160)))
    throw new Error('Cihaz hatırlatma kaydı geçerli değil.');
  return job;
}
export function validateScheduleReply(data) {
  if (!data || data.protocol !== 4 || typeof data.ownerId !== 'string' || data.ownerId.length > 128 ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.enabled !== 'boolean' || data.enabled && !data.ownerId || typeof data.timeValid !== 'boolean' ||
      !Array.isArray(data.cursors) || data.cursors.length > 24 || !Array.isArray(data.history) || data.history.length > 32 ||
      !Array.isArray(data.deferred) || data.deferred.length > 24 ||
      new Set(data.cursors.map(r => r?.id)).size !== data.cursors.length || data.cursors.some(r =>
        !r || typeof r.id !== 'string' || !r.id || r.id.length > 128 || (r.nextDue !== null && (!Number.isSafeInteger(r.nextDue) || r.nextDue < 0))))
    throw new Error('Cihaz takvim kaydı geçerli değil.');
  for (const job of [...data.history, ...data.deferred]) validateDeviceJob(job);
  if (new Set([...data.history, ...data.deferred].map(j => j.id)).size !== data.history.length + data.deferred.length)
    throw new Error('Cihaz takviminde tekrar eden kayıt var.');
  return data;
}
