// Run against a fresh local SQLite database with synthetic data; all outgoing HTTP is denied/mocked.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const { randomUUID } = require('node:crypto');
assert(!fs.existsSync('.env'), 'Never load a production environment');
for (const key of Object.keys(process.env)) if (/MOYSKLAD|DATABASE_|TELEGRAM|FEEDBACK_|ENGRAVING_/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: '.tmp/journal-' + randomUUID() + '.sqlite',
 APP_KEYS: 'isolated-a,isolated-b', ADMIN_JWT_SECRET: 'isolated-admin-secret', API_TOKEN_SALT: 'isolated-api-salt',
 TRANSFER_TOKEN_SALT: 'isolated-transfer-salt', JWT_SECRET: 'isolated-jwt-secret', ENCRYPTION_KEY: 'isolated-encryption-key',
 STRAPI_TELEMETRY_DISABLED: 'true', STRAPI_DISABLE_UPDATE_NOTIFICATION: 'true', ORDER_JOURNAL_ENABLED: 'true',
 ORDER_NOTIFICATIONS_ENABLED: 'true', ORDER_NOTIFICATIONS_FROM_REQUEST_ID: '0' });
const isolatedPG = process.env.JOURNAL_ISOLATED_PG === 'true';
if (isolatedPG) {
 assert.equal(fs.readFileSync('/CD-JOURNAL-ISOLATED','utf8'), 'isolated-journal-rehearsal');
 Object.assign(process.env, { DATABASE_CLIENT:'postgres', DATABASE_HOST:'127.0.0.1', DATABASE_PORT:'5432', DATABASE_NAME:'journal_fixture', DATABASE_USERNAME:'strapi', DATABASE_PASSWORD:'isolated-only', DATABASE_POOL_MIN:'0', DATABASE_POOL_MAX:'4' });
}
global.fetch = async () => { throw Error('External HTTP forbidden'); };
let app, calls = [], mode = 'ok';
const uid = 'api::site-order-journal.site-order-journal';
const query = (type = uid) => app.db.query(type);
const payload = () => ({ buyerType: 'individual', fullName: 'Тест Покупатель', phone: '+79990000000', address: 'Изолированный тест',
 comment: '<script>не HTML</script>', items: [{ code: 'Jig25/40', quantity: 2, engraving: false }] });
const ctx = (key = randomUUID(), body = payload()) => ({ request: { body }, get: n => n.toLowerCase() === 'idempotency-key' ? key : '', set() {}, status: 200 });
let controller, journal, queue;
async function submit(c = ctx()) { await controller.create(c); return c; }
async function row(c) { return query().findOne({ where: { requestId: c.body.journalId } }); }
async function boot() {
 const { createStrapi } = require('@strapi/strapi');
 app = await createStrapi({ appDir: process.cwd(), distDir: path.join(process.cwd(), 'dist') }).load();
 assert.equal(app.config.get('database.connection.client'), isolatedPG ? 'postgres' : 'sqlite');
 if (!isolatedPG) assert(app.config.get('database.connection.connection.filename').includes('.tmp'));
 controller = require('../dist/src/api/order/controllers/order').default;
 journal = require('../dist/src/api/site-order-journal/utils/journal');
 queue = require('../dist/src/api/order-notification/utils/queue');
 const service = require('../dist/src/api/order/services/order').default;
 service.createCounterparty = async () => { calls.push('counterparty'); if(mode === 'counterparty-down') throw Error('unavailable'); return 'https://example.invalid/agent'; };
 service.createCustomerOrder = async p => {
  calls.push('order'); assert.equal(p.positions[0].price, 1000); assert.match(p.description, /Заявка сайта: CD-/);
  assert.equal(await query().count(), await query('api::order-request.order-request').count(), 'Snapshot is durable before CRM POST');
  if(mode === 'order-timeout') throw Error('timeout after remote acceptance');
  await new Promise(r => setTimeout(r, 25));
  return { id: randomUUID(), name: 'TEST-' + calls.length, sum: 180000 };
 };
}
(async () => {
 await boot();
 await query('api::moysklad-product.moysklad-product').create({ data: { name: 'Джиггер 25/40 мл', code: 'Jig25/40', slug: 'isolated-jigger', price: 1000,
  href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/' + randomUUID(), type: 'product', isHiddenOnSite: false, isOutOfStock: false } });
 const promo = await query('api::promo-code.promo-code').create({ data: { code: 'ONCE', discountType: 'percent', discountValue: 10, isActive: true, usageCount: 0, usageLimit: 10 } });
 const key = randomUUID(), body = { ...payload(), promoCode: 'ONCE' };
 const concurrent = await Promise.all([submit(ctx(key, body)), submit(ctx(key, body)), submit(ctx(key, body))]);
 assert(concurrent.every(c => c.body.accepted), JSON.stringify(concurrent.map(c => c.body)));
 assert.equal(new Set(concurrent.map(c => c.body.journalId)).size, 1);
 assert.deepEqual(calls, ['counterparty', 'order']);
 assert.equal((await query('api::promo-code.promo-code').findOne({ where: { id: promo.id } })).usageCount, 1);
 const normal = concurrent.find(c => c.body.crmConfirmed); assert(normal);
 assert.deepEqual(normal.body.analytics, {currency:'RUB',revenue:1800,products:[{id:'Jig25/40',name:'Джиггер 25/40 мл',price:900,quantity:2}]});
 const replay = await submit(ctx(key, body));
 assert.equal(replay.body.journalId,normal.body.journalId);assert.deepEqual(replay.body.analytics,normal.body.analytics);
 assert.equal(calls.length,2,'Analytics adds no CRM calls');
 const saved = await row(normal); assert(saved.details.includes('25/40')); assert(saved.details.includes('Jig25/40'));
 const conflict = await submit(ctx(key, { ...body, address: 'Changed' })); assert.equal(conflict.status, 409); assert.equal(calls.length, 2);
 await queue.discoverOrder(); const notice = await queue.claimOrder(); assert(notice); assert(notice.messages.join('\n').includes('Заявка сайта: CD-'));
 assert(!notice.messages.join('\n').includes('<script>')); assert(notice.messages.join('\n').includes('1 800 ₽'));
 await queue.discoverOrder(); assert.equal(await query('api::order-notification.order-notification').count(), 1);
 const ack = { id: notice.id, leaseToken: notice.leaseToken, ok: true, messageIds: notice.messages.map((_, i) => String(i + 1)) };
 assert(await queue.completeOrder(ack)); assert(await queue.completeOrder(ack));
 for (const failure of ['counterparty-down', 'order-timeout']) {
  mode = failure; const failureKey = randomUUID(), failed = await submit(ctx(failureKey)); assert.equal(failed.status, 202); assert(failed.body.accepted);
  assert.equal(failed.body.analytics.revenue,2000);assert.equal(failed.body.analytics.products[0].price,1000);
  const n = calls.length; assert((await submit(ctx(failureKey))).body.accepted); assert.equal(calls.length, n, 'No CRM POST retry');
  const message = await queue.claimOrder(); assert(message); assert(message.messages.join('\n').includes('не подтверждена'));
  await queue.completeOrder({ id: message.id, leaseToken: message.leaseToken, ok: true, messageIds: message.messages.map((_, i) => String(i + 100)) });
 }
 // Missing CRM reference still yields an actionable local order without CRM traffic.
 await query('api::moysklad-product.moysklad-product').update({ where: { code: 'Jig25/40' }, data: { href: null } });
 const before = calls.length, missing = await submit(); assert.equal(missing.status, 202); assert.equal(calls.length, before);
 // Admin can annotate, but cannot overwrite immutable facts, delete or fabricate requests.
 await app.documents(uid).update({ documentId: saved.documentId, data: { handled: true, managerNote: 'Проверено', number: 'TAMPER', snapshot: {} } });
 const after = await query().findOne({ where: { id: saved.id } }); assert.equal(after.number, saved.number); assert.equal(after.snapshot.version, 1); assert(after.handled);
 await assert.rejects(app.documents(uid).delete({ documentId: saved.documentId }));
 await assert.rejects(app.documents(uid).create({ data: saved }));
 // Failure before commit rolls back key, snapshot and promo increment together.
 const atomicKey = randomUUID();
 const original = app.documents; const startCount = await query('api::order-request.order-request').count();
 const input = { key: atomicKey, name: 'Test', phone: '000', address: 'Test', positions: [{ name: 'Jig', code: 'Jig25/40', quantity: 2, price: 1000 }],
  orderPositions: [{ discountPercent: 0, productHref: '' }], description: '', totalKopecks: 200000, promoId: -1 };
 const atomic = ctx(atomicKey); await journal.acceptJournalOrder(atomic, input, {}); assert.equal(atomic.status, 400);
 assert.equal(await query('api::order-request.order-request').count(), startCount); assert.equal(await query().count(), startCount);
 // Crash recovery: persisted 'sending' request becomes a local notice after its deadline.
 await query().update({ where: { requestId: missing.body.journalId }, data: { crmState: 'Отправляется', readyAt: new Date(0) } });
 await app.destroy(); await boot();
 const recovered = await queue.claimOrder(); assert(recovered); assert(recovered.messages.join('\n').includes('не подтверждена'));
 await query('api::order-notification.order-notification').update({ where: { id: recovered.id }, data: { attempts: 12 } });
 assert(await queue.completeOrder({ id: recovered.id, leaseToken: recovered.leaseToken, ok: false, error: 'telegram_unavailable', retryAfter: 0 }));
 assert.equal((await query('api::order-notification.order-notification').findOne({ where: { id: recovered.id } })).notificationStatus, 'pending');
 process.env.ORDER_JOURNAL_ENABLED = 'false'; const rollbackReplay = await submit(ctx(key, body)); assert(rollbackReplay.body.accepted);
 // Delivered & processed payloads expire; unresolved and undelivered ones survive.
 await journal.maintainJournal(new Date(Date.now() + 91 * 86400000));
 const purged = await query().findOne({ where: { id: saved.id } }); assert.equal(purged.snapshot, null); assert.equal(purged.details, null);
 assert.equal((await row(missing)).snapshot.version, 1);
 const expiredReplay=await submit(ctx(key, body));assert(expiredReplay.body.accepted, 'Idempotency survives payload expiry');
 assert.equal(expiredReplay.body.analytics,undefined,'Expired snapshots do not fabricate commerce events');
 const cfg = await app.plugin('content-manager').service('content-types').findConfiguration(app.contentTypes[uid]);
 assert.equal(cfg.metadatas.details.edit.editable, false); assert.equal(cfg.metadatas.managerNote.edit.editable, true);
 assert.equal(cfg.settings.mainField, 'number');
 assert(!Object.values(app.api).some(api => Object.values(api.routes || {}).some(r => JSON.stringify(r).includes('/site-order-journals'))));
 console.log(JSON.stringify({ journalIntegration: 'PASS', database: isolatedPG ? 'isolated PostgreSQL' : 'isolated SQLite', concurrentSubmission: true, promoExactlyOnce: true,
  crashRestart: true, noCRMRetry: true, adminProtection: true, retention: true, rollbackReplay: true, externalHTTP: 0, realOrders: 0, telegramMessages: 0 }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if(app) await app.destroy(); });

