// backend/src/utils/moysklad-sample-sale.ts
// Sample Sale: дерево папок, stock-ассортимент, принадлежность к уценке.
// Не пишет в Strapi и не меняет данные в МойСклад.

export const SAMPLE_SALE_FOLDER_ID = "b4121850-6ab7-11ef-0a80-01fa00116171";

export const SAMPLE_SALE_FOLDER_HREF =
  "https://api.moysklad.ru/api/remap/1.2/entity/productfolder/b4121850-6ab7-11ef-0a80-01fa00116171";

export type SampleSaleAssortmentItem = {
  moyskladId: string;
  name: string | null;
  type: string | null;
  productFolderId: string | null;
  stock: number | null;
  quantity: number | null;
  reserve: number | null;
  archived: boolean | null;
  variantsCount: number | null;
  imagesCount: number | null;
};

/** Папка productfolder из МойСклад (только GET). */
export type SampleSaleFolderEntity = {
  id: string;
  name: string;
  pathName?: string | null;
  meta: {
    href: string;
    type?: string;
  };
  productFolder?: {
    meta?: {
      href?: string;
    };
  };
};

/** Сырой product из МойСклад для точечного upsert (только GET). */
export type SampleSaleProductEntity = {
  id?: string;
  name?: string;
  code?: string;
  updated?: string;
  description?: string;
  meta?: {
    href?: string;
    type?: string;
  };
  productFolder?: {
    meta?: {
      href?: string;
    };
  };
  salePrices?: unknown[];
  uom?: {
    name?: string;
  };
  weight?: number | null;
  volume?: number | null;
  supplier?: {
    meta?: {
      href?: string;
    };
  };
  pathName?: string;
  archived?: boolean;
};

/** Минимальные поля productFolder для построения Sample Sale subtree. */
export type MoySkladFolderTreeNode = {
  id: string;
  productFolder?: {
    meta?: {
      href?: string;
    };
  } | null;
};

/** Минимальные поля категории Strapi для построения Sample Sale subtree. */
export type StrapiCategoryTreeNode = {
  id: number;
  moyskladId?: string | null;
  parent?: { id?: number | null } | null;
};

type MoySkladMeta = {
  href?: string;
  type?: string;
  size?: number;
};

type MoySkladAssortmentRow = {
  id?: string;
  name?: string;
  stock?: number;
  quantity?: number;
  reserve?: number;
  archived?: boolean;
  variantsCount?: number;
  images?: unknown;
  meta?: MoySkladMeta;
  productFolder?: {
    meta?: MoySkladMeta;
  };
};

type MoySkladAssortmentListResponse = {
  rows?: MoySkladAssortmentRow[];
  meta?: {
    size?: number;
    limit?: number;
    offset?: number;
    nextHref?: string;
  };
};

class MoySkladSampleSaleHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`MoySklad sample-sale HTTP ${status}`);
    this.name = "MoySkladSampleSaleHttpError";
    this.status = status;
  }
}

const MOYSKLAD_API_BASE = "https://api.moysklad.ru/api/remap/1.2";
const PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
/** Защита от бесконечной пагинации: 100 * 1000 = 100_000 строк максимум. */
const MAX_PAGES = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getMoySkladHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json;charset=utf-8",
  } as const;
}

function pickIdFromHref(href?: string): string | null {
  if (!href) return null;

  const clean = href.split("?")[0]?.split("#")[0];
  if (!clean) return null;

  const parts = clean.split("/");
  const last = parts[parts.length - 1];

  return last ? last : null;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * stock из assortment.
 *
 * Отсутствующее значение → null: это допустимо и означает «нет в наличии».
 * Значение другого типа НЕ подменяем на null или 0 — иначе битый ответ API
 * молча превратился бы в «распродано». Такое значение отбрасывает
 * assertValidSampleSaleStock() до любых записей в базу.
 */
function toStockValue(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value as number;
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * images в assortment бывает массивом или объектом с meta.size.
 * Если структуры нет — возвращаем null, а не 0.
 */
function resolveImagesCount(images: unknown): number | null {
  if (Array.isArray(images)) {
    return images.length;
  }

  if (!images || typeof images !== "object") {
    return null;
  }

  const meta = (images as { meta?: { size?: unknown } }).meta;
  if (meta && typeof meta.size === "number" && Number.isFinite(meta.size)) {
    return meta.size;
  }

  return null;
}

function buildFolderHref(folderId: string): string {
  return `${MOYSKLAD_API_BASE}/entity/productfolder/${folderId}`;
}

function buildAssortmentPageUrl(folderId: string, offset: number): string {
  const filter = encodeURIComponent(`productFolder=${buildFolderHref(folderId)}`);
  return `${MOYSKLAD_API_BASE}/entity/assortment?filter=${filter}&limit=${PAGE_LIMIT}&offset=${offset}`;
}

function normalizeAssortmentRow(row: MoySkladAssortmentRow): SampleSaleAssortmentItem | null {
  const moyskladId =
    typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : pickIdFromHref(row.meta?.href);

  if (!moyskladId) {
    return null;
  }

  return {
    moyskladId,
    name: toNullableString(row.name),
    type: toNullableString(row.meta?.type),
    productFolderId: pickIdFromHref(row.productFolder?.meta?.href),
    stock: toStockValue(row.stock),
    quantity: toStockValue(row.quantity),
    reserve: toNullableNumber(row.reserve),
    archived: toNullableBoolean(row.archived),
    variantsCount: toNullableNumber(row.variantsCount),
    imagesCount: resolveImagesCount(row.images),
  };
}

function requireAccessToken(): string {
  const token = process.env.MOYSKLAD_ACCESS_TOKEN;

  if (!token) {
    throw new Error("MOYSKLAD_ACCESS_TOKEN is not set");
  }

  return token;
}

async function requestJson<T>(url: string, token: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: getMoySkladHeaders(token),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Текст ответа не включаем: там не должно оказаться токена / лишнего payload.
      throw new MoySkladSampleSaleHttpError(response.status);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry<T>(url: string, token: string, label: string): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestJson<T>(url, token);
    } catch (err) {
      if (err instanceof MoySkladSampleSaleHttpError) {
        if (!isRetryableHttpStatus(err.status)) {
          throw err;
        }

        lastError = err;

        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`MoySklad sample-sale ${label} failed: ${err.message}`);
        }

        await delay(RETRY_DELAYS_MS[attempt - 1] ?? 4000);
        continue;
      }

      if (err instanceof SyntaxError) {
        throw new Error(`MoySklad sample-sale ${label} failed: invalid JSON response`);
      }

      // AbortError / сетевые ошибки fetch — retry
      lastError =
        err instanceof Error ? err : new Error(`MoySklad sample-sale network error: ${label}`);

      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`MoySklad sample-sale ${label} failed: ${lastError.message}`);
      }

      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 4000);
    }
  }

  throw lastError ?? new Error(`MoySklad sample-sale ${label} failed: exhausted retries`);
}

async function fetchAssortmentPageForFolder(
  folderId: string,
  offset: number,
  token: string,
): Promise<MoySkladAssortmentListResponse> {
  return fetchJsonWithRetry<MoySkladAssortmentListResponse>(
    buildAssortmentPageUrl(folderId, offset),
    token,
    `assortment folder=${folderId} offset=${offset}`,
  );
}

/**
 * Ассортимент одной папки (только GET).
 * Фильтр — точный href папки по ID, без имени и pathName.
 */
async function fetchAssortmentForFolder(
  folderId: string,
  token: string,
): Promise<SampleSaleAssortmentItem[]> {
  const items: SampleSaleAssortmentItem[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await fetchAssortmentPageForFolder(folderId, offset, token);
    const rows = Array.isArray(data.rows) ? data.rows : [];

    for (const row of rows) {
      const item = normalizeAssortmentRow(row);
      if (item) {
        items.push(item);
      }
    }

    if (!data.meta?.nextHref) {
      return items;
    }

    if (rows.length === 0) {
      return items;
    }

    offset += rows.length;
  }

  throw new Error(
    `MoySklad sample-sale assortment pagination aborted: folder=${folderId} MAX_PAGES=${MAX_PAGES}`,
  );
}

/**
 * Уценка скрывается при отсутствии физического или свободного остатка.
 * Старые ответы без quantity сохраняют прежнее правило по stock.
 */
export function resolveSampleSaleIsOutOfStock(stock: number | null, quantity?: number | null): boolean {
  return stock === null || stock <= 0 || (quantity != null && quantity <= 0);
}

/** Принадлежность именно корневой папке Sample Sale (точный ID). */
export function isSampleSaleFolderId(folderId: string | null | undefined): boolean {
  return folderId === SAMPLE_SALE_FOLDER_ID;
}

/**
 * Принадлежность к дереву Sample Sale (корень или любой descendant).
 * Проверка только через заранее собранный Set moyskladId.
 */
export function isInsideSampleSaleFolderTree(
  folderId: string | null | undefined,
  sampleSaleFolderIds: Set<string>,
): boolean {
  if (!folderId) return false;
  return sampleSaleFolderIds.has(folderId);
}

/**
 * Собирает Set moyskladId: корень Sample Sale + все descendants любой глубины.
 *
 * Parent берётся только из productFolder.meta.href.
 * Не использует name/pathName.
 * Защита от циклов и битых parent.
 *
 * Если корень отсутствует в массиве — бросает ошибку
 * (без корня дерево уценки строить нельзя).
 */
export function collectSampleSaleSubtreeMoyskladIds(
  folders: MoySkladFolderTreeNode[],
): Set<string> {
  const byId = new Map<string, MoySkladFolderTreeNode>();

  for (const folder of folders) {
    if (!folder || typeof folder.id !== "string" || !folder.id) continue;
    byId.set(folder.id, folder);
  }

  if (!byId.has(SAMPLE_SALE_FOLDER_ID)) {
    throw new Error(
      `Sample Sale root folder missing in MoySklad productfolder list ` +
        `(moyskladId=${SAMPLE_SALE_FOLDER_ID})`,
    );
  }

  const childrenByParentId = new Map<string, string[]>();

  for (const folder of byId.values()) {
    const parentId = pickIdFromHref(folder.productFolder?.meta?.href);
    if (!parentId) continue;
    if (!byId.has(parentId)) continue;

    const list = childrenByParentId.get(parentId) ?? [];
    list.push(folder.id);
    childrenByParentId.set(parentId, list);
  }

  const result = new Set<string>();
  const queue: string[] = [SAMPLE_SALE_FOLDER_ID];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;

    if (result.has(currentId)) {
      continue;
    }

    result.add(currentId);

    const children = childrenByParentId.get(currentId) ?? [];
    for (const childId of children) {
      if (!result.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return result;
}

/**
 * Set moyskladId категорий Strapi внутри Sample Sale subtree.
 * Один проход по уже загруженным категориям — без N+1.
 */
export function buildSampleSaleMoyskladIdSetFromStrapiCategories(
  categories: StrapiCategoryTreeNode[],
): Set<string> {
  const byId = new Map<number, StrapiCategoryTreeNode>();
  let rootStrapiId: number | null = null;

  for (const category of categories) {
    if (!category || typeof category.id !== "number") continue;
    byId.set(category.id, category);

    if (category.moyskladId === SAMPLE_SALE_FOLDER_ID) {
      rootStrapiId = category.id;
    }
  }

  if (rootStrapiId === null) {
    return new Set<string>();
  }

  const childrenByParentId = new Map<number, number[]>();

  for (const category of byId.values()) {
    const parentId = category.parent?.id ?? null;
    if (typeof parentId !== "number") continue;
    if (!byId.has(parentId)) continue;

    const list = childrenByParentId.get(parentId) ?? [];
    list.push(category.id);
    childrenByParentId.set(parentId, list);
  }

  const result = new Set<string>();
  const queue: number[] = [rootStrapiId];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const currentId = queue.shift() as number;

    if (visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);

    const node = byId.get(currentId);
    const moyskladId =
      typeof node?.moyskladId === "string" && node.moyskladId.trim()
        ? node.moyskladId.trim()
        : null;

    if (moyskladId) {
      result.add(moyskladId);
    }

    const children = childrenByParentId.get(currentId) ?? [];
    for (const childId of children) {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return result;
}

/**
 * Set числовых Strapi id категорий внутри Sample Sale subtree.
 * Один проход по уже загруженным категориям — без N+1.
 */
export function buildSampleSaleStrapiCategoryIdSet(
  categories: StrapiCategoryTreeNode[],
): Set<number> {
  const byId = new Map<number, StrapiCategoryTreeNode>();
  let rootStrapiId: number | null = null;

  for (const category of categories) {
    if (!category || typeof category.id !== "number") continue;
    byId.set(category.id, category);

    if (category.moyskladId === SAMPLE_SALE_FOLDER_ID) {
      rootStrapiId = category.id;
    }
  }

  if (rootStrapiId === null) {
    return new Set<number>();
  }

  const childrenByParentId = new Map<number, number[]>();

  for (const category of byId.values()) {
    const parentId = category.parent?.id ?? null;
    if (typeof parentId !== "number") continue;
    if (!byId.has(parentId)) continue;

    const list = childrenByParentId.get(parentId) ?? [];
    list.push(category.id);
    childrenByParentId.set(parentId, list);
  }

  const result = new Set<number>();
  const queue: number[] = [rootStrapiId];

  while (queue.length > 0) {
    const currentId = queue.shift() as number;

    if (result.has(currentId)) {
      continue;
    }

    result.add(currentId);

    const children = childrenByParentId.get(currentId) ?? [];
    for (const childId of children) {
      if (!result.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return result;
}

/**
 * Проверка одной строки остатка.
 *
 * null допустим и позднее трактуется как isOutOfStock = true.
 * Любое число, включая 0, отрицательные и дробные, допустимо.
 * Ошибка только если значение присутствует, но не является конечным number:
 * строку "0" в число не превращаем.
 */
export function assertValidSampleSaleStock(item: SampleSaleAssortmentItem): void {
  if (item.quantity != null &&
      (typeof item.quantity !== "number" || !Number.isFinite(item.quantity))) {
    throw new Error(`MoySklad sample-sale invalid quantity for ${item.moyskladId}`);
  }
  const stock: unknown = item.stock;

  if (stock === null) {
    return;
  }

  if (typeof stock !== "number" || !Number.isFinite(stock)) {
    throw new Error(
      `MoySklad sample-sale invalid stock for ${item.moyskladId}: type=${typeof stock}`,
    );
  }
}

/** Системные поля остатка для записи в Strapi. */
export function buildSampleSaleStockFields(stock: number | null, quantity?: number | null): {
  moyskladStock: number | null;
  isOutOfStock: boolean;
} {
  return {
    moyskladStock: stock,
    isOutOfStock: resolveSampleSaleIsOutOfStock(stock, quantity),
  };
}

/** Сброс системных полей остатка (товар покинул Sample Sale). */
export function buildClearedSampleSaleStockFields(): {
  moyskladStock: null;
  isOutOfStock: null;
} {
  return {
    moyskladStock: null,
    isOutOfStock: null,
  };
}

/**
 * Map остатков по moyskladId с валидацией до любых записей в базу.
 * Бросает ошибку при пустом ответе и чужой папке.
 * Дубли по moyskladId не создаём: оставляем первую строку.
 */
export function buildSampleSaleStockMap(
  items: SampleSaleAssortmentItem[],
  sampleSaleFolderIds: Set<string>,
): Map<string, SampleSaleAssortmentItem> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      "MoySklad sample-sale stock map aborted: assortment is empty (possible API or filter error)",
    );
  }

  if (!sampleSaleFolderIds.has(SAMPLE_SALE_FOLDER_ID)) {
    throw new Error(
      "MoySklad sample-sale stock map aborted: Sample Sale root is missing from folder set",
    );
  }

  const map = new Map<string, SampleSaleAssortmentItem>();

  for (const item of items) {
    if (!item || typeof item.moyskladId !== "string" || !item.moyskladId) {
      throw new Error("MoySklad sample-sale stock map aborted: row without moyskladId");
    }

    if (!isInsideSampleSaleFolderTree(item.productFolderId, sampleSaleFolderIds)) {
      throw new Error(
        `MoySklad sample-sale stock map aborted: foreign folder for ${item.moyskladId}`,
      );
    }

    assertValidSampleSaleStock(item);

    // Один товар из нескольких папок / дубль ответа — оставляем первую строку.
    if (map.has(item.moyskladId)) {
      continue;
    }

    map.set(item.moyskladId, item);
  }

  return map;
}

/**
 * Загружает ассортимент корня Sample Sale и всех переданных descendants (только GET).
 * По одному запросу на folder id, результаты объединяются и дедуплицируются.
 */
export async function fetchSampleSaleAssortment(
  sampleSaleFolderIds: Set<string> | string[],
): Promise<SampleSaleAssortmentItem[]> {
  const token = requireAccessToken();
  const folderIds =
    sampleSaleFolderIds instanceof Set
      ? Array.from(sampleSaleFolderIds)
      : Array.from(new Set(sampleSaleFolderIds));

  if (folderIds.length === 0) {
    throw new Error("MoySklad sample-sale assortment aborted: empty folder id set");
  }

  if (!folderIds.includes(SAMPLE_SALE_FOLDER_ID)) {
    throw new Error(
      "MoySklad sample-sale assortment aborted: Sample Sale root is missing from folder set",
    );
  }

  const byMoyskladId = new Map<string, SampleSaleAssortmentItem>();

  for (const folderId of folderIds) {
    if (typeof folderId !== "string" || !folderId.trim()) {
      continue;
    }

    const folderItems = await fetchAssortmentForFolder(folderId.trim(), token);

    for (const item of folderItems) {
      if (!byMoyskladId.has(item.moyskladId)) {
        byMoyskladId.set(item.moyskladId, item);
      }
    }
  }

  return Array.from(byMoyskladId.values());
}

/**
 * Один товар из ассортимента по moyskladId (только GET).
 * Без фильтра по папке: затем проверяем, что productFolder входит в Sample Sale tree.
 */
export async function fetchSampleSaleAssortmentItemById(
  moyskladId: string,
  sampleSaleFolderIds: Set<string>,
): Promise<SampleSaleAssortmentItem | null> {
  const token = requireAccessToken();
  const safeId = moyskladId.trim();

  if (!safeId) {
    throw new Error("MoySklad sample-sale assortment item: empty moyskladId");
  }

  if (!sampleSaleFolderIds.has(SAMPLE_SALE_FOLDER_ID)) {
    throw new Error(
      "MoySklad sample-sale assortment item aborted: Sample Sale root is missing from folder set",
    );
  }

  const filter = encodeURIComponent(`id=${safeId}`);
  const url = `${MOYSKLAD_API_BASE}/entity/assortment?filter=${filter}&limit=10`;
  const data = await fetchJsonWithRetry<MoySkladAssortmentListResponse>(
    url,
    token,
    `assortment item id=${safeId}`,
  );

  const rows = Array.isArray(data.rows) ? data.rows : [];

  for (const row of rows) {
    const item = normalizeAssortmentRow(row);
    if (!item || item.moyskladId !== safeId) {
      continue;
    }

    if (!isInsideSampleSaleFolderTree(item.productFolderId, sampleSaleFolderIds)) {
      return null;
    }

    // Битый stock должен стать ошибкой запроса, а не «нет в наличии».
    assertValidSampleSaleStock(item);
    return item;
  }

  return null;
}

/**
 * Папка Sample Sale из МойСклад (только GET).
 */
export async function fetchSampleSaleFolder(): Promise<SampleSaleFolderEntity> {
  const token = requireAccessToken();
  const url = `${MOYSKLAD_API_BASE}/entity/productfolder/${SAMPLE_SALE_FOLDER_ID}`;
  const data = await fetchJsonWithRetry<SampleSaleFolderEntity>(
    url,
    token,
    `productfolder id=${SAMPLE_SALE_FOLDER_ID}`,
  );

  if (!data || typeof data.id !== "string" || !data.id) {
    throw new Error("MoySklad sample-sale folder response has no id");
  }

  if (data.id !== SAMPLE_SALE_FOLDER_ID) {
    throw new Error("MoySklad sample-sale folder id mismatch");
  }

  if (!data.meta || typeof data.meta.href !== "string" || !data.meta.href) {
    throw new Error("MoySklad sample-sale folder response has no meta.href");
  }

  if (typeof data.name !== "string") {
    throw new Error("MoySklad sample-sale folder response has no name");
  }

  return data;
}

/**
 * Полный product из МойСклад по id (только GET).
 * Нужен для точечного upsert через syncOneFromWebhook.
 */
export async function fetchMoySkladProductEntity(
  moyskladId: string,
): Promise<SampleSaleProductEntity> {
  const token = requireAccessToken();
  const safeId = moyskladId.trim();

  if (!safeId) {
    throw new Error("MoySklad sample-sale product: empty moyskladId");
  }

  const url = `${MOYSKLAD_API_BASE}/entity/product/${encodeURIComponent(safeId)}`;
  const data = await fetchJsonWithRetry<SampleSaleProductEntity>(
    url,
    token,
    `product id=${safeId}`,
  );

  const entityId =
    typeof data.id === "string" && data.id.trim()
      ? data.id.trim()
      : pickIdFromHref(data.meta?.href);

  if (!entityId || entityId !== safeId) {
    throw new Error(`MoySklad sample-sale product id mismatch for ${safeId}`);
  }

  return data;
}
