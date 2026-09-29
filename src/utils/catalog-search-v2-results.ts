import type { Core } from "@strapi/strapi";
import { getStorefrontVisibleProductFilter } from "./storefront-product-visibility";

import type { CatalogSearchCandidate } from "./catalog-search-v2";

const PRODUCT_UID = "api::moysklad-product.moysklad-product";

const SEARCH_RESULT_SELECT = [
  "id",
  "name",
  "moyskladId",
  "slug",
  "price",
  "priceOld",
  "code",
  "moyskladNoveltyAt",
] as const;

const PRODUCT_BADGES_POPULATE = {
  badges: {
    populate: {
      badge: {
        select: ["id", "label", "backgroundColor", "textColor"],
      },
    },
  },
} as const;

const SEARCH_RESULT_POPULATE = {
  image: { select: ["url", "alternativeText", "formats"] },
  category: { select: ["name", "moyskladId"] },
  variants: {
    select: ["id", "name", "moyskladId", "price", "priceOld", "code", "characteristics"],
    populate: {
      image: { select: ["url", "alternativeText", "formats"] },
    },
    orderBy: { id: "asc" },
  },
  ...PRODUCT_BADGES_POPULATE,
} as const;

export type CatalogSearchV2ImageRow = {
  url?: string | null;
  alternativeText?: string | null;
  formats?: unknown;
};

export type CatalogSearchV2BadgeRow = {
  id?: number;
  label?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
};

export type CatalogSearchV2ProductBadgeRelationRow = {
  id?: number;
  badge?: CatalogSearchV2BadgeRow | null;
};

export type CatalogSearchV2VariantRow = {
  id: number;
  name?: string | null;
  moyskladId?: string | null;
  price?: number | null;
  priceOld?: number | null;
  code?: string | null;
  characteristics?: unknown;
  image?: CatalogSearchV2ImageRow[] | null;
};

export type CatalogSearchV2ProductRow = {
  id: number;
  name?: string | null;
  moyskladId?: string | null;
  slug?: string | null;
  price?: number | null;
  priceOld?: number | null;
  code?: string | null;
  moyskladNoveltyAt?: string | null;
  image?: CatalogSearchV2ImageRow[] | null;
  category?: { name?: string | null; moyskladId?: string | null } | null;
  variants?: CatalogSearchV2VariantRow[] | null;
  badges?: CatalogSearchV2ProductBadgeRelationRow[] | null;
};

type ProductQuery = {
  findMany: (args: Record<string, unknown>) => Promise<CatalogSearchV2ProductRow[]>;
};

function orderRowsByCandidateIds(
  rows: CatalogSearchV2ProductRow[],
  candidates: CatalogSearchCandidate[],
): CatalogSearchV2ProductRow[] {
  const rowsById = new Map<number, CatalogSearchV2ProductRow>();

  for (const row of rows) {
    rowsById.set(row.id, row);
  }

  const orderedRows: CatalogSearchV2ProductRow[] = [];

  for (const candidate of candidates) {
    const row = rowsById.get(candidate.id);

    if (!row) {
      continue;
    }

    orderedRows.push(row);
  }

  return orderedRows;
}

export async function findCatalogSearchResultRows(
  strapi: Core.Strapi,
  candidates: CatalogSearchCandidate[],
): Promise<CatalogSearchV2ProductRow[]> {
  if (candidates.length === 0) {
    return [];
  }

  const ids = candidates.map((candidate) => candidate.id);
  const productQuery = strapi.db.query(PRODUCT_UID) as ProductQuery;

  const rows = await productQuery.findMany({
    where: { $and: [{ id: { $in: ids } }, getStorefrontVisibleProductFilter(), { category: { id: { $notIn: [14] } } }] },
    select: [...SEARCH_RESULT_SELECT],
    populate: SEARCH_RESULT_POPULATE,
    limit: candidates.length,
  });

  return orderRowsByCandidateIds(rows, candidates);
}
