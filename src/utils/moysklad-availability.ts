// Visual availability only. Never changes product flags, prices or order eligibility.
export type AvailabilitySnapshot = {
  version: 1;
  updatedAt: string;
  states: Record<string, boolean>; // MoySklad ID -> quantity <= 0
};

export const AVAILABILITY_STORE = { type: "plugin", name: "moysklad", key: "availability-v1" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = "https://api.moysklad.ru/api/remap/1.2/entity/assortment";
const LIMIT = 1000;

export function parseAvailabilitySnapshot(value: any): AvailabilitySnapshot | null {
  if (!value || value.version !== 1 || typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt)) || !value.states ||
      typeof value.states !== "object" || Array.isArray(value.states)) return null;
  if (Object.entries(value.states).some(([id, state]) => !UUID.test(id) || typeof state !== "boolean")) return null;
  return value;
}

export async function readMoySkladAvailability(token: string, fetcher = fetch): Promise<Map<string, boolean>> {
  if (!token) throw new Error("availability_token_missing");
  const states = new Map<string, boolean>();
  const seen = new Set<string>();
  let total: number | undefined;
  const started = Date.now();
  for (let offset = 0; total === undefined || offset < total; offset += LIMIT) {
    if (Date.now() - started > 120_000) throw new Error("availability_deadline");
    // No stockStore filter: all warehouses. Both zero and negative quantities included.
    const query = new URLSearchParams({ limit: String(LIMIT), offset: String(offset),
      groupBy: "variant", filter: "stockMode=all;quantityMode=all" });
    const response = await fetcher(`${BASE}?${query}`, { method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json;charset=utf-8", "Accept-Encoding": "gzip" },
      signal: AbortSignal.timeout(20_000) });
    // On rate limiting/errors keep the saved snapshot; retry on the next scheduled run.
    if (!response.ok) throw new Error(`availability_http_${response.status}`);
    const page = await response.json() as any;
    if (!Number.isInteger(page?.meta?.size) || page.meta.size <= 0 || page.meta.size > 100_000 ||
        page.meta.offset !== offset || !Array.isArray(page.rows)) throw new Error("availability_invalid_page");
    if (total === undefined) total = page.meta.size;
    if (total !== page.meta.size || page.rows.length !== Math.min(LIMIT, total - offset)) {
      throw new Error("availability_incomplete_page");
    }
    for (const row of page.rows) {
      if (typeof row?.id !== "string" || !UUID.test(row.id) || seen.has(row.id)) throw new Error("availability_invalid_id");
      seen.add(row.id);
      if (row.meta?.type === "bundle" || row.meta?.type === "service") continue;
      if (!["product", "variant"].includes(row.meta?.type) || typeof row.quantity !== "number" || !Number.isFinite(row.quantity)) {
        throw new Error("availability_invalid_quantity");
      }
      states.set(row.id, row.quantity <= 0);
    }
  }
  if (!states.size || seen.size !== total) throw new Error("availability_incomplete_snapshot");
  return states;
}
