import type {
  CatalogSearchV2ImageRow,
  CatalogSearchV2ProductRow,
  CatalogSearchV2VariantRow,
} from "./catalog-search-v2-results";
import {
  containsAllSearchTokens,
  isLiteralSearchCodeMatch,
  type PreparedCatalogSearchQuery,
} from "./catalog-search-v2";
import { mapProductBadges } from "./product-badges";
import { getProductNoveltyConfig, isProductNew } from "./product-novelty";
import { isInsideSampleSaleFolderTree } from "./moysklad-sample-sale";
import {
  normalizeSearchCode,
  normalizeSearchText,
} from "./product-search-index";

const UTSENKA_CATEGORY_LABEL = "Уценка";

function resolveStorefrontCategoryName(
  category: {
    name?: string | null;
    moyskladId?: string | null;
  } | null | undefined,
  sampleSaleFolderIds: Set<string>,
): string | null {
  if (!category) return null;
  if (isInsideSampleSaleFolderTree(category.moyskladId ?? null, sampleSaleFolderIds)) {
    return UTSENKA_CATEGORY_LABEL;
  }
  return typeof category.name === "string" ? category.name : null;
}

type ProductNoveltyConfig = Awaited<ReturnType<typeof getProductNoveltyConfig>>;

export type CatalogSearchV2MatchedVariant = {
  id: number;
  name?: string | null;
  moyskladId?: string | null;
  price?: number | null;
  priceOld?: number | null;
  code?: string | null;
  characteristics?: unknown;
  image?: CatalogSearchV2ImageRow[] | null;
};

export type CatalogSearchV2ResponseAttributes = {
  name?: string | null;
  moyskladId?: string | null;
  slug?: string | null;
  price?: number | null;
  priceOld?: number | null;
  code?: string | null;
  image: CatalogSearchV2ImageRow[] | null;
  categoryName: string | null;
  matchedVariant: CatalogSearchV2MatchedVariant | null;
  isNew: boolean;
  noveltyBadgeColor: string;
  isSampleSale: boolean;
  badges: ReturnType<typeof mapProductBadges>;
};

export type CatalogSearchV2ResponseItem = {
  id: number;
  attributes: CatalogSearchV2ResponseAttributes;
};

function buildSearchTextParts(...parts: Array<string | null | undefined>): string {
  return parts.filter((part) => Boolean(part)).join(" ");
}

function buildVariantSearchText(variant: CatalogSearchV2VariantRow): string {
  return buildSearchTextParts(
    normalizeSearchText(variant.name),
    normalizeSearchText(variant.code),
    normalizeSearchCode(variant.code),
  );
}

function isExactVariant(
  variant: CatalogSearchV2VariantRow,
  query: PreparedCatalogSearchQuery,
): boolean {
  if (query.normalizedText && normalizeSearchText(variant.name) === query.normalizedText) {
    return true;
  }

  if (query.normalizedCode && normalizeSearchCode(variant.code) === query.normalizedCode) {
    return true;
  }

  return false;
}

function isParentMatched(
  product: CatalogSearchV2ProductRow,
  query: PreparedCatalogSearchQuery,
): boolean {
  const normalizedParentName = normalizeSearchText(product.name);
  const normalizedParentCode = normalizeSearchCode(product.code);
  const parentSearchText = buildSearchTextParts(
    normalizeSearchText(product.name),
    normalizeSearchText(product.code),
    normalizeSearchCode(product.code),
  );

  if (query.normalizedText && normalizedParentName === query.normalizedText) {
    return true;
  }

  if (query.normalizedCode && normalizedParentCode === query.normalizedCode) {
    return true;
  }

  if (query.normalizedText && normalizedParentName.includes(query.normalizedText)) {
    return true;
  }

  if (query.normalizedCode && parentSearchText.includes(query.normalizedCode)) {
    return true;
  }

  if (containsAllSearchTokens(parentSearchText, query.tokens)) {
    return true;
  }

  return false;
}

function isPartialVariant(
  variantSearchText: string,
  query: PreparedCatalogSearchQuery,
): boolean {
  if (query.normalizedText && variantSearchText.includes(query.normalizedText)) {
    return true;
  }

  if (query.normalizedCode && variantSearchText.includes(query.normalizedCode)) {
    return true;
  }

  if (containsAllSearchTokens(variantSearchText, query.tokens)) {
    return true;
  }

  return false;
}

function findMatchedVariant(
  product: CatalogSearchV2ProductRow,
  query: PreparedCatalogSearchQuery,
): CatalogSearchV2VariantRow | null {
  const variants = product.variants ?? [];

  if (variants.length === 0) {
    return null;
  }

  const literalVariant = variants.find((variant) => isLiteralSearchCodeMatch(variant.code, query));
  if (literalVariant) return literalVariant;
  // A similar variant must not replace a literally matched parent in the displayed result.
  if (isLiteralSearchCodeMatch(product.code, query)) return null;

  const exactVariant = variants.find((variant) => isExactVariant(variant, query));

  if (exactVariant) {
    return exactVariant;
  }

  if (isParentMatched(product, query)) {
    return null;
  }

  const partialVariant = variants.find((variant) =>
    isPartialVariant(buildVariantSearchText(variant), query),
  );

  return partialVariant ?? null;
}

function mapMatchedVariant(variant: CatalogSearchV2VariantRow): CatalogSearchV2MatchedVariant {
  return {
    id: variant.id,
    name: variant.name ?? null,
    moyskladId: variant.moyskladId ?? null,
    price: variant.price ?? null,
    priceOld: variant.priceOld ?? null,
    code: variant.code ?? null,
    characteristics: variant.characteristics ?? null,
    image: variant.image ?? null,
  };
}

function resolveSearchImage(product: CatalogSearchV2ProductRow): CatalogSearchV2ImageRow[] | null {
  const parentImage = product.image ?? null;
  const parentHasImages = Array.isArray(parentImage) && parentImage.length > 0;
  const variants = product.variants ?? [];

  const fallbackVariantWithImage = variants.find(
    (variant) => Array.isArray(variant.image) && variant.image.length > 0,
  );

  return parentHasImages ? parentImage : (fallbackVariantWithImage?.image ?? null);
}

export function mapCatalogSearchV2Rows(
  rows: CatalogSearchV2ProductRow[],
  query: PreparedCatalogSearchQuery,
  noveltyConfig: ProductNoveltyConfig,
  sampleSaleFolderIds: Set<string>,
): CatalogSearchV2ResponseItem[] {
  return rows.map((product) => {
    const matchedVariant = findMatchedVariant(product, query);
    const searchImage = resolveSearchImage(product);
    const isSampleSale = isInsideSampleSaleFolderTree(
      product.category?.moyskladId ?? null,
      sampleSaleFolderIds,
    );

    return {
      id: product.id,
      attributes: {
        name: product.name ?? null,
        moyskladId: product.moyskladId ?? null,
        slug: product.slug ?? null,
        price: product.price ?? null,
        priceOld: product.priceOld ?? null,
        code: product.code ?? null,
        image: searchImage,
        categoryName: resolveStorefrontCategoryName(product.category, sampleSaleFolderIds),
        matchedVariant: matchedVariant ? mapMatchedVariant(matchedVariant) : null,
        isNew: isProductNew(product.moyskladNoveltyAt, noveltyConfig.noveltyDays),
        noveltyBadgeColor: noveltyConfig.noveltyBadgeColor,
        isSampleSale,
        badges: mapProductBadges(product.badges),
      },
    };
  });
}
