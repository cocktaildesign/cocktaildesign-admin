type PurchaseProduct = { id: string; name: string; price: number; quantity: number };
type PurchaseAnalytics = { currency: 'RUB'; revenue: number; products: PurchaseProduct[] };

// Optional response metadata only. Uses the accepted server snapshot, never the
// browser's prices. No customer fields, extra database reads or network calls.
export function purchaseAnalytics(value: unknown): PurchaseAnalytics | undefined {
  try {
    const snapshot = typeof value === 'string' ? JSON.parse(value) : value;
    if (!snapshot || typeof snapshot !== 'object') return;
    const { version, order, positions } = snapshot as any;
    if (version !== 1 || !Number.isSafeInteger(order?.sum) || order.sum < 0 ||
        !Array.isArray(positions) || positions.length < 1 || positions.length > 100) return;
    const products: PurchaseProduct[] = [];
    for (const item of positions) {
      const { code, name } = item?.assortment ?? {};
      const { quantity, price, discount = 0 } = item ?? {};
      if (typeof code !== 'string' || !code.trim() || code.length > 255 ||
          typeof name !== 'string' || !name.trim() || name.length > 1000 ||
          !Number.isSafeInteger(quantity) || quantity < 1 ||
          typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > Number.MAX_SAFE_INTEGER ||
          typeof discount !== 'number' || !Number.isFinite(discount) || discount < 0 || discount > 100) return;
      // Stored price is in kopecks; discount is the actual percentage sent to CRM.
      products.push({ id: code, name, quantity, price: Math.round(price * (1 - discount / 100)) / 100 });
    }
    return { currency: 'RUB', revenue: order.sum / 100, products };
  } catch { return; } // Missing/purged/invalid analytics must never fail acceptance or replay.
}
