import type { Core } from "@strapi/strapi";
import type { CatalogSearchCandidate, PreparedCatalogSearchQuery } from "./catalog-search-v2";
import { getStorefrontVisibleProductFilter } from "./storefront-product-visibility";
import { isInsideSampleSaleFolderTree } from "./moysklad-sample-sale";
import { catalogCandidateLanguageQuality } from "./catalog-search-v2";
import { searchLanguageFilters } from "./catalog-search-language";

/** Rank the complete pool, including photo presence; hydrate full details only for the requested page. */
export async function findCatalogSearchCandidates(strapi: Core.Strapi, query: PreparedCatalogSearchQuery, sampleSaleFolderIds: Set<string>) {
  if (!query.isValid) return { candidates: [] as CatalogSearchCandidate[] };
  const matches: any[] = [];
  if (query.exactCodeNeedle) matches.push({ searchCodes: { $containsi: query.exactCodeNeedle } });
  if (query.tokens.length) matches.push({ $and: query.tokens.map(token => ({ searchText: { $containsi: token } })) });
  matches.push(...searchLanguageFilters(query.interpretations));
  const fetchRows = async (alternatives: any[]) => {
  const where: any = { $and: [
    { category: { id: { $notIn: [14] } } }, getStorefrontVisibleProductFilter(),
    ...(query.sampleSaleOnly ? [{ category: { moyskladId: { $in: [...sampleSaleFolderIds] } } }] : []),
    ...(query.sampleSaleOnly && !query.tokens.length ? [] : [{ $or: alternatives }]),
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
  return rows.map(row => ({
    ...row,
    // Search uses the parent's photo, falling back to a variant's photo.
    hasSearchImage: Boolean(row.image?.[0]?.url || row.variants?.some(variant => variant.image?.[0]?.url)),
    isSampleSale: isInsideSampleSaleFolderTree(row.category?.moyskladId, sampleSaleFolderIds),
  }));
  };
  const candidates = await fetchRows(matches);
  // Only one bounded fallback query, and never for an exact article number.
  if (query.tokens.length && !candidates.some(row => catalogCandidateLanguageQuality(row, query) >= 20 ||
      (query.exactCodeNeedle && row.searchCodes?.includes(query.exactCodeNeedle)))) {
    const fuzzyFilters = searchLanguageFilters(query.interpretations, true);
    if (JSON.stringify(fuzzyFilters) !== JSON.stringify(searchLanguageFilters(query.interpretations))) {
      query.allowTypos = true;
      const additional = await fetchRows(fuzzyFilters);
      return { candidates: [...new Map([...candidates, ...additional].map(row => [row.id, row])).values()] };
    }
  }
  return { candidates };
}
