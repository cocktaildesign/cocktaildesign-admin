const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const payload = () => ({ requestId: randomUUID(), message: 'Не найден размер товара', email: 'customer@example.test', page: '/support/feedback' });
const plain = value => JSON.parse(JSON.stringify(value));
function matches(row, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === '$or') return condition.some(part => matches(row, part));
    if (condition === null) return row[key] == null;
    if (condition && typeof condition === 'object') return Object.entries(condition).every(([op, value]) => {
      if (op === '$null') return row[key] == null;
      if (op === '$lte') return row[key] != null && new Date(row[key]) <= new Date(value);
      throw new Error('Unexpected query operator ' + op);
    });
    return row[key] === condition;
  });
}
function fixture() {
  const rows = [], cache = new Map(), events = [];
  const state = { failCreate: false, failRead: false, rowReads: 0 };
  const db = {
    async findOne({ where }) {
      ++state.rowReads;
      if (state.failRead) throw new Error('DB unavailable');
      const row = rows.find(row => matches(row, where));
      return row ? plain(row) : null;
    },
    async updateMany({ where, data }) {
      const selected = rows.filter(row => matches(row, where));
      for (const row of selected) Object.assign(row, plain(data));
      return { count: selected.length };
    },
  };
  const strapi = {
    db: { query(uid) { assert.equal(uid, 'api::feedback.feedback'); return db; } },
    documents(uid) {
      assert.equal(uid, 'api::feedback.feedback');
      return { async create({ data }) {
        if (state.failCreate) throw new Error('DB unavailable');
        if (rows.some(row => row.requestId === data.requestId)) throw new Error('unique constraint');
        const row = { id: rows.length + 1, documentId: 'test-document', createdAt: new Date().toISOString(),
          leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null, ...plain(data) };
        rows.push(row); return plain(row);
      } };
    },
    log: { error: message => events.push(message) },
  };
  const env = { NODE_ENV: 'production', FEEDBACK_ENABLED: 'true', FEEDBACK_WORKER_TOKEN: 'isolated-worker-token-01234567890123456789' };
  function load(relative) {
    const file = path.resolve(root, relative.endsWith('.ts') ? relative : relative + '.ts');
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, strapi, Buffer, Date, Map,
      process: { env }, console,
      fetch() { throw new Error('All network calls are forbidden in this test'); },
      require(name) {
        if (name.startsWith('node:')) return require(name);
        assert(name.startsWith('.'));
        return load(path.relative(root, path.resolve(path.dirname(file), name)));
      },
    }, { filename: file });
    cache.set(file, module.exports); return module.exports;
  }
  const utils = load('src/api/feedback/utils/feedback');
  const controller = load('src/api/feedback/controllers/feedback').default;
  function ctx(body, worker = false) {
    const headers = { origin: 'https://new.cocktaildesign.ru', 'x-real-ip': '192.0.2.42',
      ...(worker ? { authorization: `Bearer ${env.FEEDBACK_WORKER_TOKEN}` } : {}) };
    return { request: { body }, ip: '127.0.0.1', headers, outputHeaders: {},
      get(name) { return headers[name] || ''; }, is(type) { return type === 'application/json'; },
      set(name, value) { this.outputHeaders[name] = value; } };
  }
  return { rows, state, env, utils, controller, ctx, events, load };
}

test('valid feedback is normalized; empty, malformed, oversized and unsafe fields rejected', () => {
  const { utils } = fixture(); const base = payload();
  assert.equal(utils.validateFeedback({ ...base, message: ' текст ', email: ' ' }).email, null);
  assert.equal(utils.validateFeedback({ ...base, message: 'a'.repeat(3000) }).message.length, 3000);
  for (const bad of [null, [], {}, { ...base, requestId: 'not-a-uuid' }, { ...base, message: '  ' },
    { ...base, message: 'a'.repeat(3001) }, { ...base, message: 'x\0y' }, { ...base, email: ['a@b.test'] },
    { ...base, email: 'victim@example.test\nBcc:x@y.test' }, { ...base, page: '//evil.test/' },
    { ...base, page: '/feedback?token=secret' }, { ...base, page: '/a\\b' }]) assert.equal(utils.validateFeedback(bad), null);
});
test('successful intake persists the message and pending job in a single record, sends nothing', async () => {
  const f = fixture(), data = payload(), ctx = f.ctx(data);
  await f.controller.create(ctx);
  assert.equal(ctx.status, 201); assert.equal(ctx.body.ok, true); assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].notificationStatus, 'pending'); assert.equal(f.rows[0].attempts, 0);
  assert.deepEqual(plain(ctx.body), { ok: true, requestId: data.requestId });
});
test('concurrent retries create one message; altered payload using same ID conflicts', async () => {
  const f = fixture(), data = f.utils.validateFeedback(payload());
  const outcomes = await Promise.all([f.utils.saveFeedback(data), f.utils.saveFeedback(data)]);
  assert.deepEqual(outcomes.sort(), ['created', 'replayed']); assert.equal(f.rows.length, 1);
  assert.equal(await f.utils.saveFeedback({ ...data, message: 'другой текст' }), 'conflict');
});
test('storage failure never acknowledges acceptance or discloses raw errors', async () => {
  const f = fixture(), ctx = f.ctx(payload()); f.state.failCreate = true;
  await f.controller.create(ctx);
  assert.equal(ctx.status, 503); assert.equal(ctx.body.ok, false); assert.equal(f.rows.length, 0);
  assert.deepEqual(f.events, ['[feedback] save failed']);
});
test('disabled intake, untrusted origin, non-JSON and invalid payload never create rows', async () => {
  const f = fixture(); const a = f.ctx(payload()); f.env.FEEDBACK_ENABLED = 'false';
  await f.controller.create(a); assert.equal(a.status, 503); f.env.FEEDBACK_ENABLED = 'true';
  const b = f.ctx(payload()); b.headers.origin = 'https://evil.test'; await f.controller.create(b); assert.equal(b.status, 403);
  const c = f.ctx(payload()); c.is = () => false; await f.controller.create(c); assert.equal(c.status, 415);
  const d = f.ctx({}); await f.controller.create(d); assert.equal(d.status, 400);
  assert.equal(f.rows.length, 0);
});
test('feedback rate limiting is scoped to the feedback controller', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { const c = f.ctx(payload()); await f.controller.create(c); assert.equal(c.status, 201); }
  const c = f.ctx(payload()); await f.controller.create(c); assert.equal(c.status, 429);
  assert.equal(c.outputHeaders['Retry-After'], '600'); assert.equal(f.rows.length, 10);
});
test('queue endpoints reject absent, incorrect and Unicode credentials before DB access', async () => {
  const f = fixture();
  for (const token of ['', 'incorrect', 'я'.repeat(f.env.FEEDBACK_WORKER_TOKEN.length)]) {
    const c = f.ctx({}); c.headers.authorization = `Bearer ${token}`;
    await f.controller.claim(c); assert.equal(c.status, 401);
    await f.controller.complete(c); assert.equal(c.status, 401);
  }
  assert.equal(f.state.rowReads, 0);
});
test('concurrent claims lease a message to only one worker', async () => {
  const f = fixture(); await f.utils.saveFeedback(f.utils.validateFeedback(payload()));
  const claims = await Promise.all([f.utils.claimFeedback(), f.utils.claimFeedback()]);
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(f.rows[0].attempts, 1);
  assert.equal(f.rows[0].notificationStatus, 'sending');
});
test('completion is replayable; stale lease cannot acknowledge a new delivery', async () => {
  const f = fixture(); await f.utils.saveFeedback(f.utils.validateFeedback(payload()));
  const start = new Date(); const first = await f.utils.claimFeedback(start);
  assert.equal(await f.utils.claimFeedback(new Date(start.getTime() + 30_000)), null);
  const second = await f.utils.claimFeedback(new Date(start.getTime() + 91_000));
  assert.notEqual(first.leaseToken, second.leaseToken);
  assert.equal(await f.utils.completeFeedback({ id: first.id, leaseToken: first.leaseToken, ok: true, messageId: '10' }), false);
  const result = { id: second.id, leaseToken: second.leaseToken, ok: true, messageId: '11' };
  assert.equal(await f.utils.completeFeedback(result), true);
  assert.equal(await f.utils.completeFeedback(result), true);
  assert.equal(f.rows[0].notificationStatus, 'sent'); assert.equal(await f.utils.claimFeedback(), null);
});
test('failed delivery schedules backoff; retry_after honored; attempts bounded and message retained', async () => {
  const f = fixture(); await f.utils.saveFeedback(f.utils.validateFeedback(payload()));
  let time = new Date();
  for (let attempt = 1; attempt <= 8; attempt++) {
    const item = await f.utils.claimFeedback(time); assert(item);
    await f.utils.completeFeedback({ id: item.id, leaseToken: item.leaseToken, ok: false, error: 'telegram_http_429', retryAfter: 120 }, time);
    assert(new Date(f.rows[0].nextAttemptAt).getTime() >= time.getTime() + 120_000);
    assert.equal(await f.utils.claimFeedback(new Date(time.getTime() + 20_000)), null);
    time = new Date(new Date(f.rows[0].nextAttemptAt).getTime() + 1);
  }
  assert.equal(f.rows[0].notificationStatus, 'failed'); assert.equal(await f.utils.claimFeedback(time), null);
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].message, 'Не найден размер товара');
});
test('crashed sender reaches retry limit without deleting feedback', async () => {
  const f = fixture(); await f.utils.saveFeedback(f.utils.validateFeedback(payload()));
  let time = new Date(); for (let i = 0; i < 8; i++) { assert(await f.utils.claimFeedback(time)); time = new Date(time.getTime() + 91_000); }
  assert.equal(await f.utils.claimFeedback(time), null); assert.equal(f.rows[0].notificationStatus, 'failed');
});
test('delivery input accepts only bounded structured results, not raw error content', () => {
  const { utils } = fixture(), base = { id: 1, leaseToken: randomUUID() };
  assert.equal(utils.validateDelivery({ ...base, ok: false, error: 'telegram_http_429', retryAfter: 1e9 }).retryAfter, 86400);
  for (const bad of [{ ...base, ok: 'true', messageId: '1' }, { ...base, ok: true, messageId: '../1' },
    { ...base, ok: false, error: 'secret token https://example.test' }, { ...base, id: -1, ok: true, messageId: '1' }]) assert.equal(utils.validateDelivery(bad), null);
});
test('API exposes no public read/delete routes', () => {
  const f = fixture(), routes = f.load('src/api/feedback/routes/feedback').default.routes;
  assert.deepEqual(plain(routes.map(r => [r.method, r.path])), [['POST', '/feedback'], ['POST', '/feedback-delivery/claim'], ['POST', '/feedback-delivery/complete']]);
});
