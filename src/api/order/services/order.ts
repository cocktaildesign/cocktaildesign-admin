import { isProductDiscountExcluded, loadSampleSaleFolderIdSet } from "../../../utils/product-discount-policy";

const MS_BASE = "https://api.moysklad.ru/api/remap/1.2";
const MS_REQUEST_TIMEOUT_MS = 15_000;

type OrderErrorCode =
  | "invalid_item_code"
  | "item_not_found"
  | "item_price_missing"
  | "item_price_invalid";

type ResolvedOrderItem = {
  href: string;
  type: string;
  trustedName: string;
  trustedPriceRub: number;
  trustedDiscountExcluded: boolean;
};

type OrderPromoDiscount = {
  discountType: "percent" | "fixed" | "inventory" | "startup";
  discountValue: number;
  discountAmount: number;
};

type OrderDiscountPlan = {
  volumeDiscountPercent: number;
  volumeDiscountAmount: number;
  appliedVolumeDiscountAmount: number;
  appliedPromoDiscountAmount: number;
  totalDiscountAmount: number;
  finalPrice: number;
  discountablePositionPercent: number;
  excludedPositionPercent: number;
  promoWinsAgainstVolume: boolean;
};

function normalizeDiscountPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const clamped = Math.max(0, Math.min(100, value));

  return Math.round(clamped * 10_000) / 10_000;
}

function resolveOrderDiscountPlan(params: {
  totalPrice: number;
  discountableTotal: number;
  volumeDiscountPercent: number;
  promo: OrderPromoDiscount | null;
}): OrderDiscountPlan {
  const totalPrice = Number.isFinite(params.totalPrice) ? Math.max(0, params.totalPrice) : 0;

  const discountableTotal = Number.isFinite(params.discountableTotal)
    ? Math.max(0, Math.min(params.discountableTotal, totalPrice))
    : 0;

  const volumeDiscountPercent = normalizeDiscountPercent(params.volumeDiscountPercent);

  const volumeDiscountAmount = Math.round((discountableTotal * volumeDiscountPercent) / 100);

  const noPromoPlan: OrderDiscountPlan = {
    volumeDiscountPercent,
    volumeDiscountAmount,
    appliedVolumeDiscountAmount: volumeDiscountAmount,
    appliedPromoDiscountAmount: 0,
    totalDiscountAmount: volumeDiscountAmount,
    finalPrice: Math.max(0, totalPrice - volumeDiscountAmount),
    discountablePositionPercent: volumeDiscountPercent,
    excludedPositionPercent: 0,
    promoWinsAgainstVolume: false,
  };

  if (params.promo === null || params.promo.discountType === "inventory") {
    return noPromoPlan;
  }

  const promo = params.promo;

  if (promo.discountType === "percent" || promo.discountType === "startup") {
    const promoDiscountAmount = Math.max(0, Math.min(promo.discountAmount, totalPrice));

    if (promoDiscountAmount >= volumeDiscountAmount) {
      return {
        volumeDiscountPercent,
        volumeDiscountAmount,
        appliedVolumeDiscountAmount: 0,
        appliedPromoDiscountAmount: promoDiscountAmount,
        totalDiscountAmount: promoDiscountAmount,
        finalPrice: Math.max(0, totalPrice - promoDiscountAmount),
        discountablePositionPercent: normalizeDiscountPercent(promo.discountValue),
        excludedPositionPercent: 0,
        promoWinsAgainstVolume: true,
      };
    }

    return {
      volumeDiscountPercent,
      volumeDiscountAmount,
      appliedVolumeDiscountAmount: volumeDiscountAmount,
      appliedPromoDiscountAmount: 0,
      totalDiscountAmount: volumeDiscountAmount,
      finalPrice: Math.max(0, totalPrice - volumeDiscountAmount),
      discountablePositionPercent: volumeDiscountPercent,
      excludedPositionPercent: 0,
      promoWinsAgainstVolume: false,
    };
  }

  if (promo.discountType === "fixed") {
    const remainingAfterVolume = Math.max(0, totalPrice - volumeDiscountAmount);

    const appliedFixedAmount = Math.min(Math.max(0, promo.discountAmount), remainingAfterVolume);

    const fixedPercentOnRemaining =
      remainingAfterVolume > 0 ? (appliedFixedAmount / remainingAfterVolume) * 100 : 0;

    const combinedDiscountablePercent =
      100 - ((100 - volumeDiscountPercent) * (100 - fixedPercentOnRemaining)) / 100;

    const totalDiscountAmount = Math.min(totalPrice, volumeDiscountAmount + appliedFixedAmount);

    return {
      volumeDiscountPercent,
      volumeDiscountAmount,
      appliedVolumeDiscountAmount: volumeDiscountAmount,
      appliedPromoDiscountAmount: appliedFixedAmount,
      totalDiscountAmount,
      finalPrice: Math.max(0, totalPrice - volumeDiscountAmount - appliedFixedAmount),
      discountablePositionPercent: normalizeDiscountPercent(combinedDiscountablePercent),
      excludedPositionPercent: normalizeDiscountPercent(fixedPercentOnRemaining),
      promoWinsAgainstVolume: false,
    };
  }

  return noPromoPlan;
}

function msHeaders() {
  return {
    Authorization: `Bearer ${process.env.MOYSKLAD_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

function createMoyskladRequestTimeout() {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, MS_REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeoutId);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createOrderError(code: OrderErrorCode): Error & { code: OrderErrorCode } {
  const error = new Error(code) as Error & { code: OrderErrorCode };
  error.code = code;
  return error;
}

function normalizeCode(code: string): string {
  return code.trim();
}

function isValidPriceRub(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

async function findProductHref(code: string): Promise<{ href: string; type: string } | null> {
  // Assortment возвращает всё: products, bundles, services, variants
  // Нужно именно оно, т.к. часть SKU в МС лежит как bundle (например Speed-opener'ы)
  const filter = encodeURIComponent(`code=${code}`);
  const url = `${MS_BASE}/entity/assortment?filter=${filter}&limit=10`;

  const requestTimeout = createMoyskladRequestTimeout();

  try {
    const res = await fetch(url, {
      headers: msHeaders(),
      signal: requestTimeout.signal,
    });

    if (!res.ok) {
      strapi.log.error(`[MS findProductHref] HTTP ${res.status} для code=${code}`);
      return null;
    }

    const data = (await res.json()) as {
      rows: {
        code?: string;
        article?: string;
        name?: string;
        meta: { href: string; type: string };
      }[];
    };

    const rows = data.rows ?? [];

    // Точное совпадение по code
    const exact = rows.find((r) => r.code === code);
    if (exact) {
      return { href: exact.meta.href, type: exact.meta.type };
    }

    // Fallback: вдруг артикул в поле article, а не code
    const byArticle = rows.find((r) => r.article === code);
    if (byArticle) {
      strapi.log.warn(`[MS findProductHref] ${code} найден по article, а не по code`);
      return { href: byArticle.meta.href, type: byArticle.meta.type };
    }

    strapi.log.warn(
      `[MS findProductHref] Нет точного совпадения для "${code}". ` +
        `МС вернул ${rows.length} строк. Первые 3: ` +
        JSON.stringify(rows.slice(0, 3).map((r) => ({ code: r.code, article: r.article, name: r.name }))),
    );
    return null;
  } finally {
    requestTimeout.clear();
  }
}

async function resolveOrderItemByCode(rawCode: string, folderIds?: Set<string>): Promise<ResolvedOrderItem> {
  const code = normalizeCode(rawCode);

  if (!code) {
    throw createOrderError("invalid_item_code");
  }

  const sampleSaleFolderIds = folderIds ?? await loadSampleSaleFolderIdSet(strapi);

  const variantQuery = strapi.db.query("api::moysklad-variant.moysklad-variant");
  const productQuery = strapi.db.query("api::moysklad-product.moysklad-product");

  const variant = await variantQuery.findOne({
    where: { code },
    select: ["id", "name", "price", "href"],
    populate: {
      product: {
        select: [
          "id",
          "name",
          "price",
          "discountExcluded",
          "href",
          "type",
          "isHiddenOnSite",
          "isOutOfStock",
        ],
        populate: { category: { select: ["moyskladId"] } },
      },
    },
  });

  if (variant) {
    const parentProduct = variant.product ?? null;

    if (
      !parentProduct ||
      parentProduct.isHiddenOnSite === true ||
      parentProduct.isOutOfStock === true
    ) {
      throw createOrderError("item_not_found");
    }

    const resolvedPrice = isValidPriceRub(variant.price)
      ? variant.price
      : isValidPriceRub(parentProduct?.price)
        ? parentProduct.price
        : null;

    if (resolvedPrice === null) {
      if (variant.price === null || variant.price === undefined) {
        throw createOrderError("item_price_missing");
      }
      throw createOrderError("item_price_invalid");
    }

    let href = variant.href ?? null;
    let type = "variant";

    if (variant.href) {
      href = variant.href;
      type = "variant";
    } else {
      const live = await findProductHref(code);
      if (live) {
        href = live.href;
        type = live.type;
      }
    }

    if (!href) {
      throw createOrderError("item_not_found");
    }

    return {
      href,
      type,
      trustedName: (variant.name || parentProduct?.name || code).trim(),
      trustedPriceRub: resolvedPrice,
      trustedDiscountExcluded: isProductDiscountExcluded(parentProduct, sampleSaleFolderIds),
    };
  }

  const product = await productQuery.findOne({
    where: { code },
    select: [
      "id",
      "name",
      "price",
      "discountExcluded",
      "href",
      "type",
      "isHiddenOnSite",
      "isOutOfStock",
    ],
    populate: { category: { select: ["moyskladId"] } },
  });

  if (!product) {
    throw createOrderError("item_not_found");
  }

  if (product.isHiddenOnSite === true || product.isOutOfStock === true) {
    throw createOrderError("item_not_found");
  }

  if (product.price === null || product.price === undefined) {
    throw createOrderError("item_price_missing");
  }

  if (!isValidPriceRub(product.price)) {
    throw createOrderError("item_price_invalid");
  }

  let href = product.href ?? null;
  let type = product.type ?? "product";

  if (!href) {
    const live = await findProductHref(code);
    if (live) {
      href = live.href;
      type = live.type;
    }
  }

  if (!href) {
    throw createOrderError("item_not_found");
  }

  return {
    href,
    type,
    trustedName: (product.name || code).trim(),
    trustedPriceRub: product.price,
    trustedDiscountExcluded: isProductDiscountExcluded(product, sampleSaleFolderIds),
  };
}

async function resolveVolumeDiscountPercent(subtotalRub: number): Promise<number> {
  if (!Number.isFinite(subtotalRub) || subtotalRub <= 0) {
    return 0;
  }

  const discountTierQuery = strapi.db.query("api::discount-tier.discount-tier");
  const tiers = await discountTierQuery.findMany({
    select: ["minAmount", "percent"],
    orderBy: { minAmount: "asc" },
    limit: 1000,
  });

  let percent = 0;

  for (const tier of tiers as Array<{ minAmount?: number | null; percent?: number | null }>) {
    const minAmount = tier.minAmount ?? null;
    const tierPercent = tier.percent ?? null;

    if (!Number.isFinite(minAmount) || !Number.isFinite(tierPercent)) {
      continue;
    }

    if ((minAmount as number) <= subtotalRub && (tierPercent as number) > percent) {
      percent = Math.max(0, Math.trunc(tierPercent as number));
    }
  }

  return percent;
}

async function createCounterparty(name: string, phone: string): Promise<string> {
  const requestTimeout = createMoyskladRequestTimeout();

  try {
    const res = await fetch(`${MS_BASE}/entity/counterparty`, {
      method: "POST",
      headers: msHeaders(),
      signal: requestTimeout.signal,
      body: JSON.stringify({
        name,
        phone,
        companyType: "individual",
        tags: ["клиенты интернет-магазинов", "cocktaildesign"],
      }),
    });

    if (!res.ok) {
      strapi.log.error(`[MS createCounterparty] HTTP ${res.status}`);

      throw new Error("moysklad_counterparty_http_error");
    }

    let data: unknown;

    try {
      data = await res.json();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      strapi.log.error("[MS createCounterparty] Invalid JSON response");

      throw new Error("moysklad_counterparty_invalid_json");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      strapi.log.error("[MS createCounterparty] Response does not contain meta.href");

      throw new Error("moysklad_counterparty_invalid_response");
    }

    const meta = (data as { meta?: unknown }).meta;

    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      strapi.log.error("[MS createCounterparty] Response does not contain meta.href");

      throw new Error("moysklad_counterparty_invalid_response");
    }

    const href = (meta as { href?: unknown }).href;

    if (typeof href !== "string" || !href.trim()) {
      strapi.log.error("[MS createCounterparty] Response does not contain meta.href");

      throw new Error("moysklad_counterparty_invalid_response");
    }

    return href.trim();
  } finally {
    requestTimeout.clear();
  }
}

async function createCustomerOrder(params: {
  agentHref: string;
  positions: {
    productHref: string;
    productType: string;
    quantity: number;
    price: number;
    engraving: boolean;
    discountPercent: number;
  }[];
  description: string;
  shipmentAddress: string;
}): Promise<{ id: string; name: string }> {
  const body = {
    organization: {
      meta: {
        href: process.env.MOYSKLAD_ORGANIZATION_HREF,
        type: "organization",
        mediaType: "application/json",
      },
    },
    agent: {
      meta: {
        href: params.agentHref,
        type: "counterparty",
        mediaType: "application/json",
      },
    },
    salesChannel: {
      meta: {
        href: process.env.MOYSKLAD_SALES_CHANNEL_HREF,
        type: "saleschannel",
        mediaType: "application/json",
      },
    },
    store: {
      meta: {
        href: process.env.MOYSKLAD_STORE_HREF,
        type: "store",
        mediaType: "application/json",
      },
    },
    description: params.description,
    shipmentAddress: params.shipmentAddress,
    attributes: [
      {
        meta: {
          href: process.env.MOYSKLAD_SOURCE_ATTRIBUTE_HREF,
          type: "attributemetadata",
          mediaType: "application/json",
        },
        value: {
          meta: {
            href: process.env.MOYSKLAD_SOURCE_HREF,
            type: "customentity",
            mediaType: "application/json",
          },
        },
      },
    ],
    positions: params.positions.map((p) => ({
      quantity: p.quantity,
      price: p.price * 100,
      discount: normalizeDiscountPercent(p.discountPercent),
      vat: 0,
      vatEnabled: false,
      assortment: {
        meta: {
          href: p.productHref,
          type: p.productType,
          mediaType: "application/json",
        },
      },
    })),
  };

  const requestTimeout = createMoyskladRequestTimeout();

  try {
    const res = await fetch(`${MS_BASE}/entity/customerorder`, {
      method: "POST",
      headers: msHeaders(),
      signal: requestTimeout.signal,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      strapi.log.error(`[MS createCustomerOrder] HTTP ${res.status}`);

      throw new Error("moysklad_customer_order_http_error");
    }

    let data: unknown;

    try {
      data = await res.json();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      strapi.log.error("[MS createCustomerOrder] Invalid JSON response");

      throw new Error("moysklad_customer_order_invalid_json");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      strapi.log.error("[MS createCustomerOrder] Response does not contain valid id and name");

      throw new Error("moysklad_customer_order_invalid_response");
    }

    const parsed = data as {
      id?: unknown;
      name?: unknown;
    };

    if (
      typeof parsed.id !== "string" ||
      !parsed.id.trim() ||
      typeof parsed.name !== "string" ||
      !parsed.name.trim()
    ) {
      strapi.log.error("[MS createCustomerOrder] Response does not contain valid id and name");

      throw new Error("moysklad_customer_order_invalid_response");
    }

    const result = {
      id: parsed.id.trim(),
      name: parsed.name.trim(),
    };

    strapi.log.info(`[order] Заказ МойСклад создан: ${result.name}`);
    return result;
  } finally {
    requestTimeout.clear();
  }
}

export default {
  findProductHref,
  resolveOrderItemByCode,
  resolveVolumeDiscountPercent,
  resolveOrderDiscountPlan,
  createCounterparty,
  createCustomerOrder,
};
