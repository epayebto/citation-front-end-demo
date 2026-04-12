import type { ArticlePreviewPayload, ParsedCitation, ResolvedCitation, SubArticle, SubArticleFocus } from './types';

const API_BASE_URL = (globalThis as { __LAW_API_BASE_URL__?: string }).__LAW_API_BASE_URL__ ?? 'http://localhost:8000';
const RESOLVE_ENDPOINT = `${API_BASE_URL.replace(/\/$/, '')}/api/v1/citations/resolve`;

// ---------------------------------------------------------------------------
// API response types (match the backend contract)
// ---------------------------------------------------------------------------

type ApiSubArticle = {
  eid: string;
  type: 'paragraph' | 'item';
  num?: string;
  label?: string;
  chapeau?: string;
  text: string;
  items?: ApiSubArticle[];
};

type ApiFocus = {
  eid: string;
  chapeau?: string;
  text: string;
};

type ApiPayload = {
  language?: string;
  law_title?: string;
  article_number?: string;
  article_title?: string;
  hierarchy_label?: string;
  excerpt?: string;
  full_text?: string;
  fedlex_url?: string;
  sub_articles?: ApiSubArticle[];
  focus?: ApiFocus;
};

type ApiCitationResult = {
  abbreviation?: string;
  article_number?: string;
  raw_span?: string;
  resolved: boolean;
  sr_number?: string;
  law_title?: string;
  payloads?: Record<string, ApiPayload>;
  reason?: string;
};

type ApiResolveResponse = {
  citations?: ApiCitationResult[];
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, Promise<ResolvedCitation>>();

function buildCanonicalKey(citation: ParsedCitation): string {
  const base = citation.srNumber
    ? `${citation.srNumber}|${citation.articleNumber || '*'}`
    : `${citation.abbreviation.toUpperCase()}|${citation.articleNumber.toLowerCase()}`;

  // Include sub-article in key so different sub-references resolve separately
  const sub = [citation.paragraph, citation.letter, citation.number, citation.sentence]
    .filter(Boolean)
    .join('+');

  return sub ? `${base}|${sub}` : base;
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function mapSubArticles(items?: ApiSubArticle[]): SubArticle[] {
  if (!items?.length) return [];
  return items.map((item) => ({
    eid: item.eid,
    type: item.type,
    num: item.num,
    label: item.label,
    chapeau: item.chapeau,
    text: item.text,
    items: mapSubArticles(item.items)
  }));
}

function mapFocus(focus?: ApiFocus): SubArticleFocus | undefined {
  if (!focus) return undefined;
  return { eid: focus.eid, chapeau: focus.chapeau, text: focus.text };
}

function buildPayloads(result: ApiCitationResult): Record<string, ArticlePreviewPayload> | undefined {
  if (!result.payloads) return undefined;

  const entries = Object.entries(result.payloads).map(([language, p]) => [
    language,
    {
      language,
      title: p.law_title ?? result.law_title ?? 'Swiss federal law',
      articleLabel: p.article_number ?? 'Article',
      articleTitle: p.article_title,
      hierarchyLabel: p.hierarchy_label,
      excerpt: p.excerpt ?? '',
      fullText: p.full_text ?? p.excerpt ?? '',
      sourceUrl: p.fedlex_url ?? '',
      subArticles: mapSubArticles(p.sub_articles),
      focus: mapFocus(p.focus)
    } satisfies ArticlePreviewPayload
  ]);

  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function resolveCitation(citation: ParsedCitation): Promise<ResolvedCitation> {
  const cacheKey = buildCanonicalKey(citation);
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const promise = fetch(RESOLVE_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      citations: [
        {
          abbreviation: citation.abbreviation || undefined,
          article_number: citation.articleNumber,
          sr_number: citation.srNumber || undefined,
          paragraph: citation.paragraph || undefined,
          letter: citation.letter || undefined,
          number: citation.number || undefined,
          sentence: citation.sentence || undefined
        }
      ],
      languages: ['de', 'fr', 'it']
    })
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Resolver API returned ${response.status}`);
      }

      const data = (await response.json()) as ApiResolveResponse;
      const result = data.citations?.[0];
      if (!result) {
        return {
          citationId: citation.id,
          canonicalKey: cacheKey,
          resolved: false,
          displayLabel: citation.rawSpan,
          reason: 'Resolver API returned no citation result.'
        } satisfies ResolvedCitation;
      }

      return {
        citationId: citation.id,
        canonicalKey: cacheKey,
        resolved: result.resolved,
        displayLabel: result.raw_span ?? citation.rawSpan,
        srNumber: result.sr_number,
        lawTitle: result.law_title,
        payloads: buildPayloads(result),
        reason: result.reason
      } satisfies ResolvedCitation;
    })
    .catch((error: unknown) => {
      cache.delete(cacheKey);
      return {
        citationId: citation.id,
        canonicalKey: cacheKey,
        resolved: false,
        displayLabel: citation.rawSpan,
        reason: error instanceof Error
          ? `${error.message}. Check API availability/CORS for ${API_BASE_URL}.`
          : `Resolver request failed. Check API availability/CORS for ${API_BASE_URL}.`
      };
    });

  cache.set(cacheKey, promise);
  return promise;
}
