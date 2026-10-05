import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulator } from '../tools/device-simulator.js';
import { requestDevice, validateDevice } from '../src/core/device.js';
const token = 'test-device-token-123456789';
test('real HTTP delivery authenticates and deduplicates a repeated ID', async () => {
  const notices = [];
  const server = createSimulator({ token, onNotice: n => notices.push(n) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const device = validateDevice({ url: `http://127.0.0.1:${server.address().port}/`, token });
    assert.equal((await requestDevice(device, '/api/health')).protocol, 2);
    const job = { id: 'one', title: 'Bitkileri sula', melody: 'chime' };
    assert.equal((await requestDevice(device, '/api/notify', job)).duplicate, false);
    assert.equal((await requestDevice(device, '/api/notify', job)).duplicate, true);
    assert.equal(notices.length, 1);
    await assert.rejects(requestDevice({ ...device, token: 'wrong' }, '/api/health'), /eşleşmiyor/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('redirects, mismatched acknowledgement, malformed configuration are refused', async () => {
  for (const url of ['file:///etc/passwd', 'http://user:password@host', 'http://host/api', 'http://host/?key=x'])
    assert.throws(() => validateDevice({ url, token }));
  assert.throws(() => validateDevice({ url: 'http://device', token: 'short' }));
  const job = { id: 'one', title: 'Mola', melody: 'none' };
  await assert.rejects(requestDevice({ url: 'http://device', token }, '/api/notify', job,
    async () => new Response(JSON.stringify({ protocol: 2, id: 'other', accepted: true }))), /onayı/);
});
test('network timeout cancels the request', async () => {
  await assert.rejects(requestDevice({ url: 'http://device', token }, '/api/health', undefined,
    async (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))), 5), /yanıt vermedi/);
});
test('vibration-only firmware requires an upgrade instead of accepting a different sound contract', async () => {
  await assert.rejects(requestDevice({ url: 'http://device', token }, '/api/health', undefined,
    async () => new Response(JSON.stringify({ protocol: 1 }))), /güncelle/);
});
test('silent notifications remain silent and unsupported melodies are rejected', async () => {
  const notices = [];
  const server = createSimulator({ token, onNotice: n => notices.push(n) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const device = { url: `http://127.0.0.1:${server.address().port}`, token };
    await requestDevice(device, '/api/notify', { id: 'silent', title: 'Su iç', melody: 'none' });
    assert.equal(notices[0].melody, 'none');
    await assert.rejects(requestDevice(device, '/api/notify', { id: 'bad', title: 'Su iç', melody: 'unknown' }), /HTTP 400/);
    assert.equal(notices.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
