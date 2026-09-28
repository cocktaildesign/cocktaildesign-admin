import { createHash, randomUUID } from "node:crypto";

const UID = "api::feedback.feedback" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 90_000;

type Feedback = { requestId: string; message: string; email: string | null; page: string };
// The new content type is not in the handover's generated type snapshot yet.
const query = () => strapi.db.query(UID as any);

export function validateFeedback(input: unknown): Feedback | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return null;
  if (typeof body.message !== "string" || body.message.length > 3000) return null;
  const message = body.message.trim();
  if (!message || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message)) return null;
  if (body.email != null && typeof body.email !== "string") return null;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length > 254 || (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) return null;
  if (typeof body.page !== "string" || body.page.length > 250 || !/^\/(?!\/)[^\s?#\\]*$/.test(body.page)) return null;
  // Store only the path; query strings can contain customer information.
  return { requestId: body.requestId.toLowerCase(), message, email: email || null, page: body.page };
}

export async function saveFeedback(data: Feedback): Promise<"created" | "replayed" | "conflict"> {
  const payloadHash = createHash("sha256").update(JSON.stringify([data.message, data.email, data.page])).digest("hex");
  const existing = await query().findOne({ where: { requestId: data.requestId } });
  if (existing) return existing.payloadHash === payloadHash ? "replayed" : "conflict";
  try {
    await strapi.documents(UID as any).create({ data: {
      ...data, payloadHash, notificationStatus: "pending", attempts: 0,
    } as any });
    return "created";
  } catch (error) {
    // A simultaneous retry may have won the unique requestId insert.
    const winner = await query().findOne({ where: { requestId: data.requestId } });
    if (winner) return winner.payloadHash === payloadHash ? "replayed" : "conflict";
    throw error;
  }
}

export async function claimFeedback(now = new Date()) {
  const due = { $or: [
    { notificationStatus: "pending", $or: [{ nextAttemptAt: { $null: true } }, { nextAttemptAt: { $lte: now } }] },
    { notificationStatus: "sending", leaseExpiresAt: { $lte: now } },
  ] };
  const row = await query().findOne({ where: due, orderBy: { createdAt: "asc" } });
  if (!row) return null;
  const previousLease = row.leaseToken || null;
  const leaseToken = randomUUID();
  const attempts = Number(row.attempts || 0);
  const where = { id: row.id, notificationStatus: row.notificationStatus,
    leaseToken: previousLease, attempts, ...due };
  if (attempts >= MAX_ATTEMPTS) {
    await query().updateMany({ where, data: {
      notificationStatus: "failed", deliveryError: "retry_limit", leaseToken: null, leaseExpiresAt: null,
    } });
    return null;
  }
  // Conditional update is atomic: two senders cannot acquire the same lease.
  const updated = await query().updateMany({ where, data: {
    notificationStatus: "sending", leaseToken, attempts: attempts + 1,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS), nextAttemptAt: null,
  } });
  if (updated.count !== 1) return null;
  return { id: row.id, requestId: row.requestId, leaseToken,
    message: row.message, email: row.email || null, page: row.page, createdAt: row.createdAt };
}

export function validateDelivery(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0 || typeof body.leaseToken !== "string" || !UUID.test(body.leaseToken)) return null;
  if (body.ok === true && typeof body.messageId === "string" && /^\d{1,20}$/.test(body.messageId)) {
    return { id: Number(body.id), leaseToken: body.leaseToken, ok: true as const, messageId: body.messageId };
  }
  if (body.ok === false && typeof body.error === "string" && /^[a-z0-9_]{1,80}$/.test(body.error)) {
    const retryAfter = typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter)
      ? Math.max(0, Math.min(86_400, Math.ceil(body.retryAfter))) : 0;
    return { id: Number(body.id), leaseToken: body.leaseToken, ok: false as const, error: body.error, retryAfter };
  }
  return null;
}

export async function completeFeedback(result: NonNullable<ReturnType<typeof validateDelivery>>, now = new Date()) {
  const row = await query().findOne({ where: { id: result.id } });
  if (!row) return false;
  if (result.ok && row.notificationStatus === "sent" && row.leaseToken === result.leaseToken && row.telegramMessageId === result.messageId) return true;
  if (row.notificationStatus !== "sending" || row.leaseToken !== result.leaseToken) return false;
  const data = result.ok === true ? {
    notificationStatus: "sent", sentAt: now, telegramMessageId: result.messageId,
    deliveryError: null, leaseExpiresAt: null,
  } : {
    notificationStatus: Number(row.attempts) >= MAX_ATTEMPTS ? "failed" : "pending",
    deliveryError: result.error,
    nextAttemptAt: new Date(now.getTime() + Math.max(result.retryAfter * 1000, Math.min(3_600_000, 30_000 * 2 ** (Number(row.attempts) - 1)))),
    leaseExpiresAt: null,
  };
  const updated = await query().updateMany({ where: {
    id: row.id, notificationStatus: "sending", leaseToken: result.leaseToken,
  }, data });
  return updated.count === 1;
}
