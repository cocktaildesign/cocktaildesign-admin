const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../ops/feedback-worker/worker.mjs')).href;
const load = () => import(moduleUrl);
const item = () => ({ id: 1, requestId: randomUUID(), leaseToken: randomUUID(), message: 'Текст <b>посетителя</b>', email: 'a@example.test', page: '/support/feedback' });
const config = { apiUrl: 'https://api.cocktaildesign.ru/api/', workerToken: 'isolated-worker-00000000000000000000',
  botToken: '123456789:isolated-test-token-00000000000000000', chatId: '123456', username: 'DK_cocktaildesign', stateDir: 'unused' };
function fixture({ claim = item(), failure = false, recipient = 'DK_cocktaildesign' } = {}) {
  const calls = [], saved = new Map();
  const state = { ackFailure: false, claim };
  const receipts = { get: async id => saved.get(id) || null, put: async (id, value) => saved.set(id, value), remove: async id => saved.delete(id) };
  async function fetchImpl(url, options) {
    assert.equal(options.redirect, 'error'); assert(options.signal);
    const body = JSON.parse(options.body); const pathname = new URL(url).pathname;
    calls.push({ pathname, body, headers: options.headers });
    let result;
    if (pathname.endsWith('/getMe')) result = { ok: true, result: { username: 'CD_ORDER_BOT' } };
    else if (pathname.endsWith('/getChat')) result = { ok: true, result: { id: 123456, type: 'private', username: recipient } };
    else if (pathname.endsWith('/sendMessage')) {
      if (failure) return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 65 } }), { status: 429 });
      result = { ok: true, result: { message_id: 42 } };
    } else if (pathname.endsWith('/claim')) {
      assert.equal(options.headers.authorization, `Bearer ${config.workerToken}`);
      result = { ok: true, item: state.claim };
    } else if (pathname.endsWith('/complete')) {
      if (state.ackFailure) throw new Error('isolated lost acknowledgement');
      result = { ok: true };
    } else throw new Error('Unexpected network target');
    return new Response(JSON.stringify(result), { status: 200 });
  }
  return { calls, saved, state, receipts, fetchImpl };
}
test('worker verifies recipient, sends plain text only to fixed chat and acknowledges saved message', async () => {
  const { createWorker } = await load(), f = fixture();
  assert.equal(await createWorker(config, f).runOnce(), 'delivered');
  const send = f.calls.find(c => c.pathname.endsWith('/sendMessage'));
  assert.equal(send.body.chat_id, '123456'); assert(!('parse_mode' in send.body)); assert.equal(send.body.link_preview_options.is_disabled, true);
  assert.match(send.body.text, /<b>посетителя<\/b>/); assert.equal(f.calls.at(-1).body.messageId, '42'); assert.equal(f.saved.size, 0);
});
test('wrong recipient prevents claiming or sending any customer message', async () => {
  const { createWorker } = await load(), f = fixture({ recipient: 'someone_else' });
  await assert.rejects(createWorker(config, f).runOnce(), /recipient_verification_failed/);
  assert(!f.calls.some(c => /claim|sendMessage/.test(c.pathname)));
});
test('Telegram failure schedules retry, never acknowledges success', async () => {
  const { createWorker } = await load(), f = fixture({ failure: true });
  assert.equal(await createWorker(config, f).runOnce(), 'retry_scheduled');
  assert.equal(f.calls.at(-1).body.ok, false); assert.equal(f.calls.at(-1).body.retryAfter, 65); assert.equal(f.saved.size, 0);
});
test('lost acknowledgement and restarted worker reuse receipt instead of sending twice', async () => {
  const { createWorker } = await load(), f = fixture(); f.state.ackFailure = true;
  await assert.rejects(createWorker(config, f).runOnce()); assert.equal(f.saved.size, 1);
  f.state.ackFailure = false; f.state.claim = { ...f.state.claim, leaseToken: randomUUID() };
  assert.equal(await createWorker(config, f).runOnce(), 'delivered');
  assert.equal(f.calls.filter(c => c.pathname.endsWith('/sendMessage')).length, 1); assert.equal(f.saved.size, 0);
});
test('empty queue sends nothing; malformed queued item rejected', async () => {
  const { createWorker } = await load(), f = fixture({ claim: null });
  const w = createWorker(config, f); assert.equal(await w.runOnce(), 'empty');
  f.state.claim = { ...item(), page: '//evil.test/' }; await assert.rejects(w.runOnce(), /invalid_queued_message/);
  assert(!f.calls.some(c => c.pathname.endsWith('/sendMessage')));
});
test('maximum valid payload fits Telegram message limit', async () => {
  const { formatNotification, validItem } = await load();
  const maximum = { ...item(), message: 'Я'.repeat(3000), email: 'x'.repeat(254), page: '/' + 'p'.repeat(249) };
  assert(validItem(maximum)); assert(formatNotification(maximum).length < 4096);
});
test('configuration refuses an arbitrary API server or group recipient', async () => {
  const { configuration } = await load();
  const env = { FEEDBACK_WORKER_TOKEN: config.workerToken, TELEGRAM_BOT_TOKEN: config.botToken,
    TELEGRAM_CHAT_ID: config.chatId, TELEGRAM_EXPECTED_USERNAME: config.username };
  assert.equal(configuration(env).apiUrl, config.apiUrl);
  for (const bad of [{ FEEDBACK_API_URL: 'https://evil.test/api/' }, { FEEDBACK_API_URL: 'http://api.cocktaildesign.ru/api/' },
    { TELEGRAM_CHAT_ID: '-100123456' }, { TELEGRAM_EXPECTED_USERNAME: 'another' }, { FEEDBACK_WORKER_TOKEN: '' }]) {
    assert.throws(() => configuration({ ...env, ...bad }));
  }
});
test('receipts survive reopening storage and cannot escape their directory', async () => {
  const { fileReceipts } = await load();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-feedback-receipt-'));
  const id = randomUUID(), a = fileReceipts(directory);
  try {
    assert.equal(await a.get(id), null); await a.put(id, '42');
    assert.equal(await fileReceipts(directory).get(id), '42');
    await assert.rejects(a.get('../secret')); await a.remove(id); assert.equal(await a.get(id), null);
  } finally { await fs.rmdir(directory); }
});
