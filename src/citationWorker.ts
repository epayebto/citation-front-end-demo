/// <reference lib="webworker" />
import type { ParsedCitation, WorkerRequest, WorkerResponse } from './types';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

// Abbreviations must contain at least 2 uppercase letters (rejects "Gemäss", "Dieser", etc.)
// Optionally followed by /XX cantonal suffix (e.g. KV/ZH, StPO/FR)
const ABBREV = String.raw`(?=[A-ZÄÖÜ][A-Za-zÄÖÜäöü0-9]*[A-ZÄÖÜ])[A-ZÄÖÜ][A-Za-zÄÖÜäöü0-9]{1,9}(?:/[A-Z]{2})?`;

const LATIN_SUFFIXES = String.raw`bis|ter|quater|quinquies|sexies|septies|octies|novies|decies`;
const ARTNUM = String.raw`\d+(?:${LATIN_SUFFIXES}|[a-z]?)`;
const SR_NUM = String.raw`\d{3}(?:\.\d+)*`;

// Article keyword: Art. / § / sec. / Section
const ART_KW = String.raw`(?:[Aa]rt\.?|§|[Ss]ec(?:tion)?\.?)`;

// ---------------------------------------------------------------------------
// DE ordinal words  →  digit mapping
// ---------------------------------------------------------------------------
const DE_ORDINALS = String.raw`erster|zweiter|dritter|vierter|fünfter|sechster|siebter|achter|neunter|zehnter`;
const ORDINAL_TO_DIGIT: Record<string, string> = {
  erster: '1', zweiter: '2', dritter: '3', vierter: '4', fünfter: '5',
  sechster: '6', siebter: '7', achter: '8', neunter: '9', zehnter: '10'
};

// ---------------------------------------------------------------------------
// Sub-article component patterns (named-group version for main regex)
//
// Sources:
//   DE  – BGer Zitierregeln:  Abs. / Bst. / lit. / Ziff. / Nr. / Satz
//   FR  – Règles de citation: al. / let. / ch. / phrase  (ordinal: 1re, 2e …)
//   IT  – Regole di citazione: cpv. / lett. / n. / periodo / frase (ordinal: 1o, 2a …)
//   EN  – para. / par. / let. / lit. / no. / sentence
// ---------------------------------------------------------------------------

// Paragraph:  Abs. (DE) | al. (FR) | cpv. (IT) | par./para. (EU/EN)
const PARA = (g: string) =>
  String.raw`(?:\s+(?:Abs\.|al\.|cpv\.|par(?:a)?\.)\s*(?<${g}_para>\d+[a-z]?))?`;

// Letter:  Bst./lit. (DE) | let./lett. (FR/IT) | lit. (EN)
const LETTER = (g: string) =>
  String.raw`(?:\s+(?:Bst\.|let\.|lett\.|lit\.)\s*(?<${g}_let>[a-z](?:bis|ter)?))?`;

// Number:  Ziff./Nr. (DE) | ch. (FR) | n. (IT) | no. (EN)
// Accepts digits or lowercase Roman numerals (i, ii, iii, iv, etc.)
const ROMAN = String.raw`[ivxlcdm]+`;
const NUMBER = (g: string) =>
  String.raw`(?:\s+(?:Ziff\.|Nr\.|ch\.|n\.|no\.)\s*(?<${g}_num>\d+|${ROMAN}))?`;

// Sentence — three sub-patterns:
//   1) DE ordinal word + keyword:       "zweiter Satz"
//   2) keyword + cardinal:              "Satz 2" / "sentence 3"
//   3) FR/IT/EN numeric ordinal + kw:   "2e phrase" / "2a frase" / "2nd sentence"
const SENT_KW = String.raw`Satz|phrase|periodo|frase|sentence`;
const NUM_ORD_SUFFIX = String.raw`(?:re|e|a|o|st|nd|rd|th)`;
const SENTENCE = (g: string) =>
  String.raw`(?:` +
    // optional leading comma (FR style: "art. 40, 1re phrase, LAA")
    String.raw`(?:,?\s+)` +
    String.raw`(?:` +
      // 1) DE ordinal word:  "zweiter Satz"
      String.raw`(?<${g}_sentord>${DE_ORDINALS})\s+(?:${SENT_KW})` +
      String.raw`|` +
      // 2) keyword + cardinal:  "Satz 2"
      String.raw`(?:${SENT_KW})\s*(?<${g}_sent>\d+)` +
      String.raw`|` +
      // 3) numeric ordinal:  "2e phrase" / "2a frase" / "2nd sentence"
      String.raw`(?<${g}_sentnum>\d+)${NUM_ORD_SUFFIX}\s+(?:${SENT_KW})` +
    String.raw`)` +
  String.raw`)?`;

// Following:  f./ff. (DE) | s./ss (FR) | seg./segg. (IT)
const FOLLOWING = String.raw`(?:\s+(?:ff?\.|ss?|segg?\.))?`;

// Order: para → letter → number → letter (again, for IT n.+lett.) → sentence → following
function subArticle(groupPrefix: string): string {
  // Second letter group uses _let2 to avoid duplicate named group
  const LETTER2 = String.raw`(?:\s+(?:Bst\.|let\.|lett\.|lit\.)\s*(?<${groupPrefix}_let2>[a-z](?:bis|ter)?))?`;
  return `${PARA(groupPrefix)}${LETTER(groupPrefix)}${NUMBER(groupPrefix)}${LETTER2}${SENTENCE(groupPrefix)}${FOLLOWING}`;
}

// ---------------------------------------------------------------------------
// Plain (non-capturing) sub-article pattern for compound regex
// ---------------------------------------------------------------------------
const LETTER_PLAIN = String.raw`(?:\s+(?:Bst\.|let\.|lett\.|lit\.)\s*[a-z](?:bis|ter)?)?`;
const SUB_PLAIN =
  String.raw`(?:\s+(?:Abs\.|al\.|cpv\.|par(?:a)?\.)\s*\d+[a-z]?)?` +
  LETTER_PLAIN +
  String.raw`(?:\s+(?:Ziff\.|Nr\.|ch\.|n\.|no\.)\s*(?:\d+|${ROMAN}))?` +
  LETTER_PLAIN +
  String.raw`(?:(?:,?\s+)(?:(?:${DE_ORDINALS})\s+(?:${SENT_KW})|(?:${SENT_KW})\s*\d*|\d+${NUM_ORD_SUFFIX}\s+(?:${SENT_KW})))?` +
  String.raw`(?:\s+(?:ff?\.|ss?|segg?\.))?`;

// ---------------------------------------------------------------------------
// Main citation patterns
// ---------------------------------------------------------------------------

// Format A:  ABBREV Art. NUM [sub]          e.g. "ZGB Art. 28 Abs. 2"
// Format B:  Art. NUM [sub] ABBREV          e.g. "Art. 28 Abs. 2 ZGB"
const citationPattern = new RegExp(
  String.raw`(?:` +
    String.raw`\b(?<abbrev_a>${ABBREV})\s+${ART_KW}\s*(?<num_a>${ARTNUM})${subArticle('a')}` +
  String.raw`)` +
  String.raw`|(?:` +
    String.raw`${ART_KW}\s*(?<num_b>${ARTNUM})${subArticle('b')}[,;]?\s+(?<abbrev_b>${ABBREV})\b` +
  String.raw`)`,
  'g'
);

// Compound:  Art. X [sub] et/und/and/e [Art.] Y [sub] ABBREV
const compoundPattern = new RegExp(
  String.raw`${ART_KW}\s*${ARTNUM}${SUB_PLAIN}` +
  String.raw`(?:\s+(?:et|und|e|and)\s+(?:${ART_KW}\s*)?${ARTNUM}${SUB_PLAIN})+` +
  String.raw`[,;]?\s+(?:${ABBREV})\b`,
  'g'
);

const compoundArticlePattern = new RegExp(
  String.raw`(?:${ART_KW}\s*)?(?<artnum>${ARTNUM})(?<sub>${SUB_PLAIN})`,
  'g'
);

const compoundAbbrevPattern = new RegExp(String.raw`(?<abbr>${ABBREV})\s*$`);

// SR/RS pattern
const srPattern = new RegExp(
  String.raw`(?:SR|RS)\s+(?<sr>${SR_NUM})(?:\s+${ART_KW}\s*(?<sr_artnum>${ARTNUM})${subArticle('sr')})?`,
  'g'
);

const REPARSE_CONTEXT_CHARS = 96;

let latestText = '';
let latestCitations: ParsedCitation[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSubArticle(groups: Record<string, string | undefined>, prefix: string) {
  const sentOrd = groups[`${prefix}_sentord`];
  const sentNum = groups[`${prefix}_sentnum`];
  return {
    paragraph: groups[`${prefix}_para`],
    letter: groups[`${prefix}_let`] ?? groups[`${prefix}_let2`],
    number: groups[`${prefix}_num`],
    sentence: groups[`${prefix}_sent`]
      ?? (sentOrd ? ORDINAL_TO_DIGIT[sentOrd] : undefined)
      ?? sentNum
  };
}

/** Extract sentence number from plain (non-capturing) sub-article text */
function extractSentenceFromPlain(subText: string): string | undefined {
  // keyword + cardinal: "Satz 2"
  const cardinalMatch = subText.match(new RegExp(`(?:${SENT_KW})\\s*(\\d+)`));
  if (cardinalMatch?.[1]) return cardinalMatch[1];

  // numeric ordinal: "2e phrase", "1re phrase", "2a frase"
  const numOrdMatch = subText.match(new RegExp(`(\\d+)(?:${NUM_ORD_SUFFIX.slice(2, -1)})\\s+(?:${SENT_KW})`));
  if (numOrdMatch?.[1]) return numOrdMatch[1];

  // DE ordinal word: "zweiter Satz"
  const deOrdMatch = subText.match(new RegExp(`(${DE_ORDINALS})\\s+(?:${SENT_KW})`));
  if (deOrdMatch?.[1]) return ORDINAL_TO_DIGIT[deOrdMatch[1]];

  return undefined;
}

function parseCompoundCitations(text: string, seen: Set<string>): ParsedCitation[] {
  const results: ParsedCitation[] = [];

  for (const match of text.matchAll(compoundPattern)) {
    if (typeof match.index !== 'number') continue;

    const span = match[0];
    const abbrMatch = compoundAbbrevPattern.exec(span);
    if (!abbrMatch?.groups?.abbr) continue;
    const abbreviation = abbrMatch.groups.abbr;

    const articlesText = span.slice(0, abbrMatch.index).trim();

    for (const artMatch of articlesText.matchAll(compoundArticlePattern)) {
      const articleNumber = artMatch.groups?.artnum?.trim();
      if (!articleNumber || typeof artMatch.index !== 'number') continue;

      const subText = (artMatch.groups?.sub ?? '').trim();
      const paraMatch = subText.match(/(?:Abs\.|al\.|cpv\.|par(?:a)?\.)\s*(\d+[a-z]?)/);
      const letMatch = subText.match(/(?:Bst\.|let\.|lett\.|lit\.)\s*([a-z](?:bis|ter)?)/);
      const numMatch = subText.match(/(?:Ziff\.|Nr\.|ch\.|n\.|no\.)\s*(\d+)/);

      const key = `${abbreviation.toUpperCase()}|${articleNumber.toLowerCase()}|${match.index + artMatch.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        id: `${abbreviation.toUpperCase()}-${articleNumber}-${match.index + artMatch.index}`,
        abbreviation,
        articleNumber,
        rawSpan: `Art. ${articleNumber} ${abbreviation}`,
        start: match.index,
        end: match.index + span.length,
        paragraph: paraMatch?.[1],
        letter: letMatch?.[1],
        number: numMatch?.[1],
        sentence: extractSentenceFromPlain(subText)
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main parse
// ---------------------------------------------------------------------------

function parse(text: string): ParsedCitation[] {
  const results: ParsedCitation[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(citationPattern)) {
    const groups = (match.groups ?? {}) as Record<string, string | undefined>;
    const abbreviation = (groups.abbrev_a ?? groups.abbrev_b ?? '').trim();
    const articleNumber = (groups.num_a ?? groups.num_b ?? '').trim();

    if (!abbreviation || !articleNumber || typeof match.index !== 'number') {
      continue;
    }

    const key = `${abbreviation.toUpperCase()}|${articleNumber.toLowerCase()}|${match.index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const prefix = groups.abbrev_a ? 'a' : 'b';
    results.push({
      id: `${abbreviation.toUpperCase()}-${articleNumber}-${match.index}`,
      abbreviation,
      articleNumber,
      rawSpan: match[0].trim(),
      start: match.index,
      end: match.index + match[0].length,
      ...extractSubArticle(groups, prefix)
    });
  }

  for (const match of text.matchAll(srPattern)) {
    const groups = (match.groups ?? {}) as Record<string, string | undefined>;
    const srNumber = groups.sr?.trim();
    const articleNumber = (groups.sr_artnum ?? '').trim();

    if (!srNumber || typeof match.index !== 'number') {
      continue;
    }

    const key = `SR:${srNumber}|${articleNumber.toLowerCase()}|${match.index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    results.push({
      id: `SR-${srNumber}-${articleNumber || 'law'}-${match.index}`,
      abbreviation: '',
      articleNumber,
      rawSpan: match[0].trim(),
      start: match.index,
      end: match.index + match[0].length,
      srNumber,
      ...(articleNumber
        ? extractSubArticle(groups, 'sr')
        : { paragraph: undefined, letter: undefined, number: undefined, sentence: undefined })
    });
  }

  results.push(...parseCompoundCitations(text, seen));

  return results.sort((left, right) => left.start - right.start);
}

// ---------------------------------------------------------------------------
// Incremental parsing
// ---------------------------------------------------------------------------

function shiftCitation(citation: ParsedCitation, delta: number): ParsedCitation {
  return {
    ...citation,
    start: citation.start + delta,
    end: citation.end + delta
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isBoundaryCharacter(char: string | undefined): boolean {
  return !char || /\s|[()[\]{}.,;:!?]/.test(char);
}

function expandLeft(text: string, index: number): number {
  let nextIndex = clamp(index - REPARSE_CONTEXT_CHARS, 0, text.length);
  while (nextIndex > 0 && !isBoundaryCharacter(text[nextIndex - 1])) {
    nextIndex -= 1;
  }
  return nextIndex;
}

function expandRight(text: string, index: number): number {
  let nextIndex = clamp(index + REPARSE_CONTEXT_CHARS, 0, text.length);
  while (nextIndex < text.length && !isBoundaryCharacter(text[nextIndex])) {
    nextIndex += 1;
  }
  return nextIndex;
}

function parseSlice(text: string, start: number, end: number): ParsedCitation[] {
  const slice = text.slice(start, end);
  return parse(slice).map((citation) => ({
    ...citation,
    start: citation.start + start,
    end: citation.end + start
  }));
}

function incrementalParse(text: string, changes: NonNullable<WorkerRequest['changes']>): ParsedCitation[] {
  const mergedChange = changes.reduce(
    (range, change) => ({
      from: Math.min(range.from, change.from),
      to: Math.max(range.to, change.to),
      insertedLength: range.insertedLength + change.insertedText.length,
      removedLength: range.removedLength + (change.to - change.from)
    }),
    {
      from: Number.POSITIVE_INFINITY,
      to: Number.NEGATIVE_INFINITY,
      insertedLength: 0,
      removedLength: 0
    }
  );

  if (!Number.isFinite(mergedChange.from) || !Number.isFinite(mergedChange.to)) {
    return parse(text);
  }

  const totalDelta = mergedChange.insertedLength - mergedChange.removedLength;
  const newDirtyStart = mergedChange.from;
  const newDirtyEnd = mergedChange.to + totalDelta;

  const oldWindowStart = expandLeft(latestText, mergedChange.from);
  const oldWindowEnd = expandRight(latestText, mergedChange.to);
  const newWindowStart = expandLeft(text, newDirtyStart);
  const newWindowEnd = expandRight(text, newDirtyEnd);

  const before = latestCitations.filter((citation) => citation.end <= oldWindowStart);
  const reparsed = parseSlice(text, newWindowStart, newWindowEnd);
  const after = latestCitations
    .filter((citation) => citation.start >= oldWindowEnd)
    .map((citation) => shiftCitation(citation, totalDelta));

  return [...before, ...reparsed, ...after];
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const startedAt = performance.now();
  const { fullText, changes } = event.data;
  const citations = latestText && changes && changes.length > 0
    ? incrementalParse(fullText, changes)
    : parse(fullText);

  latestText = fullText;
  latestCitations = citations;

  const response: WorkerResponse = {
    version: event.data.version,
    citations,
    durationMs: performance.now() - startedAt
  };

  self.postMessage(response);
};

export {};
