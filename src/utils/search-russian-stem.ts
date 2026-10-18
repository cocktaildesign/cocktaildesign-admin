/** Russian Snowball algorithm, applied equally to every catalog word.
 * Specification: https://snowballstem.org/algorithms/russian/stemmer.html
 * Verified against the upstream Russian vocabulary/output corpus.
 * This is a search key only: product names and CRM data are never rewritten.
 */
export function stemRussianWord(input: string): string {
  const word = input.toLowerCase().replace(/ё/g, "е");
  if (!/^[а-я]+$/.test(word)) return word;
  const vowel = /[аеиоуыэюя]/;
  const rv = word.search(vowel) + 1;
  if (!rv) return word;
  const region = (start: number) => {
    for (let i = start + 1; i < word.length; i++) {
      if (vowel.test(word[i - 1]) && !vowel.test(word[i])) return i + 1;
    }
    return word.length;
  };
  const r2 = region(region(0));
  let tail = word.slice(rv);
  const strip = (pattern: RegExp) => {
    const next = tail.replace(pattern, "");
    const changed = next !== tail;
    tail = next;
    return changed;
  };
  if (!strip(/(?:ившись|ывшись|ивши|ывши|ив|ыв|(?<=[ая])(?:вшись|вши|в))$/)) {
    strip(/(?:ся|сь)$/);
    if (strip(/(?:ими|ыми|его|ого|ему|ому|ее|ие|ые|ое|ей|ий|ый|ой|ем|им|ым|ом|их|ых|ую|юю|ая|яя|ою|ею)$/)) {
      strip(/(?:ивш|ывш|ующ|(?<=[ая])(?:ем|нн|вш|ющ|щ))$/);
    } else if (!strip(/(?:ейте|уйте|ила|ыла|ена|ите|или|ыли|ило|ыло|ено|ует|уют|ены|ить|ыть|ишь|ей|уй|ил|ыл|им|ым|ен|ят|ит|ыт|ую|ю|(?<=[ая])(?:нно|ете|йте|ешь|ла|на|ли|ем|ло|но|ет|ют|ны|ть|й|л|н))$/)) {
      strip(/(?:иями|ией|иям|ием|иях|ями|ами|ев|ов|ие|ье|еи|ии|ей|ой|ий|ям|ем|ам|ом|ах|ях|ию|ью|ия|ья|а|е|и|й|о|у|ы|ь|ю|я)$/);
    }
  }
  strip(/и$/);
  const derivation = tail.match(/ость?$/);
  if (derivation && rv + tail.length - derivation[0].length >= r2) strip(/ость?$/);
  if (!strip(/ь$/)) {
    strip(/(?:ейше|ейш)$/);
    tail = tail.replace(/нн$/, "н");
  }
  return word.slice(0, rv) + tail;
}

/** Catalogs are noun-heavy. Snowball's verb step can treat "бокал" as a verb
 * and "стаканов" as a gerund; keep a parallel noun analysis for every word.
 * Use Snowball's RV boundary and longest noun suffix, without the verb step.
 */
export function stemRussianNoun(input: string): string {
  const word = input.toLowerCase().replace(/ё/g, "е");
  if (!/^[а-я]+$/.test(word)) return word;
  const rv = word.search(/[аеиоуыэюя]/) + 1;
  if (!rv) return word;
  return word.slice(0, rv) + word.slice(rv).replace(/(?:иями|ией|иям|ием|иях|ями|ами|ев|ов|ие|ье|еи|ии|ей|ой|ий|ям|ем|ам|ом|ах|ях|ию|ью|ия|ья|а|е|и|й|о|у|ы|ь|ю|я)$/, "");
}
