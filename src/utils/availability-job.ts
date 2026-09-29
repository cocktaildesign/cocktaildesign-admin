import { AVAILABILITY_STORE, parseAvailabilitySnapshot, readMoySkladAvailability, type AvailabilitySnapshot } from "./moysklad-availability";
import { getStorefrontVisibleProductFilter } from "./storefront-product-visibility";

const INTERVAL = 5 * 60_000;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = true;
let running = false;
let cached: AvailabilitySnapshot | null = null;
let loaded = false;
let loading: Promise<void> | undefined;

export function availabilityEnabled() { return process.env.MOYSKLAD_AVAILABILITY_ENABLED === "true"; }

export async function getAvailabilitySnapshot(app: any) {
  if (!availabilityEnabled()) return { updatedAt: null, states: {} };
  if (!loaded) {
    loading ??= (async () => {
      try { cached = parseAvailabilitySnapshot(await app.store(AVAILABILITY_STORE).get()); loaded = true; }
      catch { app.log.warn("[availability] Cannot read saved snapshot; badges unchanged"); }
      finally { loading = undefined; }
    })();
    await loading;
  }
  return { updatedAt: cached?.updatedAt ?? null, states: cached?.states ?? {} };
}

export async function refreshAvailability(app: any) {
  if (!availabilityEnabled() || running) return;
  running = true;
  try {
    const sync = await app.store({ type: "plugin", name: "moysklad", key: "syncState" }).get();
    if (sync?.lock?.isLocked) return; // Do not add CRM requests during a full catalog sync.
    const states = await readMoySkladAvailability(process.env.MOYSKLAD_ACCESS_TOKEN ?? "");
    const products = await app.db.query("api::moysklad-product.moysklad-product").findMany({
      where: getStorefrontVisibleProductFilter(), select: ["moyskladId"],
      populate: { variants: { select: ["moyskladId"] } },
    });
    // Expose only IDs already on the storefront, never quantities or the full CRM assortment.
    const visible: Record<string, boolean> = {};
    for (const product of products) {
      const variants = product.variants ?? [];
      for (const item of [product, ...variants]) {
        const state = states.get(item.moyskladId);
        if (state !== undefined) visible[item.moyskladId] = state;
      }
      if (variants.length) {
        const variantStates = variants.map((variant: any) => states.get(variant.moyskladId));
        // A parent card represents its variants; a specific selected variant uses its own ID.
        if (variantStates.includes(false)) visible[product.moyskladId] = false;
        else if (variantStates.every((state: boolean | undefined) => state === true)) visible[product.moyskladId] = true;
        else delete visible[product.moyskladId];
      }
    }
    if (!Object.keys(visible).length) throw new Error("availability_no_matching_products");
    const next: AvailabilitySnapshot = { version: 1, updatedAt: new Date().toISOString(), states: visible };
    // Publish atomically only after every CRM page and DB read succeeded.
    await app.store(AVAILABILITY_STORE).set({ value: next });
    cached = next; loaded = true;
    app.log.info(`[availability] Updated ${Object.keys(visible).length} storefront products/variants`);
  } catch {
    // Do not log fetch errors/headers: they may contain credentials. Last good snapshot survives.
    app.log.warn("[availability] Refresh failed; keeping last confirmed snapshot");
  } finally { running = false; }
}

export function startAvailabilityJob(app: any) {
  stopAvailabilityJob();
  if (!availabilityEnabled()) return;
  stopped = false;
  const tick = async () => {
    await refreshAvailability(app);
    if (!stopped) { timer = setTimeout(tick, INTERVAL); timer.unref(); }
  };
  timer = setTimeout(tick, 30_000);
  timer.unref();
}

export function stopAvailabilityJob() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
