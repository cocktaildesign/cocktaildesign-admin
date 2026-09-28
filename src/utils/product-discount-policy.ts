import {
  buildSampleSaleMoyskladIdSetFromStrapiCategories,
  isInsideSampleSaleFolderTree,
} from "./moysklad-sample-sale";

/** Read the current category tree once per request, including Sample Sale descendants. */
export async function loadSampleSaleFolderIdSet(strapi: any): Promise<Set<string>> {
  const rows = await strapi.db.query("api::moysklad-category.moysklad-category").findMany({
    select: ["id", "moyskladId"],
    populate: { parent: { select: ["id"] } },
    limit: 100000,
  });
  return buildSampleSaleMoyskladIdSetFromStrapiCategories(rows);
}

/** Excludes volume/percentage discounts. Fixed-amount promo codes remain valid. */
export function isProductDiscountExcluded(
  product: { discountExcluded?: boolean | null; category?: { moyskladId?: string | null } | null },
  sampleSaleFolderIds: Set<string>,
): boolean {
  return product.discountExcluded === true ||
    isInsideSampleSaleFolderTree(product.category?.moyskladId, sampleSaleFolderIds);
}
