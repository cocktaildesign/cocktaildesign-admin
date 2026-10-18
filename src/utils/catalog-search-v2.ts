import {
  normalizeSearchCode,
  normalizeSearchText,
} from "./product-search-index";
import { isSearchSaleWord, prepareSearchInterpretations, searchLanguageQuality, searchNamePosition, swapSearchLayout, type SearchInterpretation } from "./catalog-search-language";

export type PreparedCatalogSearchQuery = {
  raw: string;
  normalizedText: string;
  normalizedCode: string;
  tokens: string[];
  exactCodeNeedle: string;
  isValid: boolean;
  sampleSaleOnly: boolean;
  interpretations: SearchInterpretation[];
  allowTypos: boolean;
};

export type CatalogSearchCandidate = {
  id: number;
  name?: string | null;
  code?: string | null;
  searchText?: string | null;
  searchCodes?: string | null;
  isSampleSale?: boolean;
  hasSearchImage?: boolean;
  image?: Array<{ url?: string | null }> | null;
  category?: { moyskladId?: string | null } | null;
  variants?: Array<{ name?: string | null; code?: string | null; image?: Array<{ url?: string | null }> | null }>;
};

const CATALOG_SEARCH_RESULT_LIMIT = 10;

function uniqueTokensInOrder(tokens: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!token || seen.has(token)) {
      continue;
    }

    seen.add(token);
    result.push(token);
  }

  return result;
}

export function prepareCatalogSearchQuery(value: unknown): PreparedCatalogSearchQuery {
  const raw = String(value ?? "").trim();
  const normalizedText = normalizeSearchText(raw);
  const normalizedCode = normalizeSearchCode(raw);
  const allTokens = uniqueTokensInOrder(normalizedText.split(" ").filter(Boolean));
  const layoutTokens = normalizeSearchText(swapSearchLayout(raw)).split(" ");
  const sampleSaleOnly = allTokens.some(isSearchSaleWord) || layoutTokens.some(isSearchSaleWord);
  const effectiveTokens = !allTokens.some(isSearchSaleWord) && layoutTokens.some(isSearchSaleWord) ? layoutTokens : allTokens;
  const tokens = effectiveTokens.filter(token => !isSearchSaleWord(token));
  const exactCodeNeedle = normalizedCode ? `|${normalizedCode}|` : "";
  const isValid =
    raw.length >= 2 && raw.length <= 160 && (normalizedText.length > 0 || normalizedCode.length > 0);

  return {
    raw,
    normalizedText,
    normalizedCode,
    tokens,
    exactCodeNeedle,
    isValid,
    sampleSaleOnly,
    interpretations: prepareSearchInterpretations(raw),
    allowTypos: false,
  };
}

export function catalogCandidateLanguageQuality(candidate: CatalogSearchCandidate, query: PreparedCatalogSearchQuery): number {
  // Codes deliberately excluded: "pin" is not a word match for "LeafPink100".
  const name = candidate.name ?? "";
  const parent = searchLanguageQuality(name, query.interpretations, query.allowTypos);
  return Math.max(parent ? parent * 10 + 1 : 0,
    ...(candidate.variants ?? []).map(v => searchLanguageQuality(name + " " + (v.name ?? ""), query.interpretations, query.allowTypos) * 10));
}

export function containsAllSearchTokens(
  searchText: string | null | undefined,
  tokens: string[],
): boolean {
  const haystack = searchText ?? "";

  if (!haystack || tokens.length === 0) {
    return false;
  }

  const haystackTokens = new Set(haystack.split(" ").filter(Boolean));

  return tokens.every((token) => haystackTokens.has(token));
}

export function scoreCatalogSearchCandidate(
  candidate: CatalogSearchCandidate,
  query: PreparedCatalogSearchQuery,
): number {
  const normalizedName = normalizeSearchText(candidate.name);
  const normalizedParentCode = normalizeSearchCode(candidate.code);
  const searchText = candidate.searchText ?? "";
  const searchCodes = candidate.searchCodes ?? "";

  let score = query.sampleSaleOnly && candidate.isSampleSale ? 1 : 0;

  if (query.normalizedCode && normalizedParentCode === query.normalizedCode) {
    score += 1200;
  }

  if (query.exactCodeNeedle && searchCodes.includes(query.exactCodeNeedle)) {
    score += 1000;
  }

  if (query.normalizedText && normalizedName === query.normalizedText) {
    score += 800;
  }

  if (query.normalizedText && normalizedName.startsWith(query.normalizedText)) {
    score += 600;
  }

  if (query.normalizedText && normalizedName.includes(query.normalizedText)) {
    score += 500;
  }

  if (query.normalizedText && searchText.includes(query.normalizedText)) {
    score += 300;
  }

  if (query.normalizedCode && searchText.includes(query.normalizedCode)) {
    score += 250;
  }

  if (containsAllSearchTokens(searchText, query.tokens)) {
    score += 200;
  }

  // Keep matches for unfinished words too (e.g. "барн лож" while typing).
  if (query.tokens.length && query.tokens.every(token => searchText.includes(token))) {
    score += 100;
  }

  return score + (catalogCandidateLanguageQuality(candidate, query) > 0 ? searchNamePosition(candidate.name ?? "", query.interpretations) : 0);
}

function exactMatch(candidate: CatalogSearchCandidate, query: PreparedCatalogSearchQuery): number {
  if (query.normalizedCode && (normalizeSearchCode(candidate.code) === query.normalizedCode ||
      candidate.searchCodes?.includes(query.exactCodeNeedle))) return 2;
  if (query.normalizedText && (normalizeSearchText(candidate.name) === query.normalizedText ||
      candidate.variants?.some(v => normalizeSearchText(v.name) === query.normalizedText))) return 1;
  return 0;
}

/** Ignore letter case and outer whitespace, but preserve SKU separators and alphabet. */
export function isLiteralSearchCodeMatch(code: string | null | undefined, query: PreparedCatalogSearchQuery): boolean {
  return Boolean(query.raw && code?.trim().toLowerCase() === query.raw.toLowerCase());
}

const alphabet = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

export function rankCatalogSearchCandidates(candidates: CatalogSearchCandidate[], query: PreparedCatalogSearchQuery): CatalogSearchCandidate[] {
  return candidates.map(candidate => ({ candidate,
    literalCode: isLiteralSearchCodeMatch(candidate.code, query) || candidate.variants?.some(v => isLiteralSearchCodeMatch(v.code, query)) === true,
    exact: exactMatch(candidate, query), score: scoreCatalogSearchCandidate(candidate, query),
    language: catalogCandidateLanguageQuality(candidate, query) }))
    .filter(({ candidate, score, language }) => (score > 0 || language > 0) && (!query.sampleSaleOnly || candidate.isSampleSale))
    .sort((a, b) => Number(b.literalCode) - Number(a.literalCode) ||
      Number(b.candidate.hasSearchImage === true) - Number(a.candidate.hasSearchImage === true) ||
      b.exact - a.exact ||
      b.language - a.language ||
      Number(a.candidate.isSampleSale === true) - Number(b.candidate.isSampleSale === true) ||
      b.score - a.score || alphabet.compare(a.candidate.name ?? "", b.candidate.name ?? "") || a.candidate.id - b.candidate.id)
    .map(({ candidate }) => candidate);
}

export function selectTopCatalogSearchCandidates(candidates: CatalogSearchCandidate[], query: PreparedCatalogSearchQuery): CatalogSearchCandidate[] {
  return rankCatalogSearchCandidates(candidates, query).slice(0, CATALOG_SEARCH_RESULT_LIMIT);
}
