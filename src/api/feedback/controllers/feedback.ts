import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context } from "koa";
import { claimFeedback, completeFeedback, saveFeedback, validateDelivery, validateFeedback } from "../utils/feedback";

const windows = new Map<string, { until: number; count: number }>();
function allowance(key: string, limit: number, duration: number) {
  const now = Date.now();
  for (const [entry, value] of windows) if (value.until <= now) windows.delete(entry);
  let value = windows.get(key);
  if (!value) {
    if (windows.size >= 10_000) return false;
    value = { until: now + duration, count: 0 };
    windows.set(key, value);
  }
  return ++value.count <= limit;
}
function fail(ctx: Context, status: number, error: string) {
  ctx.status = status;
  ctx.body = { ok: false, error };
}
export function workerAuthorized(ctx: Context) {
  const secret = process.env.FEEDBACK_WORKER_TOKEN || "";
  const supplied = ctx.get("authorization").replace(/^Bearer /, "");
  const expectedBytes = Buffer.from(secret);
  const suppliedBytes = Buffer.from(supplied);
  return secret.length >= 32 && suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}
function workerReady(ctx: Context) {
  ctx.set("Cache-Control", "no-store");
  if (!workerAuthorized(ctx)) { fail(ctx, 401, "unauthorized"); return false; }
  if (process.env.FEEDBACK_ENABLED !== "true") { fail(ctx, 503, "unavailable"); return false; }
  return true;
}

export default {
  async create(ctx: Context) {
    ctx.set("Cache-Control", "no-store");
    if (process.env.FEEDBACK_ENABLED !== "true") return fail(ctx, 503, "unavailable");
    const origin = ctx.get("origin");
    const origins = ["https://new.cocktaildesign.ru", "https://cocktaildesign.ru", "https://www.cocktaildesign.ru"];
    if (process.env.NODE_ENV !== "production") origins.push("http://localhost:3000", "http://127.0.0.1:3000");
    if (origin && !origins.includes(origin)) return fail(ctx, 403, "invalid_origin");
    if (!ctx.is("application/json")) return fail(ctx, 415, "invalid_content_type");
    // Nginx must overwrite X-Real-IP and Strapi must remain bound to loopback.
    const realIp = ctx.get("x-real-ip");
    const ip = isIP(realIp) ? realIp : ctx.ip;
    if (!allowance("global", 120, 60_000) || !allowance(`ip:${ip}`, 10, 600_000)) {
      ctx.set("Retry-After", "600");
      return fail(ctx, 429, "rate_limited");
    }
    const data = validateFeedback(ctx.request.body);
    if (!data) return fail(ctx, 400, "invalid_payload");
    try {
      const result = await saveFeedback(data);
      if (result === "conflict") return fail(ctx, 409, "request_conflict");
      ctx.status = result === "created" ? 201 : 200;
      ctx.body = { ok: true, requestId: data.requestId };
    } catch {
      strapi.log.error("[feedback] save failed");
      return fail(ctx, 503, "save_failed");
    }
  },
  async claim(ctx: Context) {
    if (!workerReady(ctx)) return;
    try { ctx.body = { ok: true, item: await claimFeedback() }; }
    catch { strapi.log.error("[feedback] claim failed"); fail(ctx, 503, "claim_failed"); }
  },
  async complete(ctx: Context) {
    if (!workerReady(ctx)) return;
    const result = validateDelivery(ctx.request.body);
    if (!result) return fail(ctx, 400, "invalid_payload");
    try {
      if (!await completeFeedback(result)) return fail(ctx, 409, "lease_conflict");
      ctx.body = { ok: true };
    } catch { strapi.log.error("[feedback] completion failed"); fail(ctx, 503, "completion_failed"); }
  },
};
