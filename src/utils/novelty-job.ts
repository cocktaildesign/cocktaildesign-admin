import { fetchMoySkladEntityCreatedAt, type MoySkladAuditEntityType } from "./moysklad-audit";

const PRODUCT = "api::moysklad-product.moysklad-product";
const VARIANT = "api::moysklad-variant.moysklad-variant";
export const NOVELTY_STORE = { type: "plugin", name: "moysklad", key: "novelty-sync-v1" } as const;
const SYNC_STORE = { type: "plugin", name: "moysklad", key: "syncState" } as const;
const INTERVAL = 5 * 60_000;
const BATCH = 6; // Up to six variants and six products per run, sequential GET only.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = true;
let running = false;

function timestamp(value: unknown): number {
  return typeof value === "string" || value instanceof Date ? new Date(value).getTime() : NaN;
}

/** Preserve the existing rule: product or latest variant creation; bundles use their own date. */
export function calculateNoveltyDate(product: any): string | null {
  const dates = [product.moyskladCreatedAt];
  if (product.type !== "bundle") dates.push(...(product.variants ?? []).map((v: any) => v.moyskladCreatedAt));
  const valid = dates.map(timestamp).filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null;
}

export function noveltyEnabled() { return process.env.MOYSKLAD_NOVELTY_ENABLED === "true"; }

/** Only metadata fields are written; never prices, flags, descriptions, relations or CRM entities. */
export async function refreshNovelty(app: any) {
  if (!noveltyEnabled() || running) return;
  running = true;
  const deadlineMs = Date.now() + 45_000;
  let savedDates = 0, savedNovelty = 0, failed = 0, pending = 0;
  try {
    if ((await app.store(SYNC_STORE).get())?.lock?.isLocked) return;
    const prior = await app.store(NOVELTY_STORE).get();
    const state = { productCursor: 0, variantCursor: 0, ...prior };
    for (const kind of ["variant", "product"] as const) {
      const query = app.db.query(kind === "variant" ? VARIANT : PRODUCT);
      const key = kind === "variant" ? "variantCursor" : "productCursor";
      let cursor = Number.isSafeInteger(state[key]) && state[key] >= 0 ? state[key] : 0;
      const fields = ["id", "moyskladId", "moyskladCreatedAt", ...(kind === "product" ? ["type"] : [])];
      const find = (after: number) => query.findMany({
        where: { moyskladCreatedAt: { $null: true }, id: { $gt: after } },
        select: fields, orderBy: { id: "asc" }, limit: BATCH,
      });
      let rows = await find(cursor);
      if (!rows.length && cursor) { cursor = 0; rows = await find(0); }
      pending += rows.length;
      for (const row of rows) {
        if (Date.now() >= deadlineMs || (await app.store(SYNC_STORE).get())?.lock?.isLocked) break;
        cursor = row.id; // Missing history/errors must not starve later products; retry next sweep.
        if (!UUID.test(row.moyskladId ?? "")) { failed++; continue; }
        const entity: MoySkladAuditEntityType = kind === "variant" ? "variant" : row.type === "bundle" ? "bundle" : "product";
        try {
          const date = await fetchMoySkladEntityCreatedAt(entity, row.moyskladId, {
            maxPages: 20, maxAttempts: 1, timeoutMs: 5000, deadlineMs,
          });
          if (!date || !Number.isFinite(timestamp(date)) || timestamp(date) > Date.now()) { failed++; continue; }
          // Compare-and-set: preserve any value filled concurrently by an editor or another process.
          const result = await query.updateMany({
            where: { id: row.id, moyskladId: row.moyskladId, moyskladCreatedAt: { $null: true } },
            data: { moyskladCreatedAt: date },
          });
          savedDates += result.count;
        } catch {
          failed++;
          break; // Rate limits/network/DB failures: stop this batch; do not retry in a tight loop.
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      state[key] = cursor;
    }
    // Reconcile dates already known, including interrupted earlier runs and newly linked variants.
    // Read in bounded pages. ORM updateMany bypasses document middleware; only novelty metadata changes.
    for (let after = 0; Date.now() < deadlineMs;) {
      if ((await app.store(SYNC_STORE).get())?.lock?.isLocked) break;
      const query = app.db.query(PRODUCT);
      const rows = await query.findMany({ where: { id: { $gt: after } },
        select: ["id", "type", "moyskladId", "moyskladCreatedAt", "moyskladNoveltyAt"],
        populate: { variants: { select: ["moyskladCreatedAt"] } }, orderBy: { id: "asc" }, limit: 100 });
      if (!rows.length) break;
      for (const row of rows) {
        const next = calculateNoveltyDate(row);
        if (!next || timestamp(next) > Date.now() || timestamp(row.moyskladNoveltyAt) >= timestamp(next)) continue;
        const result = await query.updateMany({ where: { id: row.id, moyskladId: row.moyskladId,
          $or: [{ moyskladNoveltyAt: { $null: true } }, { moyskladNoveltyAt: { $lt: next } }] },
          data: { moyskladNoveltyAt: next } });
        savedNovelty += result.count;
      }
      after = rows[rows.length - 1].id;
    }
    await app.store(NOVELTY_STORE).set({ value: { version: 1, productCursor: state.productCursor,
      variantCursor: state.variantCursor, lastRunAt: new Date().toISOString(), savedDates, savedNovelty, failed } });
    if (pending || savedNovelty) app.log.info(`[novelty] Creation dates: ${savedDates}; novelty dates: ${savedNovelty}; deferred: ${failed}`);
  } catch {
    // Do not include HTTP errors/headers: secrets may be present. Confirmed dates remain intact.
    app.log.warn("[novelty] Refresh failed; confirmed dates retained, retry scheduled");
  } finally { running = false; }
}

export function startNoveltyJob(app: any) {
  stopNoveltyJob();
  if (!noveltyEnabled()) return;
  stopped = false;
  const tick = async () => {
    await refreshNovelty(app);
    if (!stopped) { timer = setTimeout(tick, INTERVAL); timer.unref(); }
  };
  timer = setTimeout(tick, 45_000);
  timer.unref();
}

export function stopNoveltyJob() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
