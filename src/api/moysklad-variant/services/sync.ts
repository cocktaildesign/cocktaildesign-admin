// backend/src/api/moysklad-variant/services/sync.ts
//
// Задача файла:
// 1) Забрать варианты (variant) из MoySklad (пагинацией)
// 2) Найти соответствующий product в Strapi по moyskladId (из v.product.meta.href)
// 3) Сделать upsert variants в Strapi
// 4) Удалить variants, которых больше нет в MoySklad
//
// Важно:
// - Этот синк предполагает, что sync/products уже выполнен.
// - Если product не найден — variant пропускаем (skippedNoProduct).
//
// Надёжность сети:
// - fetch в Node может падать по таймауту подключения (UND_ERR_CONNECT_TIMEOUT)
// - добавлен retry + увеличенный timeout через AbortController
import {
  getWebsitePrices,
  type MoySkladSalePrice,
} from "../../../utils/moysklad-prices";
import {
  acquireMoySkladSyncLock,
  releaseMoySkladSyncLock,
  markSyncError,
  markSyncOk,
  markSyncRunning,
} from "../../../utils/moysklad-sync-state";
import { enqueueMoySkladFullSync } from "../../../utils/moysklad-mutation-queue";
import { rebuildAllProductSearchIndexes } from "../../../utils/rebuild-product-search-index";

type MoySkladMeta = { href: string };

type MoySkladCharacteristic = {
  name: string;
  value: string;
};

type MoySkladVariant = {
  id: string;
  name: string;
  code?: string;
  updated?: string;

  product: {
    meta: MoySkladMeta; // href на entity/product/<uuid>
  };

  salePrices?: MoySkladSalePrice[];
  characteristics?: MoySkladCharacteristic[];
};

type MoySkladVariantListResponse = {
  rows: MoySkladVariant[];
  meta: {
    nextHref?: string;
  };
};

function getMoySkladHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json;charset=utf-8",
  } as const;
}

/**
 * Достаём UUID из href.
 * Важно: режем ?query и #hash, чтобы не получить кривой ID.
 */
function pickIdFromHref(href?: string): string | null {
  if (!href) return null;

  const clean = href.split("?")[0]?.split("#")[0];
  if (!clean) return null;

  const parts = clean.split("/");
  const last = parts[parts.length - 1];

  return last ? last : null;
}

function isMoySkladVariantListResponse(data: unknown): data is MoySkladVariantListResponse {
  if (!data || typeof data !== "object") return false;

  const d = data as { rows?: unknown; meta?: unknown };
  const hasRows = Array.isArray(d.rows);
  const hasMeta = typeof d.meta === "object" && d.meta !== null;

  return hasRows && hasMeta;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(err: unknown): boolean {
  // undici кладёт код в cause.code
  const e = err as { cause?: { code?: string } };
  const code = e?.cause?.code;

  return code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_SOCKET" || code === "UND_ERR_HEADERS_TIMEOUT";
}

type RateLimitBudget = { waitedMs: number };
const MAX_RATE_LIMIT_WAIT_MS = 60_000; // На весь проход, а не на каждую страницу.

function rateLimitDelayMs(response: Response, attempt: number): number | null {
  // MoySklad JSON API: оба заголовка содержат оставшееся время в миллисекундах.
  const delays = [3_000 * 2 ** (attempt - 1)];
  for (const name of ["X-Lognex-Retry-After", "X-Lognex-Reset"]) {
    const value = response.headers.get(name)?.trim();
    if (value && /^\d+(?:\.\d+)?$/.test(value)) delays.push(Number(value));
  }
  const delayMs = Math.ceil(Math.max(...delays)) + 250;
  // Не повторяем раньше разрешённого API времени и не удерживаем очередь надолго.
  return Number.isFinite(delayMs) && delayMs <= 30_000 ? delayMs : null;
}

/**
 * Только чтение вариантов: прежние сетевые retry + ограниченный повтор HTTP 429.
 * Другие HTTP-ошибки и ошибки JSON не повторяем. Запросы заказов не затронуты.
 */
async function fetchWithRetry(url: string, token: string, budget: RateLimitBudget): Promise<Response> {
  const maxAttempts = 4; // 1 + 3 повтора
  const timeoutMs = 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, {
          headers: getMoySkladHeaders(token),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429 && attempt < maxAttempts) {
        const delayMs = rateLimitDelayMs(res, attempt);
        if (delayMs !== null && budget.waitedMs + delayMs <= MAX_RATE_LIMIT_WAIT_MS) {
          // Освобождаем ответ до ожидания. Тело последней ошибки оставляем вызывающему коду.
          await res.body?.cancel();
          budget.waitedMs += delayMs;
          strapi.log.warn(`[moysklad-variant] HTTP 429: retry=${attempt}/${maxAttempts - 1} delayMs=${delayMs} totalWaitMs=${budget.waitedMs}`);
          await sleep(delayMs);
          continue;
        }
        strapi.log.warn("[moysklad-variant] HTTP 429: retry wait limit reached; keeping existing variants");
      }
      return res;
    } catch (err) {
      const retryable = isRetryableFetchError(err);

      if (retryable && attempt < maxAttempts) {
        const backoffMs = 500 * attempt; // 500ms, 1000ms, 1500ms
        strapi.log.warn(`[moysklad] fetch retry: attempt=${attempt}/${maxAttempts} backoff=${backoffMs}ms url=${url}`);
        await sleep(backoffMs);
        continue;
      }

      throw err;
    }
  }

  throw new Error("fetchWithRetry: exhausted");
}

async function fetchVariantJson(url: string, token: string, budget: RateLimitBudget): Promise<MoySkladVariantListResponse> {
  const res = await fetchWithRetry(url, token, budget);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MoySklad API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as unknown;

  if (!isMoySkladVariantListResponse(data)) {
    throw new Error(`Unexpected MoySklad response shape (variant): ${JSON.stringify(data).slice(0, 500)}`);
  }

  return data;
}

/**
 * Синк ВСЕХ variants (без очереди — вызывать только через syncAllVariants).
 * Предусловие: товары уже синкнуты, иначе не найдём product в Strapi.
 */
async function syncAllVariantsUnlocked(): Promise<{ upserted: number; skippedNoProduct: number }> {
  await acquireMoySkladSyncLock("variants");
  await markSyncRunning("variants");

  try {
    const token = process.env.MOYSKLAD_ACCESS_TOKEN;
    if (!token) throw new Error("MOYSKLAD_ACCESS_TOKEN is not set");

    const variantQuery = strapi.db.query("api::moysklad-variant.moysklad-variant");
    const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");

    const keepVariantMsIds = new Set<string>();

    // 1) Забираем всё из MoySklad (пагинация)
    const all: MoySkladVariant[] = [];
    let offset = 0;
    const rateLimitBudget: RateLimitBudget = { waitedMs: 0 };

    while (true) {
      const url = `https://api.moysklad.ru/api/remap/1.2/entity/variant?limit=100&offset=${offset}`;
      const data = await fetchVariantJson(url, token, rateLimitBudget);

      all.push(...data.rows);

      if (!data.meta.nextHref) break;
      offset += 100;
    }

    // 2) Upsert
    let upserted = 0;
    let skippedNoProduct = 0;

    for (const v of all) {
      keepVariantMsIds.add(v.id);

      const productMsId = pickIdFromHref(v.product?.meta?.href);
      if (!productMsId) {
        skippedNoProduct += 1;
        continue;
      }

      const product = await productQuery.findOne({
        where: { moyskladId: productMsId },
        select: ["id"],
      });

      if (!product) {
        skippedNoProduct += 1;
        continue;
      }

      const existing = await variantQuery.findOne({
        where: { moyskladId: v.id },
        select: ["id"],
      });
      const websitePrices = getWebsitePrices(v.salePrices);

      const payload = {
        name: v.name,
        moyskladId: v.id,
        href: `https://api.moysklad.ru/api/remap/1.2/entity/variant/${v.id}`, // ← добавить
        code: v.code ?? null,
        updated: v.updated ?? null,
        product: product.id,
        characteristics: v.characteristics ?? [],
        price: websitePrices.price,
        priceOld: websitePrices.priceOld,
        publishedAt: new Date().toISOString(),
      };

      if (existing) {
        await variantQuery.update({ where: { id: existing.id }, data: payload });
      } else {
        await variantQuery.create({ data: payload });
      }

      upserted += 1;
    }

    // 3) Чистка: удаляем variants, которых больше нет в МС
    if (keepVariantMsIds.size === 0) {
      throw new Error("Variant sync aborted: MoySklad returned zero variants");
    }

    await variantQuery.deleteMany({
      where: { moyskladId: { $notIn: Array.from(keepVariantMsIds) } },
    });

    const searchIndexResult = await rebuildAllProductSearchIndexes(strapi);

    strapi.log.info(
      `[moysklad-variant] search index rebuilt: scanned=${searchIndexResult.scanned} changed=${searchIndexResult.changed} unchanged=${searchIndexResult.unchanged}`,
    );

    const result = { upserted, skippedNoProduct };

    await markSyncOk("variants");

    return result;
  } catch (error) {
    await markSyncError("variants", error);
    throw error;
  } finally {
    await releaseMoySkladSyncLock("variants");
  }
}

export async function syncAllVariants(): Promise<{ upserted: number; skippedNoProduct: number }> {
  return enqueueMoySkladFullSync("variants", syncAllVariantsUnlocked);
}
