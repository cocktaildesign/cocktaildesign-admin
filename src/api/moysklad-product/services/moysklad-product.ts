// backend/src/api/moysklad-product/services/moysklad-product.ts
//
// ИЗМЕНЕНИЯ по сравнению с предыдущей версией:
// - Убраны N+1 запросы в цикле upsert для products и bundles.
//   Раньше: findOne(...) на каждый товар внутри for-loop = тысячи запросов.
//   Теперь: один findMany(...) ДО цикла → Map<moyskladId, strapiId> → O(1) lookup.
// - syncAllVariants аналогично (один findMany до цикла).
// - Остальная логика не тронута.

import { factories } from "@strapi/strapi";
import {
  acquireMoySkladSyncLock,
  releaseMoySkladSyncLock,
  markSyncError,
  markSyncOk,
  markSyncRunning,
} from "../../../utils/moysklad-sync-state";
import { enqueueMoySkladFullSync } from "../../../utils/moysklad-mutation-queue";
import {
  getWebsitePrices,
  type MoySkladSalePrice,
} from "../../../utils/moysklad-prices";
import { isOwnProductionMoySkladProduct } from "../../../utils/moysklad-own-production";
import { getStorefrontVisibleProductFilter } from "../../../utils/storefront-product-visibility";
import { rebuildProductSearchIndex } from "../../../utils/rebuild-product-search-index";
import {
  SAMPLE_SALE_FOLDER_ID,
  buildClearedSampleSaleStockFields,
  buildSampleSaleMoyskladIdSetFromStrapiCategories,
  buildSampleSaleStockFields,
  buildSampleSaleStockMap,
  fetchSampleSaleAssortment,
  fetchSampleSaleAssortmentItemById,
  isInsideSampleSaleFolderTree,
  type SampleSaleAssortmentItem,
} from "../../../utils/moysklad-sample-sale";

import { syncBundleItemsForBundle } from "../../moysklad-bundle-item/services/sync";

const OWN_PRODUCTION_COLLECTION_SLUG = "nashe-proizvodstvo";

// ---------------------------------------------------------------------------
// Типы MoySklad
// ---------------------------------------------------------------------------

type MoySkladMeta = {
  href: string;
};

// Общая форма для product и bundle — поля одинаковые
type MoySkladProductOrBundle = {
  id: string;
  name: string;
  code?: string;
  updated?: string;
  description?: string;
  meta: MoySkladMeta;

  productFolder?: {
    meta: MoySkladMeta;
  };

  salePrices?: MoySkladSalePrice[];

  uom?: {
    name?: string;
  };

  weight?: number | null;
  volume?: number | null;

  supplier?: {
    meta?: {
      href?: string;
    };
  };
  pathName?: string;
  archived?: boolean;
};

// Webhook payload может приходить "не строгим" — подстраховываемся
type MoySkladWebhookProduct = {
  id?: string;
  name?: string;
  code?: string;
  updated?: string;
  description?: string;
  meta?: { href?: string };

  productFolder?: { meta?: { href?: string } };

  salePrices?: MoySkladSalePrice[];

  uom?: { name?: string };

  weight?: number | null;
  volume?: number | null;

  supplier?: {
    meta?: {
      href?: string;
    };
  };
  pathName?: string;
  archived?: boolean;
};

type MoySkladListResponse = {
  rows: MoySkladProductOrBundle[];
  meta: {
    nextHref?: string;
  };
};

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function getMoySkladHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json;charset=utf-8",
  } as const;
}

/**
 * UUID из href — режем ?query и #hash, берём последний сегмент пути.
 */
function pickIdFromHref(href?: string): string | null {
  if (!href) return null;

  const clean = href.split("?")[0]?.split("#")[0];
  if (!clean) return null;

  const parts = clean.split("/");
  const last = parts[parts.length - 1];

  return last ? last : null;
}

/**
 * Стабильный slug из MoySklad ID.
 * Не используем name → URL не ломается при переименовании товара.
 */
function makeStableSlug(moyskladId: string): string {
  return `ms-${moyskladId.slice(0, 8)}`;
}

/** Общая часть payload для product и bundle из MoySklad и webhook. */
type MoySkladOwnedSource = {
  name?: string;
  code?: string;
  updated?: string;
  description?: string;
  salePrices?: MoySkladSalePrice[];
  uom?: { name?: string };
  weight?: number | null;
  volume?: number | null;
};

type ProductPayloadParams = {
  type: "product" | "bundle";
  moyskladId: string;
  href: string;
  categoryId: number;
};

/**
 * Поля, владельцем которых является MoySklad.
 *
 * Сюда НЕ входят ручные поля Strapi: image, badges, isHiddenOnSite, lockImages,
 * discountExcluded, specifications, composition, catalog_collections,
 * а также displayTitle / slug, которые менеджер правит вручную у Sample Sale.
 * Описание всех товаров принадлежит MoySklad; сохраняем его пробелы и переносы.
 */
function buildMoySkladOwnedProductFields(
  source: MoySkladOwnedSource,
  params: ProductPayloadParams,
): Record<string, unknown> {
  const websitePrices = getWebsitePrices(source.salePrices);

  return {
    type: params.type,
    name: source.name ?? "",
    description: typeof source.description === "string" ? source.description : null,
    moyskladId: params.moyskladId,
    href: params.href,
    code: source.code ?? null,
    updated: source.updated ?? null,
    category: params.categoryId,
    price: websitePrices.price,
    priceOld: websitePrices.priceOld,
    uom: source.uom?.name ?? null,
    weight: typeof source.weight === "number" ? source.weight : null,
    volume: typeof source.volume === "number" ? source.volume : null,
  };
}

/**
 * Полный payload синхронизации: поля MoySklad + displayTitle/slug.
 * Используется при create и при обычном (не Sample Sale) update.
 */
function buildFullProductPayload(
  source: MoySkladOwnedSource,
  params: ProductPayloadParams & { nowIso: string; canWriteSlug: boolean },
): Record<string, unknown> {
  const payload = buildMoySkladOwnedProductFields(source, params);

  payload.displayTitle = source.name ?? "";
  payload.publishedAt = params.nowIso;

  if (params.canWriteSlug) {
    payload.slug = makeStableSlug(params.moyskladId);
  }

  return payload;
}

/**
 * Один раз загружает Set moyskladId дерева Sample Sale из Strapi.
 * Без N+1: один findMany + in-memory BFS.
 */
async function loadSampleSaleFolderIdSet(): Promise<Set<string>> {
  const categoryQuery = strapi.db.query("api::moysklad-category.moysklad-category");

  const rows = await categoryQuery.findMany({
    select: ["id", "moyskladId"],
    populate: { parent: { select: ["id"] } },
    limit: 100000,
  });

  return buildSampleSaleMoyskladIdSetFromStrapiCategories(
    Array.isArray(rows) ? rows : [],
  );
}

/**
 * Скрывает ранее импортированный товар Sample Sale вместо физического удаления.
 * Возвращает true, если товар относится к дереву Sample Sale (корень или descendant).
 */
async function hideSampleSaleProductIfNeeded(moyskladId: string): Promise<boolean> {
  const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");

  const product = await productQuery.findOne({
    where: { moyskladId, type: "product" },
    select: ["id", "isOutOfStock"],
    populate: {
      category: { select: ["moyskladId"] },
    },
  });

  const categoryMsId =
    (product as { category?: { moyskladId?: string | null } | null } | null)?.category
      ?.moyskladId ?? null;

  if (!product || !categoryMsId) {
    return false;
  }

  const sampleSaleFolderIds = await loadSampleSaleFolderIdSet();

  if (!isInsideSampleSaleFolderTree(categoryMsId, sampleSaleFolderIds)) {
    return false;
  }

  if (product.isOutOfStock !== true) {
    await productQuery.update({
      where: { id: product.id },
      data: { isOutOfStock: true },
    });
  }

  strapi.log.info(`[moysklad-sample-sale] record preserved and hidden: ${moyskladId}`);
  return true;
}

/**
 * Type-guard для ответа MoySklad list (используется и для product, и для bundle).
 */
function isMoySkladListResponse(data: unknown): data is MoySkladListResponse {
  if (!data || typeof data !== "object") return false;

  const d = data as { rows?: unknown; meta?: unknown };

  return Array.isArray(d.rows) && typeof d.meta === "object" && d.meta !== null;
}

async function fetchMoySkladList(url: string, token: string): Promise<MoySkladListResponse> {
  const res = await fetch(url, { headers: getMoySkladHeaders(token) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MoySklad API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as unknown;

  if (!isMoySkladListResponse(data)) {
    throw new Error(`Unexpected MoySklad response shape: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return data;
}

/**
 * Проверяет, есть ли атрибут у content-type в схеме Strapi.
 * Используется чтобы безопасно писать поля, которые могут ещё не существовать
 * (например, при постепенной миграции схемы).
 */
function hasCategoryAttribute(attrName: string): boolean {
  const ct = strapi.contentTypes["api::moysklad-category.moysklad-category"];
  return Boolean(ct?.attributes && Object.prototype.hasOwnProperty.call(ct.attributes, attrName));
}

function hasProductAttribute(attrName: string): boolean {
  const ct = strapi.contentTypes["api::moysklad-product.moysklad-product"];
  return Boolean(ct?.attributes && Object.prototype.hasOwnProperty.call(ct.attributes, attrName));
}

/**
 * Находит documentId опубликованной подборки «Наше производство».
 */
async function findOwnProductionCollectionDocumentId(): Promise<string | null> {
  const collection = await strapi
    .documents("api::catalog-collection.catalog-collection")
    .findFirst({
      filters: { slug: OWN_PRODUCTION_COLLECTION_SLUG },
      status: "published",
    });

  if (!collection?.documentId) {
    strapi.log.warn(
      `[moysklad-product] own production collection not found: slug=${OWN_PRODUCTION_COLLECTION_SLUG}`,
    );
    return null;
  }

  return collection.documentId;
}

/**
 * Полная замена relation products у подборки «Наше производство».
 * Strapi 5 Document Service + set по documentId.
 */
async function replaceOwnProductionCollectionProducts(productDocumentIds: string[]) {
  const collectionDocumentId = await findOwnProductionCollectionDocumentId();
  if (!collectionDocumentId) {
    return;
  }

  const data: Record<string, unknown> = {
    products: {
      set: productDocumentIds,
    },
  };

  await strapi.documents("api::catalog-collection.catalog-collection").update({
    documentId: collectionDocumentId,
    data,
    status: "published",
  });

  strapi.log.info(
    `[moysklad-product] own production collection updated: products=${productDocumentIds.length}`,
  );
}

async function addProductToOwnProductionCollection(productDocumentId: string) {
  const collection = await strapi
    .documents("api::catalog-collection.catalog-collection")
    .findFirst({
      filters: { slug: OWN_PRODUCTION_COLLECTION_SLUG },
      status: "published",
      populate: {
        products: {
          fields: ["documentId"],
        },
      },
    });

  if (!collection?.documentId) {
    strapi.log.warn(
      `[moysklad-product] own production collection not found: slug=${OWN_PRODUCTION_COLLECTION_SLUG}`,
    );
    return;
  }

  const products = (collection as { products?: Array<{ documentId?: string }> }).products ?? [];
  const alreadyInCollection = products.some(
    (product) => product.documentId === productDocumentId,
  );

  if (alreadyInCollection) {
    return;
  }

  const data: Record<string, unknown> = {
    products: {
      connect: [productDocumentId],
    },
  };

  await strapi.documents("api::catalog-collection.catalog-collection").update({
    documentId: collection.documentId,
    data,
    status: "published",
  });
}

async function removeProductFromOwnProductionCollection(productDocumentId: string) {
  const collectionDocumentId = await findOwnProductionCollectionDocumentId();
  if (!collectionDocumentId) {
    return;
  }

  const data: Record<string, unknown> = {
    products: {
      disconnect: [productDocumentId],
    },
  };

  await strapi.documents("api::catalog-collection.catalog-collection").update({
    documentId: collectionDocumentId,
    data,
    status: "published",
  });
}

async function removeProductFromOwnProductionCollectionByMoyskladId(moyskladId: string) {
  const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");

  const product = await productQuery.findOne({
    where: { moyskladId },
    select: ["id", "documentId"],
  });

  const productDocumentId =
    product && typeof (product as { documentId?: unknown }).documentId === "string"
      ? (product as { documentId: string }).documentId
      : null;

  if (!productDocumentId) {
    return;
  }

  await removeProductFromOwnProductionCollection(productDocumentId);
}

async function syncProductInOwnProductionCollection(
  productDocumentId: string,
  shouldBeInCollection: boolean,
) {
  if (shouldBeInCollection) {
    await addProductToOwnProductionCollection(productDocumentId);
    return;
  }

  await removeProductFromOwnProductionCollection(productDocumentId);
}

// ---------------------------------------------------------------------------
// Пересчёт счётчиков категорий
// ---------------------------------------------------------------------------

/**
 * Пересчитывает productsCount по дереву категорий.
 * Получает на вход прямые (direct) счётчики и рекурсивно складывает дочерние.
 *
 * productsCount = totalProducts + totalBundles (единый счётчик для витрины).
 */
async function recomputeCategoryCountsForTree(
  directProductsByCategoryId: Map<number, number>,
  directBundlesByCategoryId: Map<number, number>,
) {
  const categoryQuery = strapi.db.query("api::moysklad-category.moysklad-category");

  const categories = await categoryQuery.findMany({
    select: ["id"],
    populate: { parent: { select: ["id"] } },
    limit: 100000,
  });

  // Строим Map: parentId → [childId, childId, ...]
  const childrenByParentId = new Map<number, number[]>();
  for (const c of categories) {
    const parentId = c.parent?.id;
    if (!parentId) continue;

    const arr = childrenByParentId.get(parentId) ?? [];
    arr.push(c.id);
    childrenByParentId.set(parentId, arr);
  }

  const totalProductsByCategoryId = new Map<number, number>();
  const totalBundlesByCategoryId = new Map<number, number>();

  // Рекурсия с кэшом (memoization) — избегаем повторного обхода поддерева
  const computeTotalProducts = (categoryId: number): number => {
    const cached = totalProductsByCategoryId.get(categoryId);
    if (cached !== undefined) return cached;

    let total = directProductsByCategoryId.get(categoryId) ?? 0;
    for (const childId of childrenByParentId.get(categoryId) ?? []) {
      total += computeTotalProducts(childId);
    }

    totalProductsByCategoryId.set(categoryId, total);
    return total;
  };

  const computeTotalBundles = (categoryId: number): number => {
    const cached = totalBundlesByCategoryId.get(categoryId);
    if (cached !== undefined) return cached;

    let total = directBundlesByCategoryId.get(categoryId) ?? 0;
    for (const childId of childrenByParentId.get(categoryId) ?? []) {
      total += computeTotalBundles(childId);
    }

    totalBundlesByCategoryId.set(categoryId, total);
    return total;
  };

  // Флаги для опциональных полей схемы (могут ещё не существовать)
  const canWriteDirect = hasCategoryAttribute("productsCountDirect");
  const canWriteTotal = hasCategoryAttribute("productsCountTotal");
  const canWriteProductsDirect = hasCategoryAttribute("productsCountProductsDirect");
  const canWriteProductsTotal = hasCategoryAttribute("productsCountProductsTotal");
  const canWriteBundlesDirect = hasCategoryAttribute("productsCountBundlesDirect");
  const canWriteBundlesTotal = hasCategoryAttribute("productsCountBundlesTotal");

  for (const c of categories) {
    const directProducts = directProductsByCategoryId.get(c.id) ?? 0;
    const directBundles = directBundlesByCategoryId.get(c.id) ?? 0;

    const totalProducts = computeTotalProducts(c.id);
    const totalBundles = computeTotalBundles(c.id);

    const data: Record<string, unknown> = {
      // Основной счётчик для витрины — products + bundles вместе
      productsCount: totalProducts + totalBundles,
    };

    if (canWriteDirect) data.productsCountDirect = directProducts + directBundles;
    if (canWriteTotal) data.productsCountTotal = totalProducts + totalBundles;
    if (canWriteProductsDirect) data.productsCountProductsDirect = directProducts;
    if (canWriteProductsTotal) data.productsCountProductsTotal = totalProducts;
    if (canWriteBundlesDirect) data.productsCountBundlesDirect = directBundles;
    if (canWriteBundlesTotal) data.productsCountBundlesTotal = totalBundles;

    await categoryQuery.update({ where: { id: c.id }, data });
  }
}

/**
 * Пересчёт счётчиков ТОЛЬКО по данным из БД Strapi (без запросов в MoySklad).
 * Используется после webhook upsert/delete — быстро и без лишних запросов наружу.
 */
async function recomputeCategoryCountsFromDb() {
  const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");

  const rows = await productQuery.findMany({
    where: getStorefrontVisibleProductFilter(),
    select: ["type"],
    populate: {
      category: {
        select: ["id"],
      },
    },
    limit: 200000,
  });

  const directProductsByCategoryId = new Map<number, number>();
  const directBundlesByCategoryId = new Map<number, number>();

  for (const row of rows as Array<{ type?: unknown; category?: { id?: number } | null }>) {
    const categoryId = row.category?.id;
    if (!categoryId) continue;

    if (row.type === "product") {
      directProductsByCategoryId.set(categoryId, (directProductsByCategoryId.get(categoryId) ?? 0) + 1);
    } else if (row.type === "bundle") {
      directBundlesByCategoryId.set(categoryId, (directBundlesByCategoryId.get(categoryId) ?? 0) + 1);
    }
  }

  await recomputeCategoryCountsForTree(directProductsByCategoryId, directBundlesByCategoryId);
}

// ---------------------------------------------------------------------------
// Основной сервис
// ---------------------------------------------------------------------------

export default factories.createCoreService("api::moysklad-product.moysklad-product", ({ strapi }) => ({
  async recomputeCategoryCounts() {
    await recomputeCategoryCountsFromDb();
  },

  /**
   * Webhook: upsert одного product.
   * type всегда "product", bundle через syncOneBundleFromWebhook.
   */
  async syncOneFromWebhook(entity: MoySkladWebhookProduct) {
    const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");
    const categoryQuery = strapi.db.query("api::moysklad-category.moysklad-category");

    const moyskladId = entity.id ?? pickIdFromHref(entity.meta?.href);
    const href = entity.meta?.href ?? null;

    if (!moyskladId || !href) {
      strapi.log.warn("[moysklad-product] webhook skipped: no moyskladId/href");
      return;
    }

    const categoryMsId = pickIdFromHref(entity.productFolder?.meta?.href);
    if (!categoryMsId) {
      strapi.log.warn(`[moysklad-product] webhook skipped: no category for product=${moyskladId}`);
      // Товар Sample Sale не удаляем и не теряем — только скрываем.
      if (await hideSampleSaleProductIfNeeded(moyskladId)) {
        await recomputeCategoryCountsFromDb();
        return;
      }
      // Товар перенесли без папки / вне ожидаемой структуры — убираем из подборки.
      await removeProductFromOwnProductionCollectionByMoyskladId(moyskladId);
      return;
    }

    const category = await categoryQuery.findOne({
      where: { moyskladId: categoryMsId },
      select: ["id"],
    });

    if (!category) {
      strapi.log.warn(`[moysklad-product] webhook skipped: category not found msId=${categoryMsId}`);
      // Товар Sample Sale переместили в неразрешённую папку — сохраняем и скрываем.
      if (await hideSampleSaleProductIfNeeded(moyskladId)) {
        await recomputeCategoryCountsFromDb();
        return;
      }
      // Папка вне витринного дерева — товар в Strapi не обновляем, но из подборки убираем.
      await removeProductFromOwnProductionCollectionByMoyskladId(moyskladId);
      return;
    }

    const existing = await productQuery.findOne({
      where: { moyskladId },
      select: ["id", "documentId", "moyskladStock", "isOutOfStock"],
    });

    const nowIso = new Date().toISOString();
    const canWriteSlug = hasProductAttribute("slug");

    const payloadParams = {
      type: "product" as const,
      moyskladId,
      href,
      categoryId: category.id,
    };

    let productDocumentId: string | null = null;
    let savedProductId: number;

    // Sample Sale tree: один Set на webhook (корень + descendants).
    const sampleSaleFolderIds = await loadSampleSaleFolderIdSet();
    const isSampleSaleProduct = isInsideSampleSaleFolderTree(categoryMsId, sampleSaleFolderIds);

    if (isSampleSaleProduct) {
      // Остаток берём точечным GET. Ошибка запроса не должна менять запись.
      let stockItem: SampleSaleAssortmentItem | null;

      try {
        stockItem = await fetchSampleSaleAssortmentItemById(moyskladId, sampleSaleFolderIds);
      } catch (err) {
        strapi.log.error(
          `[moysklad-sample-sale] webhook stock fetch failed: product=${moyskladId} error=${String(err)}`,
        );
        return;
      }

      if (!stockItem) {
        strapi.log.warn(
          `[moysklad-sample-sale] webhook skipped: no stock row for product=${moyskladId}`,
        );
        return;
      }

      // Архивный товар недоступен независимо от остатка.
      const hidden =
        buildSampleSaleStockFields(stockItem.stock).isOutOfStock || entity.archived === true;
      const stockFields = { moyskladStock: stockItem.stock, isOutOfStock: hidden };

      if (!existing) {
        if (hidden) {
          strapi.log.info(
            `[moysklad-sample-sale] webhook create skipped (no stock): ${moyskladId}`,
          );
          return;
        }

        const created = await productQuery.create({
          data: {
            ...buildFullProductPayload(entity, { ...payloadParams, nowIso, canWriteSlug }),
            ...stockFields,
          },
        });
        savedProductId = created.id;
        productDocumentId =
          typeof (created as { documentId?: unknown }).documentId === "string"
            ? (created as { documentId: string }).documentId
            : null;
        strapi.log.info(`[moysklad-sample-sale] webhook created: ${moyskladId}`);
      } else {
        // У скрытого товара также обновляем описание из CRM, ручные поля сохраняем.
        const data = hidden
          ? { ...stockFields, description: typeof entity.description === "string" ? entity.description : null }
          : { ...buildMoySkladOwnedProductFields(entity, payloadParams), ...stockFields };

        await productQuery.update({ where: { id: existing.id }, data });
        savedProductId = existing.id;
        productDocumentId =
          typeof (existing as { documentId?: unknown }).documentId === "string"
            ? (existing as { documentId: string }).documentId
            : null;
        strapi.log.info(
          `[moysklad-sample-sale] webhook ${hidden ? "hidden" : "updated"}: ${moyskladId}`,
        );
      }
    } else {
      const payload = buildFullProductPayload(entity, {
        ...payloadParams,
        nowIso,
        canWriteSlug,
      });

      // Товар вернулся из Sample Sale в обычную категорию — снимаем stock-контроль.
      const hadStockFields =
        Boolean(existing) &&
        ((existing.moyskladStock ?? null) !== null || (existing.isOutOfStock ?? null) !== null);

      if (hadStockFields) {
        Object.assign(payload, buildClearedSampleSaleStockFields());
      }

      if (existing) {
        await productQuery.update({ where: { id: existing.id }, data: payload });
        savedProductId = existing.id;
        productDocumentId =
          typeof (existing as { documentId?: unknown }).documentId === "string"
            ? (existing as { documentId: string }).documentId
            : null;
        strapi.log.info(`[moysklad-product] updated: ${moyskladId}`);
      } else {
        const created = await productQuery.create({ data: payload });
        savedProductId = created.id;
        productDocumentId =
          typeof (created as { documentId?: unknown }).documentId === "string"
            ? (created as { documentId: string }).documentId
            : null;
        strapi.log.info(`[moysklad-product] created: ${moyskladId}`);
      }
    }

    await rebuildProductSearchIndex(strapi, savedProductId);

    if (productDocumentId) {
      await syncProductInOwnProductionCollection(
        productDocumentId,
        isOwnProductionMoySkladProduct(entity),
      );
    } else {
      strapi.log.warn(
        `[moysklad-product] own production skip: no documentId for product=${moyskladId}`,
      );
    }

    await recomputeCategoryCountsFromDb();
  },

  /**
   * Webhook: upsert одного bundle.
   * После апсерта автоматически синкает состав (bundle items).
   * Ошибка синка состава НЕ валит webhook — только логируем.
   */
  async syncOneBundleFromWebhook(entity: MoySkladWebhookProduct) {
    const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");
    const categoryQuery = strapi.db.query("api::moysklad-category.moysklad-category");

    const moyskladId = entity.id ?? pickIdFromHref(entity.meta?.href);
    const href = entity.meta?.href ?? null;

    if (!moyskladId || !href) {
      strapi.log.warn("[moysklad-product] bundle webhook skipped: no moyskladId/href");
      return;
    }

    const categoryMsId = pickIdFromHref(entity.productFolder?.meta?.href);
    if (!categoryMsId) {
      strapi.log.warn(`[moysklad-product] bundle webhook skipped: no category for bundle=${moyskladId}`);
      return;
    }

    const category = await categoryQuery.findOne({
      where: { moyskladId: categoryMsId },
      select: ["id"],
    });

    if (!category) {
      strapi.log.warn(`[moysklad-product] bundle webhook skipped: category not found msId=${categoryMsId}`);
      return;
    }

    const existing = await productQuery.findOne({
      where: { moyskladId },
      select: ["id"],
    });

    const nowIso = new Date().toISOString();
    const canWriteSlug = hasProductAttribute("slug");
    const websitePrices = getWebsitePrices(entity.salePrices);

    const payload: Record<string, unknown> = {
      type: "bundle",
      name: entity.name ?? "",
      displayTitle: entity.name ?? "",
      description: typeof entity.description === "string" ? entity.description : null,
      moyskladId,
      href,
      code: entity.code ?? null,
      updated: entity.updated ?? null,
      category: category.id,
      price: websitePrices.price,
      priceOld: websitePrices.priceOld,
      uom: entity.uom?.name ?? null,
      weight: typeof entity.weight === "number" ? entity.weight : null,
      volume: typeof entity.volume === "number" ? entity.volume : null,
      publishedAt: nowIso,
    };

    if (canWriteSlug) {
      payload.slug = makeStableSlug(moyskladId);
    }

    if (existing) {
      await productQuery.update({ where: { id: existing.id }, data: payload });
      strapi.log.info(`[moysklad-product] updated bundle: ${moyskladId}`);
    } else {
      await productQuery.create({ data: payload });
      strapi.log.info(`[moysklad-product] created bundle: ${moyskladId}`);
    }

    // Синк состава — ошибка не валит webhook
    try {
      const r = await syncBundleItemsForBundle(moyskladId);
      strapi.log.info(`[moysklad-product] bundle items synced: bundle=${moyskladId} created=${r.created} skipped=${r.skipped}`);
    } catch (err) {
      strapi.log.error(`[moysklad-product] bundle items sync failed: bundle=${moyskladId} error=${String(err)}`);
    }

    await recomputeCategoryCountsFromDb();
  },

  /**
   * Webhook: удаление по moyskladId.
   */
  async deleteOneFromWebhook(moyskladId: string) {
    const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");
    const variantQuery = strapi.db.query("api::moysklad-variant.moysklad-variant");

    // Товары Sample Sale физически не удаляем: сохраняем фото, бейджи и ручные поля.
    if (await hideSampleSaleProductIfNeeded(moyskladId)) {
      await recomputeCategoryCountsFromDb();
      return;
    }

    const existingProduct = await productQuery.findOne({
      where: {
        moyskladId,
        type: "product",
      },
      select: ["id"],
    });

    if (existingProduct) {
      await variantQuery.deleteMany({
        where: {
          product: {
            id: existingProduct.id,
          },
        },
      });
    }

    // Убираем из подборки до удаления записи (на случай если join не очистится сам).
    await removeProductFromOwnProductionCollectionByMoyskladId(moyskladId);

    await productQuery.deleteMany({ where: { moyskladId } });
    strapi.log.info(`[moysklad-product] deleted: ${moyskladId}`);

    await recomputeCategoryCountsFromDb();
  },

  /**
   * Полный синк товаров + комплектов + состава комплектов.
   *
   * Порядок:
   * 1) Забрать все products из MoySklad
   * 2) Забрать все bundles из MoySklad
   * 3) Upsert products (только витринные категории)
   * 4) Upsert bundles (только витринные категории)
   * 5) Удалить products/bundles которых нет в MoySklad
   * 6) Пересчитать productsCount
   * 7) Синк состава для каждого bundle
   *
   * ОПТИМИЗАЦИЯ (N+1):
   * - Перед циклом upsert делаем ОДИН findMany → Map<moyskladId, strapiId>.
   * - В цикле lookup за O(1) вместо запроса в БД на каждый товар.
   */
  async syncAllUnlocked() {
    await acquireMoySkladSyncLock("products");
    await markSyncRunning("products");

    try {
      const token = process.env.MOYSKLAD_ACCESS_TOKEN;
      if (!token) throw new Error("MOYSKLAD_ACCESS_TOKEN is not set");

      const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");
      const categoryQuery = strapi.db.query("api::moysklad-category.moysklad-category");
      const variantQuery = strapi.db.query("api::moysklad-variant.moysklad-variant");

      const canWriteSlug = hasProductAttribute("slug");

      // --- 1) Разрешённые категории (уже синкнутые витринные) ---

      const categories = await categoryQuery.findMany({
        select: ["id", "moyskladId"],
        populate: { parent: { select: ["id"] } },
        limit: 10000,
      });

      // Set для быстрой проверки "входит ли категория в витрину"
      const allowedCategoryMsIds = new Set(
        categories
          .map((c) => c.moyskladId)
          .filter((id): id is string => typeof id === "string" && Boolean(id)),
      );

      // Map для получения Strapi ID категории по её MoySklad ID
      const categoryIdByMsId = new Map<string, number>(
        categories
          .filter((c) => typeof c.moyskladId === "string" && c.moyskladId)
          .map((c) => [c.moyskladId as string, c.id]),
      );

      // Sample Sale tree (корень + descendants) — один Set на весь sync.
      const sampleSaleFolderIds = buildSampleSaleMoyskladIdSetFromStrapiCategories(categories);

      // --- 1a) Категория Sample Sale обязательна ---
      //
      // Через связь с ней определяются защищённые товары. Без неё sync не имеет
      // права работать: иначе товары Sample Sale останутся без stock-контроля
      // и без защиты от cleanup.
      if (!sampleSaleFolderIds.has(SAMPLE_SALE_FOLDER_ID)) {
        throw new Error(
          "MoySklad product sync aborted: Sample Sale category is missing in Strapi " +
            `(moyskladId=${SAMPLE_SALE_FOLDER_ID}). Run the category sync first.`,
        );
      }

      // --- 1b) Остатки Sample Sale: грузим ДО любых записей в базу ---
      //
      // Ошибка запроса, пустой ответ, дубли, чужая папка или битый stock
      // останавливают sync ещё до create/update/delete.
      // Отсутствующий stock нельзя считать нулём.
      const sampleSaleAssortment = await fetchSampleSaleAssortment(sampleSaleFolderIds);
      const sampleSaleStockByMsId = buildSampleSaleStockMap(
        sampleSaleAssortment,
        sampleSaleFolderIds,
      );

      strapi.log.info(
        `[moysklad-sample-sale] stock loaded before writes: rows=${sampleSaleStockByMsId.size} folders=${sampleSaleFolderIds.size}`,
      );

      // --- 2) Тянем все products из MoySklad (пагинация) ---

      const allProducts: MoySkladProductOrBundle[] = [];
      let offset = 0;

      while (true) {
        const url = `https://api.moysklad.ru/api/remap/1.2/entity/product?limit=100&offset=${offset}`;
        const data = await fetchMoySkladList(url, token);

        allProducts.push(...data.rows);

        if (!data.meta.nextHref) break;
        offset += 100;
      }

      // --- 3) Тянем все bundles из MoySklad (пагинация) ---

      const allBundles: MoySkladProductOrBundle[] = [];
      let bundleOffset = 0;

      while (true) {
        const url = `https://api.moysklad.ru/api/remap/1.2/entity/bundle?limit=100&offset=${bundleOffset}`;
        const data = await fetchMoySkladList(url, token);

        allBundles.push(...data.rows);

        if (!data.meta.nextHref) break;
        bundleOffset += 100;
      }

      strapi.log.info(`[moysklad] fetched: products=${allProducts.length} bundles=${allBundles.length}`);

      // --- 3a) Полнота остатков: проверяем ДО первой записи в базу ---
      //
      // Товар лежит в папке Sample Sale, но строки в ассортименте нет — это
      // расхождение данных, а не нулевой остаток. Скрывать товар по такому
      // признаку нельзя, поэтому останавливаемся до create/update/cleanup.
      const missingStockMsIds = allProducts
        .filter(
          (p) =>
            isInsideSampleSaleFolderTree(
              pickIdFromHref(p.productFolder?.meta?.href),
              sampleSaleFolderIds,
            ) && !sampleSaleStockByMsId.has(p.id),
        )
        .map((p) => p.id);

      if (missingStockMsIds.length > 0) {
        throw new Error(
          `MoySklad product sync aborted: no stock row for ${missingStockMsIds.length} ` +
            `Sample Sale product(s), first=${missingStockMsIds[0]}`,
        );
      }

      // --- 4) Загружаем все существующие записи из Strapi ОДНИМ запросом ---
      //
      // ✅ ИСПРАВЛЕНИЕ N+1:
      // Раньше: findOne(moyskladId) на каждый товар внутри for-loop.
      // Теперь: один findMany → Map<moyskladId, strapiId>.
      // При 1000 товарах = 1 запрос вместо 1000.

      const existingRows = await productQuery.findMany({
        select: ["id", "moyskladId", "type", "moyskladStock", "isOutOfStock"],
        populate: {
          category: { select: ["moyskladId"] },
        },
        limit: 200000,
      });

      type ExistingProductRow = {
        id: number;
        moyskladId: string;
        type?: string;
        moyskladStock?: number | null;
        isOutOfStock?: boolean | null;
        category?: { moyskladId?: string | null } | null;
      };

      // Map: moyskladId → Strapi numeric id
      const existingIdByMsId = new Map<string, number>(
        (existingRows as ExistingProductRow[])
          .filter((r) => r.moyskladId)
          .map((r) => [r.moyskladId, r.id]),
      );

      // Состояние записи на момент старта sync (нужно для stock-полей и статистики)
      const existingByMsId = new Map<string, ExistingProductRow>(
        (existingRows as ExistingProductRow[])
          .filter((r) => r.moyskladId)
          .map((r) => [r.moyskladId, r]),
      );

      // Ранее импортированные товары Sample Sale — определяем по дереву категорий, не по имени
      const previousSampleSaleMsIds = new Set<string>(
        (existingRows as ExistingProductRow[])
          .filter(
            (r) =>
              Boolean(r.moyskladId) &&
              r.type === "product" &&
              isInsideSampleSaleFolderTree(r.category?.moyskladId ?? null, sampleSaleFolderIds),
          )
          .map((r) => r.moyskladId),
      );

      const nowIso = new Date().toISOString();

      const keepMsIds = new Set<string>();       // витринные products
      const keepBundleMsIds = new Set<string>(); // витринные bundles
      const ownProductionMsIds = new Set<string>(); // кандидаты в «Наше производство»

      // moyskladId, обработанные в разрешённой категории в этом прогоне.
      // Нужны, чтобы не пометить isOutOfStock товар, который уже переехал
      // из Sample Sale в обычную категорию.
      const processedAllowedProductIds = new Set<string>();

      const sampleSaleStats = {
        total: 0,
        created: 0,
        updated: 0,
        skippedOutOfStock: 0,
        markedOutOfStock: 0,
        reactivated: 0,
        preservedMissing: 0,
      };

      // --- 5) Upsert products ---

      for (const p of allProducts) {
        if (isOwnProductionMoySkladProduct(p)) {
          ownProductionMsIds.add(p.id);
        }

        const categoryMsId = pickIdFromHref(p.productFolder?.meta?.href);
        if (!categoryMsId) continue;
        if (!allowedCategoryMsIds.has(categoryMsId)) continue;

        const categoryId = categoryIdByMsId.get(categoryMsId);
        if (!categoryId) continue;

        const existingStrapiId = existingIdByMsId.get(p.id);

        const payloadParams = {
          type: "product" as const,
          moyskladId: p.id,
          href: p.meta.href,
          categoryId,
        };

        // --- 5a) Sample Sale: остаток управляет видимостью, но не удалением ---
        if (isInsideSampleSaleFolderTree(categoryMsId, sampleSaleFolderIds)) {
          sampleSaleStats.total += 1;

          // Запись защищена от cleanup независимо от остатка.
          keepMsIds.add(p.id);
          processedAllowedProductIds.add(p.id);

          // Полнота Map проверена до цикла — здесь строка обязана существовать.
          const stockRow = sampleSaleStockByMsId.get(p.id);
          if (!stockRow) {
            throw new Error(`MoySklad product sync aborted: missing stock row for ${p.id}`);
          }

          const stock = stockRow.stock;
          // Архивный товар недоступен независимо от остатка.
          const hidden = buildSampleSaleStockFields(stock).isOutOfStock || p.archived === true;
          const stockFields = { moyskladStock: stock, isOutOfStock: hidden };
          const wasOutOfStock = existingByMsId.get(p.id)?.isOutOfStock === true;

          if (!existingStrapiId) {
            if (hidden) {
              sampleSaleStats.skippedOutOfStock += 1;
              continue;
            }

            await productQuery.create({
              data: {
                ...buildFullProductPayload(p, { ...payloadParams, nowIso, canWriteSlug }),
                ...stockFields,
              },
            });
            sampleSaleStats.created += 1;
            continue;
          }

          // У скрытого товара также обновляем описание из CRM, ручные поля сохраняем.
          const data = hidden
            ? { ...stockFields, description: typeof p.description === "string" ? p.description : null }
            : { ...buildMoySkladOwnedProductFields(p, payloadParams), ...stockFields };

          await productQuery.update({ where: { id: existingStrapiId }, data });
          sampleSaleStats.updated += 1;

          if (hidden && !wasOutOfStock) {
            sampleSaleStats.markedOutOfStock += 1;
          }

          if (!hidden && wasOutOfStock) {
            sampleSaleStats.reactivated += 1;
          }

          continue;
        }

        // --- 5b) Обычные товары: поведение не меняется ---
        keepMsIds.add(p.id);
        processedAllowedProductIds.add(p.id);

        const payload = buildFullProductPayload(p, { ...payloadParams, nowIso, canWriteSlug });

        // Товар переехал из Sample Sale в обычную категорию — снимаем stock-контроль.
        const previous = existingByMsId.get(p.id);
        const hadStockFields =
          Boolean(previous) &&
          ((previous?.moyskladStock ?? null) !== null ||
            (previous?.isOutOfStock ?? null) !== null);

        if (hadStockFields) {
          Object.assign(payload, buildClearedSampleSaleStockFields());
        }

        // ✅ O(1) lookup вместо запроса в БД
        if (existingStrapiId) {
          await productQuery.update({ where: { id: existingStrapiId }, data: payload });
        } else {
          await productQuery.create({ data: payload });
        }
      }

      // --- 5c) Товары Sample Sale, которых нет в текущей выборке ---
      //
      // Перемещены в неразрешённую папку, удалены или архивированы в MoySklad.
      // Запись сохраняем и скрываем: фотографии и ручные поля не теряем.
      for (const msId of previousSampleSaleMsIds) {
        if (processedAllowedProductIds.has(msId)) continue;

        keepMsIds.add(msId);
        sampleSaleStats.preservedMissing += 1;

        const row = existingByMsId.get(msId);
        if (!row || row.isOutOfStock === true) continue;

        await productQuery.update({
          where: { id: row.id },
          data: { isOutOfStock: true },
        });
        sampleSaleStats.markedOutOfStock += 1;
      }

      // --- 6) Upsert bundles ---

      let bundlesAllowed = 0;

      for (const b of allBundles) {
        const categoryMsId = pickIdFromHref(b.productFolder?.meta?.href);
        if (!categoryMsId) continue;
        if (!allowedCategoryMsIds.has(categoryMsId)) continue;

        const categoryId = categoryIdByMsId.get(categoryMsId);
        if (!categoryId) continue;

        // В Sample Sale контроль остатка реализован только для product.
        // Комплекты оттуда не создаём; уже существующие защищаем от удаления.
        if (isInsideSampleSaleFolderTree(categoryMsId, sampleSaleFolderIds)) {
          if (existingIdByMsId.has(b.id)) {
            keepBundleMsIds.add(b.id);
          }
          strapi.log.warn(`[moysklad-sample-sale] bundle skipped (unsupported): ${b.id}`);
          continue;
        }

        bundlesAllowed += 1;
        keepBundleMsIds.add(b.id);

        const payload = buildFullProductPayload(b, {
          type: "bundle",
          moyskladId: b.id,
          href: b.meta.href,
          categoryId,
          nowIso,
          canWriteSlug,
        });

        // ✅ O(1) lookup вместо запроса в БД
        const existingStrapiId = existingIdByMsId.get(b.id);

        if (existingStrapiId) {
          await productQuery.update({ where: { id: existingStrapiId }, data: payload });
        } else {
          await productQuery.create({ data: payload });
        }
      }

      strapi.log.info(`[moysklad] bundles allowed by category: ${bundlesAllowed}`);

      // --- 7) Удаляем то, чего больше нет в MoySklad/витрине ---
      // Важно: удаляем раздельно по type, чтобы products и bundles не затирали друг друга.
      // Пустой keepMsIds → не вызываем $notIn: [] (риск массового удаления всех товаров).
      if (keepMsIds.size === 0) {
        throw new Error(
          "MoySklad product sync aborted: keepMsIds is empty, destructive cleanup skipped",
        );
      }

      const staleProductIds = (existingRows as ExistingProductRow[])
        .filter((row) => row.type === "product" && !keepMsIds.has(row.moyskladId))
        .map((row) => row.id);

      if (staleProductIds.length > 0) {
        await variantQuery.deleteMany({
          where: {
            product: {
              id: {
                $in: staleProductIds,
              },
            },
          },
        });
      }

      await productQuery.deleteMany({
        where: { type: "product", moyskladId: { $notIn: Array.from(keepMsIds) } },
      });

      if (keepBundleMsIds.size > 0) {
        await productQuery.deleteMany({
          where: { type: "bundle", moyskladId: { $notIn: Array.from(keepBundleMsIds) } },
        });
      } else {
        strapi.log.warn("[moysklad-product] Bundle cleanup skipped: keepBundleMsIds is empty");
      }

      // --- 8) Полная замена relation подборки «Наше производство» ---
      // Берём только те кандидаты, которые реально есть в Strapi как type=product.
      const ownProductionRows =
        ownProductionMsIds.size === 0
          ? []
          : await productQuery.findMany({
              where: {
                type: "product",
                moyskladId: { $in: Array.from(ownProductionMsIds) },
              },
              select: ["id", "documentId"],
              limit: 100000,
            });

      const ownProductionDocumentIds = (ownProductionRows as Array<{ documentId?: string }>)
        .map((row) => row.documentId)
        .filter((documentId): documentId is string => typeof documentId === "string" && documentId.length > 0);

      await replaceOwnProductionCollectionProducts(ownProductionDocumentIds);

      // --- 9) Пересчёт productsCount по дереву категорий ---

      await recomputeCategoryCountsFromDb();

      // --- 10) Синк состава для всех bundles ---
      // Важно: запускаем ПОСЛЕ upsert products, чтобы componentProduct уже существовали в БД.

      let bundleItemsCreatedTotal = 0;
      let bundleItemsSkippedTotal = 0;
      let bundlesProcessed = 0;
      let bundlesFailed = 0;

      for (const bundleMsId of keepBundleMsIds) {
        try {
          const r = await syncBundleItemsForBundle(bundleMsId);
          bundleItemsCreatedTotal += r.created;
          bundleItemsSkippedTotal += r.skipped;
          bundlesProcessed += 1;
        } catch (err) {
          bundlesFailed += 1;
          // Один сломанный бандл не должен валить весь sync — только логируем.
          strapi.log.error(`[moysklad] bundle items sync failed: bundle=${bundleMsId} error=${String(err)}`);
        }
      }

      await markSyncOk("products", { products: keepMsIds.size });

      strapi.log.info(
        `[moysklad-sample-sale] total=${sampleSaleStats.total} created=${sampleSaleStats.created} ` +
          `updated=${sampleSaleStats.updated} skippedOutOfStock=${sampleSaleStats.skippedOutOfStock} ` +
          `markedOutOfStock=${sampleSaleStats.markedOutOfStock} reactivated=${sampleSaleStats.reactivated} ` +
          `preservedMissing=${sampleSaleStats.preservedMissing}`,
      );

      return {
        ok: true,
        total: keepMsIds.size,
        bundles: keepBundleMsIds.size,
        bundleItems: {
          bundlesProcessed,
          created: bundleItemsCreatedTotal,
          skipped: bundleItemsSkippedTotal,
          failed: bundlesFailed,
        },
        sampleSale: {
          sampleSaleTotal: sampleSaleStats.total,
          sampleSaleCreated: sampleSaleStats.created,
          sampleSaleUpdated: sampleSaleStats.updated,
          sampleSaleSkippedOutOfStock: sampleSaleStats.skippedOutOfStock,
          sampleSaleMarkedOutOfStock: sampleSaleStats.markedOutOfStock,
          sampleSaleReactivated: sampleSaleStats.reactivated,
          sampleSalePreservedMissing: sampleSaleStats.preservedMissing,
        },
      };
    } catch (e) {
      await markSyncError("products", e);
      throw e;
    } finally {
      await releaseMoySkladSyncLock("products");
    }
  },

  async syncAll() {
    return enqueueMoySkladFullSync("products", () => this.syncAllUnlocked());
  },
}));
