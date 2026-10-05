type ComponentProduct = {
  id: number;
  name?: string | null;
  slug?: string | null;
  price?: number | null;
  image?: unknown;
  isHiddenOnSite?: boolean | null;
  isOutOfStock?: boolean | null;
};

export type BundleItemRow = {
  id: number;
  quantity?: number | string | null;
  title?: string | null;
  componentName?: string | null;
  componentType?: string | null;
  componentProduct?: ComponentProduct | null;
  componentVariant?: {
    id: number;
    name?: string | null;
    price?: number | null;
    image?: unknown;
    product?: { id: number } | null;
  } | null;
};

function imagePath(images: unknown): string | null {
  const first = Array.isArray(images) ? images[0] : null;
  return first?.formats?.large?.url ?? first?.formats?.medium?.url ??
    first?.formats?.small?.url ?? first?.formats?.thumbnail?.url ?? first?.url ?? null;
}

/** A missing/hidden component remains text in the composition, never a broken shop link. */
export function presentBundleItems(items: BundleItemRow[], hidden: boolean) {
  if (hidden) return [];
  return items.map((item) => {
    const product = item.componentProduct;
    const variant = item.componentVariant;
    const isVariant = item.componentType === "variant" || Boolean(variant);
    const canLink = Boolean(product?.slug && product.isHiddenOnSite !== true &&
      product.isOutOfStock !== true && (!isVariant || variant?.product?.id === product.id));
    const name = (isVariant ? variant?.name : product?.name) || item.componentName ||
      item.title?.replace(/\s*×\s*[\d.,]+\s*$/, "") || "Составляющая комплекта";
    return {
      id: item.id,
      name,
      quantity: Number(item.quantity ?? 1),
      componentProduct: canLink && product ? {
        id: product.id,
        variantId: isVariant ? variant!.id : null,
        name,
        slug: product.slug,
        price: isVariant ? variant!.price ?? null : product.price ?? null,
        imageUrl: (isVariant ? imagePath(variant!.image) : null) ?? imagePath(product.image),
      } : null,
    };
  });
}
