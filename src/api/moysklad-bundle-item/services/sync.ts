// Website composition only. Never changes CRM bundles, inventory, prices or order positions.
type ComponentRow = {
  quantity: number;
  assortment?: { name?: string; meta?: { href?: string; type?: string } };
};

async function fetchBundleComponents(bundleMsId: string, token: string): Promise<ComponentRow[]> {
  const url = `https://api.moysklad.ru/api/remap/1.2/entity/bundle/${bundleMsId}/components?limit=1000&expand=assortment`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json;charset=utf-8" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`MoySklad bundle components HTTP ${response.status}`);
  const data = await response.json() as { rows?: ComponentRow[]; meta?: { size?: number } };
  // Preserve the last complete composition if CRM returns a partial/malformed response.
  if (!Array.isArray(data.rows) || data.meta?.size !== data.rows.length) {
    throw new Error("Incomplete MoySklad bundle components response");
  }
  return data.rows;
}

export async function syncBundleItemsForBundle(bundleMsId: string) {
  const token = process.env.MOYSKLAD_ACCESS_TOKEN;
  if (!token) throw new Error("MOYSKLAD_ACCESS_TOKEN is not set");
  const products = strapi.db.query("api::moysklad-product.moysklad-product");
  const variants = strapi.db.query("api::moysklad-variant.moysklad-variant");
  const items = strapi.db.query("api::moysklad-bundle-item.moysklad-bundle-item");
  const bundle = await products.findOne({ where: { moyskladId: bundleMsId }, select: ["id", "type"] });
  if (!bundle || bundle.type !== "bundle") throw new Error("Bundle not found in Strapi");

  const rows = await fetchBundleComponents(bundleMsId, token);
  const prepared: Record<string, unknown>[] = [];
  for (const [position, row] of rows.entries()) {
    const assortment = row.assortment;
    const match = assortment?.meta?.href?.match(/\/entity\/(product|variant|bundle|service)\/([a-f\d-]{36})(?:[?#].*)?$/i);
    const quantity = Number(row.quantity);
    if (!match || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Invalid MoySklad bundle component");
    }
    const [, componentType, componentMsId] = match;
    const variant = componentType === "variant" ? await variants.findOne({
      where: { moyskladId: componentMsId }, select: ["id", "name"], populate: { product: { select: ["id"] } },
    }) : null;
    const product = componentType === "product" || componentType === "bundle" ? await products.findOne({
      where: { moyskladId: componentMsId }, select: ["id", "name"],
    }) : null;
    const componentName = assortment?.name || variant?.name || product?.name;
    if (!componentName) throw new Error("Bundle component name missing");
    prepared.push({
      title: `${componentName} × ${quantity}`.slice(0, 255), componentName, componentType, position,
      bundle: bundle.id, quantity,
      componentProduct: variant?.product?.id ?? product?.id ?? null,
      componentVariant: variant?.id ?? null,
    });
  }

  // All remote reads and validation finish first; a failed write restores the previous set.
  // hideBundleContents is editorial and is never touched by this service.
  await strapi.db.transaction(async () => {
    await items.deleteMany({ where: { bundle: bundle.id } });
    for (const data of prepared) await items.create({ data });
  });
  strapi.log.info(`[moysklad] bundle items synced: bundle=${bundleMsId} created=${prepared.length} skipped=0`);
  return { ok: true, bundleMsId, created: prepared.length, skipped: 0 };
}

export default () => ({ syncBundleItemsForBundle });
