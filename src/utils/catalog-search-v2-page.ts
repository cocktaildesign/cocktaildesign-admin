import { createHash } from "node:crypto";
import { prepareCatalogSearchQuery, rankCatalogSearchCandidates } from "./catalog-search-v2";
import { findCatalogSearchCandidates } from "./catalog-search-v2-candidates";
import { findCatalogSearchResultRows } from "./catalog-search-v2-results";
import { mapCatalogSearchV2Rows } from "./catalog-search-v2-response";
import { loadSampleSaleFolderIdSet } from "./product-discount-policy";
import { getProductNoveltyConfig } from "./product-novelty";

function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

export async function getCatalogSearchPage(strapi: any, params: Record<string, unknown>) {
  const limit = integer(params.limit, 10, 50), offset = integer(params.offset, 0, 100000);
  if (limit === null || limit < 1 || offset === null || typeof params.q !== "string" || params.q.length > 160 ||
      (params.revision !== undefined && (typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)))) {
    return { status: 400, body: { error: "invalid_search_request" } };
  }
  const query = prepareCatalogSearchQuery(params.q);
  const empty = { items: [], total: 0, limit, offset, nextOffset: 0, hasMore: false, revision: "" };
  if (!query.isValid) return { status: 200, body: empty };
  const folders = await loadSampleSaleFolderIdSet(strapi);
  const { candidates } = await findCatalogSearchCandidates(strapi, query, folders);
  const ranked = rankCatalogSearchCandidates(candidates, query);
  // Detect changes in membership/order while the visitor pages, instead of silently skipping items.
  const revision = createHash("sha256").update(JSON.stringify([query.normalizedText, ranked.map(p => p.id)])).digest("hex");
  const changed = { status: 409, body: { error: "search_results_changed" } };
  if (offset > 0 && params.revision && params.revision !== revision) return changed;
  const page = ranked.slice(offset, offset + limit);
  const rows = await findCatalogSearchResultRows(strapi, page);
  if (rows.length !== page.length) return changed;
  const novelty = await getProductNoveltyConfig(strapi);
  const items = mapCatalogSearchV2Rows(rows, query, novelty, folders);
  const nextOffset = Math.min(offset + page.length, ranked.length);
  return { status: 200, body: { items, total: ranked.length, limit, offset, nextOffset, hasMore: nextOffset < ranked.length, revision } };
}
