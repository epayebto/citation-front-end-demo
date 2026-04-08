import type { ArticlePreviewPayload, ParsedCitation, ResolvedCitation } from './types';

const API_BASE_URL = (globalThis as { __LAW_API_BASE_URL__?: string }).__LAW_API_BASE_URL__ ?? 'http://localhost:8000';
const RESOLVE_ENDPOINT = `${API_BASE_URL.replace(/\/$/, '')}/api/v1/citations/resolve`;

type ApiCitationPayload = {
  excerpt?: string;
  full_text?: string;
  fedlex_url?: string;
  law_title?: string;
  article_number?: string;
  language?: string;
};

type ApiCitationResult = {
  abbreviation?: string;
  article_number?: string;
  raw_span?: string;
  resolved: boolean;
  sr_number?: string;
  law_title?: string;
  payloads?: Record<string, ApiCitationPayload>;
  reason?: string;
};

type ApiResolveResponse = {
  citations?: ApiCitationResult[];
};

const cache = new Map<string, Promise<ResolvedCitation>>();

function buildCanonicalKey(citation: ParsedCitation): string {
  if (citation.srNumber) {
    return `${citation.srNumber}|${citation.articleNumber || '*'}`;
  }
  return `${citation.abbreviation.toUpperCase()}|${citation.articleNumber.toLowerCase()}`;
}

function buildPayloads(result: ApiCitationResult): Record<string, ArticlePreviewPayload> | undefined {
  if (!result.payloads) {
    return undefined;
  }

  const entries = Object.entries(result.payloads).map(([language, payload]) => [
    language,
    {
      language,
      title: payload.law_title ?? result.law_title ?? 'Swiss federal law',
      articleLabel: payload.article_number ? `Art. ${payload.article_number}` : 'Article',
      html: `<p>${payload.full_text ?? payload.excerpt ?? 'No article text returned.'}</p>`,
      sourceUrl: payload.fedlex_url ?? ''
    } satisfies ArticlePreviewPayload
  ]);

  return Object.fromEntries(entries);
}

export async function resolveCitation(citation: ParsedCitation): Promise<ResolvedCitation> {
  const cacheKey = buildCanonicalKey(citation);
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = fetch(RESOLVE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      citations: [
        {
          abbreviation: citation.abbreviation || undefined,
          article_number: citation.articleNumber,
          sr_number: citation.srNumber || undefined
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
    .catch((error: unknown) => ({
      citationId: citation.id,
      canonicalKey: cacheKey,
      resolved: false,
      displayLabel: citation.rawSpan,
      reason: error instanceof Error
        ? `${error.message}. Check API availability/CORS for ${API_BASE_URL}.`
        : `Resolver request failed. Check API availability/CORS for ${API_BASE_URL}.`
    }));

  cache.set(cacheKey, promise);
  return promise;
}
