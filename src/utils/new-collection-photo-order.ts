type PhotoCandidate = {
  id: number;
  image?: Array<{ url?: string | null }> | null;
  variants?: Array<{ image?: Array<{ url?: string | null }> | null }> | null;
};

type ProductQuery = {
  findMany(args: Record<string, unknown>): Promise<PhotoCandidate[]>;
};

const BATCH_SIZE = 200;

/** Preserve the database's novelty order inside each photo group, across all pages. */
export async function getNewCollectionPhotoPage(
  productQuery: ProductQuery,
  where: Record<string, unknown>,
  orderBy: unknown,
  limit: number,
  offset: number,
): Promise<{ ids: number[]; total: number }> {
  const withPhoto: number[] = [];
  const withoutPhoto: number[] = [];
  let cursor = 0;

  for (;;) {
    // Read only ids and photo links for sorting; hydrate full cards for the requested page.
    const rows = await productQuery.findMany({
      where,
      select: ["id"],
      populate: {
        image: { select: ["url"] },
        variants: { select: ["id"], populate: { image: { select: ["url"] } } },
      },
      orderBy,
      limit: BATCH_SIZE,
      offset: cursor,
    });
    for (const row of rows) {
      const hasPhoto = row.image?.some(image => Boolean(image.url)) ||
        row.variants?.some(variant => variant.image?.some(image => Boolean(image.url)));
      (hasPhoto ? withPhoto : withoutPhoto).push(row.id);
    }
    cursor += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  const ordered = withPhoto.concat(withoutPhoto);
  return { ids: ordered.slice(offset, offset + limit), total: ordered.length };
}
