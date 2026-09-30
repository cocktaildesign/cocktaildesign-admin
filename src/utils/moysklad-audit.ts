// backend/src/utils/moysklad-audit.ts
// Получает официальную дату создания сущности из Audit API МойСклад.

export type MoySkladAuditEntityType = "product" | "bundle" | "variant";

export type MoySkladAuditOptions = {
  maxPages?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  deadlineMs?: number;
};

type MoySkladAuditRow = {
  eventType?: string;
  entityType?: string;
  moment?: string;
};

type MoySkladAuditMeta = {
  size?: number;
};

type MoySkladAuditResponse = {
  meta?: MoySkladAuditMeta;
  rows?: MoySkladAuditRow[];
};

/** HTTP-ответ МойСклад с кодом, который нужно обработать отдельно от сетевых ошибок. */
class MoySkladAuditHttpError extends Error {
  readonly status: number;

  constructor(status: number, entityType: MoySkladAuditEntityType, entityId: string) {
    super(`MoySklad audit HTTP ${status} for ${entityType}/${entityId}`);
    this.name = "MoySkladAuditHttpError";
    this.status = status;
  }
}

const MOYSKLAD_API_BASE = "https://api.moysklad.ru/api/remap/1.2";
const AUDIT_PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * МойСклад отдаёт moment в московском времени без timezone:
 * "2026-07-29 11:25:45.534" → UTC ISO.
 */
function normalizeMoySkladMomentToIsoUtc(moment: string): string | null {
  const raw = moment.trim();
  if (!raw) {
    return null;
  }

  let normalized = raw.includes("T") ? raw : raw.replace(" ", "T");

  const hasTimezone =
    /([zZ]|[+-]\d{2}:\d{2})$/.test(normalized) || /([+-]\d{4})$/.test(normalized);

  if (!hasTimezone) {
    normalized = `${normalized}+03:00`;
  }

  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

/**
 * Ищет create-событие на одной странице аудита.
 * found=true — событие есть (iso может быть null при битом moment).
 */
function findCreateMomentOnPage(
  rows: MoySkladAuditRow[],
  entityType: MoySkladAuditEntityType,
): { found: boolean; iso: string | null } {
  for (const row of rows) {
    if (row.eventType !== "create") {
      continue;
    }

    if (row.entityType !== entityType) {
      continue;
    }

    if (typeof row.moment !== "string" || !row.moment.trim()) {
      return { found: true, iso: null };
    }

    return {
      found: true,
      iso: normalizeMoySkladMomentToIsoUtc(row.moment),
    };
  }

  return { found: false, iso: null };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Один HTTP-запрос страницы аудита.
 * Сетевые ошибки (включая TypeError: fetch failed) пробрасываются наружу как есть.
 * HTTP-ошибки — через MoySkladAuditHttpError.
 * Ошибки JSON parsing не маскируются и не считаются сетевыми.
 */
async function requestAuditPage(
  url: string,
  token: string,
  entityType: MoySkladAuditEntityType,
  entityId: string,
  options: MoySkladAuditOptions,
): Promise<MoySkladAuditResponse | null> {
  const remaining = (options.deadlineMs ?? Infinity) - Date.now();
  if (remaining <= 0) throw new Error("MoySklad audit deadline reached");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, remaining));

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
          Accept: "application/json;charset=utf-8",
        "Accept-Encoding": "gzip",
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new MoySkladAuditHttpError(response.status, entityType, entityId);
    }

    // JSON parsing: ошибка не обёртывается в сетевую и не ретраится снаружи
    const data = (await response.json()) as MoySkladAuditResponse;
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAuditPage(
  entityType: MoySkladAuditEntityType,
  entityId: string,
  token: string,
  offset: number,
  options: MoySkladAuditOptions,
): Promise<MoySkladAuditResponse | null> {
  const url =
    `${MOYSKLAD_API_BASE}/entity/` +
    `${encodeURIComponent(entityType)}/` +
    `${encodeURIComponent(entityId)}/` +
    `audit?limit=${AUDIT_PAGE_LIMIT}&offset=${offset}`;

  let lastError: Error | null = null;

  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestAuditPage(url, token, entityType, entityId, options);
    } catch (err) {
      // HTTP: 404 уже вернул null внутри requestAuditPage.
      // 429 и 5xx — повторяем; остальные 4xx — сразу наружу.
      if (err instanceof MoySkladAuditHttpError) {
        if (!isRetryableHttpStatus(err.status)) {
          throw err;
        }

        lastError = err;

        if (attempt >= maxAttempts) {
          throw new Error(
            `MoySklad audit failed for ${entityType}/${entityId}: ${err.message}`,
          );
        }

        await delay(RETRY_DELAYS_MS[attempt - 1] ?? 4000);
        continue;
      }

      // Ошибка разбора JSON после успешного HTTP — не сетевая, без retry
      if (err instanceof SyntaxError) {
        throw new Error(
          `MoySklad audit failed for ${entityType}/${entityId}: invalid JSON response`,
        );
      }

      // AbortError и любая ошибка fetch (в т.ч. TypeError: fetch failed) — retry
      lastError =
        err instanceof Error
          ? err
          : new Error(`MoySklad audit network error for ${entityType}/${entityId}`);

      if (attempt >= maxAttempts) {
        throw new Error(
          `MoySklad audit failed for ${entityType}/${entityId}: ${lastError.message}`,
        );
      }

      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 4000);
    }
  }

  throw (
    lastError ??
    new Error(`MoySklad audit failed for ${entityType}/${entityId}: exhausted retries`)
  );
}

/**
 * Официальная дата создания сущности из Audit API.
 * Возвращает ISO datetime UTC или null (нет create / 404 / невалидный moment).
 */
export async function fetchMoySkladEntityCreatedAt(
  entityType: MoySkladAuditEntityType,
  entityId: string,
  options: MoySkladAuditOptions = {},
): Promise<string | null> {
  const token = process.env.MOYSKLAD_ACCESS_TOKEN;

  if (!token) {
    throw new Error("MOYSKLAD_ACCESS_TOKEN is not set");
  }

  const safeEntityId = entityId.trim();
  if (!safeEntityId) {
    throw new Error(`MoySklad audit skipped: empty entityId for ${entityType}`);
  }

  let offset = 0;
  let pages = 0;

  while (true) {
    if (pages >= (options.maxPages ?? Infinity)) throw new Error("MoySklad audit page limit reached");
    pages += 1;
    const page = await fetchAuditPage(entityType, safeEntityId, token, offset, options);

    if (page === null) {
      return null;
    }

    const rows = Array.isArray(page.rows) ? page.rows : [];

    if (rows.length === 0) {
      return null;
    }

    const createEvent = findCreateMomentOnPage(rows, entityType);

    if (createEvent.found) {
      return createEvent.iso;
    }

    offset += rows.length;

    const totalSize =
      typeof page.meta?.size === "number" && Number.isFinite(page.meta.size)
        ? page.meta.size
        : null;

    if (totalSize !== null && offset >= totalSize) {
      return null;
    }

    if (totalSize === null && rows.length < AUDIT_PAGE_LIMIT) {
      return null;
    }
  }
}
