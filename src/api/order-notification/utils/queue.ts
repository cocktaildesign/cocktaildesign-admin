import { randomUUID } from "node:crypto";
import { formatOrder } from "./format";

const UID = "api::order-notification.order-notification" as any;
const query = () => strapi.db.query(UID);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 30 * 60_000;

export function enabled() {
  const floor = process.env.ORDER_NOTIFICATIONS_FROM_REQUEST_ID;
  return process.env.ORDER_NOTIFICATIONS_ENABLED === "true" && /^\d+$/.test(floor || "") && Number.isSafeInteger(Number(floor));
}

export async function discoverOrder() {
  if (!enabled()) return;
  // Read succeeded records only. Never update an order, promo, or checkout request.
  const row = await strapi.db.connection("order_requests as r")
    .leftJoin("order_notifications as n", "n.order_id", "r.order_id")
    .where("r.status", "succeeded").where("r.id", ">", Number(process.env.ORDER_NOTIFICATIONS_FROM_REQUEST_ID))
    .whereNull("n.id").whereNotNull("r.order_id").orderBy("r.id", "asc")
    .select("r.id", "r.order_id", "r.order_name").first();
  if (!row) return;
  try {
    await strapi.documents(UID).create({ data: {
      orderId: row.order_id, orderName: row.order_name, sourceRequestId: row.id,
      requestId: randomUUID(), notificationStatus: "pending", attempts: 0,
    } as any });
  } catch (error) {
    if (!await query().findOne({ where: { orderId: row.order_id } })) throw error;
  }
}

async function readOrder(orderId: string) {
  if (!UUID.test(orderId) || !process.env.MOYSKLAD_ACCESS_TOKEN) throw new Error("invalid_order_reference");
  const request = async (suffix: string) => {
    const response = await fetch(`https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${orderId}${suffix}`, {
      // Two reads stay below the existing 20-second Nginx timeout for this queue.
      method: "GET", redirect: "error", signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${process.env.MOYSKLAD_ACCESS_TOKEN}`, "Accept-Encoding": "gzip" },
    });
    if (!response.ok) throw new Error(response.status === 429 ? "crm_rate_limit" : "crm_read_failed");
    return await response.json() as any;
  };
  const order = await request("?expand=agent");
  if (order.id !== orderId || !order.agent?.name) throw new Error("invalid_order_snapshot");
  const positions = await request("/positions?expand=assortment&limit=1000");
  if (!Array.isArray(positions.rows) || !Number.isInteger(positions.meta?.size) || positions.meta.size !== positions.rows.length) throw new Error("incomplete_order_positions");
  return formatOrder(order, positions.rows);
}

async function failLease(row: any, error: string, now: Date, retryAfter = 0) {
  return query().updateMany({ where: { id: row.id, notificationStatus: "sending", leaseToken: row.leaseToken }, data: {
    notificationStatus: row.attempts >= MAX_ATTEMPTS ? "failed" : "pending", deliveryError: error,
    nextAttemptAt: new Date(now.getTime() + Math.max(retryAfter * 1000, Math.min(3_600_000, 60_000 * 2 ** (row.attempts - 1)))),
    leaseExpiresAt: null,
  } });
}

export async function claimOrder(now = new Date()) {
  if (!enabled()) return null;
  await discoverOrder();
  const due = { $or: [
    { notificationStatus: "pending", $or: [{ nextAttemptAt: { $null: true } }, { nextAttemptAt: { $lte: now } }] },
    { notificationStatus: "sending", leaseExpiresAt: { $lte: now } },
  ] };
  const row = await query().findOne({ where: due, orderBy: { createdAt: "asc" } });
  if (!row) return null;
  const where = { id: row.id, notificationStatus: row.notificationStatus, leaseToken: row.leaseToken || null, attempts: row.attempts, ...due };
  if (row.attempts >= MAX_ATTEMPTS) {
    await query().updateMany({ where, data: { notificationStatus: "failed", deliveryError: "retry_limit", leaseToken: null, leaseExpiresAt: null } });
    return null;
  }
  const leaseToken = randomUUID(), leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const updated = await query().updateMany({ where, data: { notificationStatus: "sending", leaseToken, leaseExpiresAt, attempts: row.attempts + 1, nextAttemptAt: null } });
  if (updated.count !== 1) return null;
  Object.assign(row, { leaseToken, attempts: row.attempts + 1 });
  try {
    const messages = row.messages || await readOrder(row.orderId);
    if (!row.messages) {
      const stored = await query().updateMany({ where: { id: row.id, notificationStatus: "sending", leaseToken }, data: { messages } });
      if (stored.count !== 1) throw new Error("lease_lost");
    }
    return { id: row.id, requestId: row.requestId, leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString(), messages };
  } catch (error) {
    await failLease(row, error instanceof Error && error.message === "crm_rate_limit" ? "crm_rate_limit" : "snapshot_unavailable", new Date());
    strapi.log.warn("[order-notification] snapshot unavailable; queued for retry");
    return null;
  }
}

export function validateCompletion(input: any) {
  if (!input || !Number.isSafeInteger(input.id) || input.id < 1 || typeof input.leaseToken !== "string" || !UUID.test(input.leaseToken)) return null;
  if (input.ok === true && Array.isArray(input.messageIds) && input.messageIds.length > 0 && input.messageIds.length <= 100 && input.messageIds.every((v: any) => typeof v === "string" && /^\d{1,20}$/.test(v))) {
    return { id: input.id, leaseToken: input.leaseToken, ok: true as const, messageIds: input.messageIds as string[] };
  }
  if (input.ok === false && typeof input.error === "string" && /^[a-z0-9_]{1,80}$/.test(input.error)) {
    return { id: input.id, leaseToken: input.leaseToken, ok: false as const, error: input.error,
      retryAfter: typeof input.retryAfter === "number" && Number.isFinite(input.retryAfter) ? Math.max(0, Math.min(86400, Math.ceil(input.retryAfter))) : 0 };
  }
  return null;
}

export async function completeOrder(result: NonNullable<ReturnType<typeof validateCompletion>>, now = new Date()) {
  const row = await query().findOne({ where: { id: result.id } });
  if (!row || row.leaseToken !== result.leaseToken) return false;
  if (result.ok && row.notificationStatus === "sent") return JSON.stringify(row.telegramMessageIds) === JSON.stringify(result.messageIds);
  if (row.notificationStatus !== "sending") return false;
  if (result.ok === false) return (await failLease(row, result.error, now, result.retryAfter)).count === 1;
  if (!Array.isArray(row.messages) || row.messages.length !== result.messageIds.length) return false;
  return (await query().updateMany({ where: { id: row.id, notificationStatus: "sending", leaseToken: result.leaseToken }, data: {
    notificationStatus: "sent", sentAt: now, telegramMessageIds: result.messageIds, deliveryError: null, leaseExpiresAt: null,
  } })).count === 1;
}
