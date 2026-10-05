import http from 'node:http';
export function createSimulator({ token = process.env.DEVICE_TOKEN || 'local-simulator-token-12345678', onNotice = console.log } = {}) {
  const seen = new Set();
  return http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ protocol: 2, ...body })); };
    if (req.headers.authorization !== 'Bearer ' + token) return json(401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/api/health') return json(200, { name: 'Masa simulator', firmware: 'simulator', pending: 0 });
    if (req.method !== 'POST' || req.url !== '/api/notify') return json(404, { error: 'Not found' });
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 1024) return json(413, { error: 'Payload too large' }); }
      const notice = JSON.parse(body);
      if (typeof notice.id !== 'string' || !notice.id || notice.id.length > 160 || typeof notice.title !== 'string' || !notice.title.trim() || Buffer.byteLength(notice.title) > 320 || !['chime', 'none'].includes(notice.melody)) return json(400, { error: 'Invalid notification' });
      const duplicate = seen.has(notice.id);
      if (!duplicate) { seen.add(notice.id); onNotice(notice); }
      if (seen.size > 32) seen.delete(seen.values().next().value);
      json(200, { id: notice.id, accepted: true, duplicate });
    } catch { json(400, { error: 'Invalid JSON' }); }
  });
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || 8787);
  createSimulator().listen(port, '127.0.0.1', () => console.log(`Cihaz simülatörü: http://127.0.0.1:${port}\nAnahtar: DEVICE_TOKEN ortam değişkeni veya local-simulator-token-12345678`));
}
