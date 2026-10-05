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
    if (response.status === 429) throw new Error('Cihaz kuyruğu dolu; yeniden denenecek.');
    if (!response.ok) throw new Error('Cihaz HTTP ' + response.status + ' yanıtı verdi.');
    const data = await response.json();
    if (data.protocol === 1) throw new Error('Cihaz yazılımını melodi destekleyen 0.2.0 veya üzeri sürüme güncelle.');
    if (data.protocol !== 2 || (body && (data.id !== body.id || data.accepted !== true)))
      throw new Error('Cihaz geçerli bir teslimat onayı vermedi.');
    return data;
  } catch (error) {
    if (abort.signal.aborted) throw new Error('Cihaz 5 saniyede yanıt vermedi. Aynı Wi-Fi ağını ve adresi kontrol et.');
    throw error;
  } finally { clearTimeout(timer); }
}
