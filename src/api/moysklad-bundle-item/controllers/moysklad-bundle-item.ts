// backend/src/api/moysklad-bundle-item/controllers/moysklad-bundle-item.ts

import { factories } from "@strapi/strapi";
import type { Context } from "koa";
import { syncBundleItemsForBundle } from "../services/sync";
import { enqueueMoySkladMutation } from "../../../utils/moysklad-mutation-queue";

export default factories.createCoreController("api::moysklad-bundle-item.moysklad-bundle-item", () => ({
  async syncOne(ctx: Context) {
    const secret = ctx.request.headers["x-webhook-secret"];

    if (secret !== process.env.MOYSKLAD_WEBHOOK_SECRET) {
      ctx.status = 401;
      ctx.body = { ok: false };
      return;
    }

    const bundleMsId = ctx.request.body?.bundleMsId;

    if (!bundleMsId || typeof bundleMsId !== "string") {
      ctx.status = 400;
      ctx.body = { ok: false, error: "bundleMsId is required" };
      return;
    }

    try {
      const result = await enqueueMoySkladMutation("products", () => syncBundleItemsForBundle(bundleMsId));
      ctx.body = result;
    } catch (err) {
      strapi.log.error(err);
      ctx.status = 500;
      ctx.body = { ok: false, error: "sync_failed" };
    }
  },
}));
