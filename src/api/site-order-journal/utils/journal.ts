import { createHash, randomUUID } from 'node:crypto';
import { createJournal } from './admin';
import { formatOrder } from '../../order-notification/utils/format';
import { bindEngravingFiles, releaseEngravingFiles, completeEngravingFiles } from '../../../utils/order-engraving-files';
import { purchaseAnalytics } from './analytics';

export const JOURNAL_UID = 'api::site-order-journal.site-order-journal' as any;
const REQUEST_UID = 'api::order-request.order-request';
const NOTIFICATION_UID = 'api::order-notification.order-notification' as any;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const READY_DELAY_MS = 45_000; // Two existing 15-second CRM requests, with a recovery margin.
const CREATED = 'Создан в CRM', REVIEW = 'Требует проверки', SENDING = 'Отправляется';
const query = () => strapi.db.query(JOURNAL_UID);
export const journalEnabled = () => process.env.ORDER_JOURNAL_ENABLED === 'true';
export const journalAvailable = () => Boolean(strapi.contentTypes?.[JOURNAL_UID]);

export function requestFingerprint(body: any): string {
  const value: any = {};
  for (const key of ['buyerType','fullName','contactName','phone','telegram','inn','address','comment','promoCode']) value[key] = String(body?.[key] ?? '').trim();
  value.items = (body?.items ?? []).map((item: any) => [String(item.code ?? '').trim(), item.quantity, item.engraving === true]);
  value.engravingFiles = body?.engravingFiles ?? null;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function receipt(row: any, replayed = false) {
  const analytics = purchaseAnalytics(row.snapshot);
  return { ok: true, accepted: true, journalNumber: row.number, journalId: row.requestId,
    orderId: row.crmOrderId || row.requestId, orderName: row.crmOrderName || row.number,
    crmConfirmed: row.crmState === CREATED, replayed, ...(analytics ? { analytics } : {}) };
}

export async function replayJournal(ctx: any, requestId: number): Promise<boolean> {
  if (!journalAvailable()) return false;
  const row = await query().findOne({ where: { orderRequestId: requestId } });
  if (!row) return false;
  if (row.fingerprint !== requestFingerprint(ctx.request.body)) {
    ctx.status = 409; ctx.body = { ok: false, error: 'idempotency_conflict' }; return true;
  }
  ctx.status = 200; ctx.body = receipt(row, true); return true;
}

function parsedSnapshot(value: any) {
  const snapshot = typeof value === 'string' ? JSON.parse(value) : value;
  if (snapshot?.version !== 1 || !snapshot.order || !Array.isArray(snapshot.positions)) throw Error('journal_snapshot_invalid');
  return snapshot;
}

export function journalMessages(row: any): string[] {
  const snapshot = parsedSnapshot(row.snapshot);
  return formatOrder({ ...snapshot.order, name: row.crmOrderName || row.number }, snapshot.positions,
    { journalNumber: row.number, crmConfirmed: row.crmState === CREATED });
}

function readableDetails(row: any): string {
  return journalMessages(row).map(s => s.replace(/<\/?b>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('\n\n');
}

// Called only after the existing server-side validation and discount calculation.
// The transaction includes the request key, snapshot and promo accounting; no CRM/TG HTTP inside it.
export async function acceptJournalOrder(ctx: any, input: any, service: any) {
  const { key, name, phone, address, positions, orderPositions, description, totalKopecks, promoId, engravingFiles } = input;
  let row: any; let bound = false;
  try {
    if (!Number.isSafeInteger(totalKopecks) || totalKopecks < 0) throw Error('invalid_journal_total');
    await strapi.db.transaction(async ({ trx }) => {
      const request = await strapi.db.query(REQUEST_UID).create({ data: { idempotencyKey: key, status: 'processing' } });
      const number = `CD-${request.id}`;
      const links = engravingFiles ? bindEngravingFiles(engravingFiles, key) : [];
      bound = Boolean(engravingFiles);
      const detail = [description, `Заявка сайта: ${number}`, ...links].filter(Boolean).join(' | ');
      const snapshot = { version: 1, order: { name: number, sum: totalKopecks, agent: { name, phone }, shipmentAddress: address, description: detail },
        positions: positions.map((p: any, i: number) => ({ quantity: p.quantity, price: p.price * 100,
          discount: orderPositions[i].discountPercent, assortment: { name: p.name, code: p.code } })) };
      const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (payloadBytes > MAX_SNAPSHOT_BYTES) throw Error('journal_order_too_large');
      row = { number, orderRequestId: request.id, requestId: randomUUID(), fingerprint: requestFingerprint(ctx.request.body),
        crmState: SENDING, snapshot, readyAt: new Date(Date.now() + READY_DELAY_MS), payloadBytes, handled: false };
      // Validate formatting before accepting; the sender will never need to reconstruct this from CRM.
      row.details = readableDetails(row);
      if (promoId !== null) {
        const updated = await trx('promo_codes').where({ id: promoId, is_active: true })
          .where(function(this: any) { this.whereNull('usage_limit').orWhereRaw('COALESCE(usage_count, 0) < usage_limit'); })
          .update({ usage_count: trx.raw('COALESCE(usage_count, 0) + 1'), updated_at: new Date() });
        if (updated !== 1) throw Error('promo_limit_reached');
      }
      row = await createJournal(row);
    });
  } catch (error) {
    // A concurrent identical request, or an uncertain transaction acknowledgement, must never create a second CRM order.
    const existing = await strapi.db.query(REQUEST_UID).findOne({ where: { idempotencyKey: key } });
    if (existing && await replayJournal(ctx, existing.id)) return;
    if (bound) { try { releaseEngravingFiles(key); } catch { strapi.log.error('[order-journal] attachments need reconciliation'); } }
    const code = error instanceof Error ? error.message : '';
    ctx.status = code === 'promo_limit_reached' ? 400 : code === 'journal_order_too_large' ? 413 : 503;
    ctx.body = { ok: false, error: ['promo_limit_reached','journal_order_too_large'].includes(code) ? code : 'order_storage_unavailable' };
    return;
  }

  // The durable journal is now the acceptance boundary. Any subsequent failure keeps the order for a manager.
  let result: any;
  try {
    // A valid local product without its CRM reference can still be handled manually.
    if (orderPositions.some((p: any) => !p.productHref)) throw Error('missing_crm_reference');
    const agentHref = await service.createCounterparty(name, phone);
    result = await service.createCustomerOrder({ agentHref, positions: orderPositions,
      description: row.snapshot.order.description, shipmentAddress: address });
    if (!result?.id || !result?.name) throw Error('invalid_moysklad_order_response');
    const snapshot = parsedSnapshot(row.snapshot);
    if (typeof result.sum === 'number' && Number.isSafeInteger(result.sum) && result.sum >= 0) snapshot.order.sum = result.sum;
    const next = { ...row, snapshot, crmState: CREATED, crmOrderId: result.id, crmOrderName: result.name, readyAt: new Date() };
    await strapi.db.transaction(async ({ trx }) => {
      const n = await trx('order_requests').where({ id: row.orderRequestId, status: 'processing' })
        .update({ status: 'succeeded', order_id: result.id, order_name: result.name, updated_at: new Date() });
      if (n !== 1) throw Error('journal_request_finalize_failed');
      await query().update({ where: { id: row.id }, data: { crmState: CREATED, crmOrderId: result.id, crmOrderName: result.name,
        snapshot, readyAt: next.readyAt, details: readableDetails(next) } });
    });
    row = next;
  } catch {
    // No automatic CRM POST retry, even after a timeout: the remote order may already exist.
    const next = { ...row, crmState: REVIEW, readyAt: new Date() };
    try {
      await strapi.db.transaction(async () => {
        await query().update({ where: { id: row.id }, data: { crmState: REVIEW, readyAt: next.readyAt, details: readableDetails(next) } });
        await strapi.db.query(REQUEST_UID).updateMany({ where: { id: row.orderRequestId, status: 'processing' }, data: { status: 'needs_review' } });
      });
    }
    catch { strapi.log.error('[order-journal] accepted order requires status reconciliation'); }
    row = next;
  }
  if (bound) {
    try { completeEngravingFiles(key, row.crmOrderId || row.requestId, row.crmOrderName || row.number); }
    catch { strapi.log.error('[order-journal] accepted attachments metadata needs reconciliation'); }
  }
  ctx.status = row.crmState === CREATED ? 200 : 202;
  ctx.body = receipt(row);
}

// Uses the already-running sender. Eligible after 45s even if the checkout process crashed.
export async function discoverJournalNotification(now = new Date()): Promise<boolean> {
  if (!journalAvailable()) return false;
  const row = await strapi.db.connection('site_order_journals as j')
    .leftJoin('order_notifications as n', 'n.source_request_id', 'j.order_request_id')
    .whereNull('n.id').whereNotNull('j.snapshot').where('j.ready_at', '<=', now)
    .orderBy('j.id', 'asc').select('j.*').first();
  if (!row) return false;
  const journal: any = { id: row.id, number: row.number, requestId: row.request_id, orderRequestId: row.order_request_id,
    crmOrderId: row.crm_order_id, crmOrderName: row.crm_order_name, crmState: row.crm_state, snapshot: row.snapshot };
  if (journal.crmState === SENDING) {
    journal.crmState = REVIEW;
    await query().updateMany({ where: { id: row.id, crmState: SENDING }, data: { crmState: REVIEW, details: readableDetails(journal) } });
    await strapi.db.query(REQUEST_UID).updateMany({ where: { id: journal.orderRequestId, status: 'processing' }, data: { status: 'needs_review' } });
  }
  const notificationId = `journal:${journal.requestId}`;
  try {
    await strapi.documents(NOTIFICATION_UID).create({ data: { orderId: notificationId,
      orderName: journal.crmOrderName || journal.number, sourceRequestId: journal.orderRequestId,
      requestId: journal.requestId, messages: journalMessages(journal), notificationStatus: 'pending', attempts: 0 } });
  } catch (error) {
    if (!await strapi.db.query(NOTIFICATION_UID).findOne({ where: { orderId: notificationId } })) throw error;
  }
  return true;
}

let maintenanceAfter = 0;
export async function maintainJournal(now = new Date()) {
  if (!journalAvailable() || now.getTime() < maintenanceAfter) return;
  maintenanceAfter = now.getTime() + 86_400_000;
  try {
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    // Keep unresolved orders and notifications. Retain only tiny keys/numbers after payload removal to prevent old POST replay.
    const rows = await strapi.db.connection('site_order_journals as j')
      .join('order_notifications as n', 'n.source_request_id', 'j.order_request_id')
      .where('j.created_at', '<', cutoff).whereNull('j.purged_at').where('n.notification_status', 'sent')
      .where(function(this: any) { this.where('j.crm_state', CREATED).orWhere('j.handled', true); })
      .orderBy('j.id', 'asc').limit(100).select('j.id', 'n.id as notification_id');
    for (const row of rows) await strapi.db.transaction(async ({ trx }) => {
      const changed = await trx('site_order_journals').where({ id: row.id }).whereNull('purged_at')
        .where(function(this: any) { this.where('crm_state', CREATED).orWhere('handled', true); })
        .update({ snapshot: null, details: null, manager_note: null, payload_bytes: 0, purged_at: now });
      if (changed) await trx('order_notifications').where({ id: row.notification_id, notification_status: 'sent' }).update({ messages: null });
    });
    const totals = await strapi.db.connection('site_order_journals').whereNull('purged_at')
      .count({ count: '*' }).sum({ bytes: 'payload_bytes' }).first();
    if (Number(totals?.count) > 3000 || Number(totals?.bytes) > 64 * 1024 * 1024) strapi.log.warn('[order-journal] retained orders need review; automatic removal of unresolved orders is disabled');
  } catch { maintenanceAfter = now.getTime() + 3_600_000; strapi.log.error('[order-journal] retention postponed; no acceptance impact'); }
}
