import type { Context } from "koa";
import { workerAuthorized } from "../../feedback/controllers/feedback";
import { claimOrder, completeOrder, enabled, validateCompletion } from "../utils/queue";

function ready(ctx: Context) {
  ctx.set("Cache-Control", "no-store");
  if (!workerAuthorized(ctx)) { ctx.status = 401; ctx.body = { ok: false }; return false; }
  if (!enabled()) { ctx.status = 503; ctx.body = { ok: false }; return false; }
  return true;
}
export default {
  async claim(ctx: Context) {
    if (!ready(ctx)) return;
    try { ctx.body = { ok: true, item: await claimOrder() }; }
    catch { strapi.log.error("[order-notification] claim failed"); ctx.status = 503; ctx.body = { ok: false }; }
  },
  async complete(ctx: Context) {
    if (!ready(ctx)) return;
    const result = validateCompletion(ctx.request.body);
    if (!result) { ctx.status = 400; ctx.body = { ok: false }; return; }
    try {
      if (!await completeOrder(result)) { ctx.status = 409; ctx.body = { ok: false }; return; }
      ctx.body = { ok: true };
    } catch { strapi.log.error("[order-notification] completion failed"); ctx.status = 503; ctx.body = { ok: false }; }
  },
};
