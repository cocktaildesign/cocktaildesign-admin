import { loadSampleSaleFolderIdSet } from "./product-discount-policy";
import { enqueueMoySkladMutation } from "./moysklad-mutation-queue";

const PRODUCT = "api::moysklad-product.moysklad-product";

/**
 * A complete availability poll can hide sold/reserved Sample Sale items sooner
 * than the full catalog sync. Only the catalog sync can reveal them again: it
 * also checks physical stock, archive status and current CRM folder membership.
 * Never writes the manager's isHiddenOnSite flag or any ordinary product.
 */
export async function hideUnavailableSampleSale(
  app: any, states: Map<string, boolean>, readStartedAt: string,
): Promise<number> {
  return enqueueMoySkladMutation("products", async () => {
    const sync = await app.store({ type: "plugin", name: "moysklad", key: "syncState" }).get();
    if (sync?.lock?.isLocked) return 0;
    const folders = await loadSampleSaleFolderIdSet(app);
    if (!folders.size) return 0;
    const scope = {
      category: { moyskladId: { $in: [...folders] } },
      type: "product",
      $or: [{ isOutOfStock: false }, { isOutOfStock: { $null: true } }],
      // Do not apply a snapshot over a newer webhook, sync or manager edit.
      updatedAt: { $lte: readStartedAt },
    };
    const products = await app.db.query(PRODUCT).findMany({
      where: scope, select: ["id", "moyskladId"],
      populate: { variants: { select: ["moyskladId"] } },
    });
    const ids = products.filter((product: any) => {
      const variants = product.variants ?? [];
      return variants.length
        ? variants.every((variant: any) => states.get(variant.moyskladId) === true)
        : states.get(product.moyskladId) === true;
    }).map((product: any) => product.id);
    if (!ids.length) return 0;
    // Bulk updates in Strapi do not support relation filters. IDs come only from
    // the scoped read; the timestamp guard rejects later product/category edits.
    const { category: _category, ...updateScope } = scope;
    const result = await app.db.query(PRODUCT).updateMany({
      where: { ...updateScope, id: { $in: ids } },
      data: { isOutOfStock: true, updatedAt: new Date().toISOString() },
    });
    return result.count;
  });
}
