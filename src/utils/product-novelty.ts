export const DEFAULT_NOVELTY_DAYS = 100;
export const DEFAULT_NOVELTY_BADGE_COLOR = "#2eae4a";
export const NOVELTY_COLLECTION_SLUG = "novinki";

const NOVELTY_BADGE_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

export type ProductNoveltyConfig = {
  noveltyDays: number;
  noveltyBadgeColor: string;
};

function normalizeNoveltyDays(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(raw)) {
    return DEFAULT_NOVELTY_DAYS;
  }

  const floored = Math.floor(raw);

  if (floored < 1) {
    return DEFAULT_NOVELTY_DAYS;
  }

  return floored;
}

function normalizeNoveltyBadgeColor(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_NOVELTY_BADGE_COLOR;
  }

  const trimmed = value.trim();

  if (!NOVELTY_BADGE_COLOR_REGEX.test(trimmed)) {
    return DEFAULT_NOVELTY_BADGE_COLOR;
  }

  return trimmed.toLowerCase();
}

export async function getProductNoveltyConfig(strapi: any): Promise<ProductNoveltyConfig> {
  const defaults: ProductNoveltyConfig = {
    noveltyDays: DEFAULT_NOVELTY_DAYS,
    noveltyBadgeColor: DEFAULT_NOVELTY_BADGE_COLOR,
  };

  try {
    const collectionQuery = strapi.db.query("api::catalog-collection.catalog-collection");

    const collection = await collectionQuery.findOne({
      where: { slug: NOVELTY_COLLECTION_SLUG },
      select: ["noveltyDays", "noveltyBadgeColor", "selectionMode"],
    });

    if (!collection) {
      return defaults;
    }

    const selectionMode = collection.selectionMode ?? null;

    if (selectionMode !== "new") {
      return defaults;
    }

    return {
      noveltyDays: normalizeNoveltyDays(collection.noveltyDays),
      noveltyBadgeColor: normalizeNoveltyBadgeColor(collection.noveltyBadgeColor),
    };
  } catch {
    return defaults;
  }
}

/** Sample Sale has its own collection and is never a storefront novelty. */
export function isProductNew(moyskladNoveltyAt: unknown, noveltyDays: number, isSampleSale: boolean): boolean {
  if (isSampleSale || moyskladNoveltyAt === null || moyskladNoveltyAt === undefined) {
    return false;
  }

  let noveltyDateMs: number;

  if (moyskladNoveltyAt instanceof Date) {
    noveltyDateMs = moyskladNoveltyAt.getTime();
  } else if (typeof moyskladNoveltyAt === "string") {
    const trimmed = moyskladNoveltyAt.trim();

    if (!trimmed) {
      return false;
    }

    noveltyDateMs = Date.parse(trimmed);
  } else {
    return false;
  }

  if (!Number.isFinite(noveltyDateMs)) {
    return false;
  }

  const safeDays = normalizeNoveltyDays(noveltyDays);
  const cutoffMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;

  return noveltyDateMs >= cutoffMs;
}
