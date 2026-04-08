/// <reference lib="webworker" />
import type { ParsedCitation, WorkerRequest, WorkerResponse } from './types';

const ABBREV = String.raw`(?=[A-ZÄÖÜ][A-Za-zÄÖÜäöü0-9]*[A-ZÄÖÜ])[A-ZÄÖÜ][A-Za-zÄÖÜäöü0-9]{1,9}`;
const LATIN_SUFFIXES = String.raw`bis|ter|quater|quinquies|sexies|septies|octies|novies|decies`;
const ARTNUM = String.raw`\d+(?:${LATIN_SUFFIXES}|[a-z]?)`;
const SR_NUM = String.raw`\d{3}(?:\.\d+)*`;

const ORDINALS = String.raw`erster|zweiter|dritter|vierter|fünfter|sechster|siebter|achter|neunter|zehnter`;
const ORDINAL_TO_DIGIT: Record<string, string> = {
  erster: '1', zweiter: '2', dritter: '3', vierter: '4', fünfter: '5',
  sechster: '6', siebter: '7', achter: '8', neunter: '9', zehnter: '10'
};
const PARA = (groupPrefix: string) => String.raw`(?:\s+(?:Abs\.|al\.|cpv\.)\s*(?<${groupPrefix}_para>\d+[a-z]?))?`;
const LETTER = (groupPrefix: string) => String.raw`(?:\s+(?:Bst\.|let\.|lett\.|lit\.)\s*(?<${groupPrefix}_let>[a-z](?:bis|ter)?))?`;
const NUMBER = (groupPrefix: string) => String.raw`(?:\s+(?:Ziff\.|ch\.|n\.)\s*(?<${groupPrefix}_num>\d+))?`;
const SENTENCE = (groupPrefix: string) => String.raw`(?:\s+(?:(?<${groupPrefix}_sentord>${ORDINALS})\s+(?:Satz|phrase|periodo)|(?:Satz|phrase|periodo)\s*(?<${groupPrefix}_sent>\d+)))?`;

function subArticle(groupPrefix: string): string {
  return `${PARA(groupPrefix)}${LETTER(groupPrefix)}${NUMBER(groupPrefix)}${SENTENCE(groupPrefix)}`;
}

const SUB_PLAIN = String.raw`(?:\s+(?:Abs\.|al\.|cpv\.)\s*\d+[a-z]?)?` +
  String.raw`(?:\s+(?:Bst\.|let\.|lett\.|lit\.)\s*[a-z](?:bis|ter)?)?` +
  String.raw`(?:\s+(?:Ziff\.|ch\.|n\.)\s*\d+)?` +
  String.raw`(?:\s+(?:(?:${ORDINALS})\s+)?(?:Satz|phrase|periodo)\s*\d*)?`;

const citationPattern = new RegExp(
  String.raw`(?:` +
    String.raw`\b(?<abbrev_a>${ABBREV})\s+[Aa]rt\.?\s*(?<num_a>${ARTNUM})${subArticle('a')}` +
  String.raw`)` +
  String.raw`|(?:` +
    String.raw`[Aa]rt\.?\s*(?<num_b>${ARTNUM})${subArticle('b')}\s+(?<abbrev_b>${ABBREV})\b` +
  String.raw`)`,
  'g'
);

const compoundPattern = new RegExp(
  String.raw`[Aa]rt\.?\s*${ARTNUM}${SUB_PLAIN}` +
  String.raw`(?:\s+(?:et|und|e)\s+(?:[Aa]rt\.?\s*)?${ARTNUM}${SUB_PLAIN})+` +
  String.raw`\s+(?:${ABBREV})\b`,
  'g'
);

const compoundArticlePattern = new RegExp(
  String.raw`(?:[Aa]rt\.?\s*)?(?<artnum>${ARTNUM})(?<sub>${SUB_PLAIN})`,
  'g'
);

const compoundAbbrevPattern = new RegExp(String.raw`(?<abbr>${ABBREV})\s*$`);

const srPattern = new RegExp(
  String.raw`(?:SR|RS)\s+(?<sr>${SR_NUM})(?:\s+[Aa]rt\.?\s*(?<sr_artnum>${ARTNUM})${subArticle('sr')})?`,
  'g'
);
const REPARSE_CONTEXT_CHARS = 96;

let latestText = '';
let latestCitations: ParsedCitation[] = [];

function extractSubArticle(groups: Record<string, string | undefined>, prefix: string) {
  const sentOrd = groups[`${prefix}_sentord`];
  return {
    paragraph: groups[`${prefix}_para`],
    letter: groups[`${prefix}_let`],
    number: groups[`${prefix}_num`],
    sentence: groups[`${prefix}_sent`] ?? (sentOrd ? ORDINAL_TO_DIGIT[sentOrd] : undefined)
  };
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
      const paraMatch = subText.match(/(?:Abs\.|al\.|cpv\.)\s*(\d+[a-z]?)/);
      const letMatch = subText.match(/(?:Bst\.|let\.|lett\.|lit\.)\s*([a-z](?:bis|ter)?)/);
      const numMatch = subText.match(/(?:Ziff\.|ch\.|n\.)\s*(\d+)/);
      const sentMatch = subText.match(/(?:Satz|phrase|periodo)\s*(\d+)/);
      const sentOrdMatch = subText.match(new RegExp(`(${ORDINALS})\\s+(?:Satz|phrase|periodo)`));

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
        sentence: sentMatch?.[1] ?? (sentOrdMatch?.[1] ? ORDINAL_TO_DIGIT[sentOrdMatch[1]] : undefined)
      });
    }
  }

  return results;
}

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
