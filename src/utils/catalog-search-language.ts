import { normalizeSearchText } from "./product-search-index";
import { stemRussianNoun, stemRussianWord } from "./search-russian-stem";

type Term = { text: string; stems: string[] };
export type SearchInterpretation = { terms: Term[]; layout: boolean };
const stopWords = new Set(["для", "и", "в", "во", "на", "с", "со", "из", "от", "к", "по"]);
const saleWord = /^уцен(?:ка|ки|ке|ку|кой|ок|енный|енная|енное|енные|енных|енному|енного|енными)$/;
export const isSearchSaleWord = (word: string) => saleWord.test(word);

// Equivalent vocabulary, not a list of searchable products. Morphology is general.
// Fleeting-vowel/irregular nouns need explicit equivalence beyond Snowball's suffix rules.
const equivalentWords = [
  ["пин", "пины", "pin", "pins", "значок", "значки"],
  ["лед", "льда", "льду", "льдом"],
  ["ложка", "ложек"], ["бутылочка", "бутылочек"],
  ["крышка", "крышек"], ["формочка", "формочек"],
  ["кольцо", "колец"], ["блюдце", "блюдец"],
  ["лист", "листья", "листьев"], ["щипцы", "щипцов"],
  ["джиггер", "джигер"], ["темпер", "тампер"],
];
const equivalents = new Map<string, string[]>();
const wordKeys = (word: string) => [...new Set([stemRussianWord(word), stemRussianNoun(word), word])];
for (const group of equivalentWords) {
  const stems = [...new Set(group.flatMap(wordKeys))];
  for (const stem of stems) equivalents.set(stem, stems);
}

const enKeys = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const ruKeys = "ёйцукенгшщзхъфывапролджэячсмитьбю";
export function swapSearchLayout(raw: string): string | null {
  const lower = raw.toLowerCase();
  // Digits, SKU separators and mixed alphabets are not auto-corrected.
  if (!/^[a-z\s`\[\];',.]+$/.test(lower) && !/^[а-яё\s]+$/.test(lower)) return null;
  if (lower.replace(/\s/g, "").length < 3) return null;
  const [from, to] = /[а-яё]/.test(lower) ? [ruKeys, enKeys] : [enKeys, ruKeys];
  return [...lower].map(char => from.includes(char) ? to[from.indexOf(char)] : char).join("");
}

export function prepareSearchInterpretations(raw: string): SearchInterpretation[] {
  const swapped = swapSearchLayout(raw);
  return [raw, ...(swapped ? [swapped] : [])].map((value, i) => ({
    layout: i > 0,
    terms: [...new Set(normalizeSearchText(value).split(" "))]
      .filter(word => word && !stopWords.has(word) && !saleWord.test(word))
      .map(text => ({ text, stems: [...new Set(wordKeys(text).flatMap(stem => equivalents.get(stem) ?? [stem]))] })),
  })).filter(interpretation => interpretation.terms.length > 0);
}

/** Conservative one-character edit, including adjacent transposition, in a word only. */
export function oneSearchEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function typoEligible(term: Term) {
  return /^[а-я]{5,32}$/.test(term.text) && term.stems[0].length >= 5;
}

/** Whole words/morphology first; a typo is allowed in at most one term of a phrase. */
export function searchLanguageQuality(text: string, interpretations: SearchInterpretation[], fuzzy = false): number {
  const words = new Set(normalizeSearchText(text).split(" ").filter(Boolean));
  const stems = new Set([...words].flatMap(wordKeys));
  let best = 0;
  for (const interpretation of interpretations) {
    if (!interpretation.terms.length) continue;
    let edits = 0, literal = true;
    const match = interpretation.terms.every(term => {
      if (words.has(term.text)) return true;
      literal = false;
      if (term.stems.some(stem => stems.has(stem))) return true;
      if (!fuzzy || interpretation.terms.length > 6 || !typoEligible(term) || ++edits > 1) return false;
      return [...stems].some(stem => /^[а-я]{4,32}$/.test(stem) && oneSearchEdit(term.stems[0], stem));
    });
    if (match) best = Math.max(best, edits ? 1 : interpretation.layout ? 2 : literal ? 4 : 3);
  }
  return best;
}

export function searchNamePosition(name: string, interpretations: SearchInterpretation[]): number {
  const words = normalizeSearchText(name).split(" ");
  const firstTerms = interpretations.map(item => ({ ...item, terms: item.terms.slice(0, 1) }));
  const position = words.findIndex(word => searchLanguageQuality(word, firstTerms) > 0);
  return position < 0 ? 0 : Math.max(0, 100 - position * 10);
}

/** Parameterized Strapi filters over the existing index; no migration/backfill needed. */
export function searchLanguageFilters(interpretations: SearchInterpretation[], fuzzy = false): any[] {
  return interpretations.flatMap(interpretation => {
    if (!interpretation.terms.length || (fuzzy && interpretation.terms.length > 6)) return [];
    return [{ $and: interpretation.terms.map(term => {
      const needles = [...term.stems, term.text];
      if (fuzzy && typoEligible(term)) {
        const stem = term.stems[0], n = Math.max(1, Math.floor((stem.length - 1) / 2));
        // Non-overlapping ends leave a gap: one edit/transposition cannot damage both.
        needles.push(stem.slice(0, n), stem.slice(-n));
      }
      return { $or: [...new Set(needles)].map(value => ({ searchText: { $containsi: value } })) };
    }) }];
  });
}
