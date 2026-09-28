import { getStorefrontVisibleProductFilter } from "../../../utils/storefront-product-visibility";
import { isProductDiscountExcluded, loadSampleSaleFolderIdSet } from "../../../utils/product-discount-policy";

export default {
  /** GET only: refresh saved cart flags by public SKU, including variants. No prices or CRM writes. */
  async find(ctx) {
    let codes: unknown;
    try {
      codes = JSON.parse(String(ctx.query.codes ?? ""));
    } catch {
      ctx.status = 400;
      ctx.body = { error: "invalid_codes" };
      return;
    }
    if (!Array.isArray(codes) || codes.length < 1 || codes.length > 25 ||
        codes.some(code => typeof code !== "string" || !code.trim() || code.length > 64)) {
      ctx.status = 400;
      ctx.body = { error: "invalid_codes" };
      return;
    }
    const requested = [...new Set((codes as string[]).map(code => code.trim()))];
    const productFields = ["code", "discountExcluded"];
    const category = { select: ["moyskladId"] };
    const visible = getStorefrontVisibleProductFilter();
    const [folders, products, variants] = await Promise.all([
      loadSampleSaleFolderIdSet(strapi),
      strapi.db.query("api::moysklad-product.moysklad-product").findMany({
        where: { code: { $in: requested }, ...visible },
        select: productFields, populate: { category }, limit: 25,
      }),
      strapi.db.query("api::moysklad-variant.moysklad-variant").findMany({
        where: { code: { $in: requested }, product: visible }, select: ["code"],
        populate: { product: { select: productFields, populate: { category } } }, limit: 25,
      }),
    ]);
    const byCode = new Map<string, boolean>();
    for (const product of products) byCode.set(product.code, isProductDiscountExcluded(product, folders));
    // Same precedence as the trusted order resolver: variant first, parent fallback.
    for (const variant of variants) {
      if (variant.product) byCode.set(variant.code, isProductDiscountExcluded(variant.product, folders));
    }
    ctx.set("Cache-Control", "no-store");
    ctx.body = {
      items: requested.filter(code => byCode.has(code)).map(code => ({ code, discountExcluded: byCode.get(code) })),
    };
  },
};
