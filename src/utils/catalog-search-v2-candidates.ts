import type { Core } from "@strapi/strapi";
import type { CatalogSearchCandidate, PreparedCatalogSearchQuery } from "./catalog-search-v2";
import { getStorefrontVisibleProductFilter } from "./storefront-product-visibility";
import { isInsideSampleSaleFolderTree } from "./moysklad-sample-sale";

/** Rank the complete pool, including photo presence; hydrate full details only for the requested page. */
export async function findCatalogSearchCandidates(strapi: Core.Strapi, query: PreparedCatalogSearchQuery, sampleSaleFolderIds: Set<string>) {
  if (!query.isValid) return { candidates: [] as CatalogSearchCandidate[] };
  const matches: any[] = [];
  if (query.exactCodeNeedle) matches.push({ searchCodes: { $containsi: query.exactCodeNeedle } });
  if (query.tokens.length) matches.push({ $and: query.tokens.map(token => ({ searchText: { $containsi: token } })) });
  const where: any = { $and: [
    { category: { id: { $notIn: [14] } } }, getStorefrontVisibleProductFilter(),
    ...(query.sampleSaleOnly ? [{ category: { moyskladId: { $in: [...sampleSaleFolderIds] } } }] : []),
    ...(query.sampleSaleOnly && !query.tokens.length ? [] : [{ $or: matches }]),
  ] };
  const rows = await strapi.db.query("api::moysklad-product.moysklad-product").findMany({
    where, select: ["id", "name", "code", "searchText", "searchCodes"],
    populate: {
      image: { select: ["url"] },
      category: { select: ["moyskladId"] },
      variants: { select: ["name", "code"], populate: { image: { select: ["url"] } }, orderBy: { id: "asc" } },
    },
    orderBy: { id: "asc" },
  }) as CatalogSearchCandidate[];
  return { candidates: rows.map(row => ({
    ...row,
    // Search uses the parent's photo, falling back to a variant's photo.
    hasSearchImage: Boolean(row.image?.[0]?.url || row.variants?.some(variant => variant.image?.[0]?.url)),
    isSampleSale: isInsideSampleSaleFolderTree(row.category?.moyskladId, sampleSaleFolderIds),
  })) };
}
