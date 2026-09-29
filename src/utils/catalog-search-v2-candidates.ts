import type { Core } from "@strapi/strapi";
import type { CatalogSearchCandidate, PreparedCatalogSearchQuery } from "./catalog-search-v2";
import { getStorefrontVisibleProductFilter } from "./storefront-product-visibility";
import { isInsideSampleSaleFolderTree } from "./moysklad-sample-sale";

/** Rank all matching lightweight rows; only hydrate images/details for the requested page. */
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
    populate: { category: { select: ["moyskladId"] }, variants: { select: ["name"] } },
    orderBy: { id: "asc" },
  }) as CatalogSearchCandidate[];
  return { candidates: rows.map(row => ({ ...row, isSampleSale: isInsideSampleSaleFolderTree(row.category?.moyskladId, sampleSaleFolderIds) })) };
}
